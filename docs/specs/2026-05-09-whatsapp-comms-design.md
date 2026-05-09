# WhatsApp Comms Channel — Design Spec

**Status:** Draft, pending implementation
**Date:** 2026-05-09
**Owner:** Mohamed Ghassan (mghassan@jisr.net)
**Related:** Saudi Gov RAG ingestion design (`rag-platform/docs/superpowers/specs/2026-05-09-saudi-gov-rag-ingestion-design.md`) — provides the corpus this channel queries.

## TL;DR

Add a new always-on WhatsApp listener that gives the **comms** sub-agent identity a third channel (alongside Slack and Gmail). Listens to messages in the "Pilot with Ghassan AI" group and auto-replies with RAG-grounded answers, escalating to media generation (existing or AI-generated images, PDFs, documents, videos, audio podcasts) when an answer needs more than text. Connection via unofficial `whatsapp-web.js` library on Mohamed's personal WhatsApp number. Three new MCP servers wrap external media APIs (Nano Banana, GPT-Image-1, HeyGen, NotebookLM, Whisper). One new systemd unit, one new audit table, no new agent identities.

## Background

ClaudeClaw's comms sub-agent today owns Slack + Gmail. WhatsApp is the dominant customer-support channel for Saudi HR teams (Jisr customers, Master Works clients). The "Pilot with Ghassan AI" WhatsApp group is positioned as an early test for AI-assisted HR support — the group name itself signals to members that AI is in the loop. Members ask HR / labor / compliance questions, and the bot replies with citations from the freshly-ingested Saudi gov corpus (qiwa, mudad, hrsd, vision2030 + existing labor-law / GOSI / Jisr KB).

This is **not** a generic chatbot. It's a focused HR-support assistant grounded in the RAG corpus, with the comms persona, and conservative escalation to media generation when text isn't enough.

## Scope

**In scope:**
- WhatsApp Web session on Mohamed's personal number, linked to AWS-hosted Chrome via `whatsapp-web.js`
- Reply to every message in the "Pilot with Ghassan AI" group (allowlisted; bot ignores all other groups)
- 8 reply tiers (text, existing image, existing PDF, generated doc, generated image, generated video, generated audio podcast, inbound voice transcription)
- 🤖 emoji prefix on every reply + citation footer when RAG-grounded
- Persistent audit log of every inbound + outbound message
- Three kill switches (master toggle, group allowlist, per-tier disable)
- Hooks into existing `claudeclaw-healthcheck.timer` for liveness + WA-auth health monitoring

**Out of scope:**
- Sending unsolicited messages outside the allowlisted group
- Multi-group support (one group only in v1; allowlist allows future expansion)
- Sending to individuals (only group context)
- Veo 3 video generation (HeyGen handles avatar narration which is the right shape for HR support)
- Routing text replies through OpenAI GPT-4o (Sonnet 4.6 is right tool, free via Pro/Max OAuth)
- DALL-E 3 / older OpenAI image models (GPT-Image-1 is the current best)
- WhatsApp Cloud API / Meta Business API (limited group support; unofficial library is the right tool for personal-group use case)
- Veo 3 / Sora / Runway video generation (HeyGen avatar covers HR-support need)

## Success criteria

1. Group members get cited, accurate answers within 5 seconds for text-only questions and within 90 seconds for media-generation requests.
2. Bot correctly identifies and routes by topic (Qiwa / Mudad / HRSD / Vision 2030 / labor law / GOSI) per the comms agent's existing routing table.
3. Zero accidental replies in groups other than "Pilot with Ghassan AI".
4. Audit log captures 100% of inbound + outbound exchanges with idempotency (no double-replies on service restart).
5. Mohamed's personal WhatsApp account does not get banned within first 30 days of operation (proxy: throttling + identifying prefix + allowlisted group is sufficient mitigation).

## Architecture

