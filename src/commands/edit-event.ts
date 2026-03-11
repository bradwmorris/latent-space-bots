import {
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import * as dbOps from "../db";
import { db } from "../config";
import { lookupMember } from "../members";
import { getNextDatesForDay } from "./schedulingDates";
import { validateEventDate, validateEventTitle, validatePaperUrl } from "./validation";

type EditableEvent = {
  id: number;
  title: string;
  eventDate: string;
  eventType: "paper-club" | "builders-club";
  metadata: Record<string, unknown>;
};

type EditSession = {
  memberDiscordId: string;
  memberNodeId?: number;
  memberUsername?: string;
  events: EditableEvent[];
  selectedEventId?: number;
  step: "pick_event" | "menu" | "edit_title" | "edit_url" | "pick_date";
  dateOptions?: string[];
};

const editSessions = new Map<string, EditSession>();
const editTimeouts = new Map<string, NodeJS.Timeout>();
const EDIT_TIMEOUT_MS = 10 * 60 * 1000;

function clearEditSession(key: string): void {
  editSessions.delete(key);
  const timeout = editTimeouts.get(key);
  if (timeout) clearTimeout(timeout);
  editTimeouts.delete(key);
}

function registerEditSession(key: string, session: EditSession): void {
  editSessions.set(key, session);
  const timeout = setTimeout(() => clearEditSession(key), EDIT_TIMEOUT_MS);
  editTimeouts.set(key, timeout);
}

function getSelectedEvent(session: EditSession): EditableEvent | null {
  if (!session.selectedEventId) return null;
  return session.events.find((e) => e.id === session.selectedEventId) || null;
}

function formatEventLine(event: EditableEvent, idx: number): string {
  const label = event.eventType === "paper-club" ? "Paper Club" : "Builders Club";
  return `**${idx + 1}.** ${label} — ${event.eventDate} — ${event.title}`;
}

function menuPrompt(eventType: "paper-club" | "builders-club"): string {
  if (eventType === "paper-club") {
    return "Reply with:\n`1` change title\n`2` change paper URL\n`3` reschedule date\n`4` cancel event\n`5` done";
  }
  return "Reply with:\n`1` change title\n`2` reschedule date\n`3` cancel event\n`4` done";
}

function toEditableEvent(row: dbOps.ScheduledEventRow): EditableEvent | null {
  const metadata = (row.metadata && typeof row.metadata === "object")
    ? (row.metadata as Record<string, unknown>)
    : {};
  const eventType = metadata.event_type;
  if (eventType !== "paper-club" && eventType !== "builders-club") return null;
  return {
    id: row.id,
    title: row.title,
    eventDate: row.event_date,
    eventType,
    metadata,
  };
}

export function getEditEventSession(channelId: string): EditSession | undefined {
  return editSessions.get(channelId);
}

export async function handleEditEventCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const member = await lookupMember(interaction.user.id);
    const rows = await dbOps.getScheduledEventsByPresenter(db, {
      presenterDiscordId: interaction.user.id,
      presenterNodeId: member?.id,
      presenterName: interaction.user.username,
    });
    const events = rows.map(toEditableEvent).filter((event): event is EditableEvent => event !== null);
    if (!events.length) {
      await interaction.editReply("You don't have any upcoming scheduled events.");
      return;
    }

    const message = await interaction.editReply("Opening event editor...");
    let sessionKey = interaction.channelId || "";
    let fallback = true;
    let promptChannel = interaction.channel;

    try {
      const channel = interaction.channel;
      if (channel && "threads" in channel && channel.threads) {
        const thread = await channel.threads.create({
          name: `Edit Event: ${interaction.user.username}`,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
          startMessage: message.id,
          reason: "Event editing thread",
        });
        sessionKey = thread.id;
        fallback = false;
        promptChannel = thread;
      }
    } catch {
      // Fall back to channel session.
    }

    if (fallback && editSessions.has(sessionKey)) {
      await interaction.followUp("Another event editing session is already active in this channel.");
      return;
    }

    const canSend = promptChannel && promptChannel.isTextBased() && "send" in promptChannel;
    if (!canSend) {
      await interaction.followUp("Couldn't open an editable thread/channel for this command. Please try again.");
      return;
    }

    if (events.length === 1) {
      const only = events[0];
      registerEditSession(sessionKey, {
        memberDiscordId: interaction.user.id,
        memberNodeId: member?.id,
        memberUsername: interaction.user.username,
        events,
        selectedEventId: only.id,
        step: "menu",
      });
      await (promptChannel as unknown as { send: (x: string) => Promise<unknown> }).send(
        `Editing:\n${formatEventLine(only, 0)}\n\n` +
        menuPrompt(only.eventType)
      );
      return;
    }

    registerEditSession(sessionKey, {
      memberDiscordId: interaction.user.id,
      memberNodeId: member?.id,
      memberUsername: interaction.user.username,
      events,
      step: "pick_event",
    });
    await (promptChannel as unknown as { send: (x: string) => Promise<unknown> }).send(
      `Pick the event to edit:\n${events.map((event, idx) => formatEventLine(event, idx)).join("\n")}`
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await interaction.editReply(`Couldn't open event editor: ${msg}`);
  }
}

