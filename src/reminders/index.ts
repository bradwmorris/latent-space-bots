import type { Client as LibsqlClient } from "@libsql/client";
import type { Client as DiscordClient } from "discord.js";
import cron from "node-cron";
import {
  claimPaperClub24hReminder,
  finalizePaperClub24hReminder,
  getPaperClubEventsForDate,
  releasePaperClub24hReminderClaim,
} from "../db";

type ReminderConfig = {
  enabled: boolean;
  paperClubChannelId: string;
  instanceId: string;
  timezone: string;
};

function formatIsoDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Failed to format date parts for reminders.");
  }
  return `${year}-${month}-${day}`;
}

function getTomorrowDateInTimeZone(timeZone: string): string {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return formatIsoDateInTimeZone(tomorrow, timeZone);
}

export function setupReminders(client: DiscordClient, db: LibsqlClient, config: ReminderConfig): void {
  if (!config.enabled) {
    console.log("[reminders] Disabled (REMINDERS_ENABLED=false)");
    return;
  }

  if (!config.paperClubChannelId) {
    console.warn("[reminders] PAPER_CLUB_CHANNEL_ID is not set; reminders disabled.");
    return;
  }

  cron.schedule(
    "0 12 * * *",
    async () => {
      const targetDate = getTomorrowDateInTimeZone(config.timezone);
      console.log(`[reminders] Checking paper-club reminders for event_date=${targetDate}`);

      try {
        const events = await getPaperClubEventsForDate(db, targetDate);
        if (!events.length) {
          console.log("[reminders] No reminder candidates.");
          return;
        }

        const channel = await client.channels.fetch(config.paperClubChannelId);
        if (!channel || !channel.isTextBased()) {
          console.warn("[reminders] Paper Club channel missing or not text-based.");
          return;
        }
        const sendChannel = "send" in channel && typeof channel.send === "function" ? channel : null;
        if (!sendChannel) {
          console.warn("[reminders] Paper Club channel does not support sending messages.");
          return;
        }

        for (const event of events) {
          const claimed = await claimPaperClub24hReminder(db, event.id, config.instanceId);
          if (!claimed) continue;

          const metadata = (event.metadata && typeof event.metadata === "object" ? event.metadata : {}) as Record<string, unknown>;
          const presenterId = typeof metadata.presenter_discord_id === "string" ? metadata.presenter_discord_id : "";
          const presenterName = typeof metadata.presenter_name === "string" ? metadata.presenter_name : "TBD";
          const paperUrl = typeof metadata.paper_url === "string" ? metadata.paper_url : "";
          const presenterMention = presenterId ? `<@${presenterId}>` : presenterName;
          const paperLine = paperUrl
            ? `\n\nReview the paper and come prepared with questions:\n${paperUrl}`
            : "";

          try {
            const sent = await sendChannel.send({
              content:
                `📅 **Paper Club tomorrow (12pm PT)**\n\n` +
                `${presenterMention} is presenting: **${event.title}**${paperLine}`,
              allowedMentions: { parse: ["users"] },
            });
            await finalizePaperClub24hReminder(db, event.id, sent.id);
            console.log(`[reminders] Sent reminder for event=${event.id}`);
          } catch (error) {
            await releasePaperClub24hReminderClaim(db, event.id, config.instanceId);
            console.error(`[reminders] Failed sending reminder for event=${event.id}:`, error);
          }
        }
      } catch (error) {
        console.error("[reminders] Reminder check failed:", error);
      }
    },
    { timezone: config.timezone }
  );

  console.log(`[reminders] Scheduler started (daily 12:00 ${config.timezone})`);
}
