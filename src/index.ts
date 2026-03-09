import "dotenv/config";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { createClient as createLibsqlClient } from "@libsql/client";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  type User
} from "discord.js";
import { TOOL_DEFINITIONS, TOOL_HANDLERS, type OpenAIToolDef } from "./tools";
import * as dbOps from "./db";

export type ToolTrace = {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  duration_ms: number;
  error?: string;
};

const toolTraces: ToolTrace[] = [];
function clearTraces(): ToolTrace[] {
  const traces = [...toolTraces];
  toolTraces.length = 0;
  return traces;
}
function recordTrace(trace: ToolTrace): void {
  toolTraces.push(trace);
}

type BotProfile = {
  name: "Slop";
  token: string;
  model: string;
  appId?: string;
};

type DestinationChannel = {
  sendTyping: () => Promise<void>;
  send: (content: string) => Promise<unknown>;
};

type KickoffPayload = {
  channelId?: string;
  title?: string;
  url?: string;
  contentType?: string;
  eventDate?: string;
  summary?: string;
  prompt?: string;
  exchanges?: number;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const processedMessageIds = new Set<string>();
const rateLimitByUser = new Map<string, number>();
const rateLimitByChannel = new Map<string, number>();
const activeDebates = new Set<string>();
const joinInFlight = new Set<string>();

type SchedulingSession = {
  eventType: "paper-club" | "builders-club";
  memberId: number;
  memberDiscordId: string;
  memberUsername: string;
  availableDates: string[];  // YYYY-MM-DD strings the user can pick from
  step: "pick_date" | "pick_title";
  chosenDate?: string;
};
const schedulingSessions = new Map<string, SchedulingSession>(); // threadId -> session

function getNextDatesForDay(targetDay: number, count: number): string[] {
  const dates: string[] = [];
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1); // start from tomorrow
  while (dates.length < count) {
    if (d.getUTCDay() === targetDay) {
      dates.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const TURSO_DATABASE_URL = requiredEnv("TURSO_DATABASE_URL");
const TURSO_AUTH_TOKEN = requiredEnv("TURSO_AUTH_TOKEN");
const OPENROUTER_API_KEY = requiredEnv("OPENROUTER_API_KEY");

const SLOP_MODEL = process.env.SLOP_MODEL || "anthropic/claude-sonnet-4-6";
const DISCORD_TEST_GUILD_ID = process.env.DISCORD_TEST_GUILD_ID || "";
const ALLOWED_CHANNEL_IDS = new Set(
  (process.env.ALLOWED_CHANNEL_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);
const USER_RATE_LIMIT_WINDOW_MS = Number(process.env.USER_RATE_LIMIT_WINDOW_MS || 5000);
const CHANNEL_RATE_LIMIT_WINDOW_MS = Number(process.env.CHANNEL_RATE_LIMIT_WINDOW_MS || 1200);
const DEBATE_KICKOFF_SECRET = process.env.DEBATE_KICKOFF_SECRET || "";
const DEBATE_KICKOFF_PORT = Number(process.env.DEBATE_KICKOFF_PORT || 8787);
const DEBATE_KICKOFF_HOST = process.env.DEBATE_KICKOFF_HOST || "0.0.0.0";
const BOT_TALK_CHANNEL_ID = process.env.BOT_TALK_CHANNEL_ID || "";
const clientsByProfile = new Map<BotProfile["name"], Client>();

const db = createLibsqlClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN
});
// MCP removed — all DB operations go through direct Turso queries (src/db.ts)

type MemberMetadata = {
  discord_id: string;
  discord_handle: string;
  avatar_url?: string;
  joined_at: string;
  last_active?: string;
  interaction_count?: number;
  interests?: string[];
  role?: string;
  company?: string;
  location?: string;
  interaction_preference?: string;
};

type MemberNode = {
  id: number;
  title: string;
  notes: string;
  metadata: MemberMetadata;
};

const profiles: BotProfile[] = [
  {
    name: "Slop",
    token: requiredEnv("BOT_TOKEN_SLOP"),
    model: SLOP_MODEL,
    appId: process.env.BOT_APP_ID_SLOP,
  }
];

function cleanUserPrompt(message: Message, botUserId: string): string {
  const mentionPattern = new RegExp(`<@!?${botUserId}>`, "g");
  const cleaned = message.content.replace(mentionPattern, "").trim();
  return cleaned || "Give a concise update based on the most relevant Latent Space context.";
}

function getThreadOwnerBotName(message: Message): BotProfile["name"] | null {
  if (
    message.channel.type !== ChannelType.PublicThread &&
    message.channel.type !== ChannelType.PrivateThread
  ) {
    return null;
  }

  const threadName = (message.channel.name || "").trim().toLowerCase();
  if (threadName.startsWith("slop:")) return "Slop";
  return null;
}


function shouldRespondToMessage(message: Message, botUserId: string, profileName: BotProfile["name"]): boolean {
  if (!message.inGuild()) return false;

  const owner = getThreadOwnerBotName(message);
  if (owner) {
    if (owner !== profileName) return false;
    if (message.author.id === botUserId) return false;
    // In owned threads, treat all non-bot user messages as addressed to the owner bot.
    if (message.author.bot && !message.webhookId) return false;
    return true;
  }

  const directMentionPattern = new RegExp(`<@!?${botUserId}>`);
  const directlyMentioned = message.mentions.users.has(botUserId) || directMentionPattern.test(message.content);
  const replyToBot =
    Boolean(message.reference?.messageId) && message.mentions.repliedUser?.id === botUserId;

  // Allow Discord webhook-originated messages when this bot is explicitly addressed.
  // Webhook authors are marked as bot=true, so a blanket bot filter would ignore them.
  if (message.author.bot && !message.webhookId) return false;

  return directlyMentioned || replyToBot;
}


function isAllowedChannel(message: Message): boolean {
  if (!ALLOWED_CHANNEL_IDS.size) return true;
  return ALLOWED_CHANNEL_IDS.has(message.channelId);
}

function withinRateLimit(
  message: Message,
  profileName: BotProfile["name"],
  options?: { ownedThread?: boolean }
): boolean {
  const now = Date.now();
  const userKey = `${profileName}:${message.author.id}`;
  const channelKey = `${profileName}:${message.channelId}`;
  const userLast = rateLimitByUser.get(userKey) || 0;
  const channelLast = rateLimitByChannel.get(channelKey) || 0;
  const ownedThread = Boolean(options?.ownedThread);

  // In bot-owned threads we relax per-user cooldown to keep natural back-and-forth.
  if (!ownedThread && now - userLast < USER_RATE_LIMIT_WINDOW_MS) return false;
  if (now - channelLast < CHANNEL_RATE_LIMIT_WINDOW_MS) return false;

  rateLimitByUser.set(userKey, now);
  rateLimitByChannel.set(channelKey, now);
  return true;
}

function formatMemberContext(member: MemberNode): string {
  const interests = (member.metadata.interests || []).slice(0, 12).join(", ") || "none yet";
  const lastActive = member.metadata.last_active || member.metadata.joined_at || "unknown";
  const recentNotes = member.notes
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  const profileLines: string[] = [];
  profileLines.push(`Name: ${member.title}`);
  if (member.metadata.role) profileLines.push(`Role: ${member.metadata.role}`);
  if (member.metadata.company) profileLines.push(`Company: ${member.metadata.company}`);
  if (member.metadata.location) profileLines.push(`Location: ${member.metadata.location}`);
  profileLines.push(`Interests: ${interests}`);
  if (member.metadata.interaction_preference) {
    profileLines.push(`Interaction preference: ${member.metadata.interaction_preference}`);
  }
  profileLines.push(`Last active: ${lastActive}`);
  profileLines.push(`Recent interactions: ${recentNotes || "none"}`);
  return (
    `[MEMBER CONTEXT]\n` +
    profileLines.join("\n") + "\n" +
    `Use this to personalize your response. Update interaction_preference in <profile> when you learn how they like to interact.`
  );
}

function buildSystemPrompt(options: {
  skillsContext: string;
  memberContext: string;
}): string {
  const identity = [
    "[IDENTITY]",
    "You are Slop — Latent Space community's AI. Opinionated, sharp, concise.",
    "Lead with your take. Challenge lazy thinking. Short sentences hit harder — use them.",
    "Bold your strongest claims. End with a question or challenge when debating.",
    "Never agree just to be agreeable. Never hedge. Never use filler like 'interesting' or 'fascinating'.",
    "You are not an assistant. You are an interlocutor.",
  ].join("\n");

  const rules = [
    "[RULES]",
    "Search the knowledge base BEFORE answering factual questions. Don't guess — look it up.",
    "Always link to sources: [Title](url). Never reference content without a link.",
    "Never fabricate names, dates, episodes, quotes, or links. If tools return nothing, say so.",
    "Mark speculation explicitly: 'No hard data, but...' or 'Extrapolating here...'",
  ].join("\n");

  return [identity, rules, options.skillsContext, options.memberContext]
    .filter(Boolean)
    .join("\n\n");
}

function summarizeUserMessage(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  if (clean.length <= 180) return clean;
  return `${clean.slice(0, 177)}...`;
}


function parseMetadata(raw: unknown): MemberMetadata {
  if (!raw || typeof raw !== "object") {
    return {
      discord_id: "",
      discord_handle: "",
      joined_at: new Date().toISOString(),
      interests: [],
      interaction_count: 0
    };
  }

  const data = raw as Record<string, unknown>;
  return {
    discord_id: String(data.discord_id || ""),
    discord_handle: String(data.discord_handle || ""),
    avatar_url: data.avatar_url ? String(data.avatar_url) : undefined,
    joined_at: String(data.joined_at || new Date().toISOString()),
    last_active: data.last_active ? String(data.last_active) : undefined,
    interaction_count: Number(data.interaction_count || 0),
    interests: Array.isArray(data.interests) ? data.interests.map((x) => String(x)) : [],
    role: data.role ? String(data.role) : undefined,
    company: data.company ? String(data.company) : undefined,
    location: data.location ? String(data.location) : undefined,
    interaction_preference: data.interaction_preference ? String(data.interaction_preference) : undefined
  };
}

async function lookupMember(discordId: string): Promise<MemberNode | null> {
  const row = await dbOps.lookupMemberByDiscordId(db, discordId);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    notes: row.notes || "",
    metadata: parseMetadata(row.metadata)
  };
}

async function createMemberNodeFromUser(
  user: Pick<User, "id" | "username" | "globalName" | "displayAvatarURL">
): Promise<{ id: number }> {
  const now = new Date().toISOString();
  const title = (user.globalName || user.username || "Discord Member").trim();
  return dbOps.createMemberNode(db, {
    title,
    description: `${title} — community member profile in Latent Space Discord.`,
    metadata: {
      discord_id: user.id,
      discord_handle: user.username,
      avatar_url: user.displayAvatarURL({ size: 256, extension: "png" }),
      joined_at: now,
      last_active: now,
      interaction_count: 0,
      interests: []
    }
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /unique|constraint|already exists/i.test(msg);
}

async function ensureMemberDiscordIndex(): Promise<void> {
  try {
    await db.execute({
      sql:
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_member_discord_id_unique " +
        "ON nodes(json_extract(metadata, '$.discord_id')) " +
        "WHERE node_type = 'member' " +
        "AND json_extract(metadata, '$.discord_id') IS NOT NULL " +
        "AND json_extract(metadata, '$.discord_id') != ''",
      args: []
    });
    console.log("Member uniqueness index ready: idx_nodes_member_discord_id_unique");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`Could not create member uniqueness index (continuing): ${msg}`);
  }
}

function parseProfileBlock(response: string): {
  clean: string;
  profile: { role?: string; company?: string; location?: string; interests?: string[]; interaction_preference?: string } | null;
} {
  const match = response.match(/<profile>\s*(\{[\s\S]*?\})\s*<\/profile>/);
  if (!match) return { clean: response, profile: null };
  const clean = response.replace(/<profile>[\s\S]*?<\/profile>/, "").trim();
  try {
    return { clean, profile: JSON.parse(match[1]) };
  } catch {
    return { clean, profile: null };
  }
}

async function updateMemberAfterInteraction(
  member: MemberNode,
  userMessage: string,
  retrievalNodeIds: number[],
  profileUpdate?: { role?: string; company?: string; location?: string; interests?: string[]; interaction_preference?: string } | null,
  avatarUrl?: string
): Promise<void> {
  const nowIso = new Date().toISOString();

  const metadata: MemberMetadata = {
    ...member.metadata,
    avatar_url: avatarUrl || member.metadata.avatar_url,
    last_active: nowIso,
    interaction_count: (member.metadata.interaction_count || 0) + 1
  };

  // Apply profile fields extracted by the main model
  if (profileUpdate) {
    if (profileUpdate.role) metadata.role = profileUpdate.role;
    if (profileUpdate.company) metadata.company = profileUpdate.company;
    if (profileUpdate.location) metadata.location = profileUpdate.location;
    if (profileUpdate.interests?.length) {
      metadata.interests = Array.from(
        new Set([...(member.metadata.interests || []), ...profileUpdate.interests])
      ).slice(0, 25);
    }
    if (profileUpdate.interaction_preference) {
      metadata.interaction_preference = profileUpdate.interaction_preference;
    }
  }

  const line = `[${nowIso.slice(0, 10)}] ${summarizeUserMessage(userMessage)}`;
  await dbOps.updateMemberNode(db, member.id, {
    content: line,
    metadata: metadata as Record<string, unknown>
  });

  const uniqueTargets = Array.from(new Set(retrievalNodeIds.filter((id) => Number.isFinite(id) && id > 0 && id !== member.id))).slice(0, 8);
  await Promise.all(
    uniqueTargets.map(async (targetId) => {
      try {
        await dbOps.createEdge(db,
          member.id,
          targetId,
          "showed interest in this content during a Discord conversation"
        );
      } catch (error) {
        console.warn(`Member edge create failed (${member.id} -> ${targetId}):`, error);
      }
    })
  );
}

function shortModelName(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return "unknown-model";
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

function modelBadge(model: string): string {
  return `🤖 ${shortModelName(model)}`;
}

type SkillMeta = {
  name: string;
  description: string;
};

const REQUIRED_SLOP_SKILLS = [
  "Start Here",
  "Member Profiles",
  "DB Operations",
  "Event Scheduling"
];
const REQUIRED_SLOP_SKILL_SET = new Set(REQUIRED_SLOP_SKILLS.map((name) => normalizeSkillName(name)));
const REQUIRED_SLOP_SKILL_ORDER = new Map(
  REQUIRED_SLOP_SKILLS.map((name, index) => [normalizeSkillName(name), index] as const)
);
const SKILLS_DIR = path.join(__dirname, "..", "skills");

function normalizeSkillName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

let cachedSkillsContext = "";

function validateRequiredSlopSkills(skills: SkillMeta[]): void {
  const slopSet = new Set(skills.map((s) => normalizeSkillName(s.name)));

  const missing = REQUIRED_SLOP_SKILLS.filter((name) => !slopSet.has(normalizeSkillName(name)));
  const extras = [...slopSet].filter((name) => !REQUIRED_SLOP_SKILL_SET.has(name));

  if (missing.length || extras.length) {
    const missingText = missing.length ? ` missing=[${missing.join(", ")}]` : "";
    const extrasText = extras.length ? ` extras=[${extras.join(", ")}]` : "";
    throw new Error(
      `Hub Slop skill set mismatch.${missingText}${extrasText} Expected exactly: ${REQUIRED_SLOP_SKILLS.join(", ")}`
    );
  }
}

function loadSkillIndexFromLocal(): SkillMeta[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    throw new Error(`Skills directory not found: ${SKILLS_DIR}`);
  }
  return fs.readdirSync(SKILLS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = fs.readFileSync(path.join(SKILLS_DIR, f), "utf-8");
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return null;
      const fm: Record<string, string> = {};
      for (const line of fmMatch[1].split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) {
          const key = line.slice(0, idx).trim();
          const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
          fm[key] = val;
        }
      }
      return {
        name: fm.name || f.replace(".md", ""),
        description: fm.description || "",
      };
    })
    .filter((s): s is SkillMeta => s !== null);
}

