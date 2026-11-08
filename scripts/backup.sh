#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
task_compose_file="${MAY_COMPOSE_FILE:-infrastructure/compose.yaml}"
task_compose=(docker compose -f "$task_compose_file")
if [[ "$task_compose_file" == infrastructure/compose.yaml ]]; then task_compose+=(--env-file .env); fi
mkdir -p backups
task_backup_dir=$(mktemp -d)
trap 'rm -rf "$task_backup_dir"' EXIT
"${task_compose[@]}" exec -T server sqlite3 /app/data/may.db ".backup '/app/data/backup.db'"
"${task_compose[@]}" cp server:/app/data/backup.db "$task_backup_dir/may.db"
"${task_compose[@]}" cp server:/app/data/uploads "$task_backup_dir/uploads"
task_backup_name="backups/may-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -czf "$task_backup_name" -C "$task_backup_dir" may.db uploads
"${task_compose[@]}" exec -T server rm -f /app/data/backup.db
printf 'Saved %s\n' "$task_backup_name"
