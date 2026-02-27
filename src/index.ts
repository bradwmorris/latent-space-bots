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
  type Message
} from "discord.js";
import { McpGraphClient, type ToolTrace } from "./mcpGraphClient";

type BotProfile = {
  name: "Slop";
  token: string;
  model: string;
  systemPrompt: string;
  appId?: string;
};

type BotProfileSeed = {
  name: "Slop";
  token: string;
  model: string;
  soulFile: string;
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

type ContentNodeType = "podcast" | "article" | "ainews" | "builders-club" | "paper-club" | "workshop";
type RetrievalIntent = {
  wantsLatest: boolean;
  requestedType?: ContentNodeType;
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_CONTEXT_ROWS = 6;
const processedMessageIds = new Set<string>();
const rateLimitByUser = new Map<string, number>();
const rateLimitByChannel = new Map<string, number>();
const activeDebates = new Set<string>();

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
const mcpGraph = new McpGraphClient();
let cachedGuideSnippet = "";

type MemberMetadata = {
  discord_id: string;
  discord_handle: string;
  joined_at: string;
  last_active?: string;
  interaction_count?: number;
  interests?: string[];
  role?: string;
  company?: string;
  location?: string;
};

type MemberNode = {
  id: number;
  title: string;
  notes: string;
  metadata: MemberMetadata;
};

const profileSeeds: BotProfileSeed[] = [
  {
    name: "Slop",
    token: requiredEnv("BOT_TOKEN_SLOP"),
    model: SLOP_MODEL,
    appId: process.env.BOT_APP_ID_SLOP,
    soulFile: "slop.soul.md"
  }
];

function readSoulDocument(filename: string): string {
  const soulPath = path.join(process.cwd(), "personas", filename);
  if (!fs.existsSync(soulPath)) {
    throw new Error(`Missing SOUL file: ${soulPath}`);
  }
  const text = fs.readFileSync(soulPath, "utf8").trim();
  if (!text) {
    throw new Error(`SOUL file is empty: ${soulPath}`);
  }
  return text;
}

function buildProfiles(): BotProfile[] {
  return profileSeeds.map((seed) => ({
    name: seed.name,
    token: seed.token,
    model: seed.model,
    appId: seed.appId,
    systemPrompt: readSoulDocument(seed.soulFile)
  }));
}

const profiles = buildProfiles();

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

function isProfileUpdateThread(message: Message): boolean {
  if (
    message.channel.type !== ChannelType.PublicThread &&
    message.channel.type !== ChannelType.PrivateThread
  ) {
    return false;
  }
  const threadName = (message.channel.name || "").trim().toLowerCase();
  return threadName === "slop: profile update";
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

function parseCommand(content: string): { command: "tldr" | "wassup"; query: string } | null {
  const trimmed = content.trim();
  // /wassup can be used with no arguments
  const wassupMatch = trimmed.match(/^\/wassup\s*$/i);
  if (wassupMatch) return { command: "wassup", query: "" };
  // /tldr requires a query, /wassup can optionally have one too
  const regex = /^\/(tldr|wassup)\s+([\s\S]+)$/i;
  const match = trimmed.match(regex);
  if (!match) return null;
  return {
    command: match[1].toLowerCase() as "tldr" | "wassup",
    query: match[2].trim()
  };
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
  const interests = (member.metadata.interests || []).slice(0, 8).join(", ") || "none yet";
  const lastActive = member.metadata.last_active || member.metadata.joined_at || "unknown";
  const recentNotes = member.notes
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  return (
    `[MEMBER CONTEXT]\n` +
    `Name: ${member.title}\n` +
    `Interests: ${interests}\n` +
    `Last active: ${lastActive}\n` +
    `Recent interactions: ${recentNotes || "none"}\n` +
    `Use this to personalize your response naturally.`
  );
}

function summarizeUserMessage(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  if (clean.length <= 180) return clean;
  return `${clean.slice(0, 177)}...`;
}

function extractInterestKeywords(message: string): string[] {
  const stopwords = new Set([
    // articles, prepositions, conjunctions
    "the", "and", "for", "that", "with", "this", "from", "what", "about",
    "into", "just", "like", "also", "more", "most", "very", "really", "please",
    "there", "their", "then", "than", "when", "where", "which", "some", "such",
    "over", "under", "after", "before", "between", "through", "during", "without",
    "within", "along", "among", "around", "above", "below", "behind", "beyond",
    // pronouns
    "you", "your", "yours", "they", "them", "their", "theirs",
    "she", "her", "hers", "him", "his", "its", "our", "ours",
    "who", "whom", "whose", "myself", "yourself", "itself",
    // common verbs (non-technical)
    "have", "has", "had", "will", "would", "could", "should", "might",
    "can", "may", "shall", "must", "need", "want", "know", "think",
    "see", "look", "find", "get", "got", "give", "take", "make", "made",
    "say", "said", "tell", "told", "ask", "asked", "let", "put", "try",
    "come", "came", "going", "went", "been", "being", "does", "did",
    "doing", "done", "was", "were", "are", "isn", "aren", "don", "didn",
    "won", "wouldn", "couldn", "shouldn", "hasn", "haven", "wasn", "weren",
    "keep", "kept", "set", "run", "show", "shown", "call", "called",
    "help", "use", "used", "using", "work", "working", "start", "stop",
    // conversational fillers
    "hey", "hello", "thanks", "thank", "sorry", "yeah", "yep", "nope",
    "okay", "sure", "right", "well", "hmm", "umm", "actually", "basically",
    "literally", "maybe", "probably", "definitely", "obviously", "apparently",
    "pretty", "quite", "still", "already", "anyway", "though", "although",
    // question / request words
    "how", "why", "any", "all", "each", "every", "both", "few", "many",
    "much", "own", "other", "another", "same", "different", "new", "old",
    "first", "last", "next", "only", "even", "ever", "never", "always",
    // bot-interaction noise
    "bot", "slop", "check", "update", "record", "information", "access",
    "search", "graph", "tool", "tools", "latest", "recent", "now",
    "thing", "things", "stuff", "something", "anything", "nothing",
    "way", "ways", "lot", "lots", "bit", "kind", "type", "part",
    "able", "seem", "seems", "feel", "feels", "looking", "interested"
  ]);
  const matches = message.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  const filtered = matches.filter((token) => !stopwords.has(token) && token.length > 3);
  return Array.from(new Set(filtered)).slice(0, 10);
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
    joined_at: String(data.joined_at || new Date().toISOString()),
    last_active: data.last_active ? String(data.last_active) : undefined,
    interaction_count: Number(data.interaction_count || 0),
    interests: Array.isArray(data.interests) ? data.interests.map((x) => String(x)) : []
  };
}

async function lookupMember(discordId: string): Promise<MemberNode | null> {
  const row = await mcpGraph.lookupMemberByDiscordId(discordId);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    notes: row.notes || "",
    metadata: parseMetadata(row.metadata)
  };
}

async function createMemberNodeFromUser(user: { id: string; username: string; globalName?: string | null }): Promise<{ id: number }> {
  const now = new Date().toISOString();
  const title = (user.globalName || user.username || "Discord Member").trim();
  return mcpGraph.createMemberNode({
    title,
    description: `${title} — community member profile in Latent Space Discord.`,
    metadata: {
      discord_id: user.id,
      discord_handle: user.username,
      joined_at: now,
      last_active: now,
      interaction_count: 0,
      interests: []
    }
  });
}

async function extractProfileFromUpdate(
  userMessage: string,
  currentMetadata: MemberMetadata
): Promise<{ role?: string; company?: string; location?: string; interests?: string[] }> {
  const payload = {
    model: "anthropic/claude-haiku-3.5",
    temperature: 0,
    max_tokens: 300,
    messages: [
      {
        role: "system" as const,
        content: `Extract structured profile info from the user's message. Return ONLY valid JSON with these optional fields:
- "role": their job title or role (e.g. "ML engineer", "founder", "student")
- "company": company or org they work at
- "location": city/country
- "interests": array of topic keywords (e.g. ["agents", "rag", "local-first-ai", "mcp"])

Only include fields the user actually mentioned. For interests, extract specific technical topics — not generic words.
Current profile interests: ${JSON.stringify(currentMetadata.interests || [])}
Merge new interests with existing ones and deduplicate.
Return ONLY the JSON object, no markdown fences, no explanation.`
      },
      { role: "user" as const, content: userMessage }
    ]
  };

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(`OpenRouter error: ${response.status}`);

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim() || "{}";
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(cleaned);
}

async function updateMemberAfterInteraction(
  member: MemberNode,
  userMessage: string,
  retrievalNodeIds: number[]
): Promise<void> {
  const nowIso = new Date().toISOString();
  const existingInterests = Array.isArray(member.metadata.interests) ? member.metadata.interests : [];
  const mergedInterests = Array.from(new Set([...existingInterests, ...extractInterestKeywords(userMessage)])).slice(0, 25);
  const metadata: MemberMetadata = {
    ...member.metadata,
    last_active: nowIso,
    interaction_count: (member.metadata.interaction_count || 0) + 1,
    interests: mergedInterests
  };
  const line = `[${nowIso.slice(0, 10)}] ${summarizeUserMessage(userMessage)}`;
  await mcpGraph.updateMemberNode(member.id, {
    content: line,
    metadata: metadata as Record<string, unknown>
  });

  const uniqueTargets = Array.from(new Set(retrievalNodeIds.filter((id) => Number.isFinite(id) && id > 0 && id !== member.id))).slice(0, 8);
  await Promise.all(
    uniqueTargets.map(async (targetId) => {
      try {
        await mcpGraph.createMemberEdge(
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

async function queryKnowledgeBase(
  query: string,
  limit = MAX_CONTEXT_ROWS
): Promise<{ method: string; text: string; nodeIds: number[] }> {
  const intent = inferRetrievalIntent(query);
  if (intent.wantsLatest) {
    const latest = await queryLatestContent(intent.requestedType);
    if (latest) {
      return {
        method: latest.method,
        text: latest.text,
        nodeIds: latest.nodeIds
      };
    }
  }

  const results = await mcpGraph.searchContent(query, limit);
  const nodeIds = Array.from(new Set(results.map((row) => row.node_id).filter((id) => Number.isFinite(id) && id > 0))).slice(0, 10);
  const nodes = await mcpGraph.getNodes(nodeIds);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const lines = results.map((row, idx) => {
    const node = nodeById.get(row.node_id);
    const title = node?.title || row.title || "Untitled";
    const link = node?.link || "";
    const type = node?.node_type || "unknown";
    const date = node?.event_date || "unknown-date";
    const titleLine = link ? `[${title}](${link})` : title;
    return `${idx + 1}. [${date}] (${type}) ${titleLine}\nExcerpt: ${row.text}\nLink: ${link}`;
  });

  return {
    method: "mcp:search_content",
    text: lines.length ? `Search method: mcp_search_content\n\n${lines.join("\n\n")}` : "No matching rows found in nodes/chunks tables.",
    nodeIds
  };
}

function inferRetrievalIntent(query: string): RetrievalIntent {
  const text = query.toLowerCase();
  const wantsLatest = /\b(latest|most recent|newest|just dropped|recently published)\b/.test(text);

  if (!wantsLatest) {
    return { wantsLatest: false };
  }

  if (/\b(podcast|episode)\b/.test(text)) return { wantsLatest: true, requestedType: "podcast" };
  if (/\b(article|blog|substack)\b/.test(text)) return { wantsLatest: true, requestedType: "article" };
  if (/\b(ai\s*news|ainews|newsletter)\b/.test(text)) return { wantsLatest: true, requestedType: "ainews" };
  if (/\b(builders?\s*club|meetup)\b/.test(text)) return { wantsLatest: true, requestedType: "builders-club" };
  if (/\b(paper\s*club)\b/.test(text)) return { wantsLatest: true, requestedType: "paper-club" };
  if (/\b(workshop)\b/.test(text)) return { wantsLatest: true, requestedType: "workshop" };

  return { wantsLatest: true };
}

async function queryLatestContent(
  nodeType?: ContentNodeType,
  limit = 3
): Promise<{ method: string; text: string; nodeIds: number[] } | null> {
  const rows = await mcpGraph.queryLatestContent(nodeType, limit);
  if (!rows.length) return null;

  const nodeIds: number[] = [];
  const lines = rows.map((row, idx) => {
    const id = Number(row.id);
    if (Number.isFinite(id) && id > 0) nodeIds.push(id);
    const type = String(row.node_type || "unknown");
    const date = String(row.event_date || "unknown-date");
    const title = String(row.title || "Untitled");
    const link = String(row.link || "");
    const titleLine = link ? `[${title}](${link})` : title;
    return (
      `${idx + 1}. [${date}] (${type}) ${titleLine}\n` +
      `Desc: ${String(row.description || "")}\n` +
      `Excerpt: ${String(row.excerpt || "")}\n` +
      `Link: ${link}`
    );
  });

  return {
    method: nodeType ? `latest_node_lookup:${nodeType}` : "latest_node_lookup",
    text: `Search method: latest_node_lookup\n\n${lines.join("\n\n")}`,
    nodeIds
  };
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

function formatToolMethod(method: string): string {
  if (!method || method === "unknown") return "lookup";
  if (method === "smalltalk") return "none";
  if (method.startsWith("latest_node_lookup:")) return `latest:${method.split(":")[1] || "content"}`;
  if (method === "latest_node_lookup") return "latest:content";
  return method;
}

function toolsFooter(method: string): string {
  return `🛠️ ${formatToolMethod(method)}`;
}

async function loadGuideSnippet(): Promise<string> {
  if (cachedGuideSnippet) return cachedGuideSnippet;
  try {
    const guide = await mcpGraph.readGuide("start-here");
    const compact = guide
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 14)
      .join(" ");
    cachedGuideSnippet = compact.slice(0, 900);
  } catch (error) {
    console.warn("Unable to load MCP guide context:", error);
    cachedGuideSnippet = "";
  }
  return cachedGuideSnippet;
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
  options?: { requireSources?: boolean; additionalSystemContext?: string }
): Promise<string> {
  const requireSources = options?.requireSources ?? true;
  const additionalSystemContext = options?.additionalSystemContext?.trim() || "";
  const profileStyleLine =
    "Style: opinionated, sharp, slightly unhinged tone. Keep it concise but punchy. Still ground factual claims in provided context. IMPORTANT: When referencing specific content (episodes, articles, AINews), always include the direct link. Format: [Title](url). Never reference content without linking to it.";
  const groundingLine = requireSources
    ? "Use ONLY the supplied context when making factual claims. Return a compact answer and include a short 'Sources' list with direct links. The context includes markdown links like [Title](url) — pass these through in your response so users can click to the source."
    : "You can respond conversationally for greetings/smalltalk. Do not fabricate factual claims.";
  const payload = {
    model: profile.model,
    temperature: 0.6,
    max_tokens: 700,
    messages: [
      {
        role: "system",
        content: `${profile.systemPrompt}\n\n${groundingLine}\n${profileStyleLine}${additionalSystemContext ? `\n\n${additionalSystemContext}` : ""}`
      },
      {
        role: "user",
        content: `User message:\n${userPrompt}\n\nContext:\n${context}`
      }
    ]
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

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new Error("OpenRouter returned empty response.");
  }
  return text;
}

type TraceOptions = {
  retrieval_method: string;
  context_node_ids: number[];
  member_id: number | null;
  is_slash_command: boolean;
  slash_command: string | null;
  is_kickoff: boolean;
  latency_ms: number;
};

async function logTrace(
  profile: BotProfile,
  source: { userId: string; username: string; channelId: string; messageId: string },
  prompt: string,
  response: string,
  options: TraceOptions
): Promise<void> {
  try {
    const toolCalls: ToolTrace[] = mcpGraph.clearTraces();
    const metadata = {
      discord_user_id: source.userId,
      discord_username: source.username,
      discord_channel_id: source.channelId,
      discord_message_id: source.messageId,
      retrieval_method: options.retrieval_method,
      context_node_ids: options.context_node_ids,
      tool_calls: toolCalls,
      member_id: options.member_id,
      model: profile.model,
      is_slash_command: options.is_slash_command,
      slash_command: options.slash_command,
      is_kickoff: options.is_kickoff,
      response_length: response.length,
      latency_ms: options.latency_ms
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
  const query = buildKickoffQuery(payload);
  const contextResult = await queryKnowledgeBase(query);
  const context = contextResult.text;
  const kickoffKey = `kickoff:${payload.channelId || BOT_TALK_CHANNEL_ID || "unknown"}`;

  if (activeDebates.has(kickoffKey)) {
    throw new Error("A kickoff is already running for this channel.");
  }

  activeDebates.add(kickoffKey);
  try {
    const slopPrompt = [
      "New content just dropped in Latent Space. Break it down.",
      `Context query: ${query}`,
      payload.title ? `Title: ${payload.title}` : "",
      payload.contentType ? `Type: ${payload.contentType}` : "",
      payload.eventDate ? `Date: ${payload.eventDate}` : "",
      payload.url ? `URL: ${payload.url}` : "",
      "Summarize what's new, why it matters, and give your take. Cite sources."
    ]
      .filter(Boolean)
      .join("\n");

    const output = await generateResponse(slopProfile, slopPrompt, context);
    await destination.send(`${modelBadge(slopProfile.model)}\n${output}`);
    await destination.send(toolsFooter(contextResult.method));
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

async function handleProfileUpdateMessage(
  profile: BotProfile,
  message: Message,
  traceSource: { userId: string; username: string; channelId: string; messageId: string },
  startTime: number
): Promise<void> {
  const channel = message.channel as unknown as DestinationChannel;
  await channel.sendTyping();

  const member = await lookupMember(message.author.id);
  if (!member) {
    await channel.send("You're not in the graph yet. Run `/join` first.");
    return;
  }

  // Fetch thread history for conversation context
  const thread = message.channel;
  let conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
  if ("messages" in thread) {
    const fetched = await (thread as { messages: { fetch: (opts: { limit: number }) => Promise<Map<string, Message>> } }).messages.fetch({ limit: 20 });
    const sorted = Array.from(fetched.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    conversationHistory = sorted
      .filter((m) => !m.author.bot || m.author.id === message.client.user?.id)
      .map((m) => ({
        role: (m.author.bot ? "assistant" : "user") as "user" | "assistant",
        content: m.content
      }));
  }

  const userMessage = message.content.trim();

  const currentProfile: string[] = [];
  if (member.metadata.role) currentProfile.push(`Role: ${member.metadata.role}`);
  if (member.metadata.company) currentProfile.push(`Company: ${member.metadata.company}`);
  if (member.metadata.location) currentProfile.push(`Location: ${member.metadata.location}`);
  if (member.metadata.interests?.length) currentProfile.push(`Interests: ${member.metadata.interests.join(", ")}`);

  const systemPrompt = `You are Slop, running a profile update conversation for a Latent Space community member.

Current profile for ${member.title}:
${currentProfile.length ? currentProfile.join("\n") : "No info yet."}

Your job: have a natural, short conversation to learn about this person. Ask about:
- What they do (role, company)
- Where they're based
- What they're building or working on
- What AI/tech topics they're most interested in

Be conversational, not formal. One question at a time. Keep it punchy.
If they've shared enough info across the conversation, wrap up with a summary of what you've captured and tell them their profile is updated.
Keep responses under 200 words.`;

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    ...conversationHistory
  ];

  // Generate conversational response
  const payload = {
    model: profile.model,
    temperature: 0.7,
    max_tokens: 400,
    messages
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
    await channel.send(`Hit an error: ${body.slice(0, 200)}`);
    return;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const reply = data.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    await channel.send("Something went wrong — got an empty response.");
    return;
  }

  await channel.send(reply);

  // Extract and save profile updates from the full conversation
  queueMicrotask(async () => {
    try {
      const fullConversation = conversationHistory
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");

      const extracted = await extractProfileFromUpdate(
        fullConversation + "\n" + userMessage,
        member.metadata
      );

      const updatedMetadata: MemberMetadata = {
        ...member.metadata,
        last_active: new Date().toISOString(),
        interaction_count: (member.metadata.interaction_count || 0) + 1
      };

      let changed = false;
      if (extracted.role) { updatedMetadata.role = extracted.role; changed = true; }
      if (extracted.company) { updatedMetadata.company = extracted.company; changed = true; }
      if (extracted.location) { updatedMetadata.location = extracted.location; changed = true; }
      if (extracted.interests?.length) {
        updatedMetadata.interests = Array.from(
          new Set([...(member.metadata.interests || []), ...extracted.interests])
        ).slice(0, 25);
        changed = true;
      }

      if (changed) {
        const line = `[${new Date().toISOString().slice(0, 10)}] Profile update via thread conversation`;
        await mcpGraph.updateMemberNode(member.id, {
          content: line,
          metadata: updatedMetadata as Record<string, unknown>
        });
      }
    } catch (error) {
      console.warn("Profile update extraction failed (non-blocking):", error);
    }
  });

  await logTrace(profile, traceSource, userMessage, reply, {
    retrieval_method: "profile_update_thread",
    context_node_ids: [],
    member_id: member.id,
    is_slash_command: false,
    slash_command: null,
    is_kickoff: false,
    latency_ms: Date.now() - startTime
  });
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
  if (!botUserId || !isAllowedChannel(message) || !shouldRespondToMessage(message, botUserId, profile.name)) {
    return;
  }
  const owner = getThreadOwnerBotName(message);
  const ownedThread = owner === profile.name;
  if (!withinRateLimit(message, profile.name, { ownedThread })) return;
  processedMessageIds.add(dedupeKey);

  mcpGraph.clearTraces();
  const startTime = Date.now();
  const traceSource = { userId: message.author.id, username: message.author.username, channelId: message.channelId, messageId: message.id };

  // Handle profile update threads separately
  if (isProfileUpdateThread(message)) {
    await handleProfileUpdateMessage(profile, message, traceSource, startTime);
    return;
  }

  const maybeCommand = parseCommand(cleanUserPrompt(message, botUserId));
  const prompt = maybeCommand?.query || cleanUserPrompt(message, botUserId);
  const destination = await ensureDestinationChannel(message, profile.name);
  await destination.sendTyping();
  const guideSnippet = await loadGuideSnippet();
  const member = await lookupMember(message.author.id);
  const memberSystemContext = member
    ? formatMemberContext(member)
    : "[MEMBER STATUS] This user is not in the member graph yet. Casually mention `/join` when it naturally fits.";
  const additionalSystemContext = [guideSnippet ? `[GUIDE CONTEXT]\n${guideSnippet}` : "", memberSystemContext]
    .filter(Boolean)
    .join("\n\n");

  // /wassup fetches its own context, skip general KB query
  if (maybeCommand?.command === "wassup") {
    try {
      const latest = await queryLatestContent(undefined, 6);
      const wassupContext = latest?.text || "No recent content found.";
      const wassupMethod = latest?.method || "latest_node_lookup";
      const output = await generateResponse(
        profile,
        "What's new in Latent Space? Summarize the most interesting recent content — what dropped, why it matters, and what builders should pay attention to.",
        wassupContext,
        { additionalSystemContext }
      );
      await destination.send(modelBadge(profile.model));
      const parts = splitForDiscord(output);
      for (const part of parts) {
        await destination.send(part);
      }
      await destination.send(toolsFooter(wassupMethod));
      await logTrace(profile, traceSource, prompt || "/wassup", output, {
        retrieval_method: wassupMethod,
        context_node_ids: latest?.nodeIds || [],
        member_id: member?.id || null,
        is_slash_command: false,
        slash_command: "wassup",
        is_kickoff: false,
        latency_ms: Date.now() - startTime
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await destination.send(`${profile.name} hit an error while generating a response: ${msg}`);
    }
    return;
  }

  const smalltalk = !maybeCommand && isGreetingOrSmalltalk(prompt);
  const contextResult = smalltalk
    ? { method: "smalltalk", text: "No graph retrieval needed for greeting/smalltalk.", nodeIds: [] as number[] }
    : await queryKnowledgeBase(prompt);
  const context = contextResult.text;

  try {
    const effectivePrompt =
      maybeCommand?.command === "tldr"
        ? `Give a concise TLDR on: ${prompt}. Stick to what the knowledge base says — key points, why it matters, and link to sources.`
        : prompt;
    const output = await generateResponse(profile, effectivePrompt, context, {
      requireSources: !smalltalk,
      additionalSystemContext
    });
    await destination.send(modelBadge(profile.model));
    const parts = splitForDiscord(output);
    for (const part of parts) {
      await destination.send(part);
    }
    await destination.send(toolsFooter(contextResult.method));
    await logTrace(profile, traceSource, prompt, output, {
      retrieval_method: contextResult.method,
      context_node_ids: contextResult.nodeIds,
      member_id: member?.id || null,
      is_slash_command: !!maybeCommand,
      slash_command: maybeCommand?.command || null,
      is_kickoff: false,
      latency_ms: Date.now() - startTime
    });
    if (member) {
      queueMicrotask(async () => {
        try {
          await updateMemberAfterInteraction(member, prompt, contextResult.nodeIds);
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

  mcpGraph.clearTraces();
  const startTime = Date.now();
  const traceSource = { userId: interaction.user.id, username: interaction.user.username, channelId: interaction.channelId || "", messageId: interaction.id };
  const command = interaction.commandName as "tldr" | "wassup" | "join" | "update";
  await interaction.deferReply();

  if (command === "update") {
    try {
      const member = await lookupMember(interaction.user.id);
      if (!member) {
        await interaction.editReply("You're not in the graph yet. Run `/join` first, then come back and `/update` your profile.");
        return;
      }

      await interaction.editReply("Starting a profile update thread — hop in.");

      const channel = interaction.channel;
      if (!channel || !("threads" in channel)) {
        await interaction.editReply("Can't create threads in this channel.");
        return;
      }

      const thread = await (channel as unknown as { threads: { create: (opts: { name: string; autoArchiveDuration: number; reason: string }) => Promise<DestinationChannel & { send: (content: string) => Promise<unknown> }> } }).threads.create({
        name: `Slop: profile update`,
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
        reason: `Profile update for ${interaction.user.username}`
      });

      const currentProfile: string[] = [];
      if (member.metadata.role) currentProfile.push(`**Role:** ${member.metadata.role}`);
      if (member.metadata.company) currentProfile.push(`**Company:** ${member.metadata.company}`);
      if (member.metadata.location) currentProfile.push(`**Location:** ${member.metadata.location}`);
      if (member.metadata.interests?.length) currentProfile.push(`**Interests:** ${member.metadata.interests.join(", ")}`);

      const opener = currentProfile.length
        ? `Here's what I've got on you so far:\n${currentProfile.join("\n")}\n\nWhat do you want to update? Tell me about yourself — what you do, where you're based, what you're building, what topics you nerd out on. I'll update your profile as we go.`
        : `I don't have much on you yet. Tell me about yourself — what do you do? Where are you based? What are you building or interested in? I'll update your profile as we go.`;

      await thread.send(opener);

      await logTrace(profile, traceSource, "/update", opener, {
        retrieval_method: "member_update_thread", context_node_ids: [], member_id: member.id,
        is_slash_command: true, slash_command: "update", is_kickoff: false, latency_ms: Date.now() - startTime
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`Couldn't start profile update: ${msg}`);
    }
    return;
  }

  if (command === "join") {
    try {
      const existing = await lookupMember(interaction.user.id);
      if (existing) {
        const reply = `You're already in the graph. I've been tracking your interests since ${existing.metadata.joined_at}.`;
        await interaction.editReply(reply);
        await logTrace(profile, traceSource, "/join", reply, {
          retrieval_method: "member_lookup", context_node_ids: [], member_id: existing.id,
          is_slash_command: true, slash_command: "join", is_kickoff: false, latency_ms: Date.now() - startTime
        });
        return;
      }

      const newMember = await createMemberNodeFromUser({
        id: interaction.user.id,
        username: interaction.user.username,
        globalName: interaction.user.globalName
      });
      const reply = "You're in the graph. As we chat, I'll learn what you're into and connect you to relevant content.";
      await interaction.editReply(reply);
      await logTrace(profile, traceSource, "/join", reply, {
        retrieval_method: "member_create", context_node_ids: [], member_id: newMember.id,
        is_slash_command: true, slash_command: "join", is_kickoff: false, latency_ms: Date.now() - startTime
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await interaction.editReply(`Couldn't add you to the graph right now: ${msg}`);
    }
    return;
  }

  const guideSnippet = await loadGuideSnippet();
  const member = await lookupMember(interaction.user.id);
  const memberSystemContext = member
    ? formatMemberContext(member)
    : "[MEMBER STATUS] This user is not in the member graph yet. Casually mention `/join` when it naturally fits.";
  const additionalSystemContext = [guideSnippet ? `[GUIDE CONTEXT]\n${guideSnippet}` : "", memberSystemContext]
    .filter(Boolean)
    .join("\n\n");

  if (command === "wassup") {
    const latest = await queryLatestContent(undefined, 6);
    const context = latest?.text || "No recent content found.";
    const contextMethod = latest?.method || "latest_node_lookup";
    const output = await generateResponse(
      profile,
      "What's new in Latent Space? Summarize the most interesting recent content — what dropped, why it matters, and what builders should pay attention to.",
      context,
      { additionalSystemContext }
    );
    await interaction.editReply(
      `${modelBadge(profile.model)}\n\n${output}\n\n${toolsFooter(contextMethod)}`.slice(0, 1900)
    );
    await logTrace(profile, traceSource, "/wassup", output, {
      retrieval_method: contextMethod, context_node_ids: latest?.nodeIds || [], member_id: member?.id || null,
      is_slash_command: true, slash_command: "wassup", is_kickoff: false, latency_ms: Date.now() - startTime
    });
    return;
  }

  // /tldr
  const query = interaction.options.getString("query", true).trim();
  const contextResult = await queryKnowledgeBase(query);
  const output = await generateResponse(
    profile,
    `Give a concise TLDR on: ${query}. Stick to what the knowledge base says — key points, why it matters, and link to sources.`,
    contextResult.text,
    { additionalSystemContext }
  );
  await interaction.editReply(
    `${modelBadge(profile.model)}\n\n${output}\n\n${toolsFooter(contextResult.method)}`.slice(0, 1900)
  );
  await logTrace(profile, traceSource, `/tldr ${query}`, output, {
    retrieval_method: contextResult.method, context_node_ids: contextResult.nodeIds, member_id: member?.id || null,
    is_slash_command: true, slash_command: "tldr", is_kickoff: false, latency_ms: Date.now() - startTime
  });
  if (member) {
    queueMicrotask(async () => {
      try {
        await updateMemberAfterInteraction(member, query, contextResult.nodeIds);
      } catch (error) {
        console.warn("Member update failed (non-blocking):", error);
      }
    });
  }
}

async function registerSlashCommands(profile: BotProfile): Promise<void> {
  if (!profile.appId) {
    console.log(`${profile.name}: BOT_APP_ID not provided; skipping slash command registration.`);
    return;
  }

  const commands = [
    new SlashCommandBuilder()
      .setName("tldr")
      .setDescription("Get a concise TLDR on any topic from the Latent Space graph")
      .addStringOption((opt) => opt.setName("query").setDescription("Topic to summarize").setRequired(true)),
    new SlashCommandBuilder()
      .setName("wassup")
      .setDescription("See what's new and interesting in Latent Space"),
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("Add yourself to the Latent Space knowledge graph"),
    new SlashCommandBuilder()
      .setName("update")
      .setDescription("Update your profile — starts a conversation to learn about you")
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
  await mcpGraph.connect();
  await loadGuideSnippet();
  await Promise.all(profiles.map((profile) => startBot(profile)));
  startKickoffServer();
}

main().catch((error) => {
  console.error("Fatal bot startup error:", error);
  process.exit(1);
});