function loadSkillsContextFromLocalStrict(): string {
  const skills = loadSkillIndexFromLocal();
  validateRequiredSlopSkills(skills);

  const ordered = skills
    .slice()
    .sort((a, b) => {
      const ai = REQUIRED_SLOP_SKILL_ORDER.get(normalizeSkillName(a.name)) ?? Number.MAX_SAFE_INTEGER;
      const bi = REQUIRED_SLOP_SKILL_ORDER.get(normalizeSkillName(b.name)) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });

  const lines = ordered
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join("\n");

  cachedSkillsContext = [
    "[SKILLS] Available skills. Use slop_read_skill(name) for full instructions.",
    lines,
  ].join("\n");
  return cachedSkillsContext;
}

function readLocalSkillStrict(name: string): string {
  const slug = normalizeSkillName(name);
  const filepath = path.join(SKILLS_DIR, `${slug}.md`);
  if (!fs.existsSync(filepath)) {
    throw new Error(`Local skill not found: ${name}`);
  }
  const raw = fs.readFileSync(filepath, "utf-8");
  const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  const content = bodyMatch ? bodyMatch[1].trim() : raw.trim();
  if (!content) throw new Error(`Local skill is empty: ${name}`);
  return content;
}

function getSkillsContextOrThrow(): string {
  if (!cachedSkillsContext) {
    throw new Error("Skills context not loaded. Local skills must be loaded at startup.");
  }
  return cachedSkillsContext;
}

