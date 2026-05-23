#!/usr/bin/env python3
"""
Exchange a Google OAuth authorization code (no-PKCE flow) for a refresh token.
Usage: python3 scripts/gmail_exchange_code.py <auth_code>

The code must come from a link without code_challenge (PKCE-free).
Token is saved to ~/.config/gmail/token.json.
"""

import json
import sys
import urllib.request
import urllib.parse
from pathlib import Path

CREDENTIALS_FILE = Path.home() / ".config" / "gmail" / "credentials.json"
TOKEN_FILE = Path.home() / ".config" / "gmail" / "token.json"
REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob"

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

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 gmail_exchange_code.py <auth_code>")
        sys.exit(1)

    auth_code = sys.argv[1].strip()
    creds = json.loads(CREDENTIALS_FILE.read_text())["installed"]

    data = urllib.parse.urlencode({
        "code": auth_code,
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode()

    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err = json.loads(e.read())
        print(f"❌ Token exchange failed: {err.get('error')} — {err.get('error_description')}")
        sys.exit(1)

    if "refresh_token" not in tokens:
        print("❌ No refresh_token in response:", tokens)
        sys.exit(1)

    import datetime
    expiry = None
    if "expires_in" in tokens:
        expiry = (datetime.datetime.utcnow() + datetime.timedelta(seconds=tokens["expires_in"])).isoformat() + "Z"

    token_data = {
        "token": tokens.get("access_token"),
        "refresh_token": tokens["refresh_token"],
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": creds["client_id"],
        "client_secret": creds["client_secret"],
        "scopes": SCOPES,
        "universe_domain": "googleapis.com",
        "account": "",
        "expiry": expiry,
    }

    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(json.dumps(token_data, indent=2))
    print(f"✅ Token saved to {TOKEN_FILE}")
    print(f"   refresh_token: {'present' if tokens.get('refresh_token') else 'MISSING'}")
    print(f"   access_token:  {'present' if tokens.get('access_token') else 'MISSING'}")
    print(f"   expires_in:    {tokens.get('expires_in')}s")
    return 0

if __name__ == "__main__":
    main()
