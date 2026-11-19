#!/usr/bin/env bash
# Deploys the WBTC carry bot to its own directory (/home/kdn/wbtc) as pm2 process kdn-wbtc, so a
# WBTC deploy never restarts the ETH bot. Settings live in .env.wbtc there.
#
#   scripts/deploy-wbtc.sh          deploy code, install, typecheck, test, reload kdn-wbtc
#   scripts/deploy-wbtc.sh --env    also upload the local .env.wbtc
set -euo pipefail
cd "$(dirname "$0")"
DEPLOY_DIR=wbtc ECOSYSTEM=ecosystem.wbtc.config.cjs ENV_FILE=.env.wbtc exec ./deploy.sh "$@"