async function ensureDestinationChannel(message: Message, botName: string): Promise<DestinationChannel> {
  if (message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread) {
    return message.channel as unknown as DestinationChannel;
  }

  const seed = message.content.trim().replace(/\s+/g, " ").slice(0, 40) || "discussion";
  try {
    const thread = await (message as Message<true>).startThread({
      name: `${botName}: ${seed}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `${botName} conversation thread`
    });
    return thread as unknown as DestinationChannel;
  } catch {
    return message.channel as unknown as DestinationChannel;
  }
}

function isGreetingOrSmalltalk(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const simple = new Set([
    "hi",
    "hello",
    "hey",
    "yo",
    "sup",
    "how are you",
    "whats up",
    "what's up",
    "gm",
    "good morning",
    "good afternoon",
    "good evening"
  ]);
  return simple.has(normalized);
}

async function generateResponse(
  profile: BotProfile,
  userPrompt: string,
  context: string,
  options?: { requireSources?: boolean; systemPrompt?: string }
): Promise<{ text: string; trace: LlmTrace }> {
  const requireSources = options?.requireSources ?? true;
  const systemContent = options?.systemPrompt || buildSystemPrompt({ skillsContext: "", memberContext: "" });
  const contextNote = requireSources
    ? "Use the supplied context for factual claims. Include a short Sources list with links."
    : "";
  const payload: {
    model: string;
    temperature: number;
    max_tokens: number;
    messages: OpenRouterMessage[];
  } = {
    model: profile.model,
    temperature: 0.6,
    max_tokens: 700,
    messages: [
      {
        role: "system",
        content: contextNote ? `${systemContent}\n\n${contextNote}` : systemContent
      },
      {
        role: "user",
        content: `User message:\n${userPrompt}\n\nContext:\n${context}`
      }
    ]
  };

  const start = Date.now();
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter error (${response.status}): ${body.slice(0, 400)}`);
  }

  const data = (await response.json()) as OpenRouterChatResponse;
  const text = data.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new Error("OpenRouter returned empty response.");
  }

  return {
    text,
    trace: {
      system_prompt: systemContent,
      request_messages: payload.messages,
      request_payload: payload,
      response_id: data.id,
      provider: data.provider ?? null,
      usage: data.usage ?? null,
      estimated_cost_usd: extractEstimatedCostUsd(data.usage),
      latency_ms: Date.now() - start,
      rounds: 1
    }
  };
}

