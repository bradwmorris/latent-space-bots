import {
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import * as dbOps from "../db";
import { db, HUB_BASE_URL } from "../config";
import { createMemberNodeFromUser, lookupMember } from "../members";
import { logTrace } from "../llm/tracing";
import type { BotProfile, SchedulingSession } from "../types";
import { getNextDatesForDay } from "./schedulingDates";
import { validateEventDate, validateEventTitle, validatePaperUrl } from "./validation";

const schedulingSessions = new Map<string, SchedulingSession>();
const schedulingInFlight = new Set<string>();
const sessionTimeouts = new Map<string, NodeJS.Timeout>();
const warningTimeouts = new Map<string, NodeJS.Timeout>();

const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const WARNING_TIMEOUT_MS = 8 * 60 * 1000;

function clearSessionTimers(sessionKey: string): void {
  const timeout = sessionTimeouts.get(sessionKey);
  if (timeout) clearTimeout(timeout);
  sessionTimeouts.delete(sessionKey);

  const warning = warningTimeouts.get(sessionKey);
  if (warning) clearTimeout(warning);
  warningTimeouts.delete(sessionKey);
}

function clearSchedulingSession(sessionKey: string): void {
  schedulingSessions.delete(sessionKey);
  clearSessionTimers(sessionKey);
}

function registerSchedulingSession(sessionKey: string, session: SchedulingSession, channelIdForWarning: string): void {
  schedulingSessions.set(sessionKey, session);

  const warningTimer = setTimeout(() => {
    const active = schedulingSessions.get(sessionKey);
    if (!active) return;
    const client = active.clientRef;
    if (!client) return;
    client.channels.fetch(channelIdForWarning).then((channel) => {
      if (channel && channel.isTextBased() && "send" in channel) {
        void channel.send("Heads up: this scheduling session expires in 2 minutes. Reply now to continue.");
      }
    }).catch(() => {});
  }, WARNING_TIMEOUT_MS);
  warningTimeouts.set(sessionKey, warningTimer);

  const timeoutTimer = setTimeout(() => {
    clearSchedulingSession(sessionKey);
  }, SESSION_TIMEOUT_MS);
  sessionTimeouts.set(sessionKey, timeoutTimer);
}

export function getSchedulingSession(channelId: string): SchedulingSession | undefined {
  return schedulingSessions.get(channelId);
}

export async function handleScheduleCommand(
  profile: BotProfile,
  interaction: ChatInputCommandInteraction,
  command: "paper-club" | "builders-club"
): Promise<void> {
  const inFlightKey = `${interaction.user.id}:${command}`;
  if (schedulingInFlight.has(inFlightKey)) {
    await interaction.editReply(`You already have a ${command} scheduling flow in progress.`);
    return;
  }
  schedulingInFlight.add(inFlightKey);

  try {
    let member = await lookupMember(interaction.user.id);
    if (!member) {
      await createMemberNodeFromUser(interaction.user);
      member = await lookupMember(interaction.user.id);
      if (!member) {
        await interaction.editReply("Couldn't create your profile. Try again or run `/join` first.");
        return;
      }
    }

    const isPaperClub = command === "paper-club";
    const label = isPaperClub ? "Paper Club" : "Builders Club";
    const targetDay = isPaperClub ? 3 : 5;
    const nextDates = getNextDatesForDay(targetDay, 6);

    const booked = await dbOps.getBookedDates(db, command, nextDates);
    const available = nextDates.filter((d) => !booked.has(d)).slice(0, 4);

    if (!available.length) {
      await interaction.editReply(`All upcoming ${label} slots are booked. Try again later.`);
      return;
    }

    const dayLabel = isPaperClub ? "Wed" : "Fri";
    const lines = available.map((d, i) => {
      const date = new Date(`${d}T12:00:00Z`);
      const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
      const day = date.getUTCDate();
      return `**${i + 1}.** ${dayLabel} ${month} ${day} (${d})`;
    });

    const prompt = isPaperClub
      ? "Reply with the **number** of the date you want, and the **paper title** (optionally with URL)."
      : "Reply with the **number** of the date you want, and your **topic**.";

    const message = await interaction.editReply(
      `**Schedule a ${label} session**\n\nAvailable dates:\n${lines.join("\n")}\n\n${prompt}`
    );

    let sessionKey = interaction.channelId || "";
    let warningChannelId = interaction.channelId || "";
    let usingFallbackChannel = true;

    try {
      const channel = interaction.channel;
      if (channel && "threads" in channel && channel.threads) {
        const thread = await channel.threads.create({
          name: `${label}: ${interaction.user.username} scheduling`,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
          startMessage: message.id,
          reason: `${label} scheduling thread`,
        });
        sessionKey = thread.id;
        warningChannelId = thread.id;
        usingFallbackChannel = false;
      }
    } catch {
      // Falls back to the interaction channel.
    }

    if (usingFallbackChannel && schedulingSessions.has(sessionKey)) {
      await interaction.followUp("Another scheduling session is active in this channel. Try again in a few minutes.");
      return;
    }

    registerSchedulingSession(sessionKey, {
      eventType: command,
      memberId: member.id,
      memberDiscordId: interaction.user.id,
      memberUsername: interaction.user.username,
      availableDates: available,
      step: "pick_date",
      clientRef: interaction.client,
    }, warningChannelId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await interaction.editReply(`Couldn't start scheduling: ${msg}`);
  } finally {
    schedulingInFlight.delete(inFlightKey);
  }
}

export async function handleSchedulingReply(
  profile: BotProfile,
  message: Message,
  session: SchedulingSession
): Promise<void> {
  const text = message.content.trim();
  const isPaperClub = session.eventType === "paper-club";

  if (session.step === "pick_date") {
    const match = text.trim().match(/^(\d)\s*(.*)/s);
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

    if (titleText) {
      await createScheduledEvent(profile, message, session, chosenDate, titleText);
      return;
    }

    session.chosenDate = chosenDate;
    session.step = "pick_title";
    const dateLabel = new Date(`${chosenDate}T12:00:00Z`).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const ask = isPaperClub
      ? `Got it: **${dateLabel}**. What paper are you presenting? (title, optionally URL)`
      : `Got it: **${dateLabel}**. What's your topic?`;
    await message.reply(ask);
    return;
  }

  if (session.step === "pick_title") {
    if (!text) {
      await message.reply(isPaperClub ? "What paper are you presenting?" : "What's your topic?");
      return;
    }
    await createScheduledEvent(profile, message, session, session.chosenDate!, text);
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
    const dateValidation = validateEventDate(dateStr, session.eventType);
    if (!dateValidation.valid) {
      await message.reply(dateValidation.error || "That date is not valid anymore. Please restart scheduling.");
      return;
    }

    let paperUrl: string | undefined;
    let rawTitle = titleText;
    if (isPaperClub) {
      const urlMatch = titleText.match(/(https?:\/\/\S+)/);
      if (urlMatch) {
        const validUrl = validatePaperUrl(urlMatch[1]);
        if (!validUrl.valid) {
          await message.reply(validUrl.error || "Paper URL is invalid.");
          return;
        }
        paperUrl = validUrl.url;
        rawTitle = titleText.replace(urlMatch[0], "").trim();
      }
    }

    const titleValidation = validateEventTitle(rawTitle);
    if (!titleValidation.valid) {
      await message.reply(titleValidation.error || "Title is invalid.");
      return;
    }
    const cleanTitle = titleValidation.title;

    const eventPayload: Parameters<typeof dbOps.createEventNodeAtomic>[1] = isPaperClub
      ? {
          title: `${label}: ${cleanTitle}`,
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
          title: `${label}: ${cleanTitle}`,
          description: `Hosted by ${session.memberUsername}. ${cleanTitle}`,
          event_date: dateStr,
          event_type: "builders-club",
          presenter_name: session.memberUsername,
          presenter_discord_id: session.memberDiscordId,
          presenter_node_id: session.memberId,
          topic: cleanTitle,
        };

    const created = await dbOps.createEventNodeAtomic(db, eventPayload);
    if (created.alreadyBooked) {
      await message.reply("That slot was just taken. Pick another date with `/paper-club` or `/builders-club`.");
      clearSchedulingSession(message.channelId);
      return;
    }

    await dbOps.createEdge(db, session.memberId, created.nodeId, `hosting ${label} session`);

    const dateLabel = new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    const deepLink = `${HUB_BASE_URL}/?type=${session.eventType}`;
    const reply = `**${label} scheduled!**\n📅 ${dateLabel}\n📝 ${cleanTitle}\n🎤 ${session.memberUsername}\n\n[View in the Hub](${deepLink})`;
    await message.reply(reply);

    clearSchedulingSession(message.channelId);

    const traceSource = {
      userId: session.memberDiscordId,
      username: session.memberUsername,
      channelId: message.channelId,
      messageId: message.id,
    };
    await logTrace(profile, traceSource, `/${session.eventType}`, reply, {
      retrieval_method: "event_create",
      context_node_ids: [created.nodeId],
      member_id: session.memberId,
      is_slash_command: true,
      slash_command: session.eventType,
      is_kickoff: false,
      latency_ms: 0,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await message.reply(`Couldn't create the event: ${msg}`);
    clearSchedulingSession(message.channelId);
  }
}
