#!/usr/bin/env python3
"""
Deterministic "new human comments" detector for the GMC Jira board.

WHY THIS EXISTS
---------------
The Scrum Master's comment scan used to JQL-fetch every comment on every
recently-updated issue and re-parse all of them each run. Because the bot and
the human share ONE Jira account (m.ghassan@jisr.net), the bot kept re-reading
its own past comments ("Approved - moving to In Progress", etc.) as fresh human
instructions -> infinite loop (GMC-13 reached 188 comments).

This helper makes detection deterministic so the loop cannot recur:

  1. CURSOR  - a per-issue "last seen comment id" is persisted. Every comment is
     considered exactly once, ever. History is never re-read.
  2. [BOT] SKIP - any comment whose text starts with [BOT] / [AUTOMATED] is
     treated as bot-authored and skipped. Author email cannot distinguish bot
     from human (shared account), so the [BOT] text marker is the signal.

MODES
-----
  jira_new_comments.py --seed
      Point every GMC issue's cursor at its current newest comment id, then
      exit. Returns nothing actionable. Run once to ignore all existing history.

  jira_new_comments.py
      Print JSON: genuinely-new, non-bot comments only. Then advance every
      cursor. The Scrum Master agent acts ONLY on the "comments" array.

  jira_new_comments.py --dry-run
      Same as default but does NOT advance cursors (inspection only).
"""
import base64
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

JIRA = "https://jisrhr.atlassian.net"
EMAIL = "m.ghassan@jisr.net"
ENV_FILE = "/home/ubuntu/claudeclaw-os/.env"
PROJECT = "GMC"
CURSOR_FILE = Path.home() / ".claudeclaw" / "agents" / "scrum" / "comment_cursors.json"
BOT_PREFIXES = ("[BOT]", "[AUTOMATED]")


def jira_token():
    for line in open(ENV_FILE):
        if line.startswith("JIRA_API_TOKEN="):
            return line.strip().split("=", 1)[1]
    sys.exit("ERROR: JIRA_API_TOKEN not found in .env")


AUTH = base64.b64encode(f"{EMAIL}:{jira_token()}".encode()).decode()
HEADERS = {"Authorization": f"Basic {AUTH}", "Accept": "application/json"}


def jget(path):
    req = urllib.request.Request(JIRA + path, headers=HEADERS)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def jpost(path, body):
    req = urllib.request.Request(
        JIRA + path, data=json.dumps(body).encode(),
        headers={**HEADERS, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def plain_text(adf):
    """Flatten an ADF comment body to plain text."""
    out = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "text":
                out.append(node.get("text", ""))
            for child in node.get("content", []):
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(adf)
    return "".join(out)


def is_bot_comment(text):
    t = text.strip().upper()
    return any(t.startswith(p) for p in BOT_PREFIXES)


def load_cursors():
    if CURSOR_FILE.exists():
        return json.loads(CURSOR_FILE.read_text())
    return {}


def save_cursors(cursors):
    CURSOR_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(CURSOR_FILE.parent))
    with os.fdopen(fd, "w") as f:
        json.dump(cursors, f, indent=2, sort_keys=True)
    os.replace(tmp, CURSOR_FILE)


def list_issues():
    res = jpost("/rest/api/3/search/jql", {
        "jql": f"project={PROJECT}",
        "fields": ["summary", "status"],
        "maxResults": 100,
    })
    return [(i["key"], i["fields"]["summary"], i["fields"]["status"]["name"])
            for i in res.get("issues", [])]


def fetch_comments(issue_key):
    out, start = [], 0
    while True:
        d = jget(f"/rest/api/3/issue/{issue_key}/comment"
                 f"?startAt={start}&maxResults=100&orderBy=created")
        out.extend(d.get("comments", []))
        total = d.get("total", 0)
        start += d.get("maxResults", 100)
        if start >= total or not d.get("comments"):
            break
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    seed = mode == "--seed"
    dry = mode == "--dry-run"
    if mode and not (seed or dry):
        sys.exit("usage: jira_new_comments.py [--seed | --dry-run]")

    cursors = load_cursors()
    new_cursors = dict(cursors)
    actionable = []

    for key, summary, status in list_issues():
        comments = fetch_comments(key)
        if not comments:
            continue
        max_id = max(int(c["id"]) for c in comments)
        cur = int(cursors.get(key, 0))
        if not seed:
            for c in comments:
                cid = int(c["id"])
                if cid <= cur:
                    continue
                text = plain_text(c.get("body"))
                if is_bot_comment(text):
                    continue
                author = c.get("author", {})
                actionable.append({
                    "issue_key": key,
                    "issue_summary": summary,
                    "issue_status": status,
                    "comment_id": c["id"],
                    "created": c.get("created"),
                    "author": author.get("emailAddress") or author.get("displayName"),
                    "text": text,
                })
        new_cursors[key] = max_id

    if not dry:
        save_cursors(new_cursors)

    if seed:
        print(json.dumps({
            "mode": "seed",
            "issues_seeded": len(new_cursors),
            "message": "All existing comments are now behind the cursor and "
                       "will never be re-processed.",
            "cursors": new_cursors,
        }, indent=2))
    else:
        actionable.sort(key=lambda x: x["created"] or "")
        print(json.dumps({
            "mode": "dry-run" if dry else "scan",
            "new_comment_count": len(actionable),
            "comments": actionable,
        }, indent=2))


if __name__ == "__main__":
    main()