type LlmTrace = {
  system_prompt: string;
  request_messages: OpenRouterMessage[];
  request_payload: Record<string, unknown>;
  response_id?: string;
  provider?: string | null;
  usage?: Record<string, unknown> | null;
  estimated_cost_usd?: number | null;
  latency_ms: number;
  rounds: number;
};

type AgenticResult = { text: string; toolsUsed: string[]; skillsRead: string[]; trace: LlmTrace };

type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
};

type OpenRouterChatResponse = {
  id?: string;
  provider?: string;
  usage?: Record<string, unknown>;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenRouterToolCall[];
      role?: string;
    };
    finish_reason?: string;
  }>;
};

function extractEstimatedCostUsd(usage: Record<string, unknown> | undefined): number | null {
  if (!usage) return null;
  const candidates = [
    usage.total_cost,
    usage.cost,
    usage.estimated_cost,
    usage.usd_cost,
    usage.total_cost_usd
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

const MAX_AGENTIC_ROUNDS = 5;
const MAX_TOOL_RESULT_CHARS = 4000;

async function generateAgenticResponse(
  profile: BotProfile,
  userPrompt: string,
  options?: { systemPrompt?: string }
): Promise<AgenticResult> {
  const systemContent = options?.systemPrompt || buildSystemPrompt({ skillsContext: "", memberContext: "" });
  const tools: OpenAIToolDef[] = TOOL_DEFINITIONS;
  const start = Date.now();

  const messages: OpenRouterMessage[] = [
    {
      role: "system",
      content: systemContent
    },
    { role: "user", content: userPrompt }
  ];

  const toolsUsed: string[] = [];
  const skillsRead = new Set<string>();

  for (let round = 0; round < MAX_AGENTIC_ROUNDS; round++) {
    const payload = {
      model: profile.model,
      temperature: 0.6,
      max_tokens: 1200,
      messages,
      tools
    };

    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenRouter error (${response.status}): ${body.slice(0, 400)}`);
    }

    const data = (await response.json()) as OpenRouterChatResponse;

    const choice = data.choices?.[0];
    const assistantMsg = choice?.message;
    if (!assistantMsg) throw new Error("OpenRouter returned empty response.");

    // Append the assistant message to conversation
    const aMsg: OpenRouterMessage = { role: "assistant" };
    if (assistantMsg.content) aMsg.content = assistantMsg.content;
    if (assistantMsg.tool_calls?.length) aMsg.tool_calls = assistantMsg.tool_calls;
    messages.push(aMsg);

    // If no tool calls, we have our final text response
    if (!assistantMsg.tool_calls?.length) {
      const text = (assistantMsg.content || "").trim();
      if (!text) throw new Error("OpenRouter returned empty response after tool loop.");
      return {
        text,
        toolsUsed,
        skillsRead: [...skillsRead],
        trace: {
          system_prompt: systemContent,
          request_messages: payload.messages,
          request_payload: {
            ...payload,
            tools: tools.map((t) => t.function.name)
          },
          response_id: data.id,
          provider: data.provider ?? null,
          usage: data.usage ?? null,
          estimated_cost_usd: extractEstimatedCostUsd(data.usage),
          latency_ms: Date.now() - start,
          rounds: round + 1
        }
      };
    }

    // Execute each tool call
    for (const tc of assistantMsg.tool_calls) {
      const toolName = tc.function.name;
      toolsUsed.push(toolName);
      let resultText: string;
      try {
        const args = JSON.parse(tc.function.arguments || "{}");

        const toolStart = Date.now();
        if (toolName === "slop_read_skill" && typeof args.name === "string") {
          skillsRead.add(args.name);
          resultText = readLocalSkillStrict(args.name);
        } else if (TOOL_HANDLERS[toolName]) {
          resultText = await TOOL_HANDLERS[toolName].execute(args, db);
        } else {
          resultText = `Error: Unknown tool "${toolName}"`;
        }
        recordTrace({ tool: toolName, args, result: resultText.length > 500 ? { length: resultText.length } : resultText, duration_ms: Date.now() - toolStart });
        if (resultText.length > MAX_TOOL_RESULT_CHARS) {
          resultText = resultText.slice(0, MAX_TOOL_RESULT_CHARS) + "\n...[truncated]";
        }
      } catch (error) {
        resultText = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: resultText
      });
    }
  }

  // Exhausted rounds — force a text response without tools
  messages.push({
    role: "user",
    content: "Please provide your final answer now based on the information gathered."
  });

  const finalPayload = {
    model: profile.model,
    temperature: 0.6,
    max_tokens: 1200,
    messages
  };

  const finalResponse = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(finalPayload)
  });

  if (!finalResponse.ok) {
    const body = await finalResponse.text();
    throw new Error(`OpenRouter error (${finalResponse.status}): ${body.slice(0, 400)}`);
  }

  const finalData = (await finalResponse.json()) as {
    id?: string;
    provider?: string;
    usage?: Record<string, unknown>;
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = finalData.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter returned empty response on final round.");
  return {
    text,
    toolsUsed,
    skillsRead: [...skillsRead],
    trace: {
      system_prompt: systemContent,
      request_messages: finalPayload.messages,
      request_payload: finalPayload,
      response_id: finalData.id,
      provider: finalData.provider ?? null,
      usage: finalData.usage ?? null,
      estimated_cost_usd: extractEstimatedCostUsd(finalData.usage),
      latency_ms: Date.now() - start,
      rounds: MAX_AGENTIC_ROUNDS + 1
    }
  };
}

function agenticToolsFooter(toolsUsed: string[]): string {
  if (!toolsUsed.length) return "🛠️ none";
  const counts = new Map<string, number>();
  for (const name of toolsUsed) {
    const short = name.replace(/^ls_/, "");
    counts.set(short, (counts.get(short) || 0) + 1);
  }
  const parts: string[] = [];
  for (const [name, count] of counts) {
    parts.push(count > 1 ? `${name}(x${count})` : name);
  }
  return `🛠️ ${parts.join(" | ")}`;
}

type TraceOptions = {
  retrieval_method: string;
  context_node_ids: number[];
  member_id: number | null;
  is_slash_command: boolean;
  slash_command: string | null;
  is_kickoff: boolean;
  latency_ms: number;
  interaction_kind?: string;
  tools_used?: string[];
  skills_used?: string[];
  llm_trace?: LlmTrace | null;
};

function inferInteractionKind(options: TraceOptions): string {
  if (options.interaction_kind) return options.interaction_kind;
  if (options.is_kickoff) return "Kickoff post from newly ingested content";
  if (options.is_slash_command) {
    if (options.slash_command === "join") return "Slash command: member onboarding";
    if (options.slash_command === "paper-club") return "Slash command: schedule paper club event";
    if (options.slash_command === "builders-club") return "Slash command: schedule builders club event";
    return "Slash command interaction";
  }
  if (options.retrieval_method === "smalltalk") return "Thread chat / small talk";
  if (options.retrieval_method === "agentic") return "Thread user request answered with agentic retrieval";
  if (options.retrieval_method === "event_create") return "Event scheduling workflow";
  return "Discord interaction";
}

async function logTrace(
  profile: BotProfile,
  source: { userId: string; username: string; channelId: string; messageId: string },
  prompt: string,
  response: string,
  options: TraceOptions
): Promise<void> {
  try {
    const toolCalls: ToolTrace[] = clearTraces();
    const metadata = {
      interaction_kind: inferInteractionKind(options),
      discord_user_id: source.userId,
      discord_username: source.username,
      discord_channel_id: source.channelId,
      discord_message_id: source.messageId,
      retrieval_method: options.retrieval_method,
      context_node_ids: options.context_node_ids,
      tools_used: options.tools_used || toolCalls.map((t) => t.tool),
      skills_used: options.skills_used || [],
      tool_calls: toolCalls,
      member_id: options.member_id,
      model: profile.model,
      is_slash_command: options.is_slash_command,
      slash_command: options.slash_command,
      is_kickoff: options.is_kickoff,
      response_length: response.length,
      latency_ms: options.latency_ms,
      system_message: options.llm_trace?.system_prompt || null,
      llm_messages: options.llm_trace?.request_messages || null,
      llm_request_payload: options.llm_trace?.request_payload || null,
      openrouter_response_id: options.llm_trace?.response_id || null,
      openrouter_provider: options.llm_trace?.provider || null,
      openrouter_usage: options.llm_trace?.usage || null,
      estimated_cost_usd: options.llm_trace?.estimated_cost_usd ?? null
    };

    await db.execute({
      sql: "INSERT INTO chats (chat_type, user_message, assistant_message, thread_id, helper_name, agent_type, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        "discord",
        prompt,
        response.slice(0, 8000),
        source.channelId,
        profile.name.toLowerCase(),
        "discord-bot",
        JSON.stringify(metadata),
        new Date().toISOString()
      ]
    });
  } catch (error) {
    console.warn("Trace logging failed:", error instanceof Error ? error.message : String(error));
  }
}

function splitForDiscord(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  const limit = 1800;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < 400) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

function getProfileByName(name: BotProfile["name"]): BotProfile {
  const profile = profiles.find((p) => p.name === name);
  if (!profile) throw new Error(`Profile not found: ${name}`);
  return profile;
}

function getReadyClient(name: BotProfile["name"]): Client {
  const client = clientsByProfile.get(name);
  if (!client || !client.isReady()) {
    throw new Error(`${name} client is not ready.`);
  }
  return client;
}

function buildKickoffQuery(payload: KickoffPayload): string {
  const candidate =
    payload.prompt ||
    [payload.title, payload.contentType, payload.summary, payload.eventDate]
      .filter((v) => typeof v === "string" && v.trim().length > 0)
      .join(" | ");
  return candidate?.trim() || "Summarize the most recent Latent Space content and why it matters.";
}

async function resolveKickoffDestination(client: Client, payload: KickoffPayload): Promise<DestinationChannel> {
  const channelId = (payload.channelId || BOT_TALK_CHANNEL_ID || "").trim();
  if (!channelId) {
    throw new Error("No kickoff channel configured. Set BOT_TALK_CHANNEL_ID or include channelId in request.");
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Channel ${channelId} is not text-based or is inaccessible.`);
  }

  if (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread) {
    return channel as unknown as DestinationChannel;
  }

  const seedParts = [
    "New content ingested.",
    payload.title ? `Title: ${payload.title}` : "",
    payload.contentType ? `Type: ${payload.contentType}` : "",
    payload.eventDate ? `Date: ${payload.eventDate}` : "",
    payload.url ? `Source: ${payload.url}` : ""
  ].filter(Boolean);

  const baseChannel = channel as GuildTextBasedChannel;
  const kickoffMessage = await baseChannel.send(seedParts.join("\n"));
  const threadTitleSeed = (payload.title || payload.contentType || "new-content")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);

  try {
    const thread = await kickoffMessage.startThread({
      name: `Slop: ${threadTitleSeed || "new-content"}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: "Kickoff for newly ingested content"
    });
    return thread as unknown as DestinationChannel;
  } catch {
    return baseChannel as unknown as DestinationChannel;
  }
}

async function runDeterministicKickoff(payload: KickoffPayload): Promise<{ ok: true }> {
  const slopProfile = getProfileByName("Slop");
  const slopClient = getReadyClient("Slop");

  const destination = await resolveKickoffDestination(slopClient, payload);
  const kickoffKey = `kickoff:${payload.channelId || BOT_TALK_CHANNEL_ID || "unknown"}`;

  if (activeDebates.has(kickoffKey)) {
    throw new Error("A kickoff is already running for this channel.");
  }

  activeDebates.add(kickoffKey);
  const startTime = Date.now();
  const channelId = payload.channelId || BOT_TALK_CHANNEL_ID || "unknown";
  try {
    const slopPrompt = [
      "New content just dropped in Latent Space. Break it down.",
      `Context query: ${buildKickoffQuery(payload)}`,
      payload.title ? `Title: ${payload.title}` : "",
      payload.contentType ? `Type: ${payload.contentType}` : "",
      payload.eventDate ? `Date: ${payload.eventDate}` : "",
      payload.url ? `URL: ${payload.url}` : "",
      "Search the knowledge base for this content, summarize what's new, why it matters, and give your take. Cite sources."
    ]
      .filter(Boolean)
      .join("\n");

    const { text: output, toolsUsed, skillsRead, trace } = await generateAgenticResponse(slopProfile, slopPrompt);
    await destination.send(`${modelBadge(slopProfile.model)}\n${output}`);
    await destination.send(agenticToolsFooter(toolsUsed));

    const nodeIds = toolTraces
      .filter((t) => t.tool === "slop_get_nodes" || t.tool === "slop_search_nodes")
      .flatMap((t) => {
        const r = t.result as Record<string, unknown> | null;
        if (r && Array.isArray((r as { nodes?: unknown[] }).nodes)) return ((r as { nodes: Array<Record<string, unknown>> }).nodes).map((n) => Number(n.id)).filter(Number.isFinite);
        return [];
      });
    await logTrace(slopProfile, { userId: "system", username: "kickoff", channelId, messageId: "" }, slopPrompt, output, {
      retrieval_method: "agentic",
      context_node_ids: nodeIds,
      member_id: null,
      is_slash_command: false,
      slash_command: null,
      is_kickoff: true,
      latency_ms: Date.now() - startTime,
      tools_used: toolsUsed,
      skills_used: skillsRead,
      llm_trace: trace
    });
  } finally {
    activeDebates.delete(kickoffKey);
  }

  return { ok: true };
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    chunks.push(part);
    totalBytes += part.length;
    if (totalBytes > 1_000_000) {
      throw new Error("Request body too large.");
    }
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function startKickoffServer(): void {
  if (!DEBATE_KICKOFF_SECRET) {
    console.warn("DEBATE_KICKOFF_SECRET not set; deterministic kickoff API disabled.");
    return;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        writeJson(res, 200, { ok: true, service: "latent-space-bots", kickoff: "enabled" });
        return;
      }

      if (req.method !== "POST" || req.url !== "/internal/kickoff") {
        writeJson(res, 404, { ok: false, error: "Not found" });
        return;
      }

      const authHeader = String(req.headers.authorization || "");
      if (authHeader !== `Bearer ${DEBATE_KICKOFF_SECRET}`) {
        writeJson(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      const body = (await readJsonBody(req)) as KickoffPayload;
      const kickoffPayload = body || {};
      const kickoffId = `${Date.now()}`;

      // Return quickly so upstream ingestion hooks don't timeout while debate generation runs.
      writeJson(res, 202, { ok: true, accepted: true, kickoffId });

      queueMicrotask(async () => {
        try {
          const result = await runDeterministicKickoff(kickoffPayload);
          console.log(`[kickoff:${kickoffId}] completed`, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[kickoff:${kickoffId}] failed: ${message}`);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(res, 500, { ok: false, error: message });
    }
  });

  server.listen(DEBATE_KICKOFF_PORT, DEBATE_KICKOFF_HOST, () => {
    console.log(
      `Deterministic kickoff API listening on http://${DEBATE_KICKOFF_HOST}:${DEBATE_KICKOFF_PORT}/internal/kickoff`
    );
  });
}

