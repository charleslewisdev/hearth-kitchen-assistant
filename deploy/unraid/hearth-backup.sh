#!/bin/bash
# Nightly Hearth database dump, for unraid's User Scripts plugin.
#
# Add it as a new script (Settings > User Scripts > Add New Script), paste this in, and schedule
# it daily. It writes a compressed pg_dump beside the appdata, keeps the last KEEP_DAYS days, and
# never touches the flash drive.
#
# Restore, into an EMPTY database (stop hearth, point hearth-db at a fresh data directory, start
# hearth-db only). The app's role is cluster-wide and not in the dump, so create it first:
#   docker exec hearth-db psql -U hearth -d hearth -c "CREATE ROLE hearth_app NOLOGIN"
#   gunzip -c <file> | docker exec -i hearth-db psql -v ON_ERROR_STOP=1 -U hearth -d hearth
# then start hearth. Tested round trip: the restored data reads back under the app role's RLS.
#
# A dump is consistent while the database is running, unlike a copy of the data directory, so
# this does not stop anything.
#
# Recipe photos and source pages are files, not rows: they live under the app's data directory
# in files/, and the database only records them. They are copied to DEST/files alongside the
# dumps. A stored file never changes, so each run only adds new ones, and nothing is ever deleted
# from the copy: a photo removed by mistake is still there. To restore, copy DEST/files back into
# the data directory before starting hearth.

set -euo pipefail

CONTAINER="${CONTAINER:-hearth-db}"
DB_USER="${DB_USER:-hearth}"
DB_NAME="${DB_NAME:-hearth}"
DEST="${DEST:-/mnt/user/appdata/hearth/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
DATA_DIR="${DATA_DIR:-/mnt/user/appdata/hearth/data}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "hearth-backup: $CONTAINER is not running; nothing dumped" >&2
  exit 1
fi

mkdir -p "$DEST"
stamp="$(date +%Y-%m-%d_%H%M)"
tmp="$DEST/.hearth-$stamp.sql.gz.partial"
out="$DEST/hearth-$stamp.sql.gz"

# Written to a partial file first, so a failed dump never looks like a good one.
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner | gzip -9 > "$tmp"
mv "$tmp" "$out"
echo "hearth-backup: wrote $out ($(du -h "$out" | cut -f1))"

find "$DEST" -name 'hearth-*.sql.gz' -mtime +"$KEEP_DAYS" -print -delete

# files/ is recipe photos and source pages; import-failures/ is photos and PDFs an import could
# not read, with the text read off them (text.txt) when there was any, kept for improving the
# parser.
for dir in files import-failures; do
  if [ -d "$DATA_DIR/$dir" ]; then
    mkdir -p "$DEST/$dir"
    rsync -a --ignore-existing --exclude '*.tmp' "$DATA_DIR/$dir/" "$DEST/$dir/"
    echo "hearth-backup: $dir copied to $DEST/$dir ($(du -sh "$DEST/$dir" | cut -f1))"
  fi
done
