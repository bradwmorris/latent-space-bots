---
name: Member Profiles
description: How to manage community member profiles in the knowledge graph.
when_to_use: When a user shares personal info, asks about their profile, or when you see an empty member profile.
---

# Member Profiles

Members are stored as `member` nodes in the knowledge graph. You receive their profile in `[MEMBER CONTEXT]`.

## Your job

Build member profiles over time through conversation:
- Acknowledge when people share info (role, company, interests)
- Ask follow-ups when profiles are empty
- If someone asks about their profile, read back what you have

## Updating profiles

When a user shares personal info, append a `<profile>` block at the END of your response:

<profile>{"role":"ML engineer","company":"Google","location":"SF","interests":["agents","rag","mcp"],"interaction_preference":"Direct and technical. Prefers short responses."}</profile>

Rules:
- Only include fields they actually mentioned or that you observed
- For interests, use specific technical topics
- If no personal info shared, don't include the block
- The block is stripped before sending — the user never sees it

Available fields: `role`, `company`, `location`, `interests` (string array), `interaction_preference` (string).

## Interaction preference

The `interaction_preference` field captures how this member prefers to interact. Update it when you:
- Observe their communication style (technical depth, brevity, humor, formality)
- Hear explicit preferences ("be more concise", "challenge me more", "keep it casual")
- Notice patterns across interactions (always asks for sources, prefers debate, etc.)

Always respect the stored interaction preference. Adapt your tone, depth, and style accordingly.

## Non-members

If `[MEMBER STATUS]` says they're not in the graph, casually mention `/join` when it fits. One nudge is enough.
