#!/usr/bin/env bash
# Gives the Otari gateway a public https URL for this server's MCP and guardrail routes.
#
# It tunnels the loopback tools listener (PUBLIC_TOOLS_PORT, default 8090), which serves only
# /api/mcp/adu-law and /api/guardrails/check. Port 8080 is never exposed: /generate there has
# no auth and spends Otari credit.
#
# Start the server first (scripts/run-local.sh), then run this and keep it open. Put the
# printed line in server/.env and restart the server. A quick tunnel's URL changes on every
# start, so update the line each time.
set -euo pipefail
port="${PUBLIC_TOOLS_PORT:-8090}"

if ! curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
  echo "Nothing on 127.0.0.1:${port}. Start the server first: scripts/run-local.sh"
  exit 1
fi

print_env() {
  echo
  echo "Add this to server/.env, then restart the server:"
  echo "  OTARI_PUBLIC_TOOLS_URL=$1"
  echo "Check it from outside:  curl -s $1/health"
  echo
}

if command -v cloudflared >/dev/null 2>&1; then
  echo "Starting a Cloudflare quick tunnel to 127.0.0.1:${port} (no account needed). Ctrl-C stops it."
  log="$(mktemp -t crossbeam-tunnel)"
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${port}" >"$log" 2>&1 &
  pid=$!
  trap 'kill $pid 2>/dev/null; rm -f "$log"' EXIT
  for _ in $(seq 1 30); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -z "${url:-}" ]; then
    echo "cloudflared did not report a URL:"; cat "$log"; exit 1
  fi
  print_env "$url"
  wait "$pid"
elif command -v ngrok >/dev/null 2>&1; then
  echo "Starting ngrok to 127.0.0.1:${port} (needs 'ngrok config add-authtoken' once). Ctrl-C stops it."
  ngrok http "127.0.0.1:${port}" --log=stdout >/dev/null &
  pid=$!
  trap 'kill $pid 2>/dev/null' EXIT
  for _ in $(seq 1 30); do
    url="$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -oE '"public_url":"https://[^"]+' | head -1 | cut -d'"' -f4 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -z "${url:-}" ]; then
    echo "ngrok did not report a URL. Check 'ngrok config check'."; exit 1
  fi
  print_env "$url"
  wait "$pid"
else
  cat <<EOF
Neither cloudflared nor ngrok is installed. Either one works:

  brew install cloudflared                      # no account needed
  cloudflared tunnel --url http://127.0.0.1:${port}

  brew install ngrok                            # needs a free account and authtoken
  ngrok http 127.0.0.1:${port}

Then rerun this script, or copy the https URL the tunnel prints into server/.env as
OTARI_PUBLIC_TOOLS_URL and restart the server.
EOF
  exit 1
fi