```
                          ┌─────────────────────────────────────────┐
                          │  Persistent Chrome (private profile)    │
                          │  /home/ubuntu/.wwebjs_auth/ (mode 700)  │
                          │  WhatsApp Web session — your number     │
                          └────────────────────▲────────────────────┘
                                               │ Puppeteer (whatsapp-web.js)
                                               │
   ┌───────────────────────────────────────────┴─────────────────────────────────────────┐
   │  claudeclaw-comms-whatsapp.service (NEW Node + TypeScript)                          │
   │                                                                                      │
   │  on incoming msg in "Pilot with Ghassan AI":                                        │
   │    1. idempotency check (whatsapp_exchanges UNIQUE constraint)                      │
   │    2. fetch last 8 group msgs → conversation context                                │
   │    3. detect inbound type (text vs voice)                                           │
   │       └─ if voice → Whisper transcribe → continue as text (Tier 8)                  │
   │    4. detect language (ar/en) via fasttext                                          │
   │    5. spawn Claude Sonnet 4.6 call:                                                 │
   │         system = comms/CLAUDE.md + WA-specific reply rules                          │
   │         tools = (see Tool surface below)                                            │
   │    6. Claude reasons + tool-calls + composes reply                                  │
   │    7. throttle (max 1 send / 3s globally)                                           │
   │    8. send via whatsapp-web.js with 🤖 prefix + citation footer                     │
   │    9. write whatsapp_exchanges audit row                                            │
   └─────────────────────────────────────────────────────────────────────────────────────┘
                  │                       │                       │
                  ▼                       ▼                       ▼
        ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
        │   rag MCP        │    │  imagegen MCP    │    │  videogen MCP    │
        │   (existing)     │    │  Nano Banana +   │    │  HeyGen          │
        │                  │    │  GPT-Image-1     │    │                  │
        └──────────────────┘    └──────────────────┘    └──────────────────┘
                                ┌──────────────────┐    ┌──────────────────┐
                                │ podcastgen MCP   │    │ transcribe util  │
                                │ NotebookLM (?)   │    │ Whisper inline   │
                                └──────────────────┘    └──────────────────┘
                                          │
                                          ▼
                                ┌──────────────────────┐
                                │ Neon Postgres        │
                                │ whatsapp_exchanges   │
                                └──────────────────────┘
```

**Why standalone (not under existing comms service):** Comms is request/response (Telegram message → respond → exit). WhatsApp needs always-on socket listening. Different lifecycle, but **same identity** — runs Sonnet 4.6, loads `agents/comms/CLAUDE.md`, follows the same RAG routing table.

## Tool surface

The Claude call inside `claudeclaw-comms-whatsapp.service` has access to:

| Tool | Backed by | Tier | Latency p50 |
|---|---|---|---|
| `search_enterprise_kb(query, source?, limit)` | existing `rag` MCP | 1 | 200-500ms |
| `search_enterprise_kb_visual(text_query, source?, limit)` | existing `rag` MCP | 2 | ~300ms |
| `fetch_source_pdf(page_url)` | inline helper | 3 | 500-2000ms |
| `generate_doc(format, prompt, template?)` | inline `docx`/`pdf`/`xlsx` skills | 4 | 15-45s |
| `generate_image(prompt, prefer="auto"\|"text-heavy")` | NEW `mcp:imagegen` (routes to Nano Banana or GPT-Image-1) | 5a/5b | 6-20s |
| `generate_video(prompt, narrator?, duration_s)` | NEW `mcp:videogen` (HeyGen avatar) | 6 | 30-90s |
| `generate_podcast(source_text_or_url, duration_min)` | NEW `mcp:podcastgen` (NotebookLM, conditional) | 7 | 60-180s |
| `transcribe_voice(audio_bytes, lang_hint?)` | inline (OpenAI Whisper) | 8 (inbound only) | ~$0.006/min |
| `send_whatsapp_text(text, reply_to_msg_id?)` | whatsapp-web.js | delivery | 100-500ms |
| `send_whatsapp_media(file_or_url, caption?)` | whatsapp-web.js | delivery | 500-3000ms |
| `send_whatsapp_voice(audio_bytes)` | whatsapp-web.js | delivery | 500-3000ms |
| `send_interim_message(text)` | whatsapp-web.js | UX | 100-500ms |

