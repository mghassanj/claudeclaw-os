#!/usr/bin/env python3
"""
Gmail -> Jira sync script (Scrum Master agent)
- Scans Gmail inbox for emails newer than 1h
- Excludes m.ghassan@jisr.net and no-reply senders
- Matches emails to GMC Jira issues by keyword/subject analysis
- Posts summaries and draft replies as Jira comments
- Does NOT send any emails
"""

import json
import os
import re
import sys
import base64
import email
from datetime import datetime, timezone
from pathlib import Path

import requests
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

# ── Config ──────────────────────────────────────────────────────────────────
TOKEN_PATH = Path.home() / ".config/gmail/token.json"
CREDENTIALS_PATH = Path.home() / ".config/gmail/credentials.json"

ENV_PATH = Path.home() / "claudeclaw-os/.env"


def load_env(path):
    env = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


env = load_env(ENV_PATH)

JIRA_BASE_URL = env.get("JIRA_BASE_URL", "").rstrip("/")
JIRA_USER_EMAIL = env.get("JIRA_USER_EMAIL", "")
JIRA_API_TOKEN = env.get("JIRA_API_TOKEN", "")
GMC_PROJECT_KEY = "GMC"
INBOX_PROJECT_KEY = "GMC"  # New issues go into GMC as inbox items


# ── Gmail Auth ───────────────────────────────────────────────────────────────

def get_gmail_service():
    """Load and refresh Gmail OAuth token, return service object."""
    token_data = json.loads(TOKEN_PATH.read_text())
    creds_data = json.loads(CREDENTIALS_PATH.read_text())
    installed = creds_data.get("installed", creds_data)

    creds = Credentials(
        token=token_data.get("token"),
        refresh_token=token_data.get("refresh_token"),
        token_uri=token_data.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=installed.get("client_id"),
        client_secret=installed.get("client_secret"),
        scopes=token_data.get("scopes"),
    )

    # Refresh if expired
    if creds.expired or not creds.valid:
        print("[auth] Refreshing Gmail token...")
        creds.refresh(Request())
        # Persist refreshed token
        updated = {
            "token": creds.token,
            "refresh_token": creds.refresh_token,
            "token_uri": creds.token_uri,
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
            "scopes": list(creds.scopes),
            "universe_domain": token_data.get("universe_domain", "googleapis.com"),
            "account": token_data.get("account", ""),
            "expiry": creds.expiry.isoformat() if creds.expiry else None,
        }
        TOKEN_PATH.write_text(json.dumps(updated, indent=2))
        print("[auth] Token refreshed and saved.")
    else:
        print("[auth] Token valid, no refresh needed.")

    service = build("gmail", "v1", credentials=creds)
    return service


# ── Gmail helpers ────────────────────────────────────────────────────────────

def decode_body(msg_data):
    """Extract plain-text body from a Gmail message payload."""
    payload = msg_data.get("payload", {})

    def extract_text(part):
        mime = part.get("mimeType", "")
        if mime == "text/plain":
            data = part.get("body", {}).get("data", "")
            if data:
                return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
        if "parts" in part:
            for p in part["parts"]:
                result = extract_text(p)
                if result:
                    return result
        return ""

    return extract_text(payload).strip()


def get_header(msg_data, name):
    headers = msg_data.get("payload", {}).get("headers", [])
    for h in headers:
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def fetch_recent_emails(service, max_results=50):
    """Fetch emails newer than 1h, excluding specified senders."""
    query = "newer_than:1h -from:m.ghassan@jisr.net -from:no-reply"
    print(f"[gmail] Search query: {query}")

    result = service.users().messages().list(
        userId="me",
        q=query,
        maxResults=max_results
    ).execute()

    messages = result.get("messages", [])
    print(f"[gmail] Found {len(messages)} message(s).")

    emails = []
    for msg_stub in messages:
        msg_data = service.users().messages().get(
            userId="me",
            id=msg_stub["id"],
            format="full"
        ).execute()

        sender = get_header(msg_data, "from")
        subject = get_header(msg_data, "subject")
        date_str = get_header(msg_data, "date")
        body = decode_body(msg_data)

        # Extra filter: skip anything with no-reply in sender address
        sender_email_match = re.search(r"<(.+?)>", sender)
        sender_addr = sender_email_match.group(1) if sender_email_match else sender
        if "no-reply" in sender_addr.lower() or "noreply" in sender_addr.lower():
            print(f"  [skip] no-reply sender: {sender_addr}")
            continue

        emails.append({
            "id": msg_stub["id"],
            "sender": sender,
            "sender_addr": sender_addr,
            "subject": subject,
            "date": date_str,
            "body_preview": body[:500] if body else "(no plain-text body)",
            "body_full": body[:2000] if body else "",
        })
        print(f"  [email] {subject[:60]!r} from {sender_addr}")

    return emails


