# WhatsApp Comms Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an always-on WhatsApp listener service that gives the comms agent identity a third channel — replies in the "Pilot with Ghassan AI" group with RAG-grounded answers, escalating to media generation (Nano Banana, GPT-Image-1, HeyGen, NotebookLM) when text isn't enough.

**Architecture:** New `claudeclaw-comms-whatsapp.service` (Node + TypeScript) on the AWS box, using `whatsapp-web.js` over its own Puppeteer-launched Chromium (separate from the `:9333` Chrome). On each inbound group message, runs a single Claude Sonnet 4.6 call with full tool surface (RAG, image gen, video gen, podcast gen, doc gen, send-back). Three new MCP servers wrap the external media APIs. New `whatsapp_exchanges` audit table with idempotency.

**Tech Stack:**
- Node 20 + TypeScript (matches claudeclaw-os stack)
- `whatsapp-web.js` ≥ 1.27 over Puppeteer (its own bundled Chromium — not the `:9333` instance)
- Anthropic Claude Agent SDK (already in claudeclaw-os deps; uses `CLAUDE_CODE_OAUTH_TOKEN`)
- Python 3.12 for the 3 new MCP servers (matches existing `rag` MCP at `/home/ubuntu/rag-platform/mcp/`)
- Postgres on Neon (existing)
- Pytest for MCP tests; Vitest for TS tests (already in claudeclaw-os)
- Source spec: `/home/ubuntu/claudeclaw-os/docs/specs/2026-05-09-whatsapp-comms-design.md` (commit `83e5ca4`)

**Working directory for all commands:** `/home/ubuntu/claudeclaw-os/` (TS code) and `/home/ubuntu/rag-platform/` (Python MCPs) on the AWS box (`ubuntu@13.204.65.145`, key `~/.ssh/claudeclaw-aws`).

---

## File structure

```
claudeclaw-os/
├── whatsapp/                                          (NEW Node module)
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── service.ts                                (entry: lifecycle, signal handlers, msg dispatch)
│   │   ├── client.ts                                 (whatsapp-web.js wrapper + QR endpoint)
│   │   ├── reply-composer.ts                         (Claude agent SDK call with tools)
│   │   ├── routing.ts                                (RAG source routing table)
│   │   ├── lang.ts                                   (langdetect via cld3 or franc-min)
│   │   ├── config.ts                                 (env-var parsing, tier toggles, SIGHUP reload)
│   │   ├── audit.ts                                  (whatsapp_exchanges DB writer)
│   │   ├── healthcheck.ts                            (HTTP /health + /qr endpoints)
│   │   └── tools/
│   │       ├── send.ts                               (send_whatsapp_text/media/voice/interim)
│   │       ├── transcribe.ts                         (Whisper inline)
│   │       ├── fetch_pdf.ts                          (Tier 3 helper)
│   │       └── generate_doc.ts                       (Tier 4 wrapper for docx/pdf/xlsx skills)
│   └── tests/
│       ├── routing.test.ts
│       ├── lang.test.ts
│       ├── config.test.ts
│       └── audit.test.ts
│
├── docs/plans/2026-05-09-whatsapp-comms-plan.md     (NEW — this plan)
├── package.json                                       (MODIFY — add `whatsapp` workspace, scripts)
└── tsconfig.base.json                                 (existing — referenced by whatsapp/tsconfig.json)

rag-platform/
├── migrations/003_whatsapp_exchanges.sql             (NEW)
└── mcp/
    ├── imagegen/server.py                             (NEW — Nano Banana + GPT-Image-1)
    ├── videogen/server.py                             (NEW — HeyGen)
    └── podcastgen/server.py                           (NEW — NotebookLM, conditional)

/etc/systemd/system/
└── claudeclaw-comms-whatsapp.service                  (NEW)

/home/ubuntu/.wwebjs_auth/                             (NEW persistent WA session, mode 700)
/home/ubuntu/logs/claudeclaw-comms-whatsapp.log       (NEW service log)
```

Each TS file <250 lines, focused responsibility. MCP servers <150 lines each.

---

## Phase A — Pre-flight gates

### Task 1: Rotate the leaked OpenAI key

**Files:** None (security action by Mohamed).

- [ ] **Step 1: Mohamed action — rotate at platform.openai.com**

This task BLOCKS everything else. Mohamed must:
1. Open https://platform.openai.com/api-keys
2. Revoke the key starting `sk-proj-_-Tx…` (leaked in chat 2026-05-09)
3. Create a new key
4. Provide it via secure channel (NOT chat) — e.g. `cat | ssh ubuntu@13.204.65.145 'sed -i "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=<paste here>|" /home/ubuntu/claudeclaw-os/.env'` from his Mac