### Tier decision rules (in system prompt)

1. **Default to Tier 1.** Answer with text + citation unless visual/audio would substantially help.
2. **Tier 2-3** when corpus has the asset. Always check `search_enterprise_kb_visual` before generating an image.
3. **Tier 4** only when explicitly asked for a document, OR the answer requires a structured artifact (sample contract, payroll worksheet).
4. **Tier 5a (Nano Banana)** for image-gen by default. Multilingual prompts work natively.
5. **Tier 5b (GPT-Image-1)** if the image needs embedded text/labels (charts, mockups with annotations, branded copy).
6. **Tier 6 (HeyGen)** ONLY if customer explicitly asks for video, OR explaining a 4+ step flow where avatar narration substantially helps. Send "generating a short video, ~90s…" interim message.
7. **Tier 7 (NotebookLM)** ONLY when customer asks for "audio version" / "podcast" / source content is >2000 words. Send as WhatsApp voice note. Send "generating audio summary…" interim.
8. **Tier 8 (Whisper)** automatic for any inbound voice note; transcript becomes the question, then normal tier selection applies.

### RAG routing (mirrors comms `CLAUDE.md` from commit `53ee01c`)

| Customer message contains… | source filter |
|---|---|
| "Qiwa", "قوى" | `qiwa-sa` |
| "Mudad", "مدد" | `mudad-com-sa` |
| "Ministry of HR", "وزارة الموارد", "HRSD" | `hrsd-gov-sa` |
| "Vision 2030", "رؤية 2030" | `vision2030-gov-sa` |
| "labor law", "نظام العمل" | `saudi-labor-law`, `saudi-labor-law-bylaws` |
| "GOSI", "تأمينات" | `gosi-social-insurance` |
| anything else | no filter |

## Reply formatting

```
🤖 <answer in customer's language>

_Source: <short URL>_
```

For multi-source answers, multiple `_Source: …_` lines. For media replies, the media is sent first, then a follow-up text with citation. Citations always link to the canonical `page_url` from the chunk metadata.

## Data model

New table in the existing Neon DB:

```sql
CREATE TABLE whatsapp_exchanges (
    id              bigserial PRIMARY KEY,
    group_id        text NOT NULL,
    group_name      text,
    sender_number   text,            -- as received; consider hashing in v2
    sender_name     text,
    message_id      text NOT NULL,   -- whatsapp-web.js message id
    inbound_text    text NOT NULL,   -- transcript if voice
    inbound_type    text NOT NULL,   -- 'text' | 'voice' | 'image'
    inbound_lang    text,            -- 'ar' | 'en' | 'unknown'
    inbound_at      timestamptz NOT NULL,

    chosen_tier     text,            -- '1' .. '8'
    tools_called    text[],          -- ['search_enterprise_kb', 'generate_image']
    sources_cited   text[],          -- ['qiwa-sa', 'saudi-labor-law']

    reply_text      text,
    reply_media_url text,            -- if Tier 2-7
    reply_at        timestamptz,
    reply_msg_id    text,            -- whatsapp-web.js sent message id

    duration_ms     int,
    cost_estimate   numeric(10,4),   -- USD
    error           text,
    UNIQUE (group_id, message_id)    -- idempotency
);

CREATE INDEX whatsapp_exchanges_group_inbound_idx
    ON whatsapp_exchanges(group_id, inbound_at DESC);
CREATE INDEX whatsapp_exchanges_tier_idx ON whatsapp_exchanges(chosen_tier);
```

Migration: `migrations/003_whatsapp_exchanges.sql` (or in claudeclaw-os if we keep WA tables there — TBD at impl time).

## Deployment