async function handleSchedulingReply(profile: BotProfile, message: Message, session: SchedulingSession): Promise<void> {
  const text = message.content.trim();
  const isPaperClub = session.eventType === "paper-club";
  const label = isPaperClub ? "Paper Club" : "Builders Club";

  if (session.step === "pick_date") {
    // Parse: expect a number (1-4) optionally followed by title/topic text
    const match = text.match(/^(\d)\s*(.*)/s);
    if (!match) {
      await message.reply(`Reply with a number (1-${session.availableDates.length}) to pick a date.`);
      return;
    }

    const pick = parseInt(match[1], 10);
    if (pick < 1 || pick > session.availableDates.length) {
      await message.reply(`Pick a number between 1 and ${session.availableDates.length}.`);
      return;
    }

    const chosenDate = session.availableDates[pick - 1];
    const titleText = match[2]?.trim();

    // If they included the title/topic in the same message, create the event immediately
    if (titleText) {
      await createScheduledEvent(profile, message, session, chosenDate, titleText);
      return;
    }

    // Otherwise, ask for title/topic
    session.chosenDate = chosenDate;
    session.step = "pick_title";
    const dateLabel = new Date(chosenDate + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    const ask = isPaperClub
      ? `Got it — **${dateLabel}**. What paper are you presenting? (title, and optionally a URL)`
      : `Got it — **${dateLabel}**. What's your topic?`;
    await message.reply(ask);
    return;
  }

  if (session.step === "pick_title") {
    if (!text) {
      const ask = isPaperClub ? "What paper are you presenting?" : "What's your topic?";
      await message.reply(ask);
      return;
    }
    await createScheduledEvent(profile, message, session, session.chosenDate!, text);
    return;
  }
}

async function createScheduledEvent(
  profile: BotProfile,
  message: Message,
  session: SchedulingSession,
  dateStr: string,
  titleText: string
): Promise<void> {
  const isPaperClub = session.eventType === "paper-club";
  const label = isPaperClub ? "Paper Club" : "Builders Club";

  try {
    // For paper club, try to extract a URL from the text
    let paperUrl: string | undefined;
    let cleanTitle = titleText;
    if (isPaperClub) {
      const urlMatch = titleText.match(/(https?:\/\/\S+)/);
      if (urlMatch) {
        paperUrl = urlMatch[1];
        cleanTitle = titleText.replace(urlMatch[0], "").trim();
      }
    }

    const title = `${label}: ${cleanTitle}`;
    const eventPayload: Parameters<typeof dbOps.createEventNode>[1] = isPaperClub
      ? {
          title,
          description: `Hosted by ${session.memberUsername}. ${cleanTitle}`,
          event_date: dateStr,
          event_type: "paper-club",
          presenter_name: session.memberUsername,
          presenter_discord_id: session.memberDiscordId,
          presenter_node_id: session.memberId,
          paper_title: cleanTitle,
          paper_url: paperUrl,
        }
      : {
          title,
          description: `Hosted by ${session.memberUsername}. ${cleanTitle}`,
          event_date: dateStr,
          event_type: "builders-club",
          presenter_name: session.memberUsername,
          presenter_discord_id: session.memberDiscordId,
          presenter_node_id: session.memberId,
          topic: cleanTitle,
        };

    const eventNode = await dbOps.createEventNode(db, eventPayload);
    await dbOps.createEdge(db, session.memberId, eventNode.id, `hosting ${label} session`);

    const dateLabel = new Date(dateStr + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    const reply = `**${label} scheduled!**\n📅 ${dateLabel}\n📝 ${cleanTitle}\n🎤 ${session.memberUsername}`;
    await message.reply(reply);

    // Clean up session
    schedulingSessions.delete(message.channelId);

    // Log trace
    const traceSource = { userId: session.memberDiscordId, username: session.memberUsername, channelId: message.channelId, messageId: message.id };
    await logTrace(profile, traceSource, `/${session.eventType}`, reply, {
      retrieval_method: "event_create", context_node_ids: [eventNode.id], member_id: session.memberId,
      is_slash_command: true, slash_command: session.eventType, is_kickoff: false, latency_ms: 0
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await message.reply(`Couldn't create the event: ${msg}`);
    schedulingSessions.delete(message.channelId);
  }
}

async function handleMessage(client: Client, profile: BotProfile, message: Message): Promise<void> {
  if (message.webhookId) {
    console.log(
      `[${profile.name}] webhook message received channel=${message.channelId} id=${message.id} mentionsBot=${Boolean(
        client.user?.id && (message.mentions.users.has(client.user.id) || new RegExp(`<@!?${client.user.id}>`).test(message.content))
      )}`
    );
  }

  const dedupeKey = `${profile.name}:${message.id}`;
  if (processedMessageIds.has(dedupeKey)) return;
  const botUserId = client.user?.id;
  if (!botUserId) return;
  if (message.author.bot && !message.webhookId) return;

  // Intercept scheduling thread replies BEFORE the general shouldRespond gate.
  // Scheduling threads are named "Paper Club: ..." not "Slop: ...", so
  // shouldRespondToMessage would reject them.
  const schedulingSession = schedulingSessions.get(message.channelId);
  if (schedulingSession && message.author.id === schedulingSession.memberDiscordId) {
    if (processedMessageIds.has(dedupeKey)) return;
    processedMessageIds.add(dedupeKey);
    await handleSchedulingReply(profile, message, schedulingSession);
    return;
  }

  if (!isAllowedChannel(message) || !shouldRespondToMessage(message, botUserId, profile.name)) {
    return;
  }
  const owner = getThreadOwnerBotName(message);
  const ownedThread = owner === profile.name;
  if (!withinRateLimit(message, profile.name, { ownedThread })) return;
  processedMessageIds.add(dedupeKey);

  clearTraces();
  const startTime = Date.now();
  const traceSource = { userId: message.author.id, username: message.author.username, channelId: message.channelId, messageId: message.id };

  const prompt = cleanUserPrompt(message, botUserId);
  const destination = await ensureDestinationChannel(message, profile.name);
  await destination.sendTyping();
  const skillsContext = getSkillsContextOrThrow();
  const member = await lookupMember(message.author.id);
  const memberContext = member
    ? formatMemberContext(member)
    : "[MEMBER STATUS] This user is not in the member graph yet. Casually mention `/join` when it naturally fits.";
  const systemPrompt = buildSystemPrompt({ skillsContext, memberContext });

  const smalltalk = isGreetingOrSmalltalk(prompt);

  if (smalltalk) {
    try {
      const { text: rawOutput, trace } = await generateResponse(profile, prompt, "No graph retrieval needed for greeting/smalltalk.", {
        requireSources: false,
        systemPrompt
      });
      const { clean: output, profile: profileUpdate } = parseProfileBlock(rawOutput);
      await destination.send(modelBadge(profile.model));
      const parts = splitForDiscord(output);
      for (const part of parts) {
        await destination.send(part);
      }
      await destination.send(agenticToolsFooter([]));
      await logTrace(profile, traceSource, prompt, output, {
        retrieval_method: "smalltalk",
        context_node_ids: [],
        member_id: member?.id || null,
        is_slash_command: false,
        slash_command: null,
        is_kickoff: false,
        latency_ms: Date.now() - startTime,
        tools_used: [],
        skills_used: [],
        llm_trace: trace
      });
      if (member && profileUpdate) {
        queueMicrotask(async () => {
          try {
            await updateMemberAfterInteraction(member, prompt, [], profileUpdate, message.author.displayAvatarURL({ size: 256, extension: "png" }));
          } catch (error) {
            console.warn("Member update failed (non-blocking):", error);
          }
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await destination.send(`${profile.name} hit an error while generating a response: ${msg}`);
    }
    return;
  }

  // Agentic path — LLM decides what to search
  try {
    const { text: rawOutput, toolsUsed, skillsRead, trace } = await generateAgenticResponse(profile, prompt, { systemPrompt });
    const { clean: output, profile: profileUpdate } = parseProfileBlock(rawOutput);
    // Extract node IDs from tool call traces for member edge creation
    const nodeIds = toolTraces
      .filter((t) => t.tool === "slop_get_nodes" || t.tool === "slop_search_nodes")
      .flatMap((t) => {
        const r = t.result as Record<string, unknown> | null;
        if (!r) return [];
        if (Array.isArray(r)) return r.map((n: Record<string, unknown>) => Number(n.id)).filter(Number.isFinite);
        if (typeof r === "object" && "nodes_count" in r) return [];
        return [];
      });
    await destination.send(modelBadge(profile.model));
    const parts = splitForDiscord(output);
    for (const part of parts) {
      await destination.send(part);
    }
    await destination.send(agenticToolsFooter(toolsUsed));
    await logTrace(profile, traceSource, prompt, output, {
      retrieval_method: "agentic",
      context_node_ids: nodeIds,
      member_id: member?.id || null,
      is_slash_command: false,
      slash_command: null,
      is_kickoff: false,
      latency_ms: Date.now() - startTime,
      tools_used: toolsUsed,
      skills_used: skillsRead,
      llm_trace: trace
    });
    if (member) {
      queueMicrotask(async () => {
        try {
          await updateMemberAfterInteraction(
            member,
            prompt,
            nodeIds,
            profileUpdate,
            message.author.displayAvatarURL({ size: 256, extension: "png" })
          );
        } catch (error) {
          console.warn("Member update failed (non-blocking):", error);
        }
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await destination.send(`${profile.name} hit an error while generating a response: ${msg}`);
  }
}

async function handleInteraction(client: Client, profile: BotProfile, interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return;
  if (interaction.user.bot) return;
  if (ALLOWED_CHANNEL_IDS.size && !ALLOWED_CHANNEL_IDS.has(interaction.channelId || "")) {
    return;
  }

  clearTraces();
  const startTime = Date.now();
  const traceSource = { userId: interaction.user.id, username: interaction.user.username, channelId: interaction.channelId || "", messageId: interaction.id };
  const command = interaction.commandName as "join" | "paper-club" | "builders-club";
  await interaction.deferReply();

  if (command === "join") {
    if (joinInFlight.has(interaction.user.id)) {
      await interaction.editReply("Already processing your `/join` request. Try again in a few seconds.");
      return;
    }
    joinInFlight.add(interaction.user.id);
    try {
      const existing = await lookupMember(interaction.user.id);
      if (existing) {
        const refreshedMetadata: MemberMetadata = {
          ...existing.metadata,
          discord_id: interaction.user.id,
          discord_handle: interaction.user.username,
          avatar_url: interaction.user.displayAvatarURL({ size: 256, extension: "png" }),
          last_active: new Date().toISOString()
        };
        await dbOps.updateMemberNode(db, existing.id, {
          metadata: refreshedMetadata as Record<string, unknown>
        });
        const reply = `You're already in the graph. I've been tracking your interests since ${existing.metadata.joined_at}.`;
        await interaction.editReply(reply);
        await logTrace(profile, traceSource, "/join", reply, {
          retrieval_method: "member_lookup", context_node_ids: [], member_id: existing.id,
          is_slash_command: true, slash_command: "join", is_kickoff: false, latency_ms: Date.now() - startTime
        });
        return;
      }

      try {
        const newMember = await createMemberNodeFromUser(interaction.user);
        const reply = "You're in the graph. As we chat, I'll learn what you're into and connect you to relevant content.";
        await interaction.editReply(reply);
        await logTrace(profile, traceSource, "/join", reply, {
          retrieval_method: "member_create", context_node_ids: [], member_id: newMember.id,
          is_slash_command: true, slash_command: "join", is_kickoff: false, latency_ms: Date.now() - startTime
        });
      } catch (createError) {
        // Handle join races gracefully: if another concurrent request created the member,
        // treat this as already joined.
        const raced = await lookupMember(interaction.user.id);
        if (raced && isUniqueConstraintError(createError)) {
          const refreshedMetadata: MemberMetadata = {
            ...raced.metadata,
            discord_id: interaction.user.id,
            discord_handle: interaction.user.username,
            avatar_url: interaction.user.displayAvatarURL({ size: 256, extension: "png" }),
            last_active: new Date().toISOString()
          };
          await dbOps.updateMemberNode(db, raced.id, {
            metadata: refreshedMetadata as Record<string, unknown>
          });
          const reply = `You're already in the graph. I've been tracking your interests since ${raced.metadata.joined_at}.`;
          await interaction.editReply(reply);
          await logTrace(profile, traceSource, "/join", reply, {
            retrieval_method: "member_lookup", context_node_ids: [], member_id: raced.id,
            is_slash_command: true, slash_command: "join", is_kickoff: false, latency_ms: Date.now() - startTime
          });
          return;
        }
        throw createError;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`Couldn't add you to the graph right now: ${msg}`);
    } finally {
      joinInFlight.delete(interaction.user.id);
    }
    return;
  }

  if (command === "paper-club" || command === "builders-club") {
    try {
      const member = await lookupMember(interaction.user.id);
      if (!member) {
        await interaction.editReply("You need to `/join` the graph first before scheduling events.");
        return;
      }

      const isPaperClub = command === "paper-club";
      const label = isPaperClub ? "Paper Club" : "Builders Club";
      const targetDay = isPaperClub ? 3 : 5; // Wednesday or Friday
      const nextDates = getNextDatesForDay(targetDay, 6);

      // Check which dates are already booked
      const booked = await dbOps.getBookedDates(db, command, nextDates);
      const available = nextDates.filter((d) => !booked.has(d)).slice(0, 4);

      if (!available.length) {
        await interaction.editReply(`All upcoming ${label} slots are booked! Try again later.`);
        return;
      }

      const dayLabel = isPaperClub ? "Wed" : "Fri";
      const lines = available.map((d, i) => {
        const date = new Date(d + "T12:00:00Z");
        const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
        const day = date.getUTCDate();
        return `**${i + 1}.** ${dayLabel} ${month} ${day} (${d})`;
      });

      const prompt = isPaperClub
        ? "Reply with the **number** of the date you want, and the **paper title** (and optionally a URL)."
        : "Reply with the **number** of the date you want, and your **topic**.";

      const reply = `**Schedule a ${label} session**\n\nAvailable dates:\n${lines.join("\n")}\n\n${prompt}`;

      const message = await interaction.editReply(reply);

      // Create a thread from the reply for the scheduling conversation
      let threadId: string;
      try {
        const channel = interaction.channel;
        if (channel && "threads" in channel && channel.threads) {
          const thread = await channel.threads.create({
            name: `${label}: ${interaction.user.username} scheduling`,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
            startMessage: message.id,
            reason: `${label} scheduling thread`,
          });
          threadId = thread.id;
        } else {
          threadId = interaction.channelId || "";
        }
      } catch {
        threadId = interaction.channelId || "";
      }

      schedulingSessions.set(threadId, {
        eventType: command as "paper-club" | "builders-club",
        memberId: member.id,
        memberDiscordId: interaction.user.id,
        memberUsername: interaction.user.username,
        availableDates: available,
        step: "pick_date",
      });

      // Auto-expire session after 10 minutes
      setTimeout(() => schedulingSessions.delete(threadId), 10 * 60 * 1000);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`Couldn't start scheduling: ${msg}`);
    }
    return;
  }
}

async function registerSlashCommands(profile: BotProfile): Promise<void> {
  if (!profile.appId) {
    console.log(`${profile.name}: BOT_APP_ID not provided; skipping slash command registration.`);
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("Add yourself to the Latent Space knowledge graph"),
    new SlashCommandBuilder()
      .setName("paper-club")
      .setDescription("Schedule a Paper Club session — pick a date and paper"),
    new SlashCommandBuilder()
      .setName("builders-club")
      .setDescription("Schedule a Builders Club session — pick a date and topic"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(profile.token);
  if (DISCORD_TEST_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(profile.appId, DISCORD_TEST_GUILD_ID), { body: commands });
    console.log(`${profile.name}: guild slash commands registered.`);
  } else {
    await rest.put(Routes.applicationCommands(profile.appId), { body: commands });
    console.log(`${profile.name}: global slash commands registered.`);
  }
}

async function startBot(profile: BotProfile): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });
  clientsByProfile.set(profile.name, client);

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`${profile.name} ready as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    await handleInteraction(client, profile, interaction);
  });

  client.on(Events.MessageCreate, async (message) => {
    await handleMessage(client, profile, message);
  });

  await registerSlashCommands(profile);
  await client.login(profile.token);
}

async function main(): Promise<void> {
  console.log("Starting Latent Space bots...");

  if (!profiles.length) {
    console.error("No bot profiles configured (all tokens missing). Exiting.");
    process.exit(1);
  }

  console.log(`Active bots: ${profiles.map((p) => p.name).join(", ")}`);

  if (ALLOWED_CHANNEL_IDS.size) {
    console.log(`Allowed channels: ${[...ALLOWED_CHANNEL_IDS].join(", ")}`);
  } else {
    console.warn("ALLOWED_CHANNEL_IDS not set. Bots will respond in any channel they can read.");
  }
  await ensureMemberDiscordIndex();
  console.log(`Local tools loaded: ${TOOL_DEFINITIONS.length} read-only tools available for LLM`);
  const skillsCtx = loadSkillsContextFromLocalStrict();
  console.log(`Skills loaded: ${skillsCtx.length} chars`);
  await Promise.all(profiles.map((profile) => startBot(profile)));
  startKickoffServer();
}

main().catch((error) => {
  console.error("Fatal bot startup error:", error);
  process.exit(1);
});
