#!/usr/bin/env bash
# kiori-backup: tonight's backup of Kiori's data, kept 14 days in /var/backups/kiori.
# setup.sh installs it as /usr/local/sbin/kiori-backup; kiori-backup.timer runs it nightly as the kiori user.
#
#   By hand:    systemctl start kiori-backup   (or: sudo -u kiori kiori-backup)
#   Restore:    kiori-restore /var/backups/kiori/kiori-<time>.tar.gz
#
# Each backup is one file, kiori-<UTC time>.tar.gz, holding:
#   kiori.db     a consistent copy of the SQLite database (VACUUM INTO: one snapshot, safe while Kiori writes, WAL and all)
#   secret.key   the key that opens the customers' sealed model keys in that database
#   admin.key    the admin key
#   kiori.env    the server's settings (its own model key, and KIORI_SECRET if one is set)
#   info.txt, SHA256SUMS
#
# !! EVERY BACKUP HOLDS SECRETS. secret.key together with the database opens your customers' model provider keys, and
# !! kiori.env holds your own. Keep /var/backups/kiori as setup.sh made it (kiori only, mode 700), never put a backup
# !! anywhere public, and encrypt it before it leaves this server (the offsite step at the bottom does).
set -euo pipefail
umask 077

DATA_DIR=/var/lib/kiori
BACKUP_DIR=/var/backups/kiori
ENV_FILE=/etc/kiori/kiori.env
KEEP_DAYS=14

log() { printf '%s\n' "$*"; }
die() { printf 'kiori-backup: %s\n' "$*" >&2; exit 1; }

# As root, sqlite3 could leave root-owned -wal/-shm files next to the live database, and Kiori couldn't open it again
[ "$(id -un)" = kiori ] || die "run me as the kiori user: systemctl start kiori-backup (or sudo -u kiori $0)"
command -v sqlite3 >/dev/null || die "sqlite3 is missing (apt-get install sqlite3)"
[ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ] || die "$BACKUP_DIR is missing or not writable (setup.sh makes it)"

# The database, found the way Kiori finds it (src/config.mjs): psyche.db only while there is no kiori.db
db="$DATA_DIR/kiori.db"
if [ ! -e "$db" ] && [ -e "$DATA_DIR/psyche.db" ]; then db="$DATA_DIR/psyche.db"; fi
[ -e "$db" ] || die "no database in $DATA_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d "$BACKUP_DIR/.work-$stamp.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# 1. The database. VACUUM INTO copies it inside one read transaction: one consistent snapshot even while Kiori writes,
# and never started over (sqlite3's .backup starts over whenever Kiori commits meanwhile, so under steady writes it may
# never finish). .timeout waits out a busy moment.
sqlite3 -bail -cmd '.timeout 30000' "$db" "VACUUM INTO '$work/kiori.db'"
# One self-contained file (SQLite folds the copy's WAL in; the -shm it leaves behind means nothing now), then a check
mode="$(sqlite3 "$work/kiori.db" 'PRAGMA journal_mode=DELETE;' 2>&1)" || die "can't open the database copy: $mode"
[ "$mode" = delete ] || die "couldn't finish the database copy (journal_mode: $mode)"
[ ! -e "$work/kiori.db-wal" ] || die "the database copy still has a -wal file"
rm -f "$work/kiori.db-shm"
check="$(sqlite3 "$work/kiori.db" 'PRAGMA integrity_check;' 2>&1)" || die "can't check the database copy: $check"
[ "$check" = ok ] || die "the copy failed its integrity check: $check"

# 2. The keys and the settings
for f in secret.key admin.key; do
  if [ -f "$DATA_DIR/$f" ]; then cp "$DATA_DIR/$f" "$work/$f"; else log "note: no $f in $DATA_DIR (not in this backup)"; fi
