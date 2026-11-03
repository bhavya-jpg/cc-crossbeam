#!/usr/bin/env bash
# Starts the local data store, the server and the frontend, and stops them together.
# Needs server/.env and frontend/.env.local. See SUBMISSION_PACKET.md, "Run it locally".
# --prod builds the frontend first, which also removes Next's dev overlay for recording.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in server/.env frontend/.env.local; do
  [ -f "$f" ] || { echo "Missing $f"; exit 1; }
done
if [ "${1:-}" = "--prod" ]; then
  (cd frontend && npm run build)
  frontend_command=start
else
  frontend_command=dev
fi
trap 'kill 0' EXIT
(cd server && npm run local:db) &
(cd server && npm run dev) &
(cd frontend && npm run "$frontend_command") &
wait
