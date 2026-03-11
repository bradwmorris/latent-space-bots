import {
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message
} from "discord.js";
import {
  ALLOWED_CHANNEL_IDS,
  BOT_INSTANCE_ID,
  PAPER_CLUB_CHANNEL_ID,
  REMINDERS_ENABLED,
  REMINDERS_ONE_HOUR_ENABLED,
  REMINDERS_TIMEZONE,
  clientsByProfile,
  db,
} from "../config";
import { registerSlashCommands } from "../commands/register";
import { handleJoinCommand } from "../commands/join";
import { getSchedulingSession, handleScheduleCommand, handleSchedulingReply } from "../commands/schedule";
import { getEditEventSession, handleEditEventCommand, handleEditEventReply } from "../commands/edit-event";
import { clearTraces, getToolTracesSnapshot, logTrace } from "../llm/tracing";
import { buildSystemPrompt, parseProfileBlock } from "../llm/prompts";
import { generateAgenticResponse, generateResponse } from "../llm/generate";
import { getSkillsContextOrThrow } from "../skills";
import { formatMemberContext, lookupMember, updateMemberAfterInteraction } from "../members";
import { cleanUserPrompt, getThreadOwnerBotName, isAllowedChannel, isGreetingOrSmalltalk, shouldRespondToMessage } from "./routing";
import { withinRateLimit } from "./rate-limit";
import { agenticToolsFooter, modelBadge, splitForDiscord } from "./format";
import { ensureDestinationChannel } from "./threads";
import type { BotProfile } from "../types";
import { setupReminders } from "../reminders";

const processedMessageIds = new Set<string>();

export async function handleMessage(client: Client, profile: BotProfile, message: Message): Promise<void> {
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

  const schedulingSession = getSchedulingSession(message.channelId);
  if (schedulingSession && message.author.id === schedulingSession.memberDiscordId) {
    if (processedMessageIds.has(dedupeKey)) return;
    processedMessageIds.add(dedupeKey);
    await handleSchedulingReply(profile, message, schedulingSession);
    return;
  }

  const editSession = getEditEventSession(message.channelId);
  if (editSession && message.author.id === editSession.memberDiscordId) {
    if (processedMessageIds.has(dedupeKey)) return;
    processedMessageIds.add(dedupeKey);
    await handleEditEventReply(message, editSession);
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

  try {
    const { text: rawOutput, toolsUsed, skillsRead, trace } = await generateAgenticResponse(profile, prompt, { systemPrompt });
    const { clean: output, profile: profileUpdate } = parseProfileBlock(rawOutput);
    const nodeIds = getToolTracesSnapshot()
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

export async function handleInteraction(client: Client, profile: BotProfile, interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) return;
  if (interaction.user.bot) return;
  if (ALLOWED_CHANNEL_IDS.size && !ALLOWED_CHANNEL_IDS.has(interaction.channelId || "")) {
    return;
  }

  clearTraces();
  const startTime = Date.now();
  const traceSource = { userId: interaction.user.id, username: interaction.user.username, channelId: interaction.channelId || "", messageId: interaction.id };
  const command = interaction.commandName as "join" | "paper-club" | "builders-club" | "edit-event";
  await interaction.deferReply();

  if (command === "join") {
    await handleJoinCommand(profile, interaction, traceSource, startTime);
    return;
  }

  if (command === "paper-club" || command === "builders-club") {
    await handleScheduleCommand(profile, interaction, command);
    return;
  }

  if (command === "edit-event") {
    await handleEditEventCommand(interaction);
    return;
  }
}

export async function startBot(profile: BotProfile): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });
  clientsByProfile.set(profile.name, client);

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`${profile.name} ready as ${readyClient.user.tag}`);
    if (profile.name === "Slop") {
      setupReminders(client, db, {
        enabled: REMINDERS_ENABLED,
        oneHourEnabled: REMINDERS_ONE_HOUR_ENABLED,
        paperClubChannelId: PAPER_CLUB_CHANNEL_ID,
        instanceId: BOT_INSTANCE_ID,
        timezone: REMINDERS_TIMEZONE,
      });
    }
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