done
if [ -r "$ENV_FILE" ]; then cp "$ENV_FILE" "$work/kiori.env"; else log "note: can't read $ENV_FILE (not in this backup)"; fi
version="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' /opt/kiori/package.json 2>/dev/null | head -n1 || true)"
{
  echo "Kiori backup $stamp from $(uname -n)"
  echo "database: $db, $(sqlite3 "$work/kiori.db" 'SELECT count(*) FROM projects;' 2>/dev/null || echo '?') projects"
  echo "kiori version: ${version:-unknown}"
  echo "holds secrets: secret.key, admin.key, kiori.env"
  echo "restore: kiori-restore <this file>"
} > "$work/info.txt"
(cd "$work" && sha256sum -- * > SHA256SUMS)

# 3. One file per night, written under a temporary name so that a half-written one never counts as a backup
archive="$BACKUP_DIR/kiori-$stamp.tar.gz"
tar -C "$work" -czf "$archive.part" .
mv "$archive.part" "$archive"
log "backup: $archive ($(du -h "$archive" | cut -f1))"

# 4. Keep 14 days. Only reached after a good backup, so a job that keeps failing never eats the old ones.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'kiori-*.tar.gz' -mtime "+$((KEEP_DAYS - 1))" -print -delete | sed 's/^/removed old backup: /'
find "$BACKUP_DIR" -maxdepth 1 \( -name '.work-*' -o -name '*.part' \) -mmin +60 -exec rm -rf {} + 2>/dev/null || true

# ---------------------------------------------------------------------------------------------------------------------
# 5. Optional: a copy off this server. OFF until you uncomment the lines at the end of this block.
#    Without it these backups live and die with this server (Hetzner's server backups, +20% of the price, are the
#    other way to cover that).
#
#    The copy is encrypted first with age, to a public key: this server can make backups but can't read them. The
#    private key stays with you (password manager), never on the server.
#
#    One-time setup:
#      On your machine: brew install age && age-keygen -o kiori-backup.agekey      (prints "Public key: age1...")
#                       keep kiori-backup.agekey in your password manager, then delete the file
#      In Cloudflare:   R2: create a bucket "kiori-backups"; an R2 API token with Object Read & Write on that bucket
#                       only; a lifecycle rule on the bucket that deletes objects after 30 days
#      On the server:   apt-get install -y age rclone
#                       then /etc/kiori/backup.env (owner root, group kiori, mode 640; kiori-backup.service reads it):
#                         AGE_RECIPIENT=age1...
#                         RCLONE_CONFIG_R2_TYPE=s3
#                         RCLONE_CONFIG_R2_PROVIDER=Cloudflare
#                         RCLONE_CONFIG_R2_ACCESS_KEY_ID=<R2 access key id>
#                         RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=<R2 secret access key>
#                         RCLONE_CONFIG_R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
#                         RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
#      Then uncomment the three lines below (in deploy/backup.sh on your machine: ship it with deploy/update.sh and run
#      setup.sh on the server, which installs it; an edit made on the server itself is overwritten by the next
#      setup.sh) and test:  systemctl start kiori-backup; journalctl -u kiori-backup -n 20
#    Another S3 bucket works the same way: RCLONE_CONFIG_R2_PROVIDER=AWS (or Other), with its own endpoint and keys.
#    Getting one back:  rclone copy r2:kiori-backups/<file>.age . && age -d -i kiori-backup.agekey -o <file> <file>.age
#
# age -r "${AGE_RECIPIENT:?set AGE_RECIPIENT in /etc/kiori/backup.env}" -o "$work/offsite.age" "$archive"
# rclone copyto "$work/offsite.age" "r2:kiori-backups/$(basename "$archive").age"
# log "offsite: r2:kiori-backups/$(basename "$archive").age"

# 6. Optional: a dead man's switch, so you hear about it when a night is missed (healthchecks.io is free).
#    Put BACKUP_PING_URL=https://hc-ping.com/<uuid> in /etc/kiori/backup.env, then uncomment:
# [ -z "${BACKUP_PING_URL:-}" ] || curl -fsS -m 10 --retry 3 "$BACKUP_PING_URL" >/dev/null || log "note: the backup ping failed"
