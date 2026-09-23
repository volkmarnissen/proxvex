#!/bin/sh
# DNS configuration for production environment on OpenWrt
#
# Strategy:
#   - Internal apps (deployer, postgres, zitadel, gitea) use DHCP
#     → dnsmasq resolves their hostnames automatically
#   - External apps (nginx, mosquitto) have static IPs
#     → manual DNS entries required
#   - Public web domains (*.ohnewarum.de) are NOT overridden here →
#     they resolve publicly and are reached via the Cloudflare Tunnel
#     (from LAN and from the internet alike). No internal hairpin.
#   - mqtt.ohnewarum.de → mosquitto's real IP directly (same port 8883,
#     no DNAT needed). LAN/cluster only, no Cloudflare.
#
# Firewall/NAT is no longer managed here — it lives as static nftables
# includes in the repo (openwrt/nftables.d/, applied manually to the router).
#
# Usage: scp production/dns.sh root@router: && ssh root@router sh dns.sh

set -e

# --- Configuration ---
NGINX_IP="192.168.4.41"
REGISTRY_MIRROR_IP="192.168.4.45"
MOSQUITTO_IP="192.168.4.44"
ZOT_MIRROR_IP="192.168.4.50"
PROXVEX_IP="192.168.4.51"

MANAGED_TAG="prod-setup"

add_dns() {
  local name="$1"
  local ip="$2"
  # Check if entry already exists
  existing=$(uci show dhcp | grep "\.name='$name'" || true)
  if [ -n "$existing" ]; then
    echo "DNS entry '$name' already exists, skipping"
    return
  fi
  uci add dhcp domain
  uci set "dhcp.@domain[-1].name=$name"
  uci set "dhcp.@domain[-1].ip=$ip"
  uci set "dhcp.@domain[-1].dns=1"
  uci set "dhcp.@domain[-1].managed=$MANAGED_TAG"
  echo "Added DNS: $name → $ip"
}

# === DNS ===

echo "=== Configuring DNS entries ==="

# External apps with static IPs (no DHCP → need manual DNS)
add_dns nginx                  "$NGINX_IP"
add_dns docker-registry-mirror "$REGISTRY_MIRROR_IP"
add_dns eclipse-mosquitto      "$MOSQUITTO_IP"
add_dns zot-mirror             "$ZOT_MIRROR_IP"
add_dns proxvex                "$PROXVEX_IP"
# Internal apps use DHCP — dnsmasq resolves hostnames automatically:
#   proxvex, postgres, zitadel, gitea

# Public web domains (ohnewarum.de, www, auth, git, nebenkosten, gptwol,
# wolproxy) are intentionally NOT overridden here — they resolve publicly
# and are served via the Cloudflare Tunnel.

# MQTT domain → mosquitto directly (same port 8883, no DNAT). LAN/cluster only.
add_dns mqtt.ohnewarum.de         "$MOSQUITTO_IP"

uci commit dhcp
/etc/init.d/dnsmasq restart
echo "DNS entries configured."

echo ""
echo "=== DNS setup complete ==="
echo ""
echo "Public web domains → Cloudflare Tunnel (no internal override):"
echo "  ohnewarum.de, www, auth, git, nebenkosten, gptwol, wolproxy"
echo ""
echo "MQTT (${MOSQUITTO_IP}:8883, LAN/cluster only):"
echo "  mqtt.ohnewarum.de"
echo ""
echo "Internal apps (DHCP, no manual DNS):"
echo "  proxvex, postgres, zitadel, gitea"
echo ""
echo "Firewall/NAT: managed via static nftables includes"
echo "  (repo openwrt/nftables.d/, applied manually) — not by this script."
