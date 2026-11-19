#!/usr/bin/env bash
# Runs a bot command on the droplet, so trades, the cost ledger and logs all live in one place.
#
#   scripts/remote.sh report
#   scripts/remote.sh rebalance --go
#   scripts/remote.sh logs 50
#   scripts/remote.sh pm2 logs kdn-watch --lines 50 --nostream
set -euo pipefail

HOST="${DEPLOY_HOST:?set DEPLOY_HOST to your server SSH alias}"
if [[ $# -eq 0 ]]; then
  echo "usage: scripts/remote.sh <bot command> [args] | pm2 <args>" >&2
  exit 1
fi

if [[ "$1" == "pm2" ]]; then
  cmd="$*"
else
  cmd="npm run -s bot -- $*"
fi
ssh -t "$HOST" "sudo -iu kdn bash -lc 'cd app && $cmd'"
