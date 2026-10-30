#!/usr/bin/env bash
# Ship Kiori's code from this machine to the server, restart it there and check that it answers. Run it from anywhere.
#
#   deploy/update.sh                tests, copy, restart, health checks; the old code comes back if the new won't start
#   deploy/update.sh --sync-only    only copy the code (the first time, before Kiori runs on the server)
#   deploy/update.sh --skip-tests   don't run the tests first
#
# The server: KIORI_VPS, default kiori-vps (a Host in ~/.ssh/config). Or KIORI_VPS=root@203.0.113.7
# Never copied: data/ (except data/human-model.json, which is code), .env files, dist/, node_modules/, design/, and
# any *.db, *.key or *.pem file anywhere.
# Works with macOS's own bash (3.2) and rsync (openrsync).
set -euo pipefail

VPS="${KIORI_VPS:-kiori-vps}"
PUBLIC_HEALTH="${KIORI_PUBLIC_HEALTH:-https://api.kiori.io/health}"
REMOTE_DIR=/opt/kiori

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'update: %s\n' "$*" >&2; exit 1; }
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

sync_only=0
skip_tests=0
for arg in "$@"; do
  case "$arg" in
    --sync-only) sync_only=1 ;;
    --skip-tests) skip_tests=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $arg (see --help)" ;;
  esac
done

{ [ -f "$APP/package.json" ] && [ -f "$APP/bin/kiori.mjs" ]; } || die "can't find Kiori next to this script (looked in $APP)"
command -v rsync >/dev/null || die "rsync is missing"
command -v node >/dev/null || die "node is missing"
version="$(node -p 'require(process.argv[1]).version' "$APP/package.json")"
# Which commit goes out, written to /opt/kiori/DEPLOYED on the server (read-only git, if it's there)
rev=""
if command -v git >/dev/null 2>&1 && git -C "$APP" rev-parse --git-dir >/dev/null 2>&1; then
  rev="$(git -C "$APP" rev-parse --short HEAD 2>/dev/null || true)"
  if [ -n "$(git -C "$APP" status --porcelain -- . 2>/dev/null || true)" ]; then rev="${rev}+uncommitted"; fi
fi
say "Kiori $version${rev:+ ($rev)} to $VPS"

if [ "$sync_only" = 0 ] && pgrep -f 'cloudflared.*data/local/tunnel' >/dev/null 2>&1; then
  printf '\n!! A tunnel from this machine is running too: Cloudflare splits the traffic between this machine and\n' >&2
  printf '!! the server, each with its own database. Stop it unless you are in the middle of a move.\n' >&2
fi

