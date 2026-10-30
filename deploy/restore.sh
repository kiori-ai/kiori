#!/usr/bin/env bash
# kiori-restore: put a Kiori database (and its keys) in place on this server and start Kiori on it. Run as root.
# setup.sh installs it as /usr/local/sbin/kiori-restore.
#
#   kiori-restore /root/kiori-move                         a folder: kiori.db (or psyche.db), plus secret.key and
#                                                          admin.key if they come too (the first copy, from the old machine)
#   kiori-restore /root/kiori-cutover.db                   just a database file; the keys already here stay (the move)
#   kiori-restore /var/backups/kiori/kiori-<time>.tar.gz   a nightly backup: database and keys
#   kiori-restore --check                                  change nothing: is the live data whole, do the keys open?
#
#   --force    start Kiori even if the check fails
#
# Steps: check the incoming database (whole? a Kiori database? a -wal file next to it is folded in); stop Kiori; move
# what was there to /var/lib/kiori/before-restore-<time>/; put the new files in (owner kiori, mode 600, no stale
# -wal/-shm left beside them); check that the secret opens every sealed model key (check-data.mjs); start Kiori and
# wait for /health. If the check fails, Kiori stays stopped and nothing is lost.
set -euo pipefail
umask 077

DATA=/var/lib/kiori
CHECK=/opt/kiori/deploy/check-data.mjs
HEALTH=http://127.0.0.1:7700/health

die() { printf 'kiori-restore: %s\n' "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

[ "$(id -u)" -eq 0 ] || die "run me as root"
command -v sqlite3 >/dev/null || die "sqlite3 is missing (run setup.sh)"

force=0
src=""
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --check) src=--check ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $arg (see --help)" ;;
    *) [ -z "$src" ] || die "one source at a time"; src=$arg ;;
  esac
done
[ -n "$src" ] || { usage; exit 1; }
# The live folder itself would be copied while Kiori writes to it (a folder inside it, like before-restore-*, is fine)
[ "$src" = --check ] || [ "$(realpath -m "$src")" != "$DATA" ] || die "$DATA is the live data: restore from a copy of it"

# The data check runs as kiori with the service's settings, so it sees the same secret and model key Kiori will
check_data() {
  systemd-run --quiet --wait --pipe --collect --uid=kiori --gid=kiori \
    -p EnvironmentFile=/etc/kiori/kiori.env -p WorkingDirectory=/opt/kiori \
    /usr/bin/env KIORI_DATA="$DATA" /usr/local/bin/node "$CHECK"
}

if [ "$src" = --check ]; then
  [ -f "$CHECK" ] || die "$CHECK is missing: ship the code first (deploy/update.sh)"
  check_data
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
stage="$(mktemp -d /var/tmp/kiori-restore.XXXXXX)"
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/in" "$stage/new"

# 1. Where the database and the keys come from
db_src=""
key_dir=""
if [ -d "$src" ]; then
  key_dir=$src
  for n in kiori.db psyche.db kiori.db-wal psyche.db-wal secret.key admin.key; do
    [ ! -L "$src/$n" ] || die "$src/$n is a link: copy the file itself there"
  done
  for n in kiori.db psyche.db; do
    if [ -f "$src/$n" ]; then db_src="$src/$n"; break; fi
  done
elif [ -f "$src" ]; then
  case "$src" in
    *.tar.gz|*.tgz)
      tar -xzf "$src" -C "$stage/in" --no-same-owner --no-same-permissions
      # Plain files and folders only: a link in a backup (secret.key pointing at a file only root may read) would make
      # this script, which runs as root, copy that file into the kiori user's reach
      odd="$(find "$stage/in" -mindepth 1 ! -type f ! -type d -print -quit)"
      [ -z "$odd" ] || die "the backup holds something that isn't a plain file (${odd#"$stage/in/"}): not restoring it"
      if [ -f "$stage/in/SHA256SUMS" ]; then
        (cd "$stage/in" && sha256sum --quiet -c SHA256SUMS) || die "the backup's checksums don't match: it is damaged"
      fi
      key_dir="$stage/in"
      for n in kiori.db psyche.db; do
        if [ -f "$stage/in/$n" ]; then db_src="$stage/in/$n"; break; fi
      done
      ;;
    *) db_src=$src ;;
  esac
else
  die "no such file or folder: $src"
fi
[ -n "$db_src" ] || die "no kiori.db (or psyche.db) in $src"

