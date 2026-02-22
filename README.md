# latent-space-bots

Discord bots for Latent Space (Sig + Slop).

## Status
Gateway runtime implemented for:
- Sig + Slop dual clients in one process
- Mention/reply handling with thread-first replies
- Single-owner thread routing: if a user tags one bot, that bot owns the thread follow-up conversation
- Slash commands: `/ask`, `/search`, `/episode`, `/debate`
- Hybrid retrieval via shared `latent-space-hub-mcp/services` layer (vector + FTS, with fallback)
- Channel allowlist + basic rate limiting
- Optional chat logging to Turso (`ENABLE_CHAT_LOG_WRITE=true`)
- Deterministic kickoff API (`POST /internal/kickoff`) for announcement -> Sig/Slop debate without mention-trigger dependence

## Shared LS services

Bots now consume the shared graph retrieval layer exported by `latent-space-hub-mcp/services`.

If your installed npm package version does not include that export yet, set:

```bash
LSH_MCP_SERVICES_PATH=/absolute/path/to/latent-space-hub/apps/mcp-server-standalone/services
```

## Persona (`SOUL`) files

Bots now load persona instructions from:
- `personas/sig.soul.md` — **Sig** ("signal"): Precise, skeptical analyst. Structures arguments, cites sources, flags uncertainty. The person in the room who says "show me the benchmark."
- `personas/slop.soul.md` — **Slop** (ironic): First-principles provocateur. Takes strong stances, deconstructs consensus, ends with a challenge. Named after the enemy, fighting from the inside.

Both personas share strict anti-hallucination rules (no fabrication, source-grounded claims, flagged speculation) and are tuned to the Latent Space community's builder-first, anti-slop values.

Startup fails if either file is missing or empty, so persona behavior cannot silently drift.

## Deterministic kickoff API

Enable with:

```bash
DEBATE_KICKOFF_SECRET=your-shared-secret
BOT_TALK_CHANNEL_ID=123456789012345678
MAX_KICKOFF_EXCHANGES=2
```

Optional network settings:

```bash
DEBATE_KICKOFF_PORT=8787
DEBATE_KICKOFF_HOST=0.0.0.0
```

Endpoint:

- `POST /internal/kickoff`
- Header: `Authorization: Bearer <DEBATE_KICKOFF_SECRET>`
- Body (JSON, all fields optional except channel resolution):

```json
{
  "channelId": "123456789012345678",
  "title": "Episode title",
  "url": "https://...",
  "contentType": "podcast",
  "eventDate": "2026-02-22",
  "summary": "optional ingestion summary",
  "prompt": "optional explicit debate seed prompt",
  "exchanges": 2
}
```

Behavior:
- Bot posts a seed message in the target channel.
- It creates a thread when possible.
- Sig and Slop run a capped, bot-authored debate sequence directly in that destination.