# ── Jira helpers ─────────────────────────────────────────────────────────────

JIRA_AUTH = (JIRA_USER_EMAIL, JIRA_API_TOKEN)
JIRA_HEADERS = {"Content-Type": "application/json", "Accept": "application/json"}


def jira_get_gmc_issues():
    """Fetch all open GMC issues with summary, labels, description."""
    url = f"{JIRA_BASE_URL}/rest/api/3/search/jql"
    payload = {
        "jql": f"project={GMC_PROJECT_KEY} ORDER BY updated DESC",
        "maxResults": 50,
        "fields": ["summary", "status", "assignee", "labels", "description"],
    }
    resp = requests.post(url, auth=JIRA_AUTH, headers=JIRA_HEADERS, json=payload)
    resp.raise_for_status()
    data = resp.json()
    issues = []
    for item in data.get("issues", []):
        issues.append({
            "key": item["key"],
            "summary": item["fields"]["summary"],
            "labels": item["fields"].get("labels", []),
            "status": item["fields"]["status"]["name"],
        })
    return issues


def match_email_to_issue(email_data, issues):
    """
    Heuristic keyword matching between email subject/body and GMC issue summaries.
    Returns the best matching issue dict or None.
    """
    subject = email_data["subject"].lower()
    body = email_data["body_full"].lower()
    sender = email_data["sender_addr"].lower()

    # Build keyword sets per issue
    scored = []
    for issue in issues:
        issue_text = issue["summary"].lower()
        # Tokenize issue summary into meaningful words (3+ chars)
        words = [w for w in re.findall(r"\b[a-z]{3,}\b", issue_text) if w not in
                 {"and", "the", "for", "with", "from", "this", "that", "are", "was", "has",
                  "its", "our", "your", "their", "will", "have", "been", "can", "all"}]
        score = 0
        for word in words:
            if word in subject:
                score += 3
            if word in body:
                score += 1
        # Check sender domain against issue text
        sender_domain = sender.split("@")[-1].split(".")[0] if "@" in sender else ""
        if sender_domain and len(sender_domain) > 2 and sender_domain in issue_text:
            score += 5

        if score > 0:
            scored.append((score, issue))

    if not scored:
        return None
    scored.sort(key=lambda x: x[0], reverse=True)
    best_score, best_issue = scored[0]
    print(f"    [match] Best match: {best_issue['key']} (score={best_score}) '{best_issue['summary'][:50]}'")
    # Require a minimum score to avoid false positives
    if best_score < 3:
        print(f"    [match] Score too low, treating as no match.")
        return None
    return best_issue


def jira_add_comment(issue_key, comment_body_adf):
    """Add a comment to a Jira issue using ADF (Atlassian Document Format).

    Every comment gets a leading [BOT] marker paragraph. The bot and the human
    share one Jira account, so this text marker is the only way the Scrum
    Master's comment scanner can tell bot comments apart and skip them instead
    of re-reading them as fresh human instructions.
    """
    url = f"{JIRA_BASE_URL}/rest/api/3/issue/{issue_key}/comment"
    body = dict(comment_body_adf)
    content = list(body.get("content", []))
    first_text = ""
    if content and isinstance(content[0], dict):
        for node in content[0].get("content", []):
            if isinstance(node, dict) and node.get("type") == "text":
                first_text = node.get("text", "")
                break
    if not first_text.lstrip().upper().startswith(("[BOT]", "[AUTOMATED]")):
        marker = {"type": "paragraph", "content": [
            {"type": "text", "text": "[BOT] (Gmail-to-Jira automated sync)"}]}
        content = [marker] + content
    body["content"] = content
    payload = {"body": body}
    resp = requests.post(url, auth=JIRA_AUTH, headers=JIRA_HEADERS, json=payload)
    resp.raise_for_status()
    return resp.json()


