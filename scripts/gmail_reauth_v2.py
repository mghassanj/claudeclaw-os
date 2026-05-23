#!/usr/bin/env python3
"""Gmail OAuth re-auth via loopback redirect (Google killed the OOB flow in 2023).

Two steps:
  python3 gmail_reauth_v2.py url
      -> prints the consent URL. Open it, sign in as m.ghassan@jisr.net, approve.
         The browser will land on a "site can't be reached" page at
         http://localhost:3000/oauth2callback?code=...  -- that is expected.
  python3 gmail_reauth_v2.py exchange '<paste the whole localhost URL, or just the code>'
      -> exchanges the code and writes ~/.config/gmail/token.json
"""
import datetime
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CRED = Path.home() / ".config" / "gmail" / "credentials.json"
TOKEN = Path.home() / ".config" / "gmail" / "token.json"
REDIRECT = "http://localhost:3000/oauth2callback"
LOGIN_HINT = "m.ghassan@jisr.net"
SCOPES = [
    "https://mail.google.com/",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]


def cred():
    return json.loads(CRED.read_text())["installed"]


def make_url():
    c = cred()
    params = {
        "client_id": c["client_id"],
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "login_hint": LOGIN_HINT,
    }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)


def extract_code(s):
    s = s.strip()
    if s.startswith("http"):
        q = urllib.parse.urlparse(s).query
        code = urllib.parse.parse_qs(q).get("code", [None])[0]
        if not code:
            sys.exit("ERROR: no 'code' parameter found in that URL.")
        return code
    return s


def exchange(raw):
    code = extract_code(raw)
    c = cred()
    data = urllib.parse.urlencode({
        "code": code,
        "client_id": c["client_id"],
        "client_secret": c["client_secret"],
        "redirect_uri": REDIRECT,
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token", data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            tok = json.loads(r.read())
    except urllib.error.HTTPError as e:
        sys.exit("ERROR: token exchange failed -> " + e.read().decode())

    if "refresh_token" not in tok:
        sys.exit("ERROR: no refresh_token in response (re-run, ensure prompt=consent): "
                 + json.dumps(tok))

    expiry = (datetime.datetime.utcnow()
              + datetime.timedelta(seconds=tok.get("expires_in", 3600))).isoformat() + "Z"
    out = {
        "token": tok["access_token"],
        "refresh_token": tok["refresh_token"],
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": c["client_id"],
        "client_secret": c["client_secret"],
        "scopes": SCOPES,
        "universe_domain": "googleapis.com",
        "account": "",
        "expiry": expiry,
    }
    TOKEN.write_text(json.dumps(out, indent=2))
    TOKEN.chmod(0o600)

    ui = urllib.request.Request(
        "https://www.googleapis.com/oauth2/v1/userinfo",
        headers={"Authorization": "Bearer " + tok["access_token"]})
    who = json.loads(urllib.request.urlopen(ui).read())
    print("OK: token.json written. Authorized as:", who.get("email"))


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("url", "exchange"):
        sys.exit("usage: gmail_reauth_v2.py url | exchange '<redirect-url-or-code>'")
    if sys.argv[1] == "url":
        print(make_url())
    elif len(sys.argv) < 3:
        sys.exit("ERROR: provide the pasted redirect URL or the code")
    else:
        exchange(sys.argv[2])
