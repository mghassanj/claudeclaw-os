#!/usr/bin/env python3
"""
Gmail OAuth re-authorization script (console flow — no browser on server needed).
Run this interactively when the refresh token is revoked (invalid_grant error).

Usage:
    python3 scripts/gmail_reauth.py

You will be given a URL to open in your browser. After authorizing,
paste the code back here. The new token is saved to ~/.config/gmail/token.json.
"""

import json
import os
from pathlib import Path

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://mail.google.com/",
    "openid",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
    "https://www.googleapis.com/auth/script.projects",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.storage",
]

CREDENTIALS_FILE = Path.home() / ".config" / "gmail" / "credentials.json"
TOKEN_FILE = Path.home() / ".config" / "gmail" / "token.json"


def main():
    if not CREDENTIALS_FILE.exists():
        print(f"ERROR: credentials.json not found at {CREDENTIALS_FILE}")
        return

    print("Starting Gmail OAuth console flow...")
    print("You will be given a URL. Open it in your browser, authorize, then paste the code here.\n")

    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
    creds = flow.run_console()

    token_data = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes) if creds.scopes else SCOPES,
        "universe_domain": "googleapis.com",
        "account": "",
        "expiry": creds.expiry.isoformat() if creds.expiry else None,
    }

    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(json.dumps(token_data, indent=2))
    print(f"\n✅ Token saved to {TOKEN_FILE}")
    print("You can now re-run gmail_jira_sync.py — it will use the new token.")


if __name__ == "__main__":
    main()