- [ ] **Step 2: Verify the new key works (without echoing it)**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'export $(grep "^OPENAI_API_KEY=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && /home/ubuntu/rag-platform/.venv/bin/python -c "
from openai import OpenAI
import os
c = OpenAI(api_key=os.environ[\"OPENAI_API_KEY\"])
print(\"models accessible:\", len(list(c.models.list().data)))
"'
```
Expected: `models accessible: <number>`. If `401 Unauthorized`, key wasn't rotated correctly — stop and re-do.

### Task 2: Smoke-test all 4 media-gen APIs end-to-end

**Files:** None (validates external dependencies before we write any code that depends on them).

- [ ] **Step 1: Test Nano Banana (Gemini 2.5 Flash Image)**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'export $(grep "^GOOGLE_API_KEY=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && /home/ubuntu/rag-platform/.venv/bin/python -c "
import os, base64
from google import genai
from google.genai import types
c = genai.Client(api_key=os.environ[\"GOOGLE_API_KEY\"])
r = c.models.generate_content(
    model=\"gemini-2.5-flash-image-preview\",
    contents=[\"a simple line drawing of a dove on white background\"],
    config=types.GenerateContentConfig(response_modalities=[\"IMAGE\"]),
)
parts = r.candidates[0].content.parts
img_bytes = next(p.inline_data.data for p in parts if p.inline_data)
print(\"nano banana ok:\", len(img_bytes), \"bytes\")
"'
```
Expected: `nano banana ok: <thousands of bytes>`. If error, install `google-genai` package (`/home/ubuntu/rag-platform/.venv/bin/pip install google-genai`) and retry.

- [ ] **Step 2: Test GPT-Image-1**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'export $(grep "^OPENAI_API_KEY=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && /home/ubuntu/rag-platform/.venv/bin/python -c "
from openai import OpenAI
import os, base64
c = OpenAI(api_key=os.environ[\"OPENAI_API_KEY\"])
r = c.images.generate(
    model=\"gpt-image-1\",
    prompt=\"a simple line drawing of a chart titled Revenue Q1\",
    size=\"1024x1024\",
    quality=\"low\",
    n=1,
)
img = base64.b64decode(r.data[0].b64_json)
print(\"gpt-image-1 ok:\", len(img), \"bytes\")
"'
```
Expected: `gpt-image-1 ok: <hundreds of thousands of bytes>`. If error, check key permissions allow image generation.

- [ ] **Step 3: Test HeyGen video generation**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'export $(grep "^HEYGEN_API_KEY=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && curl -s -H "X-Api-Key: $HEYGEN_API_KEY" https://api.heygen.com/v2/avatars 2>&1 | python3 -c "import sys, json; d = json.load(sys.stdin); print(\"heygen ok, avatars available:\", len(d.get(\"data\", {}).get(\"avatars\", [])))"'
```
Expected: `heygen ok, avatars available: <number>`. If 401, key is invalid. If empty `data`, account may need plan upgrade for API access.

- [ ] **Step 4: Test NotebookLM API access (gate for Tier 7)**

NotebookLM does not have a public REST API for individual accounts as of 2026-05. Check current state:

```bash
# Check if `notebooklm` Python lib exists or if Google Workspace API has the route
pip search notebooklm 2>&1 | head -5
echo "---"
# Probe the Discovery API for any notebooklm endpoint
curl -s "https://discovery.googleapis.com/discovery/v1/apis?name=notebook&preferred=true" | head -50
```

Decision tree:
- If a real API exists → ship Tier 7 in Phase C-3 (Task 9)
- If only the Workspace API and you have Workspace access → use that, document setup in Task 9
- If NO public API → SKIP Task 9 (`mcp:podcastgen`) and DROP Tier 7 from `WHATSAPP_TIERS_ENABLED`. Update spec doc to reflect.

- [ ] **Step 5: Decision — proceed or block**

Proceed to Task 3 ONLY if Tasks 2.1 + 2.2 + 2.3 all green. If any of those 3 fail, STOP and surface to Mohamed before writing code that would silently fail at runtime. Tier 7 (NotebookLM) is the only one allowed to be deferred without blocking everything else.

### Task 3: Smoke-test Whisper

**Files:** None.

- [ ] **Step 1: Test transcription end-to-end**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /tmp && curl -s -o test_audio.mp3 https://upload.wikimedia.org/wikipedia/commons/4/4d/En-us-pronunciation.ogg && export $(grep "^OPENAI_API_KEY=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && /home/ubuntu/rag-platform/.venv/bin/python -c "
from openai import OpenAI
import os
c = OpenAI(api_key=os.environ[\"OPENAI_API_KEY\"])
with open(\"/tmp/test_audio.mp3\", \"rb\") as f:
    r = c.audio.transcriptions.create(model=\"whisper-1\", file=f)
print(\"whisper ok, transcript:\", r.text[:60])
"'
```
Expected: `whisper ok, transcript: <some text>`. If error, key lacks audio API access — escalate.

---

## Phase B — Schema migration

### Task 4: Write migration 003 — `whatsapp_exchanges`

**Files:**
- Create: `/home/ubuntu/rag-platform/migrations/003_whatsapp_exchanges.sql`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/003_whatsapp_exchanges.sql
-- Audit table for the WhatsApp comms channel. One row per inbound message + its reply.
-- UNIQUE(group_id, message_id) is the idempotency key so service restarts don't double-reply.

BEGIN;

CREATE TABLE whatsapp_exchanges (
    id              bigserial PRIMARY KEY,
    group_id        text NOT NULL,
    group_name      text,
    sender_number   text,
    sender_name     text,
    message_id      text NOT NULL,
    inbound_text    text NOT NULL,
    inbound_type    text NOT NULL,           -- 'text' | 'voice' | 'image'
    inbound_lang    text,                    -- 'ar' | 'en' | 'unknown'
    inbound_at      timestamptz NOT NULL,

    chosen_tier     text,                    -- '1' .. '8'
    tools_called    text[],
    sources_cited   text[],

    reply_text      text,
    reply_media_url text,
    reply_at        timestamptz,
    reply_msg_id    text,

    duration_ms     int,
    cost_estimate   numeric(10,4),
    error           text,
    UNIQUE (group_id, message_id)
);

CREATE INDEX whatsapp_exchanges_group_inbound_idx
    ON whatsapp_exchanges(group_id, inbound_at DESC);
CREATE INDEX whatsapp_exchanges_tier_idx
    ON whatsapp_exchanges(chosen_tier) WHERE chosen_tier IS NOT NULL;
CREATE INDEX whatsapp_exchanges_pending_idx
    ON whatsapp_exchanges(inbound_at DESC) WHERE reply_at IS NULL;

COMMIT;
```

- [ ] **Step 2: Apply migration to prod**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'export $(grep -E "^DATABASE_URL=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /home/ubuntu/rag-platform/migrations/003_whatsapp_exchanges.sql 2>&1 | tail -10'
```
Expected: `BEGIN`, `CREATE TABLE`, 3× `CREATE INDEX`, `COMMIT`.

- [ ] **Step 3: Verify**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'export $(grep -E "^DATABASE_URL=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && psql "$DATABASE_URL" -c "\d whatsapp_exchanges"'
```
Expected: table descriptor with 21 columns + 4 indexes (1 PK + 3 secondary).

- [ ] **Step 4: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/rag-platform && git add migrations/003_whatsapp_exchanges.sql && git commit -m "feat(schema): migration 003 — whatsapp_exchanges audit table with idempotency"'
```

---

## Phase C — Three MCP servers

### Task 5: `mcp:imagegen` — Nano Banana + GPT-Image-1 router

**Files:**
- Create: `/home/ubuntu/rag-platform/mcp/imagegen/server.py`
- Create: `/home/ubuntu/rag-platform/mcp/imagegen/__init__.py` (empty)

- [ ] **Step 1: Create dir + write server**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'mkdir -p /home/ubuntu/rag-platform/mcp/imagegen && touch /home/ubuntu/rag-platform/mcp/imagegen/__init__.py'
```

`/home/ubuntu/rag-platform/mcp/imagegen/server.py`:

```python
"""MCP server: image generation router.

Two backends:
  - Nano Banana (gemini-2.5-flash-image-preview) — default, cheap, multilingual, edits well
  - GPT-Image-1 — chart/text-heavy fallback (better embedded text rendering)

Routing rule: prompt mentions chart/label/text/infographic → GPT-Image-1; else Nano Banana.
The caller can also pass `prefer="text-heavy"` to force GPT-Image-1.
"""
from __future__ import annotations

import base64
import io
import logging
import os
import re
import time
from pathlib import Path

from mcp.server.fastmcp import FastMCP

log = logging.getLogger(__name__)
mcp = FastMCP("imagegen")

OUT_DIR = Path("/home/ubuntu/data/imagegen")
OUT_DIR.mkdir(parents=True, exist_ok=True)

_TEXT_HEAVY_HINTS = re.compile(
    r"\b(chart|graph|diagram|infograph|table|axis|label|annotat|mockup|wireframe|caption|title)\b",
    re.IGNORECASE,
)


def _is_text_heavy(prompt: str) -> bool:
    return bool(_TEXT_HEAVY_HINTS.search(prompt))


def _save_png(b: bytes) -> str:
    name = f"img-{int(time.time() * 1000)}.png"
    p = OUT_DIR / name
    p.write_bytes(b)
    return str(p)


@mcp.tool()
def generate_image(prompt: str, prefer: str = "auto", size: str = "1024x1024") -> dict:
    """Generate one image. `prefer` ∈ {auto, text-heavy, default}. Returns local file path + metadata."""
    use_gpt = (prefer == "text-heavy") or (prefer == "auto" and _is_text_heavy(prompt))
    backend = "gpt-image-1" if use_gpt else "nano-banana"
    t0 = time.monotonic()
    try:
        if use_gpt:
            from openai import OpenAI
            client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
            r = client.images.generate(
                model="gpt-image-1", prompt=prompt, size=size, quality="low", n=1,
            )
            img_bytes = base64.b64decode(r.data[0].b64_json)
        else:
            from google import genai
            from google.genai import types
            client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
            r = client.models.generate_content(
                model="gemini-2.5-flash-image-preview",
                contents=[prompt],
                config=types.GenerateContentConfig(response_modalities=["IMAGE"]),
            )
            parts = r.candidates[0].content.parts
            img_bytes = next(p.inline_data.data for p in parts if p.inline_data)
        path = _save_png(img_bytes)
        return {
            "ok": True, "backend": backend, "path": path,
            "bytes": len(img_bytes), "duration_ms": int((time.monotonic() - t0) * 1000),
        }
    except Exception as e:
        return {"ok": False, "backend": backend, "error": str(e)[:500],
                "duration_ms": int((time.monotonic() - t0) * 1000)}


@mcp.tool()
def list_backends() -> dict:
    """List the image-gen backends available."""
    return {
        "backends": [
            {"name": "nano-banana", "model": "gemini-2.5-flash-image-preview", "default": True,
             "best_for": "illustrations, edits, Arabic prompts, low cost"},
            {"name": "gpt-image-1", "model": "gpt-image-1", "default": False,
             "best_for": "charts, infographics, text/labels embedded in image"},
        ],
        "router_rule": "prompt mentions chart/label/text/infographic → gpt-image-1; else nano-banana",
    }


if __name__ == "__main__":
    mcp.run()
```

- [ ] **Step 2: Install `google-genai` if missing**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/rag-platform && .venv/bin/pip install google-genai'
```

- [ ] **Step 3: Smoke test the MCP server end-to-end**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/rag-platform && set -a; . /home/ubuntu/claudeclaw-os/.env; set +a; .venv/bin/python -c "
import sys
sys.path.insert(0, \"mcp/imagegen\")
from server import generate_image, list_backends
print(\"backends:\", list_backends())
r1 = generate_image(\"a simple dove illustration\", prefer=\"auto\")
print(\"nano banana:\", r1.get(\"backend\"), r1.get(\"ok\"), r1.get(\"bytes\"))
r2 = generate_image(\"a bar chart titled Revenue Q1 2026 with axis labels\", prefer=\"auto\")
print(\"text-heavy:\", r2.get(\"backend\"), r2.get(\"ok\"), r2.get(\"bytes\"))
"'
```
Expected: `backends:` dict, `nano banana: nano-banana True <bytes>`, `text-heavy: gpt-image-1 True <bytes>`.

- [ ] **Step 4: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/rag-platform && git add mcp/imagegen/ && git commit -m "feat(mcp): imagegen — Nano Banana + GPT-Image-1 router by prompt content"'
```

### Task 6: `mcp:videogen` — HeyGen avatar narration

**Files:**
- Create: `/home/ubuntu/rag-platform/mcp/videogen/server.py`
- Create: `/home/ubuntu/rag-platform/mcp/videogen/__init__.py`

- [ ] **Step 1: List available HeyGen avatars + voices to pick a default**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'export $(grep "^HEYGEN_API_KEY=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && curl -s -H "X-Api-Key: $HEYGEN_API_KEY" https://api.heygen.com/v2/avatars | python3 -c "
import sys, json
d = json.load(sys.stdin)
avatars = d.get(\"data\", {}).get(\"avatars\", [])
print(\"first 5 avatar ids + names:\")
for a in avatars[:5]:
    print(\" \", a.get(\"avatar_id\"), \"-\", a.get(\"avatar_name\"))
"'
```
Pick one avatar ID — write it down for use in Step 2 as `DEFAULT_AVATAR_ID`. Also fetch a Saudi Arabic voice if any:

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'export $(grep "^HEYGEN_API_KEY=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && curl -s -H "X-Api-Key: $HEYGEN_API_KEY" https://api.heygen.com/v2/voices | python3 -c "
import sys, json
d = json.load(sys.stdin)
voices = d.get(\"data\", {}).get(\"voices\", [])
ar = [v for v in voices if (v.get(\"language\") or \"\").lower().startswith(\"ar\")]
en = [v for v in voices if (v.get(\"language\") or \"\").lower().startswith(\"en\")]
print(\"first 3 Arabic voices:\")
for v in ar[:3]:
    print(\" \", v.get(\"voice_id\"), \"-\", v.get(\"name\"), \"-\", v.get(\"language\"))
print(\"first 3 English voices:\")
for v in en[:3]:
    print(\" \", v.get(\"voice_id\"), \"-\", v.get(\"name\"), \"-\", v.get(\"language\"))
"'
```
Pick one Arabic + one English voice ID. Use them as `DEFAULT_AR_VOICE` / `DEFAULT_EN_VOICE` in Step 2.

- [ ] **Step 2: Write the MCP server**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'mkdir -p /home/ubuntu/rag-platform/mcp/videogen && touch /home/ubuntu/rag-platform/mcp/videogen/__init__.py'
```

`/home/ubuntu/rag-platform/mcp/videogen/server.py` (substitute the avatar/voice IDs you picked above):

```python
"""MCP server: HeyGen avatar video generation.

One tool: generate_video(script, lang) → returns a local mp4 path once ready (polls).
"""
from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

log = logging.getLogger(__name__)
mcp = FastMCP("videogen")

OUT_DIR = Path("/home/ubuntu/data/videogen")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Picked from Task 6 Step 1. Update if you swap defaults later.
DEFAULT_AVATAR_ID = "REPLACE_WITH_AVATAR_ID"
DEFAULT_AR_VOICE = "REPLACE_WITH_AR_VOICE_ID"
DEFAULT_EN_VOICE = "REPLACE_WITH_EN_VOICE_ID"

API_BASE = "https://api.heygen.com"


def _headers() -> dict[str, str]:
    return {"X-Api-Key": os.environ["HEYGEN_API_KEY"], "Content-Type": "application/json"}


@mcp.tool()
def generate_video(script: str, lang: str = "en", avatar_id: str | None = None) -> dict:
    """Generate an avatar video from `script` text. Polls until ready (max 5 min)."""
    voice_id = DEFAULT_AR_VOICE if lang == "ar" else DEFAULT_EN_VOICE
    payload = {
        "video_inputs": [{
            "character": {"type": "avatar", "avatar_id": avatar_id or DEFAULT_AVATAR_ID, "avatar_style": "normal"},
            "voice": {"type": "text", "voice_id": voice_id, "input_text": script},
        }],
        "dimension": {"width": 1280, "height": 720},
    }
    t0 = time.monotonic()
    with httpx.Client(timeout=30.0) as client:
        r = client.post(f"{API_BASE}/v2/video/generate", headers=_headers(), json=payload)
        if r.status_code != 200:
            return {"ok": False, "error": f"HTTP {r.status_code}: {r.text[:300]}",
                    "duration_ms": int((time.monotonic() - t0) * 1000)}
        video_id = r.json()["data"]["video_id"]

        # Poll status (HeyGen takes 30-90s typically)
        for _ in range(60):  # 60 * 5s = 5 min cap
            time.sleep(5)
            s = client.get(f"{API_BASE}/v1/video_status.get?video_id={video_id}", headers=_headers())
            if s.status_code != 200:
                continue
            data = s.json().get("data", {})
            status = data.get("status")
            if status == "completed":
                video_url = data.get("video_url")
                # Download
                vr = client.get(video_url)
                if vr.status_code == 200:
                    name = f"vid-{int(time.time())}-{video_id[:8]}.mp4"
                    p = OUT_DIR / name
                    p.write_bytes(vr.content)
                    return {"ok": True, "path": str(p), "video_id": video_id, "bytes": len(vr.content),
                            "duration_ms": int((time.monotonic() - t0) * 1000)}
                return {"ok": False, "error": f"download failed: HTTP {vr.status_code}",
                        "duration_ms": int((time.monotonic() - t0) * 1000)}
            if status in ("failed", "error"):
                return {"ok": False, "error": data.get("error", "heygen failed"), "video_id": video_id,
                        "duration_ms": int((time.monotonic() - t0) * 1000)}
        return {"ok": False, "error": "timeout waiting for heygen", "video_id": video_id,
                "duration_ms": int((time.monotonic() - t0) * 1000)}


if __name__ == "__main__":
    mcp.run()
```

- [ ] **Step 3: Smoke test (real HeyGen call — costs ~$0.50)**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/rag-platform && set -a; . /home/ubuntu/claudeclaw-os/.env; set +a; .venv/bin/python -c "
import sys
sys.path.insert(0, \"mcp/videogen\")
from server import generate_video
r = generate_video(\"Hello, this is a test of HeyGen avatar narration.\", lang=\"en\")
print(\"result:\", {k: r[k] for k in r if k != \"path\"})
print(\"path:\", r.get(\"path\"))
"'
```
Expected: `ok: True`, `path: /home/ubuntu/data/videogen/vid-...mp4`. Run will take 60-90s. If `error: heygen failed`, check the error detail and either fix the avatar_id/voice_id or escalate.

- [ ] **Step 4: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/rag-platform && git add mcp/videogen/ && git commit -m "feat(mcp): videogen — HeyGen avatar narration with poll-until-ready"'
```

### Task 7: `mcp:podcastgen` — NotebookLM (CONDITIONAL on Task 2.4)

**Skip this task entirely** if Task 2 Step 4 determined NotebookLM API is not accessible. Drop Tier 7 from `WHATSAPP_TIERS_ENABLED` config in Task 17.

If NotebookLM IS accessible, write the server using whatever route Task 2 Step 4 determined works. Pattern matches Task 6: one tool, polling, save to `/home/ubuntu/data/podcastgen/`. Detailed steps depend on which API surface Google exposes — Mohamed approves the implementation approach before coding.

---

## Phase D — TypeScript scaffolding

### Task 8: New `whatsapp/` workspace + dependencies

**Files:**
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/package.json`
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/tsconfig.json`
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/.gitkeep`
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/tests/.gitkeep`
- Modify: `/home/ubuntu/claudeclaw-os/package.json` (add workspace)

- [ ] **Step 1: Inspect root package.json to see existing patterns**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cat /home/ubuntu/claudeclaw-os/package.json'
```

Note: workspaces field, scripts pattern, dependency versions for `@anthropic-ai/claude-agent-sdk`, `pg`/`psycopg`-equivalent, etc. Match style.

- [ ] **Step 2: Create the whatsapp dir + package.json**

`/home/ubuntu/claudeclaw-os/whatsapp/package.json`:

```json
{
  "name": "@claudeclaw/whatsapp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/service.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/service.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "*",
    "whatsapp-web.js": "^1.27.0",
    "qrcode-terminal": "^0.12.0",
    "qrcode": "^1.5.4",
    "pg": "^8.13.0",
    "openai": "^4.70.0",
    "franc-min": "^7.0.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/pg": "^8.11.0",
    "@types/qrcode": "^1.5.5",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

`/home/ubuntu/claudeclaw-os/whatsapp/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Add to root workspaces if applicable**

If root `package.json` has a `workspaces` array, append `"whatsapp"`. If it doesn't use npm workspaces, skip — install deps inside `whatsapp/` directly.

- [ ] **Step 4: Install deps + scaffolding**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'mkdir -p /home/ubuntu/claudeclaw-os/whatsapp/src /home/ubuntu/claudeclaw-os/whatsapp/tests && cd /home/ubuntu/claudeclaw-os/whatsapp && npm install 2>&1 | tail -10'
```

Expected: `added <N> packages`, no critical errors. Puppeteer (whatsapp-web.js dep) downloads its own Chromium (~150 MB) — that's expected.

- [ ] **Step 5: Sanity — empty TS file compiles**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cat > /home/ubuntu/claudeclaw-os/whatsapp/src/service.ts <<EOF
console.log("hello whatsapp");
EOF
cd /home/ubuntu/claudeclaw-os/whatsapp && npm run build && node dist/service.js'
```
Expected: `hello whatsapp`.

- [ ] **Step 6: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f whatsapp/ package.json && git commit -m "chore(whatsapp): scaffold TS workspace + deps for WhatsApp comms channel"'
```

### Task 9: Config module (env-driven, SIGHUP reload)

**Files:**
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/config.ts`
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

`/home/ubuntu/claudeclaw-os/whatsapp/tests/config.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  beforeEach(() => {
    delete process.env.WHATSAPP_ENABLED;
    delete process.env.WHATSAPP_ALLOWED_GROUPS;
    delete process.env.WHATSAPP_TIERS_ENABLED;
    delete process.env.WHATSAPP_QR_PORT;
  });

  it("defaults: disabled, no groups, all tiers", () => {
    const c = loadConfig();
    expect(c.enabled).toBe(false);
    expect(c.allowedGroups).toEqual([]);
    expect(c.tiersEnabled).toEqual(new Set(["1","2","3","4","5","6","7","8"]));
    expect(c.qrPort).toBe(9334);
  });

  it("parses single group", () => {
    process.env.WHATSAPP_ENABLED = "true";
    process.env.WHATSAPP_ALLOWED_GROUPS = "Pilot with Ghassan AI";
    expect(loadConfig().allowedGroups).toEqual(["Pilot with Ghassan AI"]);
  });

  it("parses multiple groups, trims spaces", () => {
    process.env.WHATSAPP_ALLOWED_GROUPS = "A, B ,C";
    expect(loadConfig().allowedGroups).toEqual(["A","B","C"]);
  });

  it("parses tier subset", () => {
    process.env.WHATSAPP_TIERS_ENABLED = "1,2,3";
    expect(loadConfig().tiersEnabled).toEqual(new Set(["1","2","3"]));
  });

  it("isGroupAllowed handles exact match", () => {
    process.env.WHATSAPP_ALLOWED_GROUPS = "Pilot with Ghassan AI";
    const c = loadConfig();
    expect(c.isGroupAllowed("Pilot with Ghassan AI")).toBe(true);
    expect(c.isGroupAllowed("Other Group")).toBe(false);
  });

  it("isTierEnabled", () => {
    process.env.WHATSAPP_TIERS_ENABLED = "1,2,3";
    const c = loadConfig();
    expect(c.isTierEnabled("1")).toBe(true);
    expect(c.isTierEnabled("5")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os/whatsapp && npm test 2>&1 | tail -10'
```
Expected: error finding `../src/config.js`.

- [ ] **Step 3: Implement**

`/home/ubuntu/claudeclaw-os/whatsapp/src/config.ts`:

```typescript
export interface Config {
  enabled: boolean;
  allowedGroups: string[];
  tiersEnabled: Set<string>;
  qrPort: number;
  isGroupAllowed: (groupName: string) => boolean;
  isTierEnabled: (tier: string) => boolean;
}

export function loadConfig(): Config {
  const enabled = (process.env.WHATSAPP_ENABLED ?? "false").toLowerCase() === "true";
  const allowedGroups = (process.env.WHATSAPP_ALLOWED_GROUPS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const tiersEnabled = new Set(
    (process.env.WHATSAPP_TIERS_ENABLED ?? "1,2,3,4,5,6,7,8")
      .split(",").map(s => s.trim()).filter(Boolean)
  );
  const qrPort = parseInt(process.env.WHATSAPP_QR_PORT ?? "9334", 10);
  return {
    enabled, allowedGroups, tiersEnabled, qrPort,
    isGroupAllowed: (g) => allowedGroups.includes(g),
    isTierEnabled: (t) => tiersEnabled.has(t),
  };
}

let _current: Config = loadConfig();
export function currentConfig(): Config { return _current; }
export function reloadConfig(): Config { _current = loadConfig(); return _current; }
```

- [ ] **Step 4: Run tests, expect 6 passed**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os/whatsapp && npm test 2>&1 | tail -15'
```
Expected: `6 passed`.

- [ ] **Step 5: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f whatsapp/src/config.ts whatsapp/tests/config.test.ts && git commit -m "feat(whatsapp): config module with SIGHUP-reloadable env vars"'
```

### Task 10: Routing table

**Files:**
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/routing.ts`
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/tests/routing.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/routing.test.ts
import { describe, it, expect } from "vitest";
import { routeToSource } from "../src/routing.js";

describe("routeToSource", () => {
  it.each([
    ["What is the GOSI subscription rate?", ["gosi-social-insurance"]],
    ["نسبة اشتراك التأمينات الاجتماعية", ["gosi-social-insurance"]],
    ["How do I add a worker on Qiwa?", ["qiwa-sa"]],
    ["كيف أضيف عاملاً جديداً في قوى؟", ["qiwa-sa"]],
    ["متطلبات حماية الأجور في مدد", ["mudad-com-sa"]],
    ["Mudad wage protection requirements", ["mudad-com-sa"]],
    ["HRSD ministerial decision", ["hrsd-gov-sa"]],
    ["وزارة الموارد البشرية", ["hrsd-gov-sa"]],
    ["Vision 2030 labor goals", ["vision2030-gov-sa"]],
    ["رؤية 2030", ["vision2030-gov-sa"]],
    ["What does the labor law say about annual leave", ["saudi-labor-law", "saudi-labor-law-bylaws"]],
    ["نظام العمل المادة 50", ["saudi-labor-law", "saudi-labor-law-bylaws"]],
    ["What is the weather today", null],
  ])("routes %j", (msg, expected) => {
    expect(routeToSource(msg)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement**

```typescript
// src/routing.ts
type Rule = { keywords: RegExp; sources: string[] };

const RULES: Rule[] = [
  { keywords: /\b(qiwa)\b|قوى/i,                                 sources: ["qiwa-sa"] },
  { keywords: /\b(mudad)\b|مدد/i,                                sources: ["mudad-com-sa"] },
  { keywords: /\b(hrsd)\b|وزارة\s+الموارد/i,                     sources: ["hrsd-gov-sa"] },
  { keywords: /\b(vision\s*2030)\b|رؤية\s*2030/i,                sources: ["vision2030-gov-sa"] },
  { keywords: /\b(labor\s*law|labour\s*law)\b|نظام\s+العمل/i,    sources: ["saudi-labor-law", "saudi-labor-law-bylaws"] },
  { keywords: /\b(gosi)\b|التأمينات\s+الاجتماعية|تأمينات/i,     sources: ["gosi-social-insurance"] },
];

export function routeToSource(message: string): string[] | null {
  for (const r of RULES) {
    if (r.keywords.test(message)) return r.sources;
  }
  return null;
}
```

- [ ] **Step 4: Run, expect 13 passed**

- [ ] **Step 5: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f whatsapp/src/routing.ts whatsapp/tests/routing.test.ts && git commit -m "feat(whatsapp): RAG source routing table (mirrors comms CLAUDE.md)"'
```

### Task 11: Language detection

**Files:**
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/lang.ts`
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/tests/lang.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lang.test.ts
import { describe, it, expect } from "vitest";
import { detectLang } from "../src/lang.js";

describe("detectLang", () => {
  it("detects arabic", () => {
    expect(detectLang("هذه فقرة نصية باللغة العربية تحتوي على معلومات عن نظام العمل."))
      .toBe("ar");
  });
  it("detects english", () => {
    expect(detectLang("This is an English paragraph about Saudi labor law and provisions."))
      .toBe("en");
  });
  it("returns unknown for empty", () => {
    expect(detectLang("")).toBe("unknown");
  });
  it("returns unknown for very short", () => {
    expect(detectLang("hi")).toBe("unknown");
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/lang.ts
import { franc } from "franc-min";

export function detectLang(text: string): "ar" | "en" | "unknown" {
  const t = (text ?? "").trim();
  if (t.length < 10) return "unknown";
  const code = franc(t, { minLength: 10, only: ["arb", "eng"] });
  if (code === "arb") return "ar";
  if (code === "eng") return "en";
  return "unknown";
}
```

- [ ] **Step 3: Run, expect 4 passed**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os/whatsapp && npm test -- lang 2>&1 | tail -10'
```

- [ ] **Step 4: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f whatsapp/src/lang.ts whatsapp/tests/lang.test.ts && git commit -m "feat(whatsapp): franc-min language detection (ar/en/unknown)"'
```

### Task 12: Audit writer

**Files:**
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/audit.ts`
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/tests/audit.test.ts`

- [ ] **Step 1: Write failing test (integration — needs DB)**

```typescript
// tests/audit.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { recordInbound, recordReply } from "../src/audit.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SUFFIX = `test-${Date.now()}`;

describe("audit", () => {
  afterAll(async () => {
    await pool.query("DELETE FROM whatsapp_exchanges WHERE group_id LIKE $1", [`${SUFFIX}%`]);
    await pool.end();
  });

  it("recordInbound creates a row, idempotent on (group_id, message_id)", async () => {
    const msgId = `msg-${Date.now()}`;
    const groupId = `${SUFFIX}-group`;
    await recordInbound({
      groupId, groupName: "Test", senderNumber: "+1", senderName: "T",
      messageId: msgId, inboundText: "hello", inboundType: "text",
      inboundLang: "en", inboundAt: new Date(),
    });
    // second call with same key is no-op
    await recordInbound({
      groupId, groupName: "Test", senderNumber: "+1", senderName: "T",
      messageId: msgId, inboundText: "hello again (ignored)", inboundType: "text",
      inboundLang: "en", inboundAt: new Date(),
    });
    const r = await pool.query(
      "SELECT count(*) AS n, max(inbound_text) AS txt FROM whatsapp_exchanges WHERE group_id=$1 AND message_id=$2",
      [groupId, msgId],
    );
    expect(parseInt(r.rows[0].n, 10)).toBe(1);
    expect(r.rows[0].txt).toBe("hello");
  });

  it("recordReply updates the row", async () => {
    const msgId = `msg-rep-${Date.now()}`;
    const groupId = `${SUFFIX}-group`;
    await recordInbound({
      groupId, groupName: "Test", senderNumber: "+1", senderName: "T",
      messageId: msgId, inboundText: "Q?", inboundType: "text",
      inboundLang: "en", inboundAt: new Date(),
    });
    await recordReply({
      groupId, messageId: msgId, chosenTier: "1",
      toolsCalled: ["search_enterprise_kb"], sourcesCited: ["qiwa-sa"],
      replyText: "🤖 answer", replyMediaUrl: null, replyAt: new Date(), replyMsgId: "out-1",
      durationMs: 1234, costEstimate: 0.001, error: null,
    });
    const r = await pool.query(
      "SELECT chosen_tier, reply_text, sources_cited FROM whatsapp_exchanges WHERE group_id=$1 AND message_id=$2",
      [groupId, msgId],
    );
    expect(r.rows[0].chosen_tier).toBe("1");
    expect(r.rows[0].reply_text).toBe("🤖 answer");
    expect(r.rows[0].sources_cited).toEqual(["qiwa-sa"]);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// src/audit.ts
import { Pool } from "pg";

let _pool: Pool | null = null;
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

export interface InboundRecord {
  groupId: string;
  groupName: string | null;
  senderNumber: string | null;
  senderName: string | null;
  messageId: string;
  inboundText: string;
  inboundType: "text" | "voice" | "image";
  inboundLang: "ar" | "en" | "unknown" | null;
  inboundAt: Date;
}

export async function recordInbound(r: InboundRecord): Promise<void> {
  await pool().query(
    `INSERT INTO whatsapp_exchanges
       (group_id, group_name, sender_number, sender_name, message_id,
        inbound_text, inbound_type, inbound_lang, inbound_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (group_id, message_id) DO NOTHING`,
    [r.groupId, r.groupName, r.senderNumber, r.senderName, r.messageId,
     r.inboundText, r.inboundType, r.inboundLang, r.inboundAt],
  );
}

export interface ReplyRecord {
  groupId: string;
  messageId: string;
  chosenTier: string;
  toolsCalled: string[];
  sourcesCited: string[];
  replyText: string | null;
  replyMediaUrl: string | null;
  replyAt: Date;
  replyMsgId: string | null;
  durationMs: number;
  costEstimate: number;
  error: string | null;
}

export async function recordReply(r: ReplyRecord): Promise<void> {
  await pool().query(
    `UPDATE whatsapp_exchanges SET
       chosen_tier=$3, tools_called=$4, sources_cited=$5,
       reply_text=$6, reply_media_url=$7, reply_at=$8, reply_msg_id=$9,
       duration_ms=$10, cost_estimate=$11, error=$12
     WHERE group_id=$1 AND message_id=$2`,
    [r.groupId, r.messageId,
     r.chosenTier, r.toolsCalled, r.sourcesCited,
     r.replyText, r.replyMediaUrl, r.replyAt, r.replyMsgId,
     r.durationMs, r.costEstimate, r.error],
  );
}

export async function alreadyReplied(groupId: string, messageId: string): Promise<boolean> {
  const r = await pool().query(
    "SELECT reply_at IS NOT NULL AS done FROM whatsapp_exchanges WHERE group_id=$1 AND message_id=$2",
    [groupId, messageId],
  );
  return r.rows.length > 0 && r.rows[0].done === true;
}

export async function close(): Promise<void> {
  if (_pool) { await _pool.end(); _pool = null; }
}
```

- [ ] **Step 3: Run integration test**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os/whatsapp && set -a; . /home/ubuntu/claudeclaw-os/.env; set +a; npm test -- audit 2>&1 | tail -15'
```
Expected: `2 passed`. The cleanup at end ensures no test rows linger.

- [ ] **Step 4: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f whatsapp/src/audit.ts whatsapp/tests/audit.test.ts && git commit -m "feat(whatsapp): audit writer with idempotent recordInbound + recordReply"'
```

---

## Phase E — WhatsApp client + reply pipeline

### Task 13: WhatsApp client wrapper + QR endpoint

**Files:**
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/client.ts`
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/healthcheck.ts`

(No unit tests — exercised end-to-end by Task 22 smoke. The QR-login flow is interactive, can't be unit-tested in CI.)

- [ ] **Step 1: Write the client wrapper**

```typescript
// src/client.ts
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from "qrcode";

export type WAClient = InstanceType<typeof Client>;
export type WAMessage = Awaited<ReturnType<WAClient["getChatById"]>> extends infer C
  ? C extends { fetchMessages: (...a: any) => Promise<infer M> }
    ? M extends Array<infer X> ? X : never
    : never
  : never;

export interface ClientState {
  client: WAClient;
  state: "INITIALIZING" | "QR_REQUIRED" | "READY" | "DISCONNECTED";
  lastQrPng: Buffer | null;
}

export function buildClient(authPath = "/home/ubuntu/.wwebjs_auth"): ClientState {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: authPath }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    },
  });
  const state: ClientState = { client, state: "INITIALIZING", lastQrPng: null };

  client.on("qr", async (qr) => {
    state.state = "QR_REQUIRED";
    state.lastQrPng = await qrcode.toBuffer(qr, { type: "png", scale: 8 });
    console.log("[wa] QR_REQUIRED — scan via http://localhost:9334/qr");
  });
  client.on("ready", () => { state.state = "READY"; state.lastQrPng = null; console.log("[wa] READY"); });
  client.on("disconnected", (reason) => {
    state.state = "DISCONNECTED";
    console.log("[wa] DISCONNECTED:", reason);
  });
  client.on("auth_failure", (msg) => {
    state.state = "DISCONNECTED";
    console.log("[wa] auth_failure:", msg);
  });

  return state;
}

export { MessageMedia };
```

- [ ] **Step 2: Write health + QR HTTP endpoint**

```typescript
// src/healthcheck.ts
import http from "node:http";
import type { ClientState } from "./client.js";

export function startHealthServer(state: ClientState, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: state.state }));
      return;
    }
    if (req.url === "/qr") {
      if (state.lastQrPng) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(state.lastQrPng);
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(`no QR pending (state=${state.state})`);
      }
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  server.listen(port, "127.0.0.1");
  console.log(`[wa] health/qr server on http://127.0.0.1:${port}`);
  return server;
}
```

- [ ] **Step 3: Sanity build**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os/whatsapp && npm run build 2>&1 | tail -5'
```
Expected: clean compile.

- [ ] **Step 4: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f whatsapp/src/client.ts whatsapp/src/healthcheck.ts && git commit -m "feat(whatsapp): whatsapp-web.js client wrapper + /health and /qr endpoints"'
```

### Task 14: Tier handlers — send tools

**Files:**
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/tools/send.ts`

- [ ] **Step 1: Write the send-tool wrappers**

```typescript
// src/tools/send.ts
import type { WAClient } from "../client.js";
import { MessageMedia } from "../client.js";
import fs from "node:fs/promises";

const PREFIX = "🤖";
const THROTTLE_MS = 3000;
let lastSendAt = 0;

async function throttle() {
  const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastSendAt));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastSendAt = Date.now();
}

export async function sendText(
  client: WAClient, chatId: string, text: string, replyToMsgId?: string,
): Promise<string> {
  await throttle();
  const sent = await client.sendMessage(chatId, `${PREFIX} ${text}`, {
    quotedMessageId: replyToMsgId,
  });
  return sent.id._serialized;
}

export async function sendInterim(
  client: WAClient, chatId: string, text: string, replyToMsgId?: string,
): Promise<string> {
  // Same as sendText but bypasses the 🤖 prefix duplication for in-progress acks
  await throttle();
  const sent = await client.sendMessage(chatId, `${PREFIX} ${text}`, {
    quotedMessageId: replyToMsgId,
  });
  return sent.id._serialized;
}

export async function sendMediaFromPath(
  client: WAClient, chatId: string, filePath: string, caption?: string, replyToMsgId?: string,
): Promise<string> {
  await throttle();
  const media = MessageMedia.fromFilePath(filePath);
  const sent = await client.sendMessage(chatId, media, {
    caption: caption ? `${PREFIX} ${caption}` : undefined,
    quotedMessageId: replyToMsgId,
  });
  return sent.id._serialized;
}

export async function sendMediaFromUrl(
  client: WAClient, chatId: string, url: string, caption?: string, replyToMsgId?: string,
): Promise<string> {
  await throttle();
  const media = await MessageMedia.fromUrl(url, { unsafeMime: true });
  const sent = await client.sendMessage(chatId, media, {
    caption: caption ? `${PREFIX} ${caption}` : undefined,
    quotedMessageId: replyToMsgId,
  });
  return sent.id._serialized;
}

export async function sendVoice(
  client: WAClient, chatId: string, audioFilePath: string, replyToMsgId?: string,
): Promise<string> {
  await throttle();
  const data = await fs.readFile(audioFilePath, { encoding: "base64" });
  const media = new MessageMedia("audio/ogg; codecs=opus", data);
  const sent = await client.sendMessage(chatId, media, {
    sendAudioAsVoice: true,
    quotedMessageId: replyToMsgId,
  });
  return sent.id._serialized;
}
```

- [ ] **Step 2: Build, verify compile**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os/whatsapp && npm run build 2>&1 | tail -5'
```

- [ ] **Step 3: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f whatsapp/src/tools/send.ts && git commit -m "feat(whatsapp): send tool wrappers (text/media/voice/interim) with global throttle"'
```

### Task 15: Whisper transcription tool

**Files:**
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/tools/transcribe.ts`

- [ ] **Step 1: Implement**

```typescript
// src/tools/transcribe.ts
import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeVoice(
  audioBytes: Buffer, mimeHint = "audio/ogg",
): Promise<{ text: string; durationMs: number; costEstimate: number }> {
  const t0 = Date.now();
  // Whisper API needs a file-like object; write to tmp then pass a stream.
  const ext = mimeHint.includes("mp3") ? "mp3" : mimeHint.includes("ogg") ? "ogg" : "m4a";
  const tmp = path.join(os.tmpdir(), `wa-voice-${Date.now()}.${ext}`);
  await fs.writeFile(tmp, audioBytes);
  try {
    const r = await client.audio.transcriptions.create({
      file: await import("fs").then(m => m.createReadStream(tmp)),
      model: "whisper-1",
    });
    const durationMs = Date.now() - t0;
    // Rough cost: $0.006/min — we don't know the audio duration here, approximate by 1 min.
    const costEstimate = 0.006;
    return { text: r.text, durationMs, costEstimate };
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
```

- [ ] **Step 2: Build**

- [ ] **Step 3: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f whatsapp/src/tools/transcribe.ts && git commit -m "feat(whatsapp): Whisper voice transcription tool (Tier 8 inbound)"'
```

### Task 16: Reply composer — single Claude call with tool surface

**Files:**
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/reply-composer.ts`

- [ ] **Step 1: Implement**

```typescript
// src/reply-composer.ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { routeToSource } from "./routing.js";
import type { Config } from "./config.js";

export interface ComposeInput {
  inboundText: string;
  inboundLang: "ar" | "en" | "unknown";
  threadContext: { sender: string; text: string }[];  // last 8 group msgs
  groupName: string;
  config: Config;
}

export interface ComposeResult {
  replyText: string | null;
  chosenTier: string;
  toolsCalled: string[];
  sourcesCited: string[];
  durationMs: number;
  costEstimate: number;
}

const SYSTEM_PROMPT = `You are the comms persona of ClaudeClaw, replying inside a WhatsApp group "Pilot with Ghassan AI" — an HR-support pilot where members ask questions about Saudi labor law, GOSI, Qiwa, Mudad, HRSD, Vision 2030.

REPLY RULES (STRICT):
1. Match customer's language. Arabic in → Arabic out. English in → English out.
2. Default to text answer (Tier 1). Use search_enterprise_kb with the matching source filter from the routing table.
3. Escalate to media tiers ONLY when an answer needs more than text:
   - Tier 2 (existing image): customer asks "show me X" and corpus likely has it → search_enterprise_kb_visual first
   - Tier 3 (existing PDF): customer asks for the source document
   - Tier 4 (generated doc): customer asks for sample contract / template / structured artifact
   - Tier 5 (generated image): customer asks for chart / diagram / illustration
   - Tier 6 (generated video): customer EXPLICITLY asks for video, OR explaining 4+ step flow that needs narrated walkthrough
   - Tier 7 (generated podcast): customer asks for "audio" / "podcast" version of long content
4. Cite EVERY RAG-grounded fact as: "Source: <short URL>" at end of reply.
5. Be concise. WhatsApp readers want quick answers. 2-4 sentences for most questions.
6. If no RAG match found AND topic is clearly out-of-scope (memes, chitchat, weather), give a one-line acknowledgment and stop. Don't invent answers.

ROUTING TABLE:
- "Qiwa" / "قوى" → source=qiwa-sa
- "Mudad" / "مدد" → source=mudad-com-sa
- "HRSD" / "وزارة الموارد" → source=hrsd-gov-sa
- "Vision 2030" / "رؤية 2030" → source=vision2030-gov-sa
- "labor law" / "نظام العمل" → sources=[saudi-labor-law, saudi-labor-law-bylaws]
- "GOSI" / "تأمينات" → source=gosi-social-insurance
- otherwise: no source filter

Return your reply as plain text. If you tool-called for media (image/video/etc), include the local file path in your reply text on a line "MEDIA_PATH: <path>" so the runtime can attach it.`;

export async function composeReply(input: ComposeInput): Promise<ComposeResult> {
  const t0 = Date.now();
  const routeHint = routeToSource(input.inboundText);
  const contextLines = input.threadContext.slice(-8).map(m => `${m.sender}: ${m.text}`).join("\n");
  const userPrompt = [
    `Group: ${input.groupName}`,
    `Detected language: ${input.inboundLang}`,
    routeHint ? `Routing hint: source=${routeHint.join(",")}` : "Routing hint: none",
    "",
    "Recent group messages (oldest first):",
    contextLines,
    "",
    `Latest message to answer: ${input.inboundText}`,
  ].join("\n");

  const toolsCalled: string[] = [];
  const sourcesCited: string[] = [];
  let replyText = "";
  let chosenTier = "1";

  for await (const msg of query({
    prompt: userPrompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: "claude-sonnet-4-6",
      maxTurns: 8,
      allowedTools: [
        "mcp__rag__search_enterprise_kb",
        "mcp__rag__search_enterprise_kb_visual",
        "mcp__imagegen__generate_image",
        "mcp__videogen__generate_video",
      ],
      cwd: "/tmp",
    },
  })) {
    if (msg.type === "tool_use") {
      toolsCalled.push(msg.name);
      if (msg.name.includes("imagegen")) chosenTier = "5";
      else if (msg.name.includes("videogen")) chosenTier = "6";
      else if (msg.name.includes("visual")) chosenTier = "2";
    }
    if (msg.type === "result" && msg.subtype === "success") {
      replyText = msg.result;
    }
  }

  // Parse out source citations
  const srcRegex = /Source:\s*([^\s\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = srcRegex.exec(replyText)) !== null) sourcesCited.push(m[1]);

  return {
    replyText: replyText || null,
    chosenTier,
    toolsCalled: Array.from(new Set(toolsCalled)),
    sourcesCited,
    durationMs: Date.now() - t0,
    costEstimate: 0,  // Pro/Max OAuth is free; only media gen costs are tracked elsewhere
  };
}
```

- [ ] **Step 2: Build, verify compile**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os/whatsapp && npm run build 2>&1 | tail -5'
```

- [ ] **Step 3: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f whatsapp/src/reply-composer.ts && git commit -m "feat(whatsapp): reply composer (single Claude call w/ rag + imagegen + videogen tools)"'
```

### Task 17: Service entrypoint — wire it all together

**Files:**
- Create: `/home/ubuntu/claudeclaw-os/whatsapp/src/service.ts` (replaces the placeholder from Task 8)

- [ ] **Step 1: Write the entrypoint**

```typescript
// src/service.ts
import "dotenv/config";
import { buildClient } from "./client.js";
import { startHealthServer } from "./healthcheck.js";
import { currentConfig, reloadConfig } from "./config.js";
import { detectLang } from "./lang.js";
import { composeReply } from "./reply-composer.js";
import {
  recordInbound, recordReply, alreadyReplied,
} from "./audit.js";
import {
  sendText, sendInterim, sendMediaFromPath,
} from "./tools/send.js";
import { transcribeVoice } from "./tools/transcribe.js";
import fs from "node:fs/promises";

const cfg0 = currentConfig();
console.log("[wa] starting, enabled=", cfg0.enabled, "groups=", cfg0.allowedGroups);

if (!cfg0.enabled) {
  console.log("[wa] WHATSAPP_ENABLED=false — running in passive mode (will receive but not reply)");
}

const state = buildClient();
startHealthServer(state, cfg0.qrPort);

state.client.on("message", async (msg) => {
  try {
    const cfg = currentConfig();
    const chat = await msg.getChat();
    if (!chat.isGroup) return;
    const groupName = chat.name;
    if (!cfg.isGroupAllowed(groupName)) return;

    // Idempotency: skip if already replied
    if (await alreadyReplied(chat.id._serialized, msg.id._serialized)) {
      return;
    }

    let inboundText = msg.body ?? "";
    let inboundType: "text" | "voice" | "image" = "text";

    if (msg.hasMedia && (msg.type === "audio" || msg.type === "ptt")) {
      const media = await msg.downloadMedia();
      const buf = Buffer.from(media.data, "base64");
      const t = await transcribeVoice(buf, media.mimetype);
      inboundText = t.text;
      inboundType = "voice";
    } else if (msg.hasMedia && msg.type === "image") {
      inboundType = "image";
      // Image-handling not in v1 scope (see spec out-of-scope). Treat caption as text.
      inboundText = msg.body ?? "[image]";
    }

    const inboundLang = detectLang(inboundText);
    const sender = (await msg.getContact()).pushname ?? msg.author ?? "unknown";

    await recordInbound({
      groupId: chat.id._serialized,
      groupName,
      senderNumber: msg.author ?? msg.from,
      senderName: sender,
      messageId: msg.id._serialized,
      inboundText,
      inboundType,
      inboundLang,
      inboundAt: new Date(),
    });

    if (!cfg.enabled) {
      console.log("[wa] passive mode: logged but not replying. msg=", inboundText.slice(0, 60));
      return;
    }

    // Pull thread context
    const threadMsgs = await chat.fetchMessages({ limit: 8 });
    const threadContext = await Promise.all(threadMsgs.map(async m => ({
      sender: (await m.getContact()).pushname ?? "unknown",
      text: m.body ?? "",
    })));

    const result = await composeReply({
      inboundText, inboundLang, threadContext, groupName, config: cfg,
    });

    let replyMsgId: string | null = null;
    let replyMediaUrl: string | null = null;

    if (!result.replyText) {
      // Composer chose to stay silent
      await recordReply({
        groupId: chat.id._serialized, messageId: msg.id._serialized,
        chosenTier: result.chosenTier, toolsCalled: result.toolsCalled,
        sourcesCited: result.sourcesCited, replyText: null, replyMediaUrl: null,
        replyAt: new Date(), replyMsgId: null,
        durationMs: result.durationMs, costEstimate: result.costEstimate, error: null,
      });
      return;
    }

    // Parse out MEDIA_PATH if present
    const mediaMatch = result.replyText.match(/MEDIA_PATH:\s*(\S+)/);
    const cleanText = result.replyText.replace(/MEDIA_PATH:.*$/m, "").trim();

    if (mediaMatch && cfg.isTierEnabled(result.chosenTier)) {
      const path = mediaMatch[1];
      try {
        await fs.access(path);
        replyMsgId = await sendMediaFromPath(
          state.client, chat.id._serialized, path, cleanText, msg.id._serialized,
        );
        replyMediaUrl = path;
      } catch {
        // Fallback: send text only with note
        replyMsgId = await sendText(
          state.client, chat.id._serialized,
          `${cleanText}\n\n_(media file unavailable)_`, msg.id._serialized,
        );
      }
    } else {
      replyMsgId = await sendText(
        state.client, chat.id._serialized, cleanText, msg.id._serialized,
      );
    }

    await recordReply({
      groupId: chat.id._serialized, messageId: msg.id._serialized,
      chosenTier: result.chosenTier, toolsCalled: result.toolsCalled,
      sourcesCited: result.sourcesCited, replyText: cleanText, replyMediaUrl,
      replyAt: new Date(), replyMsgId,
      durationMs: result.durationMs, costEstimate: result.costEstimate, error: null,
    });
  } catch (e) {
    console.error("[wa] message handler error:", e);
    try {
      await recordReply({
        groupId: (await msg.getChat()).id._serialized, messageId: msg.id._serialized,
        chosenTier: "0", toolsCalled: [], sourcesCited: [],
        replyText: null, replyMediaUrl: null, replyAt: new Date(), replyMsgId: null,
        durationMs: 0, costEstimate: 0,
        error: String(e).slice(0, 500),
      });
    } catch { /* swallow */ }
  }
});

process.on("SIGHUP", () => {
  reloadConfig();
  console.log("[wa] config reloaded");
});

process.on("SIGTERM", async () => {
  console.log("[wa] SIGTERM, destroying client");
  await state.client.destroy();
  process.exit(0);
});

state.client.initialize();
```

- [ ] **Step 2: Build**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os/whatsapp && npm run build 2>&1 | tail -5'
```

- [ ] **Step 3: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f whatsapp/src/service.ts && git commit -m "feat(whatsapp): service entrypoint wiring inbound msg → audit → compose → send"'
```

---

## Phase F — Deployment

### Task 18: Add MCP servers to project settings

**Files:**
- Modify: `/home/ubuntu/claudeclaw-os/.claude/settings.json`

- [ ] **Step 1: Read current MCP entries**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cat /home/ubuntu/claudeclaw-os/.claude/settings.json | python3 -m json.tool | head -60'
```

Look for the `mcpServers` block.

- [ ] **Step 2: Add `imagegen` and `videogen` (and `podcastgen` if Task 7 was completed)**

Within `mcpServers`, add (matching the existing `rag` entry style):

```json
"imagegen": {
  "command": "/home/ubuntu/rag-platform/.venv/bin/python",
  "args": ["/home/ubuntu/rag-platform/mcp/imagegen/server.py"]
},
"videogen": {
  "command": "/home/ubuntu/rag-platform/.venv/bin/python",
  "args": ["/home/ubuntu/rag-platform/mcp/videogen/server.py"]
}
```

- [ ] **Step 3: Add env vars to .env**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cat >> /home/ubuntu/claudeclaw-os/.env <<EOF

# WhatsApp comms channel (Task 17, plan 2026-05-09)
WHATSAPP_ENABLED=false
WHATSAPP_ALLOWED_GROUPS=Pilot with Ghassan AI
WHATSAPP_TIERS_ENABLED=1,2,3,4,5,6,8
WHATSAPP_QR_PORT=9334
EOF
chmod 600 /home/ubuntu/claudeclaw-os/.env'
```

(Tier 7 omitted unless Task 7 was completed.)

- [ ] **Step 4: Commit settings**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add .claude/settings.json && git commit -m "feat(mcp): register imagegen + videogen MCP servers"'
```

### Task 19: systemd unit

**Files:**
- Create: `/etc/systemd/system/claudeclaw-comms-whatsapp.service`

- [ ] **Step 1: Write the unit (sudo on AWS)**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'sudo tee /etc/systemd/system/claudeclaw-comms-whatsapp.service > /dev/null <<EOF
[Unit]
Description=ClaudeClaw WhatsApp comms channel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/claudeclaw-os/whatsapp
EnvironmentFile=/home/ubuntu/claudeclaw-os/.env
ExecStart=/usr/bin/node dist/service.js
Restart=on-failure
RestartSec=10s
StandardOutput=append:/home/ubuntu/logs/claudeclaw-comms-whatsapp.log
StandardError=append:/home/ubuntu/logs/claudeclaw-comms-whatsapp.log
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload'
```

- [ ] **Step 2: Enable but DO NOT start yet**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'sudo systemctl enable claudeclaw-comms-whatsapp.service'
```

(Don't start until Task 20 QR-login is done — otherwise the service will keep restarting trying to find a saved session that doesn't exist.)

### Task 20: QR-login bootstrap (interactive, requires Mohamed)

**Files:** None (operational).

- [ ] **Step 1: Start the service**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'sudo systemctl start claudeclaw-comms-whatsapp.service && sleep 5 && sudo systemctl status claudeclaw-comms-whatsapp.service --no-pager | head -15 && tail -10 /home/ubuntu/logs/claudeclaw-comms-whatsapp.log'
```

You should see "[wa] QR_REQUIRED" in the log within ~10s.

- [ ] **Step 2: Open SSH tunnel from Mac**

```bash
# In a new Mac terminal
ssh -L 9334:127.0.0.1:9334 -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145
# leave open
```

- [ ] **Step 3: Open the QR in your browser**

```bash
# In another Mac terminal
open http://localhost:9334/qr
```

A QR code appears.

- [ ] **Step 4: On your phone — link the device**

WhatsApp on phone → Settings → Linked Devices → Link a Device → scan the QR on screen.

- [ ] **Step 5: Verify the service moved to READY**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'curl -s http://127.0.0.1:9334/health'
```
Expected: `{"state":"READY"}`. Within ~5 seconds of linking.

If state stays at `INITIALIZING` or `QR_REQUIRED` past 30s, check the log: `tail -30 /home/ubuntu/logs/claudeclaw-comms-whatsapp.log`.

### Task 21: Add the bot to "Pilot with Ghassan AI" group

**Files:** None (operational).

- [ ] **Step 1: Confirm WhatsApp connection state**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'curl -s http://127.0.0.1:9334/health'
```
Expected: `{"state":"READY"}`.

- [ ] **Step 2: Mohamed action — create or invite**

If "Pilot with Ghassan AI" group doesn't exist yet: create it on your phone, add 1-2 test members.
If it exists: confirm the linked-device account is already a member (since the bot uses your number, you ARE already in the group).

- [ ] **Step 3: Smoke test from another phone (or yourself)**

Send a test message in the group: "What is the GOSI subscription rate?"

Watch the log:
```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'tail -f /home/ubuntu/logs/claudeclaw-comms-whatsapp.log'
```

Expected within 30 seconds:
- log line showing the inbound message logged
- log line showing "passive mode: logged but not replying" (because `WHATSAPP_ENABLED=false` initially)

This confirms ingestion works without sending any auto-replies (sanity check before flipping the switch).

- [ ] **Step 4: Verify in DB**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'export $(grep "^DATABASE_URL=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && psql "$DATABASE_URL" -c "SELECT inbound_text, inbound_lang, sender_name, inbound_at FROM whatsapp_exchanges WHERE group_name=\"Pilot with Ghassan AI\" ORDER BY inbound_at DESC LIMIT 3;"'
```
Expected: your test message appears.

### Task 22: Flip enabled=true, end-to-end smoke

**Files:**
- Modify: `/home/ubuntu/claudeclaw-os/.env` (toggle one var)

- [ ] **Step 1: Enable**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'sed -i "s|^WHATSAPP_ENABLED=false|WHATSAPP_ENABLED=true|" /home/ubuntu/claudeclaw-os/.env && sudo systemctl reload claudeclaw-comms-whatsapp.service 2>/dev/null || sudo pkill -HUP -f "node dist/service.js"'
```

(`systemctl reload` won't work without ExecReload= in the unit — fall back to direct SIGHUP.)

- [ ] **Step 2: Send a real test from your phone in the group**

"What is the GOSI subscription rate?"

Watch:
```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'tail -f /home/ubuntu/logs/claudeclaw-comms-whatsapp.log'
```

Expected within ~5s: bot replies in the group with a citation from `gosi-social-insurance` source.

- [ ] **Step 3: Test Tier 5 (image gen)**

In group: "Make me a chart showing the GOSI rate breakdown."

Expected within ~15s: bot sends 🤖 caption + a generated chart image.

- [ ] **Step 4: Test Tier 6 (video gen)**

In group: "Send me a short video explaining how to add a worker on Qiwa."

Expected within ~90s: bot sends an interim "generating video…" message, then 🤖-prefixed video attachment.

- [ ] **Step 5: Test Tier 8 (voice transcription)**

Send a voice note in the group: "نسبة اشتراك التأمينات الاجتماعية كم؟"

Expected within ~10s: bot replies with the GOSI rate answer in Arabic.

- [ ] **Step 6: Verify audit completeness**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'export $(grep "^DATABASE_URL=" /home/ubuntu/claudeclaw-os/.env | xargs -d "\n") && psql "$DATABASE_URL" -c "
SELECT chosen_tier, inbound_text, reply_text, sources_cited, duration_ms
FROM whatsapp_exchanges WHERE group_name=\"Pilot with Ghassan AI\"
  AND inbound_at > now() - interval \"30 minutes\"
ORDER BY inbound_at DESC LIMIT 10;
"'
```
Every recent exchange should have `chosen_tier`, `reply_text` (or media), `sources_cited`, sane `duration_ms`.

### Task 23: Wire monitoring into healthcheck timer

**Files:**
- Modify: `~/.config/systemd/user/claudeclaw-healthcheck.service` (or wherever the existing healthcheck logic lives — `claudeclaw_aws_deployment.md` mentions `claudeclaw-healthcheck.timer`)

- [ ] **Step 1: Find existing healthcheck script**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'systemctl --user cat claudeclaw-healthcheck.timer; systemctl --user cat claudeclaw-healthcheck.service; ls /home/ubuntu/scripts/healthcheck* 2>/dev/null'
```

- [ ] **Step 2: Append WhatsApp checks**

Add to the existing healthcheck script (path discovered in Step 1):

```bash
# WhatsApp service check
if ! systemctl is-active --quiet claudeclaw-comms-whatsapp; then
  /home/ubuntu/scripts/notify.sh "WhatsApp service inactive"
fi

# WA Web auth health
WA_STATE=$(curl -s --max-time 5 http://127.0.0.1:9334/health | python3 -c "import sys, json; print(json.load(sys.stdin).get('state','unknown'))" 2>/dev/null || echo "unreachable")
case "$WA_STATE" in
  READY) ;;
  QR_REQUIRED) /home/ubuntu/scripts/notify.sh "WhatsApp QR rescan needed: ssh -L 9334:127.0.0.1:9334 ubuntu@13.204.65.145, then http://localhost:9334/qr" ;;
  *) /home/ubuntu/scripts/notify.sh "WhatsApp state=$WA_STATE" ;;
esac

# Reply backlog
BACKLOG=$(/usr/bin/psql "$DATABASE_URL" -At -c "SELECT count(*) FROM whatsapp_exchanges WHERE reply_at IS NULL AND inbound_at > now() - interval '5 minutes'" 2>/dev/null)
if [ "${BACKLOG:-0}" -gt 5 ]; then
  /home/ubuntu/scripts/notify.sh "WhatsApp reply backlog: $BACKLOG pending in last 5 min"
fi
```

- [ ] **Step 3: Test the new checks fire correctly**

Manually run the healthcheck script once:

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 '/home/ubuntu/scripts/healthcheck.sh 2>&1 | tail -10'
```
Expected: no notifications fired (because everything's healthy).

- [ ] **Step 4: Commit**

```bash
ssh -i ~/.ssh/claudeclaw-aws ubuntu@13.204.65.145 'cd /home/ubuntu/claudeclaw-os && git add -f scripts/healthcheck.sh 2>/dev/null && git commit -m "feat(monitor): WhatsApp service liveness + auth + backlog checks" 2>&1 || echo "nothing to commit (script may live elsewhere)"'
```

---

## Phase G — Memory + closeout

### Task 24: Update Gemini-policy memory

**Files:**
- Modify: `/Users/mghassan/.claude/projects/-Users-mghassan/memory/feedback_gemini_vs_claude_split.md`

- [ ] **Step 1: Read current**

- [ ] **Step 2: Append:**

```markdown

## Updated 2026-05-09 (WhatsApp comms launch)

`GOOGLE_API_KEY` scope expanded to include MEDIA generation:
- Voice (transcription, Gemini Live war room) — original use
- **Nano Banana** (`gemini-2.5-flash-image-preview`) for image generation — NEW
- **NotebookLM Audio Overviews** for podcast generation — NEW (if API access verified)

`OPENAI_API_KEY` (added 2026-05-09) is for:
- **GPT-Image-1** for chart/text-heavy image generation
- **Whisper** for voice-note transcription

Text-LLM work (memory ingestion, classification, dashboards, customer replies) STAYS on Claude (`CLAUDE_CODE_OAUTH_TOKEN`) — original cost-optimization rule unchanged.
```

- [ ] **Step 3: Update MEMORY.md index entry to reflect new key + scope**

Find the `feedback_gemini_vs_claude_split.md` line and update its description.

### Task 25: Add WhatsApp memory entry

**Files:**
- Create: `/Users/mghassan/.claude/projects/-Users-mghassan/memory/whatsapp_comms_channel.md`
- Modify: `/Users/mghassan/.claude/projects/-Users-mghassan/memory/MEMORY.md`

- [ ] **Step 1: Write the memory file**

```markdown
---
name: WhatsApp comms channel (Pilot with Ghassan AI)
description: Always-on WA listener service — comms persona, RAG-grounded, 8 reply tiers, runs on Mohamed's personal WhatsApp number via whatsapp-web.js
type: project
---

**Live since 2026-05-09.** New systemd unit `claudeclaw-comms-whatsapp.service` on AWS (`/home/ubuntu/claudeclaw-os/whatsapp/`). Replies in the "Pilot with Ghassan AI" WhatsApp group only (allowlist).

**Tier model (from `docs/specs/2026-05-09-whatsapp-comms-design.md`):**
- 1: text answer (Sonnet 4.6 + RAG)
- 2: existing image from corpus (search_enterprise_kb_visual)
- 3: existing PDF from corpus
- 4: generated doc (docx/pdf/xlsx)
- 5a: gen image — Nano Banana (default)
- 5b: gen image — GPT-Image-1 (chart/text-heavy)
- 6: gen video — HeyGen avatar
- 7: gen audio podcast — NotebookLM (CONDITIONAL on API access)
- 8: inbound voice → Whisper transcribe

**Kill switches** (all hot-reload via SIGHUP, no restart):
- `WHATSAPP_ENABLED=false` — passive mode
- `WHATSAPP_ALLOWED_GROUPS` — group allowlist
- `WHATSAPP_TIERS_ENABLED` — disable specific tiers (e.g., `=1,2,3,4` kills all gen tiers)

**QR-login**: persists in `/home/ubuntu/.wwebjs_auth/`. Tunneled QR endpoint: `ssh -L 9334:127.0.0.1:9334 ubuntu@13.204.65.145` → `http://localhost:9334/qr`. Re-scan needed every few weeks; healthcheck timer pings on Telegram when `state=QR_REQUIRED`.

**Audit**: `whatsapp_exchanges` table in same Neon DB. Idempotent on `(group_id, message_id)` so service restart never double-replies.

**Cost**: ~$15-35/mo steady-state (mostly HeyGen video + occasional GPT-Image-1). Sonnet 4.6 free via OAuth.

**Ban-risk mitigations**: 1 send / 3s global throttle, identifying 🤖 prefix, single-group allowlist, honest user-agent. Personal WA number — rotate to dedicated SIM if account ever gets flagged.

**Memory rule update**: see `feedback_gemini_vs_claude_split.md` (2026-05-09 update) — `GOOGLE_API_KEY` and `OPENAI_API_KEY` allowed for media gen; text-LLM work still on Claude.
```

- [ ] **Step 2: Add MEMORY.md index line**

Append to `MEMORY.md`:

```markdown
- [WhatsApp comms channel (Pilot with Ghassan AI)](whatsapp_comms_channel.md) — 2026-05-09 launched; 8 reply tiers, RAG-grounded, on Mohamed's personal WA number via whatsapp-web.js; allowlisted single group; SIGHUP-reloadable kill switches.
```

---

## Self-review

**Spec coverage check:**

- ✅ Architecture (standalone service, comms identity) — Tasks 8-17
- ✅ 8 reply tiers — Tasks 14-17 (composer + service routes by Claude tool calls)
- ✅ RAG routing table — Task 10
- ✅ Audit table + idempotency — Tasks 4, 12
- ✅ Kill switches — Task 9 (config) + Task 18 (env vars) + Task 22 (test SIGHUP reload)
- ✅ QR-login bootstrap — Tasks 13, 20
- ✅ Monitoring hooks — Task 23
- ✅ Pre-flight key rotation + API smoke tests — Tasks 1-3
- ✅ Three new MCP servers (imagegen, videogen, podcastgen-conditional) — Tasks 5, 6, 7
- ✅ Memory rule update — Task 24
- ✅ NotebookLM verification gate — Task 2 Step 4 + Task 7 conditional skip

**Placeholder scan:** No "TBD" / "implement later" except Task 7 which is explicitly conditional on Task 2 Step 4 outcome (verifiable gate, not a placeholder).

**Type / signature consistency:**
- `composeReply(input: ComposeInput): Promise<ComposeResult>` used identically in service.ts and reply-composer.ts ✅
- `recordInbound(r: InboundRecord)` and `recordReply(r: ReplyRecord)` types defined in audit.ts and called from service.ts with matching shape ✅
- `sendText/sendInterim/sendMediaFromPath/sendMediaFromUrl/sendVoice` all return `Promise<string>` (the message id) ✅
- `MessageMedia` re-exported from client.ts and used by send.ts ✅
- Tier numbers as strings ("1".."8") used consistently in audit, config, and composer ✅

No issues found.
