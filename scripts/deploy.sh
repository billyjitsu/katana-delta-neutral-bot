#!/usr/bin/env bash
# Deploys the current working tree to the droplet and (re)starts the bot under the kdn user's pm2.
#
#   scripts/deploy.sh            deploy code, install, typecheck, test, reload
#   scripts/deploy.sh --env      also upload the env file (never sent through git)
#
# Defaults deploy the ETH bot to /home/kdn/app. scripts/deploy-wbtc.sh reuses this for the WBTC bot
# via DEPLOY_DIR, ECOSYSTEM and ENV_FILE.
# Leaves node_modules, data/ (database + logs) and env files on the droplet untouched otherwise.
set -euo pipefail

HOST="${DEPLOY_HOST:?set DEPLOY_HOST to your server SSH alias}"
DIR="${DEPLOY_DIR:-app}"
APP="/home/kdn/$DIR"
ECOSYSTEM="${ECOSYSTEM:-ecosystem.config.cjs}"
ENV_FILE="${ENV_FILE:-.env}"
STAGING="/tmp/kdn-deploy-$DIR"

cd "$(dirname "$0")/.."

echo "→ uploading tracked + untracked (non-ignored) files to $HOST:$APP"
git ls-files -co --exclude-standard -z | tar --null -czf - -T - |
  ssh "$HOST" "rm -rf $STAGING && mkdir -p $STAGING && tar -xzf - -C $STAGING &&
    mkdir -p $APP && rsync -a --delete --exclude node_modules --exclude data --exclude .env --exclude .env.wbtc $STAGING/ $APP/ &&
    rm -rf $STAGING && chown -R kdn:kdn $APP"

if [[ "${1:-}" == "--env" ]]; then
  echo "→ uploading $ENV_FILE (mode 600, owner kdn)"
  ssh "$HOST" "install -m 600 -o kdn -g kdn /dev/stdin $APP/$ENV_FILE" < "$ENV_FILE"
fi

echo "→ installing, checking, reloading"
ssh "$HOST" "sudo -iu kdn bash -lc 'cd $DIR && npm ci --no-audit --no-fund --loglevel=error && npm run -s typecheck && npm test 2>&1 | grep -E \"^ℹ (pass|fail)\" && pm2 startOrReload $ECOSYSTEM --update-env && pm2 save >/dev/null && pm2 ls'"
