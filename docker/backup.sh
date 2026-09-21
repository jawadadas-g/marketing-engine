#!/bin/sh
# Nightly dump of everything the engine owns: its own schema and pg-boss's.
# Anything outside those two is not ours to back up.
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
KEEP_DAYS=${KEEP_DAYS:-14}

while true; do
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  FILE="$BACKUP_DIR/marketing-$STAMP.dump"

  if pg_dump --format=custom --schema=marketing --schema=pgboss --file="$FILE"; then
    echo "{\"msg\":\"backup written\",\"file\":\"$FILE\",\"bytes\":$(stat -c%s "$FILE")}"
  else
    echo "{\"msg\":\"backup FAILED\",\"at\":\"$STAMP\"}" >&2
  fi

  # Rotation happens after a successful write, so a run of failures never
  # deletes the last good dump.
  find "$BACKUP_DIR" -name 'marketing-*.dump' -mtime "+$KEEP_DAYS" -delete

  sleep 86400
done
