#!/usr/bin/env python3
"""
Gmail → Jira email scanner for the Scrum Master agent.

WHAT IT DOES
------------
1. Fetches emails from the past hour that are NOT from Mohammed himself
   and NOT from known automated/no-reply senders.
2. Loads active GMC Jira issues via POST /rest/api/3/search/jql.
3. Tries to match each email to an existing issue (keyword overlap or
   issue-key mention in body/subject).
4. If matched → adds a [BOT] Jira comment summarising the email + a
   suggested reply draft for Mohammed to send.
5. If no match but looks like a genuine human project request → creates a
   new GMC Jira issue in Inbox and adds the same summary + draft comment.
6. Automated / system notification senders are explicitly blocked so they
   never create false-positive issues.

AUTOMATED SENDER DETECTION
---------------------------
Senders are considered automated if ANY of:
  - From address is in BLOCKED_SENDER_DOMAINS (e.g. alsaifgallery.com via
    the hr@ address that sends Jisr workflow notifications)
  - From address matches BLOCKED_SENDER_PATTERNS regex
  - Subject matches AUTOMATED_SUBJECT_PATTERNS regex (Jira, Jisr system emails)

Only emails that survive all filters reach the Jira-matching stage.

USAGE
-----
  python3 gmail_scan.py            # normal run
  python3 gmail_scan.py --dry-run  # print decisions but take no Jira action
"""

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

# ─── Config ──────────────────────────────────────────────────────────────────

DRY_RUN = "--dry-run" in sys.argv

ENV_FILE = "/home/ubuntu/claudeclaw-os/.env"
GMAIL_TOKEN_FILE = os.path.expanduser("~/.config/gmail/token.json")

# Senders/domains whose mail is NEVER treated as a project request.
# Add new automated senders here.
BLOCKED_SENDER_DOMAINS = {
    "alsaifgallery.com",    # Jisr customer — automated HR workflow emails
    "jisr.net",             # Internal Jisr system notifications
    "noreply.github.com",
    "notifications.github.com",
    "atlassian.net",
    "jira.com",
    "slack.com",
    "calendar.google.com",
    "mail.notion.so",
    "trello.com",
    "linear.app",
}

# Regex patterns matched against the From address (full string, lower-cased).
BLOCKED_SENDER_PATTERNS = re.compile(
    r"(no.?reply|noreply|do.not.reply|notifications?|alerts?|"
    r"automated|mailer.daemon|postmaster|bounces?|"
    r"hr@|system@|bot@|support@jisr|feedback@jisr)"
)

# Regex patterns matched against the Subject (lower-cased).
AUTOMATED_SUBJECT_PATTERNS = re.compile(
    r"(\[jira\]|\[jisr\]|punch correction request|leave request #|"
    r"clearance status|attendance correction|salary slip|payroll|"
    r"notification:|\[automated\]|\[system\]|do not reply)"
)

# Minimum number of project-related keywords in an email for it to be
# treated as a "new project request" (only applies when no Jira match found).
NEW_PROJECT_KEYWORD_THRESHOLD = 3

PROJECT_KEYWORDS = {
    "jisr", "hr", "human resources", "payroll", "employee", "gosi", "qiwa",
    "mudad", "onboarding", "leave", "attendance", "integration", "api",
    "development", "feature", "bug", "fix", "update", "proposal", "contract",
    "implementation", "system", "platform", "dashboard", "report",
    "automation", "project", "request", "deadline", "deliverable", "scope",
    "milestone", "sprint", "backlog", "requirement",
}

# ─── Gmail helpers ────────────────────────────────────────────────────────────

def load_gmail_token():
    with open(GMAIL_TOKEN_FILE) as f:
        return json.load(f)


def refresh_gmail_token(token_data):
    data = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": token_data.get("refresh_token", ""),
        "client_id": token_data.get("client_id", ""),
        "client_secret": token_data.get("client_secret", ""),
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token", data=data, method="POST"
    )
    try:
        with urllib.request.urlopen(req) as r:
            result = json.loads(r.read())
            new_token = result.get("access_token")
            if new_token:
                token_data["token"] = new_token
                with open(GMAIL_TOKEN_FILE, "w") as f:
                    json.dump(token_data, f, indent=2)
                return new_token
    except Exception as ex:
        print(f"  [!] Token refresh failed: {ex}", file=sys.stderr)
    return None


_gmail_token_data = load_gmail_token()
_gmail_access_token = _gmail_token_data.get("token", "")


def gmail_headers():
    return {
        "Authorization": f"Bearer {_gmail_access_token}",
        "Accept": "application/json",
    }


def gmail_get(path, params=None):
    global _gmail_access_token
    url = "https://gmail.googleapis.com/gmail/v1" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for attempt in range(2):
        req = urllib.request.Request(url, headers=gmail_headers())
        try:
            with urllib.request.urlopen(req) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt == 0:
                print("  [i] Gmail 401 — refreshing token...", file=sys.stderr)
                new = refresh_gmail_token(_gmail_token_data)
                if new:
                    _gmail_access_token = new
                    continue
            print(f"  [Gmail HTTP {e.code}]: {e.read().decode()[:200]}", file=sys.stderr)
            return None
    return None


