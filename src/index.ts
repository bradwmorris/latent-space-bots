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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

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
const ENABLE_CHAT_LOG_WRITE = String(process.env.ENABLE_CHAT_LOG_WRITE || "false").toLowerCase() === "true";
const DEBATE_KICKOFF_SECRET = process.env.DEBATE_KICKOFF_SECRET || "";
const DEBATE_KICKOFF_PORT = Number(process.env.DEBATE_KICKOFF_PORT || 8787);
const DEBATE_KICKOFF_HOST = process.env.DEBATE_KICKOFF_HOST || "0.0.0.0";
const BOT_TALK_CHANNEL_ID = process.env.BOT_TALK_CHANNEL_ID || "";
const clientsByProfile = new Map<BotProfile["name"], Client>();

const db = createLibsqlClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN
});
const lsHubServices = createLsHubServices({ db });

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
  nodeType?: ContentNodeType,
  limit = 3
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
    `LIMIT ${Math.max(1, Math.floor(limit))}`;

  const args: string[] = nodeType ? [nodeType] : contentTypes;
  const result = await db.execute({ sql, args });
  const rows = result.rows || [];
  if (!rows.length) return null;

  const lines = rows.map((row, idx) => {
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

  const maybeCommand = parseCommand(cleanUserPrompt(message, botUserId));
  const prompt = maybeCommand?.query || cleanUserPrompt(message, botUserId);
  const destination = await ensureDestinationChannel(message, profile.name);
  await destination.sendTyping();

  // /wassup fetches its own context, skip general KB query
  if (maybeCommand?.command === "wassup") {
    try {
      const latest = await queryLatestContent(undefined, 6);
      const wassupContext = latest?.text || "No recent content found.";
      const wassupMethod = latest?.method || "latest_node_lookup";
      const output = await generateResponse(
        profile,
        "What's new in Latent Space? Summarize the most interesting recent content — what dropped, why it matters, and what builders should pay attention to.",
        wassupContext
      );
      await destination.send(modelBadge(profile.model));
      const parts = splitForDiscord(output);
      for (const part of parts) {
        await destination.send(part);
      }
      await destination.send(toolsFooter(wassupMethod));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await destination.send(`${profile.name} hit an error while generating a response: ${msg}`);
    }
    return;
  }

  const smalltalk = !maybeCommand && isGreetingOrSmalltalk(prompt);
  const contextResult = smalltalk
    ? { method: "smalltalk", text: "No graph retrieval needed for greeting/smalltalk." }
    : await queryKnowledgeBase(prompt);
  const context = contextResult.text;
  const contextMethodLine = `Search method: ${contextResult.method}`;

  try {
    const effectivePrompt =
      maybeCommand?.command === "tldr"
        ? `Give a concise TLDR on: ${prompt}. Stick to what the knowledge base says — key points, why it matters, and link to sources.`
        : prompt;
    const output = await generateResponse(profile, effectivePrompt, context, { requireSources: !smalltalk });
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

  const command = interaction.commandName as "tldr" | "wassup";
  await interaction.deferReply();

  if (command === "wassup") {
    const latest = await queryLatestContent(undefined, 6);
    const context = latest?.text || "No recent content found.";
    const contextMethod = latest?.method || "latest_node_lookup";
    const output = await generateResponse(
      profile,
      "What's new in Latent Space? Summarize the most interesting recent content — what dropped, why it matters, and what builders should pay attention to.",
      context
    );
    await interaction.editReply(
      `${modelBadge(profile.model)}\n\n${output}\n\n${toolsFooter(contextMethod)}`.slice(0, 1900)
    );
    return;
  }

  // /tldr
  const query = interaction.options.getString("query", true).trim();
  const contextResult = await queryKnowledgeBase(query);
  const output = await generateResponse(
    profile,
    `Give a concise TLDR on: ${query}. Stick to what the knowledge base says — key points, why it matters, and link to sources.`,
    contextResult.text
  );
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
    new SlashCommandBuilder()
      .setName("tldr")
      .setDescription("Get a concise TLDR on any topic from the Latent Space graph")
      .addStringOption((opt) => opt.setName("query").setDescription("Topic to summarize").setRequired(true)),
    new SlashCommandBuilder()
      .setName("wassup")
      .setDescription("See what's new and interesting in Latent Space")
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
  await Promise.all(profiles.map((profile) => startBot(profile)));
  startKickoffServer();
}

main().catch((error) => {
  console.error("Fatal bot startup error:", error);
  process.exit(1);
});
