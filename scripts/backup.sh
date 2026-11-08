#!/usr/bin/env bash
# Encrypted database backup: pg_dump (custom format) piped into gpg.
# The plain dump never touches the disk.
#
#   DATABASE_URL=postgres://… BACKUP_PASSPHRASE=… scripts/backup.sh [out-dir]
#
# Writes <out-dir>/galla-mandi-<UTC time>.dump.gpg (default out-dir: backups)
# and prints its path. Then checks the file: it must decrypt and pg_restore
# must be able to read its table of contents. Any failure exits non-zero.
#
# pg_dump must be the same major version as the database server or newer;
# set PG_BIN=/usr/lib/postgresql/<major>/bin to pick one.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to the database to back up}"
: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE (the backup encryption passphrase)}"

out_dir="${1:-backups}"
pg_bin="${PG_BIN:+$PG_BIN/}"
mkdir -p "$out_dir"
file="$out_dir/galla-mandi-$(date -u +%Y-%m-%dT%H%M%SZ).dump.gpg"
# Never leave a half-written backup behind.
trap 'status=$?; [ $status -eq 0 ] || rm -f "$file"' EXIT

# The passphrase goes in through a file descriptor, never on the command line.
"${pg_bin}pg_dump" --format=custom --compress=6 --no-password \
  --dbname="$DATABASE_URL" |
  gpg --batch --yes --quiet --pinentry-mode loopback \
    --passphrase-fd 3 3<<<"$BACKUP_PASSPHRASE" \
    --symmetric --cipher-algo AES256 --output "$file"

# Prove the backup is usable before anyone relies on it.
tables=$(
  gpg --batch --quiet --pinentry-mode loopback \
    --passphrase-fd 3 3<<<"$BACKUP_PASSPHRASE" --decrypt "$file" |
    "${pg_bin}pg_restore" --list | grep -c ' TABLE DATA ' || true
)
if [ "${tables:-0}" -eq 0 ]; then
  echo "Backup check failed: no table data in $file" >&2
  exit 1
fi

echo "Backup OK: $file ($(du -h "$file" | cut -f1), $tables tables)" >&2
echo "$file"