export async function handleEditEventReply(message: Message, session: EditSession): Promise<void> {
  const text = message.content.trim();

  if (session.step === "pick_event") {
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n) || n < 1 || n > session.events.length) {
      await message.reply(`Pick a number between 1 and ${session.events.length}.`);
      return;
    }
    const selected = session.events[n - 1];
    session.selectedEventId = selected.id;
    session.step = "menu";
    await message.reply(
      `Editing:\n${formatEventLine(selected, n - 1)}\n\n` +
      menuPrompt(selected.eventType)
    );
    return;
  }

  const selected = getSelectedEvent(session);
  if (!selected) {
    clearEditSession(message.channelId);
    await message.reply("This edit session expired. Please run `/edit-event` again.");
    return;
  }

  if (session.step === "menu") {
    if (text === "1") {
      session.step = "edit_title";
      await message.reply("Send the new title/topic.");
      return;
    }
    if (selected.eventType === "paper-club" && text === "2") {
      session.step = "edit_url";
      await message.reply("Send the new paper URL, or `none` to remove it.");
      return;
    }

    const rescheduleChoice = selected.eventType === "paper-club" ? "3" : "2";
    const cancelChoice = selected.eventType === "paper-club" ? "4" : "3";
    const doneChoice = selected.eventType === "paper-club" ? "5" : "4";

    if (text === rescheduleChoice) {
      const targetDay = selected.eventType === "paper-club" ? 3 : 5;
      const nextDates = getNextDatesForDay(targetDay, 8);
      const booked = await dbOps.getBookedDates(db, selected.eventType, nextDates);
      const options = nextDates.filter((d) => d === selected.eventDate || !booked.has(d)).slice(0, 6);
      session.dateOptions = options;
      session.step = "pick_date";
      await message.reply(
        `Pick a new date:\n${options.map((d, idx) => `**${idx + 1}.** ${d}`).join("\n")}`
      );
      return;
    }
    if (text === cancelChoice) {
      const result = await dbOps.updateEventNode(db, {
        nodeId: selected.id,
        presenterDiscordId: session.memberDiscordId,
        presenterNodeId: session.memberNodeId,
        presenterName: session.memberUsername,
        cancel: true,
      });
      if (!result.ok) {
        await message.reply("Couldn't cancel this event (not found, not yours, or already updated).");
        clearEditSession(message.channelId);
        return;
      }
      await message.reply("Event cancelled.");
      clearEditSession(message.channelId);
      return;
    }
    if (text === doneChoice) {
      await message.reply("Done. Event editor closed.");
      clearEditSession(message.channelId);
      return;
    }
    await message.reply("That option isn't valid for this event type. Use the numbered menu shown above.");
    return;
  }

  if (session.step === "edit_title") {
    const validTitle = validateEventTitle(text);
    if (!validTitle.valid) {
      await message.reply(validTitle.error || "Invalid title.");
      return;
    }
    const label = selected.eventType === "paper-club" ? "Paper Club" : "Builders Club";
    const result = await dbOps.updateEventNode(db, {
      nodeId: selected.id,
      presenterDiscordId: session.memberDiscordId,
      presenterNodeId: session.memberNodeId,
      presenterName: session.memberUsername,
      title: `${label}: ${validTitle.title}`,
      description: `Hosted by ${selected.metadata.presenter_name || "presenter"}. ${validTitle.title}`,
      metadataUpdates: selected.eventType === "paper-club"
        ? { paper_title: validTitle.title }
        : { topic: validTitle.title },
    });
    if (!result.ok) {
      await message.reply("Couldn't update title.");
      clearEditSession(message.channelId);
      return;
    }
    selected.title = `${label}: ${validTitle.title}`;
    session.step = "menu";
    await message.reply(`Title updated.\n\n${menuPrompt(selected.eventType)}`);
    return;
  }

  if (session.step === "edit_url") {
    if (text.toLowerCase() === "none") {
      const result = await dbOps.updateEventNode(db, {
        nodeId: selected.id,
        presenterDiscordId: session.memberDiscordId,
        presenterNodeId: session.memberNodeId,
        presenterName: session.memberUsername,
        metadataUpdates: { paper_url: null },
      });
      if (!result.ok) {
        await message.reply("Couldn't remove paper URL.");
        clearEditSession(message.channelId);
        return;
      }
      session.step = "menu";
      await message.reply(`Paper URL removed.\n\n${menuPrompt(selected.eventType)}`);
      return;
    }

    const validUrl = validatePaperUrl(text);
    if (!validUrl.valid) {
      await message.reply(validUrl.error || "Invalid URL.");
      return;
    }
    const result = await dbOps.updateEventNode(db, {
      nodeId: selected.id,
      presenterDiscordId: session.memberDiscordId,
      presenterNodeId: session.memberNodeId,
      presenterName: session.memberUsername,
      metadataUpdates: { paper_url: validUrl.url },
    });
    if (!result.ok) {
      await message.reply("Couldn't update paper URL.");
      clearEditSession(message.channelId);
      return;
    }
    session.step = "menu";
    await message.reply(`Paper URL updated.\n\n${menuPrompt(selected.eventType)}`);
    return;
  }

  if (session.step === "pick_date") {
    const options = session.dateOptions || [];
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n) || n < 1 || n > options.length) {
      await message.reply(`Pick a number between 1 and ${options.length}.`);
      return;
    }
    const chosenDate = options[n - 1];
    const validDate = validateEventDate(chosenDate, selected.eventType);
    if (!validDate.valid) {
      await message.reply(validDate.error || "Invalid date.");
      return;
    }
    const result = await dbOps.updateEventNode(db, {
      nodeId: selected.id,
      presenterDiscordId: session.memberDiscordId,
      presenterNodeId: session.memberNodeId,
      presenterName: session.memberUsername,
      eventDate: chosenDate,
    });
    if (!result.ok) {
      if (result.reason === "already_booked") {
        await message.reply("That slot is no longer available. Pick another date.");
      } else {
        await message.reply("Couldn't reschedule this event.");
        clearEditSession(message.channelId);
      }
      return;
    }
    selected.eventDate = chosenDate;
    session.step = "menu";
    await message.reply(`Date updated to ${chosenDate}.\n\n${menuPrompt(selected.eventType)}`);
  }
}
