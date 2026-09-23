#!/bin/sh
# Confirm cloudflared registered a tunnel connection to the Cloudflare edge.
#
# Runs on the PVE host. The docker-compose LXC runs a real dockerd, so we read
# the cloudflared container's logs via `pct exec ... docker logs`. A
# remotely-managed tunnel logs one line per edge connection:
#   INF Registered tunnel connection connIndex=0 ...
# We poll because the connection comes up a few seconds after dockerd starts
# the service (and restart: unless-stopped retries until the network is up).
#
# NOTE: deliberately avoid `docker ps --format '{{.Names}}'` — the `{{ }}`
# would be eaten by proxvex's template substitution. Use `-q` (IDs) instead.
#
# Template variables:
#   vm_id - Container VM ID
#
# stdout: JSON array (schemas/outputs.schema.json). All logs go to stderr.
set -u

VM_ID="{{ vm_id }}"
PATTERN="Registered tunnel connection"
ATTEMPTS=12
SLEEP=5

cid=""
i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  cid=$(pct exec "$VM_ID" -- docker ps --filter "name=cloudflared" -q 2>/dev/null | head -1)
  if [ -n "$cid" ]; then
    logs=$(pct exec "$VM_ID" -- docker logs --tail 200 "$cid" 2>&1 || true)
    if printf '%s' "$logs" | grep -q "$PATTERN"; then
      echo "CHECK: tunnel_connected PASSED" >&2
      printf '%s' "$logs" | grep "$PATTERN" | tail -1 >&2
      printf '[{"id":"tunnel_connected","value":"true"}]'
      exit 0
    fi
  fi
  i=$((i + 1))
  echo "tunnel not registered yet (attempt $i/$ATTEMPTS), waiting ${SLEEP}s..." >&2
  sleep "$SLEEP"
done

echo "CHECK: tunnel_connected FAILED — '$PATTERN' not found in cloudflared docker logs within $((ATTEMPTS * SLEEP))s" >&2
if [ -n "$cid" ]; then
  echo "Last 20 cloudflared log lines:" >&2
  pct exec "$VM_ID" -- docker logs --tail 20 "$cid" 2>&1 | sed 's/^/  /' >&2
else
  echo "No cloudflared container found (docker ps name=cloudflared empty)" >&2
fi
printf '[{"id":"tunnel_connected","value":"false"}]'
exit 1