# 2. The incoming database, checked on a copy: any -wal file that came along is folded in, leaving one plain file
cp "$db_src" "$stage/new/kiori.db"
if [ -f "$db_src-wal" ]; then
  cp "$db_src-wal" "$stage/new/kiori.db-wal"
  say "a -wal file came with the database: folding it in"
fi
mode="$(sqlite3 "$stage/new/kiori.db" 'PRAGMA journal_mode=DELETE;' 2>&1)" || die "can't open the incoming database: $mode"
[ "$mode" = delete ] || die "can't open the incoming database (journal_mode: $mode)"
check="$(sqlite3 "$stage/new/kiori.db" 'PRAGMA integrity_check;' 2>&1)" || die "can't check the incoming database: $check"
[ "$check" = ok ] || die "the incoming database is damaged: $check"
has_projects="$(sqlite3 "$stage/new/kiori.db" "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'projects';")"
[ "$has_projects" = 1 ] || die "the incoming database has no projects table: not a Kiori database"
say "incoming database is whole: $(sqlite3 "$stage/new/kiori.db" 'SELECT count(*) FROM projects;') projects"

keys=""
if [ -n "$key_dir" ]; then
  for k in secret.key admin.key; do
    if [ -f "$key_dir/$k" ]; then
      [ -s "$key_dir/$k" ] || die "$key_dir/$k is empty"
      cp "$key_dir/$k" "$stage/new/$k"
      keys="$keys $k"
    fi
  done
fi
say "bringing in: kiori.db${keys}"

# 3. Swap, with Kiori stopped. What was there goes aside: the database with its -wal/-shm (a stale -wal next to a
#    different database would be replayed into it), and any key that's being replaced.
say "stopping kiori"
systemctl stop kiori.service
install -d -o kiori -g kiori -m 0700 "$DATA"
aside="$DATA/before-restore-$stamp"
install -d -o kiori -g kiori -m 0700 "$aside"
for f in kiori.db kiori.db-wal kiori.db-shm psyche.db psyche.db-wal psyche.db-shm; do
  if [ -e "$DATA/$f" ]; then mv "$DATA/$f" "$aside/"; fi
done
for k in $keys; do
  if [ -e "$DATA/$k" ]; then cp -p "$DATA/$k" "$aside/"; fi
done
if rmdir "$aside" 2>/dev/null; then aside=""; fi
install -o kiori -g kiori -m 0600 "$stage/new/kiori.db" "$DATA/kiori.db"
for k in $keys; do
  install -o kiori -g kiori -m 0600 "$stage/new/$k" "$DATA/$k"
done
chown kiori:kiori "$DATA"
chmod 0700 "$DATA"

# 4. Does the secret here open the sealed model keys in this database?
if [ -f "$CHECK" ]; then
  if ! check_data; then
    if [ "$force" = 1 ]; then
      echo "kiori-restore: the check failed; starting Kiori anyway (--force)" >&2
    else
      echo "kiori-restore: the check failed, so Kiori is NOT started." >&2
      echo "  The new files are in $DATA${aside:+; what was there before is in $aside}." >&2
      echo "  Usual cause: the wrong secret.key, or KIORI_SECRET missing from /etc/kiori/kiori.env." >&2
      echo "  Fix it, then: kiori-restore --check && systemctl enable --now kiori.service kiori-backup.timer" >&2
      echo "  (enable: so Kiori starts at every boot and the nightly backups run). Or start as it is: kiori-restore --force $src" >&2
      exit 1
    fi
  fi
else
  echo "kiori-restore: $CHECK is missing (ship the code with deploy/update.sh): skipping the key check" >&2
fi

# 5. Start (and from now on at every boot), with nightly backups
say "starting kiori"
systemctl enable --quiet kiori.service kiori-backup.timer
systemctl start kiori.service kiori-backup.timer
for _ in $(seq 1 30); do
  if body="$(curl -fsS --max-time 2 "$HEALTH" 2>/dev/null)"; then
    say "kiori is up: $body"
    [ -z "$aside" ] || say "what was there before: $aside (to undo: kiori-restore $aside; rm -rf it once you're happy)"
    case "$src" in
      "$DATA"/*|/var/backups/kiori/*) ;;
      *) say "$src holds secrets: delete it when you're done" ;;
    esac
    exit 0
  fi
  sleep 1
done
journalctl -u kiori.service -n 40 --no-pager >&2 || true
die "kiori didn't answer on $HEALTH within 30 seconds (its last log lines are above)"
