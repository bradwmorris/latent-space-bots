import "dotenv/config";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { createClient as createLibsqlClient, type Client as LibsqlClient } from "@libsql/client";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Interaction,
  type Message
} from "discord.js";
import { createLsHubServices as createLocalLsHubServices } from "./lsHubServicesFallback";

function loadSharedServicesFactory(): {
  createLsHubServices: (options: { db?: LibsqlClient; tursoUrl?: string; tursoToken?: string }) => {
    queryKnowledgeContext: (
      query: string,
      options?: { limit?: number; openAiApiKey?: string }
    ) => Promise<{ method: string; text: string }>;
  };
} {
  const candidates = [
    "latent-space-hub-mcp/services",
    "./lsHubServicesFallback",
    process.env.LSH_MCP_SERVICES_PATH?.trim() || "",
    path.resolve(__dirname, "../../latent-space-hub/apps/mcp-server-standalone/services")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(candidate);
    } catch {
      // try next candidate
    }
  }

  return {
    createLsHubServices: (options) => {
      if (!options.db) {
        throw new Error("Local LS services fallback requires a db client.");
      }
      return createLocalLsHubServices({ db: options.db });
    }
  };
}

const { createLsHubServices } = loadSharedServicesFactory();

type BotProfile = {
  name: "Sig" | "Slop";
  token: string;
  model: string;
  systemPrompt: string;
  appId?: string;
};

type BotProfileSeed = {
  name: "Sig" | "Slop";
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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const SIG_MODEL = process.env.SIG_MODEL || "anthropic/claude-sonnet-4";
const SLOP_MODEL = process.env.SLOP_MODEL || "moonshotai/kimi-k2";
const DISCORD_TEST_GUILD_ID = process.env.DISCORD_TEST_GUILD_ID || "";
const ALLOWED_CHANNEL_IDS = new Set(
  (process.env.ALLOWED_CHANNEL_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);
const USER_RATE_LIMIT_WINDOW_MS = Number(process.env.USER_RATE_LIMIT_WINDOW_MS || 5000);
const CHANNEL_RATE_LIMIT_WINDOW_MS = Number(process.env.CHANNEL_RATE_LIMIT_WINDOW_MS || 1200);
const MAX_DEBATE_EXCHANGES = Number(process.env.MAX_DEBATE_EXCHANGES || 4);
const ENABLE_CHAT_LOG_WRITE = String(process.env.ENABLE_CHAT_LOG_WRITE || "false").toLowerCase() === "true";
const DEBATE_KICKOFF_SECRET = process.env.DEBATE_KICKOFF_SECRET || "";
const DEBATE_KICKOFF_PORT = Number(process.env.DEBATE_KICKOFF_PORT || 8787);
const DEBATE_KICKOFF_HOST = process.env.DEBATE_KICKOFF_HOST || "0.0.0.0";
const BOT_TALK_CHANNEL_ID = process.env.BOT_TALK_CHANNEL_ID || "";
const MAX_KICKOFF_EXCHANGES = Math.min(Math.max(Number(process.env.MAX_KICKOFF_EXCHANGES || 2), 1), 3);

const clientsByProfile = new Map<BotProfile["name"], Client>();

const db = createLibsqlClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN
});
const lsHubServices = createLsHubServices({ db });

