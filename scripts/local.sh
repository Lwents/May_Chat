#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-start}" in
  start) docker compose -f infrastructure/compose.local.yaml up -d --build ;;
  stop) docker compose -f infrastructure/compose.local.yaml stop ;;
  status) docker compose -f infrastructure/compose.local.yaml ps ;;
  logs) docker compose -f infrastructure/compose.local.yaml logs --tail=80 ;;
  *) printf 'Usage: ./scripts/local.sh [start|stop|status|logs]\n'; exit 1 ;;
esac
if [[ "${1:-start}" == start ]]; then printf 'Mây: http://localhost:8088\n'; fi
