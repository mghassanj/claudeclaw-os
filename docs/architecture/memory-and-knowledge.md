# Memory & Knowledge Architecture

ClaudeClaw uses a 5-layer memory model. This doc is the source of truth
referenced by the ops agent's CLAUDE.md.

## Layer 1 — Conversational memory
Ephemeral facts auto-extracted from user-bot exchanges.
Storage: SQLite `store/claudeclaw.db` — tables `memory`, `memories`,
`memories_fts`, `hive_mind`, `conversation_log`, `consolidations`,
`session_summaries`. Managed by `dist/memory-ingest.js`.

## Layer 2 — Personal knowledge (Obsidian vault)
Curated notes: people, projects, decisions, journal.
Storage: `/home/ubuntu/vault/` (Mac is authoritative, synced via Syncthing).
Agent writes go to `/home/ubuntu/vault/Inbox/Bot/<agent>/` with required
frontmatter (`source: claudeclaw, agent: <id>, created: <ISO-date>`).

## Layer 3 — Per-project context
A `CLAUDE.md` at the root of each project repo.

## Layer 4 — Procedural knowledge (Skills)
Reusable workflows in `~/.claude/skills/<skill>/` with SKILL.md frontmatter.

## Layer 5 — Enterprise data (RAG)
Bulk read-mostly: KB articles, regulations, transcripts.
Storage: Neon Postgres + pgvector. MCP server at
`/home/ubuntu/rag-platform/mcp/server.py`. Hybrid retrieval
(0.6 semantic + 0.4 keyword, top-50 prefetch, Voyage rerank-2).
Cron ingests `jisr_kb` every 6h. 8 Saudi-gov source modules ingested.

## Invariants (enforced by ops CLAUDE.md hard rules)
- Personal notes go to Obsidian, never Neon.
- Bulk source data goes to Neon, never Obsidian.
- Never switch the embedding model after Stage 0 without dropping +
  re-ingesting all chunks (vector dim is fixed at column creation).
- Never use Gemini embeddings — Gemini is reserved for voice.
  Use Voyage (default) or OpenAI.
