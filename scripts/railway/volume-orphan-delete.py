#!/usr/bin/env python3
"""Delete the 5 confirmed-orphaned Railway volumes.

Pre-conditions verified before running:
- All 5 volumes have serviceId=null (orphaned) per live GraphQL.
- Two carry ~197 MB of postgres data from prior REMOVED services in
  qiwa-contract-management; the current Postgres uses a separate volume.

Mutation: volumeDelete(volumeId: String).
"""

import json
import sys
from pathlib import Path

import requests

CFG = Path("/home/ubuntu/.railway/config.json")
GQL = "https://backboard.railway.app/graphql/v2"
TOKEN = json.load(open(CFG))["user"]["token"]

# (project, volume_name, volume_id, current_mb)
VICTIMS = [
    ("qiwa-contract-management", "postgres-m3xs-volume", "32a88b1f-3141-46e7-a05e-b8346ebfc4a7", 197.197824),
    ("qiwa-contract-management", "postgres-yyik-volume", "3708c37c-627d-4494-bf56-5b8bdf7fd908", 0),
    ("qiwa-contract-management", "postgres-bbu7-volume", "7750e954-7fa5-4858-be4b-2a32fc756019", 197.107712),
    ("qiwa-contract-management", "redis-kz_q-volume",    "e9d05594-d28f-4551-b514-803f889ae252", 0),
    ("discerning-spontaneity",   "redis-volume",         "a3c6aaf1-f759-438e-b84d-0771824b36b3", 0),
]

MUT = """
mutation($id: String!) {
  volumeDelete(volumeId: $id)
}
"""

results = []
for project, name, vol_id, used_mb in VICTIMS:
    print(f"[delete] {project}/{name}  used={used_mb}MB  id={vol_id}")
    try:
        r = requests.post(
            GQL,
            headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
            json={"query": MUT, "variables": {"id": vol_id}},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        if "errors" in data:
            print(f"  ERROR: {data['errors']}")
            results.append({"vol": name, "ok": False, "err": data["errors"]})
        else:
            ok = data.get("data", {}).get("volumeDelete")
            print(f"  OK: volumeDelete={ok}")
            results.append({"vol": name, "ok": True, "result": ok})
    except Exception as e:
        print(f"  EXCEPTION: {e}")
        results.append({"vol": name, "ok": False, "err": str(e)})

print("\n--- final ---")
for r in results:
    print(f"  {r['vol']}: ok={r['ok']}")

# Re-verify
import subprocess
print("\n--- post-delete verification ---")
subprocess.run(["python3", "/home/ubuntu/claudeclaw-os/scripts/railway/volume-orphan-verify.py"])
