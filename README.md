# latent-space-bots

Discord bots for Latent Space (Sig + Slop).

## Status
Gateway runtime implemented for:
- Sig + Slop dual clients in one process
- Mention/reply handling with thread-first replies
- Slash commands: `/ask`, `/search`, `/episode`, `/debate`
- Hybrid retrieval attempt (vector + FTS, with fallback)
- Channel allowlist + basic rate limiting
- Optional chat logging to Turso (`ENABLE_CHAT_LOG_WRITE=true`)