def get_header(headers, name):
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def decode_body(part):
    data = part.get("body", {}).get("data", "")
    if data:
        try:
            return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
        except Exception:
            pass
    for sub in part.get("parts", []):
        result = decode_body(sub)
        if result:
            return result
    return ""


def extract_email_address(from_header):
    m = re.search(r"<(.+?)>", from_header)
    return m.group(1).lower() if m else from_header.lower().strip()


def sender_domain(from_header):
    addr = extract_email_address(from_header)
    return addr.split("@")[-1] if "@" in addr else ""


def is_automated(sender_from, subject):
    domain = sender_domain(sender_from)
    if domain in BLOCKED_SENDER_DOMAINS:
        return True, f"blocked domain: {domain}"
    if BLOCKED_SENDER_PATTERNS.search(sender_from.lower()):
        return True, "blocked sender pattern"
    if AUTOMATED_SUBJECT_PATTERNS.search(subject.lower()):
        return True, "automated subject pattern"
    return False, ""


# ─── Jira helpers ─────────────────────────────────────────────────────────────

def load_env():
    env = {}
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if "=" in line and not line.startswith("#"):
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"').strip("'")
    return env


_env = load_env()
JIRA_BASE = "https://jisrhr.atlassian.net"
JIRA_EMAIL = "m.ghassan@jisr.net"
JIRA_TOKEN = _env.get("JIRA_API_TOKEN", "")
_jira_auth = base64.b64encode(f"{JIRA_EMAIL}:{JIRA_TOKEN}".encode()).decode()
JIRA_HEADERS = {
    "Authorization": f"Basic {_jira_auth}",
    "Accept": "application/json",
    "Content-Type": "application/json",
}


def jira_get(path):
    req = urllib.request.Request(JIRA_BASE + path, headers=JIRA_HEADERS)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"  [Jira GET {e.code}]: {e.read().decode()[:200]}", file=sys.stderr)
        return None


def jira_post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        JIRA_BASE + path, data=data, headers=JIRA_HEADERS, method="POST"
    )
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        print(f"  [Jira POST {e.code}]: {e.read().decode()[:200]}", file=sys.stderr)
        return None


def add_comment(issue_key, text):
    """Always prefixes [BOT] so the comment scanner never re-reads it."""
    if not text.startswith("[BOT]") and not text.startswith("[AUTOMATED]"):
        text = "[BOT] " + text
    return jira_post(
        f"/rest/api/3/issue/{issue_key}/comment",
        {
            "body": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": text}],
                    }
                ],
            }
        },
    )


def fetch_active_issues():
    res = jira_post(
        "/rest/api/3/search/jql",
        {
            "jql": "project=GMC AND statusCategory != Done",
            "fields": ["summary", "status"],
            "maxResults": 100,
        },
    )
    if not res or "issues" not in res:
        return []
    return [
        {
            "key": i["key"],
            "summary": i["fields"]["summary"],
            "status": i["fields"]["status"]["name"],
            "keywords": set(re.findall(r"\b\w{4,}\b", i["fields"]["summary"].lower())),
        }
        for i in res["issues"]
    ]


def match_issue(email_text_lower, active_issues):
    """Return the best-matching active issue or None."""
    for issue in active_issues:
        # Direct key mention is unambiguous
        if issue["key"].lower() in email_text_lower:
            return issue, "key_mention"
        hits = sum(1 for w in issue["keywords"] if w in email_text_lower)
        if hits >= 2:
            return issue, f"{hits}_keyword_hits"
    return None, ""