def jira_create_issue(summary, description_adf, labels=None):
    """Create a new issue in the GMC project."""
    url = f"{JIRA_BASE_URL}/rest/api/3/issue"
    payload = {
        "fields": {
            "project": {"key": INBOX_PROJECT_KEY},
            "summary": summary,
            "description": description_adf,
            "issuetype": {"name": "Task"},
            "labels": labels or ["inbox", "email-triage"],
        }
    }
    resp = requests.post(url, auth=JIRA_AUTH, headers=JIRA_HEADERS, json=payload)
    resp.raise_for_status()
    return resp.json()


def make_adf_document(paragraphs):
    """Build a minimal ADF document from a list of paragraph strings."""
    content = []
    for para in paragraphs:
        if para.startswith("**") and para.endswith("**"):
            # Heading-like bold paragraph
            text = para[2:-2]
            content.append({
                "type": "paragraph",
                "content": [{"type": "text", "text": text,
                              "marks": [{"type": "strong"}]}]
            })
        else:
            content.append({
                "type": "paragraph",
                "content": [{"type": "text", "text": para}]
            })
    return {
        "type": "doc",
        "version": 1,
        "content": content,
    }


def classify_email(email_data):
    """
    Returns one of: 'project_request', 'informational', 'unclear'
    based on subject/body signals.
    """
    subject = email_data["subject"].lower()
    body = email_data["body_full"].lower()
    text = subject + " " + body

    project_signals = [
        "project", "request", "integration", "sync", "automat", "setup",
        "connect", "configure", "implement", "build", "develop", "system",
        "proposal", "scope", "requirement", "contract", "agreement",
    ]
    count = sum(1 for s in project_signals if s in text)
    if count >= 2:
        return "project_request"
    return "informational"