### Files

| Path | Purpose |
|---|---|
| `/etc/systemd/system/claudeclaw-comms-whatsapp.service` | systemd unit (NEW) |
| `/home/ubuntu/claudeclaw-os/whatsapp/service.ts` | Listener + Claude loop entrypoint |
| `/home/ubuntu/claudeclaw-os/whatsapp/reply-composer.ts` | Wraps the agent SDK call with all tools |
| `/home/ubuntu/claudeclaw-os/whatsapp/tier-handlers/*.ts` | One file per tier (text, existing-image, existing-pdf, gen-doc, gen-image, gen-video, gen-podcast, voice-in) |
| `/home/ubuntu/claudeclaw-os/whatsapp/audit.ts` | `whatsapp_exchanges` writer |
| `/home/ubuntu/.wwebjs_auth/` | Persistent WA session (mode 700) |
| `/home/ubuntu/logs/claudeclaw-comms-whatsapp.log` | Service log |
| `/home/ubuntu/rag-platform/mcp/imagegen/server.py` | NEW MCP — Nano Banana + GPT-Image-1 |
| `/home/ubuntu/rag-platform/mcp/videogen/server.py` | NEW MCP — HeyGen |
| `/home/ubuntu/rag-platform/mcp/podcastgen/server.py` | NEW MCP — NotebookLM (conditional) |

### Env vars

All required keys are already in `/home/ubuntu/claudeclaw-os/.env`:
- `GOOGLE_API_KEY` (Nano Banana, NotebookLM)
- `HEYGEN_API_KEY` (HeyGen video)
- `OPENAI_API_KEY` (GPT-Image-1, Whisper) — added 2026-05-09; **rotate immediately** because pasted in chat
- `CLAUDE_CODE_OAUTH_TOKEN` (Sonnet 4.6 calls)
- `VOYAGE_API_KEY` (RAG retrievals)
- `DATABASE_URL` (audit + RAG)

New WA-specific env vars to add:
- `WHATSAPP_ENABLED=true`
- `WHATSAPP_ALLOWED_GROUPS=Pilot with Ghassan AI`  (comma-separated for future)
- `WHATSAPP_TIERS_ENABLED=1,2,3,4,5,6,7,8`  (per-tier disable)
- `WHATSAPP_QR_PORT=9334`  (only used during initial QR-login)

### QR-login bootstrap (one-time)

```bash
# From Mac, tunnel to the QR endpoint
ssh -L 9334:127.0.0.1:9334 -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145

# In Mac browser
open http://localhost:9334/qr

# Scan with WhatsApp on phone:
#   WhatsApp → Settings → Linked Devices → Link a Device
```

Session persists for weeks/months until WhatsApp rotates auth. Telegram alert wired to `claudeclaw-healthcheck.timer` when re-scan needed.

## Operational concerns

### Kill switches

Three layers, all hot-reloadable (no restart):

| Switch | How | Effect |
|---|---|---|
| `WHATSAPP_ENABLED=false` | edit `.env` + `kill -HUP <pid>` | Service drops all incoming events, logs them, doesn't reply. Use during incidents. |
| `WHATSAPP_ALLOWED_GROUPS` | edit + SIGHUP | Bot only replies in listed groups. Misclick adding bot to wrong group → silent. |
| `WHATSAPP_TIERS_ENABLED` | edit + SIGHUP | Disable expensive tiers without taking the bot down (e.g., `=1,2,3,4` kills generation tiers). |

Plus a Telegram command `/whatsapp pause` on the main bot to flip `WHATSAPP_ENABLED=false` instantly.

### Monitoring

Three signals into existing `claudeclaw-healthcheck.timer` (every 15 min):

1. **Service liveness** — `systemctl is-active claudeclaw-comms-whatsapp` → alert if inactive
2. **WA Web auth health** — query service `/health` endpoint, returns `{state: "READY" | "QR_REQUIRED" | "DISCONNECTED"}` → Telegram alert with reconnect instructions if `QR_REQUIRED`
3. **Reply backlog** — `SELECT count(*) FROM whatsapp_exchanges WHERE reply_at IS NULL AND inbound_at > now() - interval '5 min'` → alert if > 5