if [ "$skip_tests" = 0 ]; then
  say "Tests"
  (cd "$APP" && node --no-warnings --test test/*.test.mjs) || die "the tests failed: nothing was shipped"
fi

# One SSH connection for every step (a short socket path: macOS caps them at 104 characters)
cm="$(mktemp -d /tmp/kiori-ssh.XXXXXX)"
SSH="ssh -o ControlMaster=auto -o ControlPath=$cm/%C -o ControlPersist=120 -o ServerAliveInterval=15"
# $SSH is split into words on purpose: none of its parts has a space
# shellcheck disable=SC2086
cleanup() { $SSH -O exit "$VPS" >/dev/null 2>&1 || true; rm -rf "$cm"; }
trap cleanup EXIT
# shellcheck disable=SC2086
remote() { $SSH "$VPS" "$@"; }

say "Checking the server"
uid="$(remote 'id -u' </dev/null)" || die "can't reach $VPS over SSH"
if [ "$uid" = 0 ]; then SUDO=""; else SUDO="sudo -n"; fi
remote "$SUDO bash -s -- $sync_only" <<'EOF'
set -e
if [ ! -d /opt/kiori ] || ! command -v rsync >/dev/null; then
  echo "update: the server isn't set up yet: run setup.sh there first (deploy/README.md, step 2)" >&2
  exit 1
fi
if [ "$1" = 0 ]; then
  if ! systemctl is-enabled --quiet kiori.service 2>/dev/null; then
    echo "update: Kiori doesn't run on the server yet (deploy/README.md, step 6); until then use --sync-only" >&2
    exit 1
  fi
  # The code that runs now, kept to roll back to
  rsync -a --delete /opt/kiori/ /opt/kiori.prev/
fi
# The new code goes to a copy first (seeded from the current one, so only what changed travels), and takes the
# current one's place only once it has all arrived: a copy cut off halfway leaves the running code as it was
rsync -a --delete /opt/kiori/ /opt/kiori.next/
EOF

say "Copying the code to $VPS:$REMOTE_DIR"
# From data/ only human-model.json goes: it is part of the program (src/personality.mjs reads it at startup). The rest
# of data/ (data/local: the database, secret.key, admin.key, the tunnel files, private notes) never leaves this machine.
rsync_opts=(--include=/data/human-model.json --exclude='/data/*' --exclude=/dist/ --exclude=/design/ --exclude=node_modules/ --exclude=.git/
  --exclude=.env --exclude='.env.*' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm'
  --exclude='*.key' --exclude='*.pem' --exclude=.DS_Store --exclude='*.log')
# Nor do files git doesn't know (neither added nor ignored): whatever lands in the folder by accident, a download or a
# draft, must not go live
if [ -n "$rev" ]; then
  git -C "$APP" ls-files --others --exclude-standard | sed 's/[][*?\\]/\\&/g; s|^|/|' > "$cm/untracked"
  rsync_opts+=("--exclude-from=$cm/untracked")
fi
if [ -n "$SUDO" ]; then rsync_opts+=("--rsync-path=sudo -n rsync"); fi
rsync -rlt --delete -e "$SSH" "${rsync_opts[@]}" "$APP/" "$VPS:$REMOTE_DIR.next/"
remote "$SUDO bash -s -- '$version' '${rev:-unknown}'" <<'EOF'
set -e
# Code belongs to root and is readable by all: the kiori user runs it but can't change it
chown -R root:root /opt/kiori.next
chmod -R u+rwX,go+rX,go-w /opt/kiori.next
printf 'version %s\ncommit %s\nshipped %s\n' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /opt/kiori.next/DEPLOYED
# All there: it takes the current code's place
rm -rf /opt/kiori.old
mv /opt/kiori /opt/kiori.old
if ! mv /opt/kiori.next /opt/kiori; then mv /opt/kiori.old /opt/kiori; echo "update: couldn't put the new code in place; the running code is as it was" >&2; exit 1; fi
rm -rf /opt/kiori.old
# The helper commands and systemd units run from copies setup.sh installed: a change to them takes effect when
# setup.sh runs again
changed=""
for pair in backup.sh:/usr/local/sbin/kiori-backup restore.sh:/usr/local/sbin/kiori-restore kiori-cli.sh:/usr/local/bin/kiori \
    kiori.service:/etc/systemd/system/kiori.service cloudflared.service:/etc/systemd/system/cloudflared.service \
    kiori-backup.service:/etc/systemd/system/kiori-backup.service kiori-backup.timer:/etc/systemd/system/kiori-backup.timer; do
  if [ -f "${pair#*:}" ] && ! cmp -s "/opt/kiori/deploy/${pair%%:*}" "${pair#*:}"; then changed="$changed ${pair%%:*}"; fi
done
if [ -n "$changed" ]; then echo "update: deploy/ changed ($changed ), so install it on the server: bash /opt/kiori/deploy/setup.sh" >&2; fi
EOF

if [ "$sync_only" = 1 ]; then
  say "The code is on the server ($REMOTE_DIR); nothing was restarted (--sync-only)"
  exit 0
fi

say "Restarting Kiori on the server"
if ! remote "$SUDO bash -s" <<'EOF'
systemctl restart kiori.service || exit 1
for _ in $(seq 1 30); do
  if body="$(curl -fsS --max-time 2 http://127.0.0.1:7700/health 2>/dev/null)"; then echo "on the server: $body"; exit 0; fi
  sleep 1
done
exit 1
EOF
then
  echo "update: the new code didn't come up; putting the previous code back" >&2
  remote "$SUDO bash -s" <<'EOF' || true
journalctl -u kiori.service -n 30 --no-pager
rsync -a --delete /opt/kiori.prev/ /opt/kiori/
systemctl restart kiori.service
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:7700/health >/dev/null 2>&1; then echo "rolled back: the previous code runs again"; exit 0; fi
  sleep 1
done
echo "rolled back, but Kiori still doesn't answer: journalctl -u kiori -n 50" >&2
exit 1
EOF
  die "the update failed (the new code's last log lines are above)"
fi

say "Checking $PUBLIC_HEALTH"
for _ in $(seq 1 20); do
  if body="$(curl -fsS --max-time 5 "$PUBLIC_HEALTH?t=$(date +%s)" 2>/dev/null)"; then
    case "$body" in
      *'"ok":true'*)
        echo "public: $body"
        case "$body" in *"\"version\":\"$version\""*) ;; *) echo "update: note: that answer isn't version $version" >&2 ;; esac
        say "Done: Kiori $version${rev:+ ($rev)} runs on the server"
        exit 0
        ;;
    esac
  fi
  sleep 3
done
die "Kiori runs on the server, but $PUBLIC_HEALTH doesn't answer. The tunnel? ssh $VPS journalctl -u cloudflared -n 30"
