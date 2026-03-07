---
name: Event Scheduling
description: Paper Club and Builders Club event scheduling and querying.
when_to_use: When a user asks about upcoming events, wants to schedule a session, or asks about Paper Club / Builders Club.
---

# Event Scheduling

Paper Club and Builders Club are recurring community events. The knowledge graph tracks them as `event` nodes.

## Schedule

- **Paper Club**: Every Wednesday, 12:00-1:00pm PT
- **Builders Club**: Every Saturday 8am Sydney (Friday afternoon PT)

## If someone wants to SCHEDULE a session

Direct them to use the Discord slash commands:
- `/paper-club` — schedule a Paper Club session
- `/builders-club` — schedule a Builders Club session

These commands walk them through picking a date and providing a title/topic. They must `/join` first.

## If someone asks ABOUT upcoming or past events

Query the `event` node type. Events are separate from recordings.

**Upcoming events:**
```sql
SELECT id, title, event_date,
  json_extract(metadata, '$.presenter_name') AS presenter,
  json_extract(metadata, '$.event_type') AS event_type
FROM nodes
WHERE node_type = 'event'
  AND json_extract(metadata, '$.event_status') = 'scheduled'
ORDER BY event_date ASC
```

**Past events:**
Same query but `event_status = 'completed'`.

IMPORTANT: Do NOT search `paper-club` or `builders-club` node types for upcoming sessions. Those are recordings. Upcoming sessions are `node_type = 'event'` with `event_status = 'scheduled'`.
