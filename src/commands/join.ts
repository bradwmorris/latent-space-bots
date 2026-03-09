import * as dbOps from "../db";
import { db } from "../config";
import type { BotProfile, MemberMetadata } from "../types";
import { createMemberNodeFromUser, isUniqueConstraintError, lookupMember } from "../members";
import { logTrace } from "../llm/tracing";
import type { ChatInputCommandInteraction } from "discord.js";

const joinInFlight = new Set<string>();

export async function handleJoinCommand(
  profile: BotProfile,
  interaction: ChatInputCommandInteraction,
  traceSource: { userId: string; username: string; channelId: string; messageId: string },
  startTime: number
): Promise<void> {
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
}
