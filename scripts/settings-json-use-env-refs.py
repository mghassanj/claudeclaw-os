#!/usr/bin/env python3
"""Replace pasted secrets in ~/.claude/settings.json MCP config with ${VAR} refs.

ClaudeClaw's loadMcpServers (src/agent.ts) expands ${VAR} / $VAR in MCP
server url/headers/args/env from its environment (+ .env fallback).
Claude Code itself does NOT read `mcpServers` from settings.json (it uses
~/.claude.json / .mcp.json), so these refs are interpreted only by
ClaudeClaw.

For each VAR named on the command line, every string under `mcpServers`
(url, headers.*, args[], env.*) that CONTAINS the variable's .env value is
rewritten so the value becomes `${VAR}` (e.g. "Bearer <tok>" ->
"Bearer ${JISR_CODEWIKI_TOKEN}"). Matching is by value; values are never
printed, only server/field names and counts.

Usage (on the host, as ubuntu):
  python3 scripts/settings-json-use-env-refs.py \
      --env /home/ubuntu/claudeclaw-os/.env \
      JISR_CODEWIKI_TOKEN HEYGEN_API_KEY            # dry run
  python3 scripts/settings-json-use-env-refs.py --apply \
      --env /home/ubuntu/claudeclaw-os/.env JISR_CODEWIKI_TOKEN HEYGEN_API_KEY

--apply writes a timestamped backup (mode 0600) next to settings.json first.
Deploy the ClaudeClaw build that contains ${VAR} expansion BEFORE --apply,
otherwise the running bot would send the literal "${...}" string.
"""
import argparse
import json
import os
import shutil
import sys
import time

MIN_SECRET_LEN = 8  # never match trivially short values (e.g. "1", "true")


def parse_env(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            if k.startswith("export "):
                k = k[len("export "):].strip()
            v = v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            env[k] = v
    return env


def rewrite(value, secrets):
    """Return (new_value, [var names substituted])."""
    hits = []
    # Longest value first so a secret that contains another is handled whole.
    for var, secret in sorted(secrets.items(), key=lambda kv: -len(kv[1])):
        if secret in value:
            value = value.replace(secret, "${%s}" % var)
            hits.append(var)
    return value, hits


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("vars", nargs="+", help="env var names whose values should become ${VAR} refs")
    ap.add_argument("--env", default=os.path.expanduser("~/claudeclaw-os/.env"))
    ap.add_argument("--settings", default=os.path.expanduser("~/.claude/settings.json"))
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    args = ap.parse_args()

    env = parse_env(args.env)
    secrets = {}
    for var in args.vars:
        val = env.get(var, "")
        if not val:
            print(f"[skip] {var}: not set in {args.env}")
            continue
        if len(val) < MIN_SECRET_LEN:
            print(f"[skip] {var}: value shorter than {MIN_SECRET_LEN} chars; refusing to match by value")
            continue
        secrets[var] = val
    if not secrets:
        print("nothing to do")
        return 0

    with open(args.settings, encoding="utf-8") as f:
        data = json.load(f)
    servers = data.get("mcpServers") or {}

    changes = 0
    for name, cfg in servers.items():
        if not isinstance(cfg, dict):
            continue
        if isinstance(cfg.get("url"), str):
            cfg["url"], hits = rewrite(cfg["url"], secrets)
            for h in hits:
                print(f"  {name}.url -> ${{{h}}}")
                changes += 1
        for section in ("headers", "env"):
            sec = cfg.get(section)
            if isinstance(sec, dict):
                for k, v in list(sec.items()):
                    if isinstance(v, str):
                        sec[k], hits = rewrite(v, secrets)
                        for h in hits:
                            print(f"  {name}.{section}.{k} -> ${{{h}}}")
                            changes += 1
        if isinstance(cfg.get("args"), list):
            for i, v in enumerate(cfg["args"]):
                if isinstance(v, str):
                    cfg["args"][i], hits = rewrite(v, secrets)
                    for h in hits:
                        print(f"  {name}.args[{i}] -> ${{{h}}}")
                        changes += 1

    # Verify no raw secret is left anywhere under mcpServers.
    blob = json.dumps(servers)
    leftover = [v for v, s in secrets.items() if s in blob]
    print(f"{changes} substitution(s); literal values still present for: {leftover or 'none'}")

    if not args.apply:
        print("dry run: re-run with --apply to write")
        return 0
    if changes == 0:
        print("no changes; settings.json untouched")
        return 0

    backup = f"{args.settings}.bak.{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(args.settings, backup)
    os.chmod(backup, 0o600)
    tmp = args.settings + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, args.settings)
    print(f"wrote {args.settings} (backup: {backup})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
