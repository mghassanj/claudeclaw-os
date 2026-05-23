#!/usr/bin/env python3
"""Re-verify orphan status of the 5 candidate volumes against live Railway state.

Output: prints each volume with id, project, current orphan status, used MB,
last-modified service hint, and the GraphQL volume.id we'd need to delete.

Read-only. Does NOT delete anything.
"""

import json
import sys
from pathlib import Path

import requests

CFG = Path("/home/ubuntu/.railway/config.json")
GQL = "https://backboard.railway.app/graphql/v2"
WORKSPACE_ID = "a176af9f-0a95-47ce-abc5-ccd5b38aafaf"

with open(CFG) as f:
    TOKEN = json.load(f)["user"]["token"]

CANDIDATES = [
    ("qiwa-contract-management", "postgres-m3xs-volume"),
    ("qiwa-contract-management", "postgres-yyik-volume"),
    ("qiwa-contract-management", "postgres-bbu7-volume"),
    ("qiwa-contract-management", "redis-kz_q-volume"),
    ("discerning-spontaneity",   "redis-volume"),
]


def gql(query, variables=None):
    r = requests.post(
        GQL,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        json={"query": query, "variables": variables or {}},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if "errors" in data:
        raise RuntimeError(data["errors"])
    return data["data"]


# Pull all projects with their volumes + volumeInstances.
QUERY = """
query($wsId: String!) {
  projects(workspaceId: $wsId, first: 50) {
    edges {
      node {
        id
        name
        volumes {
          edges {
            node {
              id
              name
              volumeInstances {
                edges {
                  node {
                    id
                    serviceId
                    environmentId
                    currentSizeMB
                    sizeMB
                    mountPath
                    state
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
"""

data = gql(QUERY, {"wsId": WORKSPACE_ID})
projects = [e["node"] for e in data["projects"]["edges"]]

results = []
for proj in projects:
    pname = proj["name"]
    for vedge in proj.get("volumes", {}).get("edges", []):
        v = vedge["node"]
        vname = v["name"]
        if (pname, vname) not in [(c[0], c[1]) for c in CANDIDATES]:
            continue
        instances = [ie["node"] for ie in v.get("volumeInstances", {}).get("edges", [])]
        for inst in instances:
            results.append({
                "project": pname,
                "volume_name": vname,
                "volume_id": v["id"],
                "instance_id": inst["id"],
                "service_id": inst.get("serviceId"),
                "is_orphaned": not inst.get("serviceId"),
                "current_mb": inst.get("currentSizeMB", 0),
                "limit_mb": inst.get("sizeMB", 0),
                "mount": inst.get("mountPath"),
                "state": inst.get("state"),
            })

print(json.dumps(results, indent=2))

# Summary
orphaned_now = [r for r in results if r["is_orphaned"]]
not_orphaned = [r for r in results if not r["is_orphaned"]]
print(f"\n--- Summary ---", file=sys.stderr)
print(f"Candidates verified orphaned right now: {len(orphaned_now)}", file=sys.stderr)
print(f"Candidates that became attached again:  {len(not_orphaned)}", file=sys.stderr)
for r in orphaned_now:
    print(f"  ORPHANED: {r['project']}/{r['volume_name']}  vol_id={r['volume_id']}  inst_id={r['instance_id']}  used={r['current_mb']}MB  state={r['state']}", file=sys.stderr)
for r in not_orphaned:
    print(f"  ATTACHED: {r['project']}/{r['volume_name']}  service={r['service_id']}", file=sys.stderr)
