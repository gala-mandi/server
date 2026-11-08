#!/usr/bin/env bash
# Restores an encrypted backup (made by scripts/backup.sh) into a FRESH,
# empty database. It refuses a database that already has tables, so it can
# never overwrite live data.
#
#   TARGET_DATABASE_URL=postgres://… BACKUP_PASSPHRASE=… \
#     scripts/restore.sh backups/galla-mandi-<time>.dump.gpg
#
# Create the empty database first, e.g. `createdb galla_mandi_restore` or a
# new database on the host. Objects are owned by the user in
# TARGET_DATABASE_URL (the original owner is not needed). Run the API against
# the restored database with DATABASE_URL=<TARGET_DATABASE_URL>.
set -euo pipefail

backup="${1:?Usage: scripts/restore.sh <backup.dump.gpg>}"
: "${TARGET_DATABASE_URL:?Set TARGET_DATABASE_URL to the new, empty database}"
: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE (the backup encryption passphrase)}"
pg_bin="${PG_BIN:+$PG_BIN/}"
psql_target() {
  "${pg_bin}psql" --no-psqlrc --quiet --no-password -v ON_ERROR_STOP=1 \
    --dbname="$TARGET_DATABASE_URL" "$@"
}

[ -f "$backup" ] || { echo "No such file: $backup" >&2; exit 1; }

existing=$(psql_target -tAc \
  "select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')")
if [ "$existing" -ne 0 ]; then
  echo "Refusing: the target database already has $existing tables. Use a new, empty database." >&2
  exit 1
fi

# Roles are not part of a database dump. Every shop query runs as the
# app_tenant role (migration 0003), so create it and let this user use it.
psql_target <<'SQL'
DO $$
BEGIN
  CREATE ROLE app_tenant NOLOGIN NOINHERIT;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END
$$;
GRANT app_tenant TO CURRENT_USER;
SQL

decrypt() {
  gpg --batch --quiet --pinentry-mode loopback \
    --passphrase-fd 3 3<<<"$BACKUP_PASSPHRASE" --decrypt "$backup"
}

# Everything except the "default privileges" of the old owner, which names a
# role that may not exist here; they are set again below for this user.
list=$(mktemp)
trap 'rm -f "$list"' EXIT
decrypt | "${pg_bin}pg_restore" --list | grep -v ' DEFAULT ACL ' >"$list"

decrypt | "${pg_bin}pg_restore" --no-owner --exit-on-error \
  --use-list="$list" --dbname="$TARGET_DATABASE_URL"

psql_target <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_tenant;
SQL

tables=$(psql_target -tAc "select count(*) from pg_tables where schemaname = 'public'")
migrations=$(psql_target -tAc "select count(*) from drizzle.__drizzle_migrations")
echo "Restore OK: $tables tables, $migrations migrations applied." >&2
