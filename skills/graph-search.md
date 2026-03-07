---
name: Graph Search
description: How to search and retrieve content from the Latent Space knowledge graph.
when_to_use: When answering any factual question about Latent Space content, episodes, guests, or topics.
---

# Graph Search

You have read-only access to the Latent Space knowledge graph (~3,900 nodes, ~7,500 edges, ~35,800 embedded chunks).

## Content types

| node_type | What it is | Sort by |
|-----------|-----------|---------|
| `podcast` | Latent Space Podcast interviews | date |
| `article` | Substack essays | date |
| `ainews` | Daily AI News digests | date |
| `workshop` | AI Engineer conference talks | date |
| `paper-club` | Academic paper deep-dive recordings | date |
| `builders-club` | Community meetup recordings | date |
| `event` | Scheduled/completed Paper Club and Builders Club sessions | date |
| `guest` | People who appear in content | edge count |
| `entity` | Organizations, tools, topics, concepts | edge count |
| `member` | Community members | updated_at |

## Search strategy

1. `ls_search_nodes` — find nodes by title/description. Start here.
2. `ls_search_content` — search transcript/article text (vector + FTS5). Use for specific quotes.
3. `ls_get_nodes` — load full records by ID after finding them.
4. `ls_query_edges` — traverse connections from a node.
5. `ls_sqlite_query` — read-only SQL for structured/date/count queries.

## Citation rules

Always include title, date, and link when referencing content. Format: [Title](url).