def draft_reply(email_data, jira_issue=None, new_issue_key=None):
    """Generate a draft reply text for the email."""
    sender_name = email_data["sender"].split("<")[0].strip().strip('"') or "there"
    if jira_issue:
        return (
            f"Hi {sender_name},\n\n"
            f"Thank you for reaching out. I've logged this in our tracking system "
            f"under {jira_issue['key']} ({jira_issue['summary']}) and will follow up accordingly.\n\n"
            f"Best regards,\nMohamed"
        )
    elif new_issue_key:
        return (
            f"Hi {sender_name},\n\n"
            f"Thank you for your message. I've created a new item in our queue "
            f"({new_issue_key}) and will review it shortly.\n\n"
            f"Best regards,\nMohamed"
        )
    else:
        return (
            f"Hi {sender_name},\n\n"
            f"Thank you for your message. I'll review and get back to you.\n\n"
            f"Best regards,\nMohamed"
        )


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    results = []
    errors = []

    # 1. Gmail
    print("\n=== Gmail Scan ===")
    try:
        gmail_service = get_gmail_service()
        emails = fetch_recent_emails(gmail_service)
    except Exception as e:
        print(f"[ERROR] Gmail fetch failed: {e}")
        sys.exit(1)

    if not emails:
        print("[done] No qualifying emails found in the last hour.")
        print_report(results, errors, 0)
        return

    # 2. Jira GMC issues
    print("\n=== Fetching GMC Issues ===")
    try:
        gmc_issues = jira_get_gmc_issues()
        print(f"[jira] Loaded {len(gmc_issues)} GMC issues.")
    except Exception as e:
        print(f"[ERROR] Jira fetch failed: {e}")
        errors.append(f"Jira fetch: {e}")
        gmc_issues = []

    # 3. Process each email
    print("\n=== Processing Emails ===")
    for em in emails:
        print(f"\n--- Email: {em['subject'][:60]!r} from {em['sender_addr']} ---")
        action = "no_action"
        jira_ref = None

        try:
            matched_issue = match_email_to_issue(em, gmc_issues)

            if matched_issue:
                # Post comment on matched issue
                summary_paras = [
                    f"**Email received from: {em['sender']}**",
                    f"Subject: {em['subject']}",
                    f"Date: {em['date']}",
                    f"Key points / preview:",
                    em["body_preview"] or "(no body)",
                    f"---",
                    f"**DRAFT REPLY (for Mohammed to review — do NOT send without approval):**",
                    draft_reply(em, jira_issue=matched_issue),
                ]
                adf = make_adf_document(summary_paras)
                comment_resp = jira_add_comment(matched_issue["key"], adf)
                action = f"comment_added"
                jira_ref = matched_issue["key"]
                print(f"  [jira] Comment added to {matched_issue['key']}: {comment_resp.get('id')}")

            else:
                # Check if it looks like a new project request
                email_class = classify_email(em)
                print(f"  [classify] Email type: {email_class}")

                if email_class == "project_request":
                    # Create new issue
                    new_summary = f"[Inbox] {em['subject'][:80]}"
                    desc_paras = [
                        f"**Auto-created from email triage**",
                        f"From: {em['sender']}",
                        f"Date: {em['date']}",
                        f"Subject: {em['subject']}",
                        f"Body preview:",
                        em["body_preview"] or "(no body)",
                        f"---",
                        f"**DRAFT REPLY (for Mohammed to review — do NOT send without approval):**",
                        draft_reply(em, new_issue_key="(pending)"),
                    ]
                    adf = make_adf_document(desc_paras)
                    new_issue = jira_create_issue(new_summary, adf, labels=["inbox", "email-triage"])
                    new_key = new_issue.get("key", "?")
                    action = "new_issue_created"
                    jira_ref = new_key
                    print(f"  [jira] New issue created: {new_key}")

                    # Update the draft reply with actual key
                    updated_paras = [
                        f"**Auto-created from email triage**",
                        f"From: {em['sender']}",
                        f"Date: {em['date']}",
                        f"Subject: {em['subject']}",
                        f"Body preview:",
                        em["body_preview"] or "(no body)",
                        f"---",
                        f"**DRAFT REPLY (for Mohammed to review — do NOT send without approval):**",
                        draft_reply(em, new_issue_key=new_key),
                    ]
                    # Add draft reply as a comment on the new issue
                    adf2 = make_adf_document(updated_paras)
                    jira_add_comment(new_key, adf2)
                    print(f"  [jira] Draft reply posted as comment on {new_key}")
                else:
                    # Informational / unclear — no Jira action needed
                    action = "no_action_informational"
                    jira_ref = None
                    print(f"  [info] Email appears informational, no Jira action taken.")

        except Exception as e:
            print(f"  [ERROR] Processing failed: {e}")
            errors.append(f"Email '{em['subject'][:40]}': {e}")
            action = "error"

        results.append({
            "subject": em["subject"],
            "sender": em["sender_addr"],
            "action": action,
            "jira_ref": jira_ref,
        })

    print_report(results, errors, len(emails))


def print_report(results, errors, total_found):
    print("\n" + "=" * 60)
    print("REPORT")
    print("=" * 60)
    print(f"Emails found (qualifying): {total_found}")
    print(f"Processed: {len(results)}")
    print()

    if results:
        print("Actions taken:")
        for r in results:
            jira_str = f" -> {r['jira_ref']}" if r["jira_ref"] else ""
            print(f"  [{r['action']}{jira_str}] {r['subject'][:55]} | {r['sender']}")

    if errors:
        print(f"\nErrors ({len(errors)}):")
        for e in errors:
            print(f"  - {e}")
    else:
        print("\nNo errors.")

    return results


if __name__ == "__main__":
    main()
