# Slop System Message — Full Reference

What Slop sees on every agentic interaction. Assembled at `src/index.ts:653`.

```
${profile.systemPrompt}\n\n${groundingLine}\n${profileStyleLine}\n\n${additionalSystemContext}
```

---

## Part 1: Soul (`personas/slop.soul.md`)

The full persona file. ~6,500 chars.

```
# SOUL: Slop

_Named after the enemy. Fighting from the inside._

You are Slop — Latent Space's provocateur, stress-tester, and devil's advocate...
[see personas/slop.soul.md for full content]
```

**Key sections:**
- Identity — first-principles debater, not a troll
- Voice — high-energy, wry, confidently provocative
- Approach — lead with hottest take, cite sources, end with challenge
- Grounding Rules — no fabrication, mark speculation, conditional takes
- Anti-Patterns — never agree to be agreeable, no hedging, no filler
- Knowledge Base & Tools — lists all 9 tools with usage guidance
- Member Awareness — personalize from context, nudge `/join` for non-members

---

## Part 2: Grounding Line (hardcoded)

```
Use your tools to search the knowledge base BEFORE answering factual questions. Include a short 'Sources' list with direct links in your final response. Never fabricate content — if tools return nothing relevant, say so.
```

---

## Part 3: Style Line (hardcoded)

```
Style: opinionated, sharp, slightly unhinged tone. Keep it concise but punchy. Still ground factual claims in tool results. IMPORTANT: When referencing specific content (episodes, articles, AINews), always include the direct link. Format: [Title](url). Never reference content without linking to it.
```

---

## Part 4: Additional System Context

Assembled from two pieces joined by `\n\n`.

### 4a: Skills Index (`loadSkillsContext()`)

Source: `skills/*.md` frontmatter only. ~727 chars.

```
[SKILLS] You have the following operational skills. Read the full skill with ls_read_skill(name) when you need detailed instructions.
- **Event Scheduling**: Paper Club and Builders Club event scheduling and querying. | When: When a user asks about upcoming events, wants to schedule a session, or asks about Paper Club / Builders Club.
- **Graph Search**: How to search and retrieve content from the Latent Space knowledge graph. | When: When answering any factual question about Latent Space content, episodes, guests, or topics.
- **Member Profiles**: How to manage community member profiles in the knowledge graph. | When: When a user shares personal info, asks about their profile, or when you see an empty member profile.
```

Agent reads full skill body on demand via `ls_read_skill(name)`. The call is intercepted — local `skills/` dir is checked first, falls back to MCP server.

### 4b: Member Context (`formatMemberContext()`)

**If member exists** (example: brad w morris):

```
[MEMBER CONTEXT]
Name: brad w morris
Role: founder and systems eng
Location: Byron Bay, Australia / SF
Interests: details, local-first architecture, knowledge graphs, RAG
Last active: 2026-03-07T10:40:42.646Z
Recent interactions: is there a skill to add events
Use this to personalize your response naturally.
```

**If no member node:**

```
[MEMBER STATUS] This user is not in the member graph yet. Casually mention `/join` when it naturally fits.
```

---

## Tools (OpenAI function calling format)

These 9 read-only tools are passed as the `tools` parameter alongside messages. The LLM can call them during the agentic loop (up to 5 rounds).

| Tool | Purpose |
|------|---------|
| `ls_get_context` | Knowledge graph overview (stats, top nodes, dimensions) |
| `ls_search_nodes` | Find nodes by title/description (supports node_type, date filters) |
| `ls_get_nodes` | Fetch full node records by ID |
| `ls_query_edges` | Traverse connections from a node |
| `ls_list_dimensions` | List all categories/tags with counts |
| `ls_search_content` | Vector + FTS5 search through transcript/article text |
| `ls_sqlite_query` | Read-only SQL for structured queries |
| `ls_list_skills` | List available skills (name + description) |
| `ls_read_skill` | Read full skill body (intercepted: local skills first, then MCP) |

---

## Size Budget

| Section | Chars |
|---------|-------|
| Soul file | ~6,500 |
| Grounding line | ~220 |
| Style line | ~300 |
| Skills index | ~727 |
| Member context | ~300 |
| **Total** | **~8,050** |

---

## Example Flow: "show me upcoming paper clubs"

1. LLM reads skills index → "Event Scheduling" matches the query
2. Calls `ls_read_skill("event-scheduling")`
3. Intercepted → served from local `skills/event-scheduling.md` body
4. Body contains SQL: `SELECT ... FROM nodes WHERE node_type = 'event' AND event_status = 'scheduled'`
5. Calls `ls_sqlite_query` with that pattern
6. Returns upcoming events with dates, presenters, types

## Example Flow: "what was discussed in the latest podcast?"

1. LLM reads skills index → "Graph Search" matches
2. May call `ls_read_skill("graph-search")` or go straight to tools
3. Calls `ls_sqlite_query` with `ORDER BY event_date DESC` for podcasts
4. Calls `ls_get_nodes` or `ls_search_content` for details
5. Returns answer with citations and links

## Adding a New Skill

Drop a `.md` file in `skills/` with frontmatter:

```yaml
---
name: My Skill
description: What this skill covers.
when_to_use: When the agent should read this skill.
---

# Full body here
Detailed instructions the agent gets when it calls ls_read_skill("my-skill").
```

The frontmatter auto-appears in the system prompt. The body is served on demand.
