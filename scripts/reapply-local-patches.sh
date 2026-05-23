#!/usr/bin/env bash
# reapply-local-patches.sh
#
# Read-only verifier for the 9 local customization patches that ClaudeClaw OS
# carries on top of upstream `earlyaidopters/claudeclaw-os`. Run after every
# `git pull` (or upstream-resync) to confirm no patch was lost in a merge or
# fast-forward. This script NEVER modifies source files.
#
# Exit code: 0 = all 9 present, 1 = at least one missing.
#
# Reapply reference: memory `claudeclaw_aws_deployment.md` patch list and
# `claudeclaw_upgrade_plan_2026-05.md`. Local backups, when present, follow
# the convention `<file>.bak.before-<patch-tag>`.

set -u
cd "$(dirname "$0")/.."

REPO_ROOT="$(pwd)"

PASS_GLYPH=$'\xe2\x9c\x93'   # ✓
FAIL_GLYPH=$'\xe2\x9c\x97'   # ✗

missing=0
total=9

# ---- helper: report a passing patch -----------------------------------------
report_pass() {
    local name="$1"
    printf '%s %s\n' "$PASS_GLYPH" "$name"
}

# ---- helper: report a failing patch with reapply hint -----------------------
# args: <name> <reapply-hint> [<bak-glob-relative-to-repo-root>]
report_fail() {
    local name="$1"
    local hint="$2"
    local bak_glob="${3:-}"
    local bak_note=""
    if [ -n "$bak_glob" ]; then
        # shellcheck disable=SC2086
        local found
        found=$(ls $bak_glob 2>/dev/null | head -n1)
        if [ -n "$found" ]; then
            bak_note=" | local backup: $found"
        else
            bak_note=" | no local *.bak.before-* found"
        fi
    fi
    printf '%s %s -- MISSING -- %s%s\n' "$FAIL_GLYPH" "$name" "$hint" "$bak_note"
    missing=$((missing + 1))
}

# ---- helper: grep for a marker in a file ------------------------------------
# args: <file> <marker>
file_has_marker() {
    local file="$1"
    local marker="$2"
    [ -f "$file" ] && grep -q -F -- "$marker" "$file"
}

# =============================================================================
# Patch 1: src/anthropic.ts exists (Claude agent-SDK helper for non-voice text)
# =============================================================================
name="01 src/anthropic.ts (Claude SDK helper)"
if [ -s "src/anthropic.ts" ]; then
    report_pass "$name"
else
    report_fail "$name" \
        "recreate from memory claudeclaw_aws_deployment.md (whole file is a local addition)" \
        "src/anthropic.ts.bak.before-*"
fi

# =============================================================================
# Patch 2: memory* + dashboard import from './anthropic.js' (memory->Claude swap)
# =============================================================================
name="02 memory/dashboard -> ./anthropic.js import"
# Match either single- or double-quoted import to be robust against
# formatter/quote-style drift (current tree uses double quotes).
all_ok=1
for f in src/memory-ingest.ts src/memory-consolidate.ts src/memory.ts src/dashboard.ts; do
    if ! { [ -f "$f" ] && grep -qE "from ['\"]\\./anthropic\\.js['\"]" "$f"; }; then
        all_ok=0
        break
    fi
done
if [ $all_ok -eq 1 ]; then
    report_pass "$name"
else
    report_fail "$name" \
        "ensure each of memory-ingest.ts, memory-consolidate.ts, memory.ts, dashboard.ts imports from './anthropic.js' (Gemini->Claude swap)" \
        "src/memory*.ts.bak.before-* src/dashboard.ts.bak.before-*"
fi

# =============================================================================
# Patch 3: src/bot.ts pins claude-opus-4-7 (main agent fallback model bump)
# =============================================================================
name="03 src/bot.ts model bump (claude-opus-4-7)"
if file_has_marker "src/bot.ts" "claude-opus-4-7"; then
    report_pass "$name"
else
    report_fail "$name" \
        "set fallback model to claude-opus-4-7 in src/bot.ts" \
        "src/bot.ts.bak.before-*"
fi

# =============================================================================
# Patch 4: src/voice.ts hallucination guard (both symbols)
# =============================================================================
name="04 src/voice.ts hallucination guard"
if file_has_marker "src/voice.ts" "looksLikeHallucination" \
    && file_has_marker "src/voice.ts" "TranscriptionHallucinationError"; then
    report_pass "$name"
else
    report_fail "$name" \
        "reapply looksLikeHallucination + TranscriptionHallucinationError in src/voice.ts" \
        "src/voice.ts.bak.before-*"
fi

# =============================================================================
# Patch 5: warroom/server.py SpeechTimeoutUserTurnStopStrategy (Arabic turn fix)
# =============================================================================
name="05 warroom Arabic turn-stop strategy"
if file_has_marker "warroom/server.py" "SpeechTimeoutUserTurnStopStrategy"; then
    report_pass "$name"
else
    report_fail "$name" \
        "swap default turn-stop strategy to SpeechTimeoutUserTurnStopStrategy in warroom/server.py" \
        "warroom/server.py.bak.before-*"
fi

# =============================================================================
# Patch 6: AGENTS.md exists at repo root, non-empty (browser+investigation rules)
# =============================================================================
name="06 AGENTS.md (root, non-empty)"
if [ -s "AGENTS.md" ]; then
    report_pass "$name"
else
    report_fail "$name" \
        "restore root AGENTS.md (browser-automation rules + investigation protocol; upstream has none)" \
        "AGENTS.md.bak.before-*"
fi

# =============================================================================
# Patch 7: src/agent.ts McpHttpConfig (HTTP-MCP loader, 2026-05-13)
# =============================================================================
name="07 src/agent.ts HTTP-MCP loader (McpHttpConfig)"
if file_has_marker "src/agent.ts" "McpHttpConfig"; then
    report_pass "$name"
else
    report_fail "$name" \
        "reapply McpHttpConfig type + loader branch in src/agent.ts (critical for codewiki MCP)" \
        "src/agent.ts.bak.before-*"
fi

# =============================================================================
# Patch 8: src/warroom-tool-policy.ts main allowlist entry (2026-05-13)
# =============================================================================
name="08 warroom-tool-policy main allowlist (jisr-backend-codewiki)"
if file_has_marker "src/warroom-tool-policy.ts" "main: ['mcp:jisr-backend-codewiki']"; then
    report_pass "$name"
else
    report_fail "$name" \
        "add  main: ['mcp:jisr-backend-codewiki']  entry in src/warroom-tool-policy.ts" \
        "src/warroom-tool-policy.ts.bak.before-*"
fi

# =============================================================================
# Patch 9: whatsapp/src/reply-composer.ts wires jisr-backend-codewiki (2026-05-13/14)
# =============================================================================
name="09 whatsapp reply-composer codewiki wiring"
if file_has_marker "whatsapp/src/reply-composer.ts" "jisr-backend-codewiki"; then
    report_pass "$name"
else
    report_fail "$name" \
        "reapply jisr-backend-codewiki MCP entry + Rule 5b system-prompt addition in whatsapp/src/reply-composer.ts" \
        "whatsapp/src/reply-composer.ts.bak.before-*"
fi

# =============================================================================
# Summary
# =============================================================================
echo
present=$((total - missing))
if [ "$missing" -eq 0 ]; then
    printf '%d/%d patches present\n' "$present" "$total"
    exit 0
else
    printf '%d/%d patches present -- %d MISSING (see above)\n' "$present" "$total" "$missing"
    exit 1
fi