def create_jira_issue(summary, description_text):
    body = {
        "fields": {
            "project": {"key": "GMC"},
            "summary": summary[:255],
            "description": {
                "type": "doc",
                "version": 1,
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": description_text}],
                    }
                ],
            },
            "issuetype": {"name": "Task"},
        }
    }
    return jira_post("/rest/api/3/issue", body)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print(f"=== GMAIL SCAN {'[DRY RUN] ' if DRY_RUN else ''}=== {datetime.utcnow().isoformat()}Z")

    # Load active issues
    print("\n[1/4] Loading active GMC issues...")
    active_issues = fetch_active_issues()
    print(f"      {len(active_issues)} active issues loaded")

    # Search Gmail
    print("\n[2/4] Searching Gmail (newer_than:1h)...")
    search_result = gmail_get(
        "/users/me/messages",
        {
            "q": "newer_than:1h -from:m.ghassan@jisr.net -from:no-reply",
            "maxResults": 25,
        },
    )
    messages = (search_result or {}).get("messages", [])
    print(f"      {len(messages)} messages found")

    # Process each message
    print("\n[3/4] Processing messages...")
    stats = {"matched": 0, "new_issue": 0, "skipped_automated": 0, "skipped_irrelevant": 0}

    for msg_ref in messages:
        msg = gmail_get(f"/users/me/messages/{msg_ref['id']}", {"format": "full"})
        if not msg:
            continue

        headers = msg.get("payload", {}).get("headers", [])
        sender = get_header(headers, "From")
        subject = get_header(headers, "Subject")
        date_str = get_header(headers, "Date")
        snippet = msg.get("snippet", "")
        body_text = decode_body(msg.get("payload", {}))
        body_preview = body_text[:600] if body_text else snippet[:600]

        print(f"\n  ── {sender[:60]}")
        print(f"     Subject: {subject[:80]}")

        # Filter: automated?
        auto, reason = is_automated(sender, subject)
        if auto:
            print(f"     [SKIP] automated ({reason})")
            stats["skipped_automated"] += 1
            continue

        # Attempt to match to existing issue
        combined_lower = f"{subject} {snippet} {body_preview}".lower()
        matched_issue, match_reason = match_issue(combined_lower, active_issues)

        sender_email = extract_email_address(sender)
        sender_name = sender.split("<")[0].strip().strip('"') if "<" in sender else sender

        if matched_issue:
            print(f"     [MATCH] {matched_issue['key']} — {match_reason}")
            stats["matched"] += 1

            comment = (
                f"[BOT] 📧 New email related to this issue.\n\n"
                f"From: {sender}\n"
                f"Subject: {subject}\n"
                f"Date: {date_str}\n\n"
                f"Preview:\n{snippet[:400]}\n\n"
                f"──────────────────────────────────────\n"
                f"Suggested reply draft (Mohammed — review before sending):\n\n"
                f"Hi {sender_name.split()[0] if sender_name else 'there'},\n\n"
                f"Thank you for reaching out regarding \"{subject}\". "
                f"I'll review and follow up shortly.\n\n"
                f"Best regards,\nMohammed Ghassan\nJisr HR Platform"
            )

            if not DRY_RUN:
                r = add_comment(matched_issue["key"], comment)
                print(f"     [✓] Comment added to {matched_issue['key']}: {'ok' if r else 'FAILED'}")
            else:
                print(f"     [DRY] Would comment on {matched_issue['key']}")

        else:
            # Check if it looks like a genuine human project request
            kw_hits = [k for k in PROJECT_KEYWORDS if k in combined_lower]
            if len(kw_hits) >= NEW_PROJECT_KEYWORD_THRESHOLD:
                print(f"     [NEW PROJECT?] {len(kw_hits)} keywords: {kw_hits[:6]}")
                stats["new_issue"] += 1

                issue_summary = f"[Email] {subject[:80]}"
                description = (
                    f"Inbound email from {sender}\n"
                    f"Date: {date_str}\n\n"
                    f"Preview:\n{snippet[:600]}\n\n"
                    f"Action needed: Review and respond."
                )
                comment = (
                    f"[BOT] 📧 Issue created from inbound email.\n\n"
                    f"Stakeholder: {sender_name} <{sender_email}>\n"
                    f"Subject: {subject}\n"
                    f"Received: {date_str}\n\n"
                    f"Email preview:\n{snippet[:500]}\n\n"
                    f"──────────────────────────────────────\n"
                    f"Suggested reply draft (Mohammed — review before sending):\n\n"
                    f"Hi {sender_name.split()[0] if sender_name else 'there'},\n\n"
                    f"Thank you for your message regarding \"{subject}\". "
                    f"I've logged this and will follow up within 1–2 business days.\n\n"
                    f"Best regards,\nMohammed Ghassan\nJisr HR Platform\n\n"
                    f"──────────────────────────────────────\n"
                    f"Keywords matched: {', '.join(kw_hits[:8])}"
                )

                if not DRY_RUN:
                    created = create_jira_issue(issue_summary, description)
                    if created and "key" in created:
                        new_key = created["key"]
                        print(f"     [✓] Created {new_key}")
                        add_comment(new_key, comment)
                        print(f"     [✓] Draft reply posted to {new_key}")
                    else:
                        print("     [!] Failed to create Jira issue")
                else:
                    print(f"     [DRY] Would create issue: {issue_summary}")
            else:
                print(f"     [SKIP] too few project keywords ({len(kw_hits)})")
                stats["skipped_irrelevant"] += 1

    # Summary + hive-mind log
    print(f"\n[4/4] Done.")
    print(f"      matched={stats['matched']}  new_issues={stats['new_issue']}  "
          f"skipped_auto={stats['skipped_automated']}  skipped_irrelevant={stats['skipped_irrelevant']}")

    if not DRY_RUN:
        summary = (
            f"Gmail scan: {len(messages)} emails scanned, "
            f"{stats['matched']} matched to issues, "
            f"{stats['new_issue']} new issues created, "
            f"{stats['skipped_automated']} automated senders filtered"
        )
        import subprocess
        subprocess.run(
            [
                "sqlite3",
                "/home/ubuntu/claudeclaw-os/store/claudeclaw.db",
                f"INSERT INTO hive_mind (agent_id, chat_id, action, summary, artifacts, created_at) "
                f"VALUES ('scrum', 'scrum', 'gmail_scan', "
                f"'{summary.replace(chr(39), '')}', NULL, strftime('%s','now'));",
            ],
            capture_output=True,
        )
        print(f"      [✓] Logged to hive mind")


if __name__ == "__main__":
    main()
