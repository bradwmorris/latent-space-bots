import { ThreadAutoArchiveDuration, type ChatInputCommandInteraction, type Message } from "discord.js";
import * as dbOps from "../db";
import { db } from "../config";
import { lookupMember } from "../members";
import { logTrace } from "../llm/tracing";
import type { BotProfile, SchedulingSession } from "../types";

const schedulingSessions = new Map<string, SchedulingSession>();

function getNextDatesForDay(targetDay: number, count: number): string[] {
  const dates: string[] = [];
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  while (dates.length < count) {
    if (d.getUTCDay() === targetDay) {
      dates.push(d.toISOString().slice(0, 10));
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

export function getSchedulingSession(channelId: string): SchedulingSession | undefined {
  return schedulingSessions.get(channelId);
}

export async function handleScheduleCommand(
  profile: BotProfile,
  interaction: ChatInputCommandInteraction,
  command: "paper-club" | "builders-club"
): Promise<void> {
  try {
    const member = await lookupMember(interaction.user.id);
    if (!member) {
      await interaction.editReply("You need to `/join` the graph first before scheduling events.");
      return;
    }

    const isPaperClub = command === "paper-club";
    const label = isPaperClub ? "Paper Club" : "Builders Club";
    const targetDay = isPaperClub ? 3 : 5;
    const nextDates = getNextDatesForDay(targetDay, 6);

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
      eventType: command,
      memberId: member.id,
      memberDiscordId: interaction.user.id,
      memberUsername: interaction.user.username,
      availableDates: available,
      step: "pick_date",
    });

    setTimeout(() => schedulingSessions.delete(threadId), 10 * 60 * 1000);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await interaction.editReply(`Couldn't start scheduling: ${msg}`);
  }
}

export async function handleSchedulingReply(profile: BotProfile, message: Message, session: SchedulingSession): Promise<void> {
  const text = message.content.trim();
  const isPaperClub = session.eventType === "paper-club";
  const label = isPaperClub ? "Paper Club" : "Builders Club";

  if (session.step === "pick_date") {
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

    if (titleText) {
      await createScheduledEvent(profile, message, session, chosenDate, titleText);
      return;
    }

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

    schedulingSessions.delete(message.channelId);

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
