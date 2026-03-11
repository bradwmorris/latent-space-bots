# latent-space-bots

Discord bots for Latent Space. Launches with Slop; Sig is optional.

## Status
Gateway runtime implemented for:
- Slop primary client (Sig optional — omit `BOT_TOKEN_SIG` to run Slop-only)
- Mention/reply handling with thread-first replies
- Single-owner thread routing: if a user tags one bot, that bot owns the thread follow-up conversation
- Slash commands: `/join`, `/paper-club`, `/builders-club`
- Slash command: `/edit-event` for updating/canceling your scheduled sessions
- Direct Turso graph access via parameterized SQL
- Channel allowlist + basic rate limiting
- Optional chat logging to Turso (`ENABLE_CHAT_LOG_WRITE=true`)
- Kickoff API (`POST /internal/kickoff`) for announcement → Slop response without mention-trigger dependence
- Daily Paper Club reminder (day-before at 12:00pm PT; DB-backed idempotency)

## Slash commands

| Command | Params | Description |
|---------|--------|-------------|
| `/join` | none | Add yourself as a member node in the Latent Space graph |
| `/paper-club` | none | Schedule a Paper Club session — pick a date and paper |
| `/builders-club` | none | Schedule a Builders Club session — pick a date and topic |
| `/edit-event` | none | Edit title, paper URL, date, or cancel your scheduled event |

## Member Memory

After a user runs `/join`:

- Slop looks up member context before responding.
- Responses are personalized using interests and recent interaction notes.
- After each response, the bot appends a one-line interaction note, updates metadata (`last_active`, `interaction_count`, `interests`), and creates member → content edges for retrieved items.
- Post-response graph writes are non-blocking (Slop still replies even if writes fail).

## Graph runtime

Bots use direct Turso access (`@libsql/client`) for graph reads/writes.

## Persona (`SOUL`) files

Bots now load persona instructions from:
- `personas/sig.soul.md` — **Sig** ("signal"): Precise, skeptical analyst. Structures arguments, cites sources, flags uncertainty. The person in the room who says "show me the benchmark."
- `personas/slop.soul.md` — **Slop** (ironic): First-principles provocateur. Takes strong stances, deconstructs consensus, ends with a challenge. Named after the enemy, fighting from the inside.

Both personas share strict anti-hallucination rules (no fabrication, source-grounded claims, flagged speculation) and are tuned to the Latent Space community's builder-first, anti-slop values.

Startup fails if a required bot's soul file is missing or empty, so persona behavior cannot silently drift.

## Kickoff API

Enable with:

```bash
DEBATE_KICKOFF_SECRET=your-shared-secret
BOT_TALK_CHANNEL_ID=123456789012345678
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
  "prompt": "optional explicit seed prompt"
}
```

Behavior:
- Bot posts a seed message in the target channel.
- It creates a thread when possible (named `Slop: [title]`).
- Slop generates a grounded take on the new content and posts it to the thread.

## Event reminder config

Paper Club reminders run once per day at noon Pacific (`America/Los_Angeles`) and post for events scheduled on the next calendar day.

Required/optional env vars:

- `REMINDERS_ENABLED` (default `true`)
- `PAPER_CLUB_CHANNEL_ID` (required if reminders enabled)
- `REMINDERS_TIMEZONE` (default `America/Los_Angeles`)
- `BOT_INSTANCE_ID` (optional; defaults to host/pid)