const profileSeeds: BotProfileSeed[] = [
  {
    name: "Sig",
    token: requiredEnv("BOT_TOKEN_SIG"),
    model: SIG_MODEL,
    appId: process.env.BOT_APP_ID_SIG,
    soulFile: "sig.soul.md"
  },
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
  if (threadName.startsWith("sig:")) return "Sig";
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

function parseCommand(content: string): { command: "ask" | "search" | "episode" | "debate"; query: string } | null {
  const trimmed = content.trim();
  const regex = /^\/(ask|search|episode|debate)\s+([\s\S]+)$/i;
  const match = trimmed.match(regex);
  if (!match) return null;
  return {
    command: match[1].toLowerCase() as "ask" | "search" | "episode" | "debate",
    query: match[2].trim()
  };
}

function isAllowedChannel(message: Message): boolean {
  if (!ALLOWED_CHANNEL_IDS.size) return true;
  return ALLOWED_CHANNEL_IDS.has(message.channelId);
}

function withinRateLimit(message: Message, options?: { ownedThread?: boolean }): boolean {
  const now = Date.now();
  const userLast = rateLimitByUser.get(message.author.id) || 0;
  const channelLast = rateLimitByChannel.get(message.channelId) || 0;
  const ownedThread = Boolean(options?.ownedThread);

  // In bot-owned threads we relax per-user cooldown to keep natural back-and-forth.
  if (!ownedThread && now - userLast < USER_RATE_LIMIT_WINDOW_MS) return false;
  if (now - channelLast < CHANNEL_RATE_LIMIT_WINDOW_MS) return false;

  rateLimitByUser.set(message.author.id, now);
  rateLimitByChannel.set(message.channelId, now);
  return true;
}

async function queryKnowledgeBase(query: string, limit = MAX_CONTEXT_ROWS): Promise<{ method: string; text: string }> {
  const intent = inferRetrievalIntent(query);
  if (intent.wantsLatest) {
    const latest = await queryLatestContent(intent.requestedType);
    if (latest) {
      return {
        method: latest.method,
        text: latest.text
      };
    }
  }

  const result = await lsHubServices.queryKnowledgeContext(query, {
    limit,
    openAiApiKey: OPENAI_API_KEY || undefined
  });
  return {
    method: result.method || "unknown",
    text: result.text || "No matching rows found in nodes/chunks tables."
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
  nodeType?: ContentNodeType
): Promise<{ method: string; text: string } | null> {
  const contentTypes: ContentNodeType[] = [
    "podcast",
    "article",
    "ainews",
    "builders-club",
    "paper-club",
    "workshop"
  ];

  const sql =
    "SELECT id, title, node_type, event_date, coalesce(description, '') AS description, " +
    "substr(coalesce(notes, ''), 1, 700) AS excerpt, coalesce(link, '') AS link " +
    "FROM nodes " +
    "WHERE event_date IS NOT NULL " +
    (nodeType
      ? "AND node_type = ? "
      : `AND node_type IN (${contentTypes.map(() => "?").join(",")}) `) +
    "ORDER BY event_date DESC, updated_at DESC " +
    "LIMIT 3";

  const args: string[] = nodeType ? [nodeType] : contentTypes;
  const result = await db.execute({ sql, args });
  const rows = result.rows || [];
  if (!rows.length) return null;

  const lines = rows.map((row, idx) => {
    const type = String(row.node_type || "unknown");
    const date = String(row.event_date || "unknown-date");
    return (
      `${idx + 1}. [${date}] (${type}) ${String(row.title || "Untitled")}\n` +
      `Desc: ${String(row.description || "")}\n` +
      `Excerpt: ${String(row.excerpt || "")}\n` +
      `Link: ${String(row.link || "")}`
    );
  });

  return {
    method: nodeType ? `latest_node_lookup:${nodeType}` : "latest_node_lookup",
    text: `Search method: latest_node_lookup\n\n${lines.join("\n\n")}`
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
  options?: { requireSources?: boolean }
): Promise<string> {
  const requireSources = options?.requireSources ?? true;
  const profileStyleLine =
    profile.name === "Sig"
      ? "Style for Sig: extremely concise. 1-4 short paragraphs or bullets max. Always include concrete date/event_date context when relevant. Include a short 'Sources' section with verbatim quote snippets (max ~12 words each) and URL links. No filler."
      : "Style for Slop: opinionated, sharp, slightly unhinged tone. Keep it concise but punchy. Still ground factual claims in provided context and include source links when making factual claims.";
  const groundingLine = requireSources
    ? "Use ONLY the supplied context when making factual claims. Return a compact answer and include a short 'Sources' list."
    : "You can respond conversationally for greetings/smalltalk. Do not fabricate factual claims.";
  const payload = {
    model: profile.model,
    temperature: 0.6,
    max_tokens: 700,
    messages: [
      {
        role: "system",
        content: `${profile.systemPrompt}\n\n${groundingLine}\n${profileStyleLine}`
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

async function maybeLogChat(
  profile: BotProfile,
  message: Message,
  prompt: string,
  response: string,
  contextMethod: string
): Promise<void> {
  if (!ENABLE_CHAT_LOG_WRITE) return;
  try {
    await db.execute({
      sql:
        "INSERT INTO chats " +
        "(bot_name, user_id, channel_id, message_id, prompt, response, retrieval_method, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        profile.name,
        message.author.id,
        message.channelId,
        message.id,
        prompt,
        response.slice(0, 4000),
        contextMethod,
        new Date().toISOString()
      ]
    });
  } catch {
    // Logging is best-effort only.
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

function normalizeKickoffExchanges(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return MAX_KICKOFF_EXCHANGES;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_KICKOFF_EXCHANGES);
}

function buildKickoffQuery(payload: KickoffPayload): string {
  const candidate =
    payload.prompt ||
    [payload.title, payload.contentType, payload.summary, payload.eventDate]
      .filter((v) => typeof v === "string" && v.trim().length > 0)
      .join(" | ");
  return candidate?.trim() || "Summarize the most recent Latent Space content and why it matters.";
}

async function resolveKickoffDestination(sigClient: Client, payload: KickoffPayload): Promise<DestinationChannel> {
  const channelId = (payload.channelId || BOT_TALK_CHANNEL_ID || "").trim();
  if (!channelId) {
    throw new Error("No kickoff channel configured. Set BOT_TALK_CHANNEL_ID or include channelId in request.");
  }

  const channel = await sigClient.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Channel ${channelId} is not text-based or is inaccessible.`);
  }

  if (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread) {
    return channel as unknown as DestinationChannel;
  }

  const seedParts = [
    "New content ingested. Starting Sig vs Slop.",
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
      name: `Sig vs Slop: ${threadTitleSeed || "new-content"}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: "Deterministic kickoff for newly ingested content"
    });
    return thread as unknown as DestinationChannel;
  } catch {
    return baseChannel as unknown as DestinationChannel;
  }
}

async function runDeterministicKickoff(payload: KickoffPayload): Promise<{ ok: true; exchanges: number }> {
  const sigProfile = getProfileByName("Sig");
  const slopProfile = getProfileByName("Slop");
  const sigClient = getReadyClient("Sig");

  const destination = await resolveKickoffDestination(sigClient, payload);
  const query = buildKickoffQuery(payload);
  const contextResult = await queryKnowledgeBase(query);
  const context = contextResult.text;
  const exchanges = normalizeKickoffExchanges(payload.exchanges);
  const debateKey = `kickoff:${payload.channelId || BOT_TALK_CHANNEL_ID || "unknown"}`;

  if (activeDebates.has(debateKey)) {
    throw new Error("A kickoff debate is already running for this channel.");
  }

  activeDebates.add(debateKey);
  try {
    let priorSig = "";
    let priorSlop = "";
    for (let i = 0; i < exchanges; i++) {
      const roundLabel = `Round ${i + 1}/${exchanges}`;
      const sigPrompt =
        i === 0
          ? [
              "Kick off a new-content discussion for Latent Space.",
              `Context query: ${query}`,
              payload.title ? `Title: ${payload.title}` : "",
              payload.contentType ? `Type: ${payload.contentType}` : "",
              payload.eventDate ? `Date: ${payload.eventDate}` : "",
              payload.url ? `URL: ${payload.url}` : "",
              "Summarize what is new, why it matters, and cite sources."
            ]
              .filter(Boolean)
              .join("\n")
          : [
              "Continue the Sig vs Slop debate with factual grounding.",
              `Previous Slop point: ${priorSlop || "N/A"}`,
              `Topic: ${query}`
            ].join("\n");

      priorSig = await generateResponse(sigProfile, sigPrompt, context);
      await destination.send(`**Sig (${sigProfile.model}) — ${roundLabel}**\n${priorSig}`);

      const slopPrompt = [
        "Respond to Sig with a grounded counterpoint.",
        `Sig just said: ${priorSig}`,
        "Be provocative but cite concrete evidence from the provided context."
      ].join("\n");

      priorSlop = await generateResponse(slopProfile, slopPrompt, context);
      await destination.send(`**Slop (${slopProfile.model}) — ${roundLabel}**\n${priorSlop}`);
    }
  } finally {
    activeDebates.delete(debateKey);
  }

  return { ok: true, exchanges };
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
      const result = await runDeterministicKickoff(body || {});
      writeJson(res, 200, result);
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

async function handleMessage(client: Client, profile: BotProfile, message: Message): Promise<void> {
  if (message.webhookId) {
    console.log(
      `[${profile.name}] webhook message received channel=${message.channelId} id=${message.id} mentionsBot=${Boolean(
        client.user?.id && (message.mentions.users.has(client.user.id) || new RegExp(`<@!?${client.user.id}>`).test(message.content))
      )}`
    );
  }

  if (processedMessageIds.has(message.id)) return;
  const botUserId = client.user?.id;
  if (!botUserId || !isAllowedChannel(message) || !shouldRespondToMessage(message, botUserId, profile.name)) {
    return;
  }
  const owner = getThreadOwnerBotName(message);
  const ownedThread = owner === profile.name;
  if (!withinRateLimit(message, { ownedThread })) return;
  processedMessageIds.add(message.id);

  const maybeCommand = parseCommand(cleanUserPrompt(message, botUserId));
  const prompt = maybeCommand?.query || cleanUserPrompt(message, botUserId);
  const destination = await ensureDestinationChannel(message, profile.name);
  await destination.sendTyping();

  const smalltalk = !maybeCommand && isGreetingOrSmalltalk(prompt);
  const contextResult = smalltalk
    ? { method: "smalltalk", text: "No graph retrieval needed for greeting/smalltalk." }
    : await queryKnowledgeBase(prompt);
  const context = contextResult.text;
  const contextMethodLine = `Search method: ${contextResult.method}`;

  try {
    if (maybeCommand?.command === "debate" && profile.name === "Sig") {
      const debateKey = message.channelId;
      if (activeDebates.has(debateKey)) {
        await destination.send("A debate is already active in this channel. Wait for it to finish.");
        return;
      }

      activeDebates.add(debateKey);
      try {
        await destination.send(`🤖 ${shortModelName(profiles[0].model)} + ${shortModelName(profiles[1].model)}`);
        for (let i = 0; i < MAX_DEBATE_EXCHANGES; i++) {
          const sigOut = await generateResponse(
            profiles[0],
            `Debate round ${i + 1}. Take a factual position on: ${prompt}`,
            context
          );
          await destination.send(`**Sig (${profiles[0].model})**\n${sigOut}`);

          const slopOut = await generateResponse(
            profiles[1],
            `Debate round ${i + 1}. Respond to Sig and push a sharp counterpoint on: ${prompt}`,
            context
          );
          await destination.send(`**Slop (${profiles[1].model})**\n${slopOut}`);
        }
        await destination.send(toolsFooter(contextResult.method));
      } finally {
        activeDebates.delete(debateKey);
      }
      return;
    }

    const output = await generateResponse(profile, prompt, context, { requireSources: !smalltalk });
    await destination.send(modelBadge(profile.model));
    const parts = splitForDiscord(output);
    for (const part of parts) {
      await destination.send(part);
    }
    await destination.send(toolsFooter(contextResult.method));
    await maybeLogChat(profile, message, prompt, output, contextMethodLine.replace("Search method: ", ""));
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

  const command = interaction.commandName as "ask" | "search" | "episode" | "debate";
  const query = interaction.options.getString("query", true).trim();
  await interaction.deferReply();

  if (command === "debate" && profile.name !== "Sig") {
    await interaction.editReply("Debates are orchestrated by Sig.");
    return;
  }

  const smalltalk = command === "ask" && isGreetingOrSmalltalk(query);
  const contextResult = smalltalk
    ? { method: "smalltalk", text: "No graph retrieval needed for greeting/smalltalk." }
    : await queryKnowledgeBase(query);
  const context = contextResult.text;

  if (command === "search") {
    const snippets = context.length > 1800 ? `${context.slice(0, 1800)}...` : context;
    await interaction.editReply(
      `${modelBadge(profile.model)}\n\nSearch context for "${query}":\n\n${snippets}\n\n${toolsFooter(contextResult.method)}`
    );
    return;
  }

  if (command === "episode") {
    const output = await generateResponse(
      profile,
      `Find episode-level answers for: ${query}. Focus on episodes, guests, dates, and links.`,
      context
    );
    await interaction.editReply(
      `${modelBadge(profile.model)}\n\n${output}\n\n${toolsFooter(contextResult.method)}`.slice(0, 1900)
    );
    return;
  }

  if (command === "debate") {
    const rounds: string[] = [];
    for (let i = 0; i < Math.min(MAX_DEBATE_EXCHANGES, 2); i++) {
      const sig = await generateResponse(
        profiles[0],
        `Debate round ${i + 1}. Take a factual position on: ${query}`,
        context
      );
      const slop = await generateResponse(
        profiles[1],
        `Debate round ${i + 1}. Counter Sig with a provocative take on: ${query}`,
        context
      );
      rounds.push(`Sig: ${sig}\n\nSlop: ${slop}`);
    }
    await interaction.editReply(
      `🤖 ${shortModelName(profiles[0].model)} + ${shortModelName(profiles[1].model)}\n\n${rounds.join("\n\n---\n\n")}\n\n${toolsFooter(contextResult.method)}`.slice(
        0,
        1900
      )
    );
    return;
  }

    const output = await generateResponse(profile, query, context, { requireSources: !smalltalk });
    await interaction.editReply(
      `${modelBadge(profile.model)}\n\n${output}\n\n${toolsFooter(contextResult.method)}`.slice(0, 1900)
    );
}

async function registerSlashCommands(profile: BotProfile): Promise<void> {
  if (!profile.appId) {
    console.log(`${profile.name}: BOT_APP_ID not provided; skipping slash command registration.`);
    return;
  }

  const commands = [
    new SlashCommandBuilder().setName("ask").setDescription("Ask the bot a KB-grounded question").addStringOption((opt) =>
      opt.setName("query").setDescription("Question to ask").setRequired(true)
    ),
    new SlashCommandBuilder().setName("search").setDescription("Search KB context snippets").addStringOption((opt) =>
      opt.setName("query").setDescription("Search query").setRequired(true)
    ),
    new SlashCommandBuilder().setName("episode").setDescription("Lookup episodes/guests").addStringOption((opt) =>
      opt.setName("query").setDescription("Episode/guest lookup").setRequired(true)
    ),
    new SlashCommandBuilder().setName("debate").setDescription("Run Sig/Slop debate").addStringOption((opt) =>
      opt.setName("query").setDescription("Debate topic").setRequired(true)
    )
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
  if (ALLOWED_CHANNEL_IDS.size) {
    console.log(`Allowed channels: ${[...ALLOWED_CHANNEL_IDS].join(", ")}`);
  } else {
    console.warn("ALLOWED_CHANNEL_IDS not set. Bots will respond in any channel they can read.");
  }
  await Promise.all(profiles.map((profile) => startBot(profile)));
  startKickoffServer();
}

main().catch((error) => {
  console.error("Fatal bot startup error:", error);
  process.exit(1);
});
