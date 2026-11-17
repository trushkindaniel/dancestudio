#!/usr/bin/env bash
# Обновить сайт на хостинге: забрать main с GitHub, поставить пакеты, перезапустить.
# Нужен вход на хостинг по SSH-ключу. Запуск: npm run deploy  (или bash scripts/deploy.sh)
set -euo pipefail

HOST="${DEPLOY_HOST:-u232123@79.133.175.41}"
DIR="${DEPLOY_DIR:-www/xn--55-6kcaaazhu5br8a.xn--p1ai}"
APP="${DEPLOY_APP:-xn--55-6kcaaazhu5br8a.xn--p1ai}"

if [ -n "$(git status --porcelain)" ]; then echo "Есть незакоммиченные изменения: на сайт уйдёт только то, что в main на GitHub." >&2; fi
git push origin main

ssh "$HOST" "set -e
  cd $DIR
  git pull --ff-only origin main
  export PATH=\$(ls -d \$HOME/.nvm/versions/node/*/bin | tail -1):/usr/lib/ispnodejs/bin:\$PATH
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  pm2 restart $APP --update-env >/dev/null
  sleep 3
  git log --oneline -1
  tail -n 3 \$HOME/.pm2/logs/$APP-out.log"