### Throttling + ban-risk mitigations

- Max 1 outbound send per 3s globally (across all tiers)
- Identifying 🤖 prefix on every reply (transparency)
- Allowlisted single group (no spamming new groups)
- Honest user-agent in HeyGen / OpenAI / etc. headers
- Whisper not used to monitor anything — only to transcribe voice notes the customer sends

### NotebookLM API verification (impl-time gate)

NotebookLM Audio Overviews API may require Google Workspace. **First step of impl plan: probe the API** with a tiny test call.
- ✅ Works → ship Tier 7
- ⚠️ Requires Workspace upgrade → flag, you decide upgrade vs. skip Tier 7
- ❌ Not available for individual accounts → drop Tier 7, ship Tiers 1-6 + 8

### WhatsApp size constraints

| Type | Cap | Mitigation |
|---|---|---|
| Image | 16 MB | Nano Banana / GPT-Image-1 outputs ~1-3 MB — fine |
| Video | 16 MB | HeyGen 720p ~5-15 MB; if > 16 MB, downsample to 480p before sending |
| PDF / docx | 100 MB | Plenty of room |
| Voice note | 16 MB | NotebookLM podcasts ~1MB/min so up to ~15 min fine. Truncate or split if longer. |

## Cost estimate (steady-state, ~50 msgs/day)

| Item | Cost/mo |
|---|---|
| Sonnet 4.6 (Pro/Max OAuth) | $0 |
| Voyage rerank (Tier 1) | < $1 |
| Nano Banana (~5 images/day) | ~$1.50 |
| GPT-Image-1 (~1 chart/day) | ~$1-3 |
| HeyGen (~1 video/day) | ~$5-15 |
| NotebookLM (~2/week, if available) | ~$5-15 |
| Whisper (~5 voice notes/day, 30s avg) | ~$0.50 |
| WhatsApp Web (free) | $0 |
| **Total** | **~$15-35/mo** |

Plus existing Neon Launch ($19/mo).

## Memory rule update

Append to `/Users/mghassan/.claude/projects/-Users-mghassan/memory/feedback_gemini_vs_claude_split.md`:

> **Updated 2026-05-09:** `GOOGLE_API_KEY` scope expanded to include media generation (Nano Banana for images, NotebookLM for audio podcasts). `OPENAI_API_KEY` (added 2026-05-09) is for image gen (GPT-Image-1) and voice transcription (Whisper) ONLY — text-LLM work continues to route through Claude (`CLAUDE_CODE_OAUTH_TOKEN`) per the original cost-optimization rule. Anthropic Pro/Max OAuth covers all text use cases.

## Open questions resolved at impl-time

1. **NotebookLM API access** — probe in step 1 of impl plan; downgrade Tier 7 if unavailable.
2. **WA Web auth interval** — empirical; first re-scan will tell us. Likely 2-8 weeks.
3. **HeyGen avatar choice** — pick one default avatar at first deploy; keep as env var for later swap.
4. **Throttle tuning** — start at 1 send / 3s; loosen after 30 days of clean operation if message volume justifies.

## What this design deliberately does NOT do

- No outbound to individuals (group only)
- No multi-group support (single group allowlist; v2)
- No scheduling / proactive messages (purely reactive)
- No GPT-4o text replies (Sonnet 4.6 owns text, free via OAuth)
- No Veo 3 / Sora / Runway video (HeyGen is the right tool for narration)
- No DALL-E (GPT-Image-1 supersedes)
- No new agent identity (runs as comms persona, just in always-on listener mode)
- No bridging WhatsApp ↔ Slack/Gmail (each channel is independent)
- No CRM integration (out of scope; could add later via mcp:salesforce or similar)
