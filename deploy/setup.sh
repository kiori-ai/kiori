#!/usr/bin/env bash
# Kiori server setup. Run it once as root on a fresh Ubuntu 24.04 LTS server. Running it again is safe: it only fixes
# what differs, never touches the data in /var/lib/kiori, and never overwrites a settings file you filled in.
#
#   scp -r deploy <server>:/root/                  (from your machine, in Kiori's folder)
#   ssh <server> 'bash /root/deploy/setup.sh'
#   (later, once the code is on the server: ssh <server> 'bash /opt/kiori/deploy/setup.sh')
#
# It installs Node (pinned), sqlite3 and cloudflared (from Cloudflare's apt repository); makes the kiori and
# cloudflared system users, the folders, the helper commands (kiori, kiori-backup, kiori-restore) and the systemd
# units; turns on unattended-upgrades; lets only SSH in (ufw); and, when root (or you) already signs in with an SSH
# key, turns password sign-in off (HARDEN_SSH=0 bash setup.sh skips that).
# It does NOT start Kiori or the tunnel: they start once the data is in place (deploy/README.md, Order of use).
set -euo pipefail

# Node is pinned on purpose, to a release Kiori's tests pass on; run the same wherever you test (`node --version`). To move
# to a newer 24.x: change this line and run setup.sh again. It restarts Kiori on the new Node and checks that it
# answers; if it doesn't, it goes back to the Node it had and says so.
NODE_VERSION="24.22.2"

HARDEN_SSH="${HARDEN_SSH:-1}"
APP_DIR=/opt/kiori
DATA_DIR=/var/lib/kiori
BACKUP_DIR=/var/backups/kiori
ETC_DIR=/etc/kiori
CF_DIR=/etc/cloudflared
NODE_ROOT=/opt/node
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die()  { printf 'setup: %s\n' "$*" >&2; exit 1; }

# install_file SRC DEST MODE OWNER:GROUP copies only when the content, mode or owner differ. Status 0: it changed.
install_file() {
  local src=$1 dest=$2 mode=$3 owner=$4
  if [ -f "$dest" ] && cmp -s "$src" "$dest" && [ "$(stat -c '%a %U:%G' "$dest")" = "${mode#0} $owner" ]; then
    return 1
  fi
  install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dest" || die "couldn't install $dest"
  return 0
}

in_list() {
  local x=$1 y
  shift
  for y in "$@"; do
    if [ "$x" = "$y" ]; then return 0; fi
  done
  return 1
}

# apt-get that waits: on a new server, the first automatic update may still hold the package lock for a while
apt_get() {
  local try
  for try in 1 2 3 4 5 6; do
    if apt-get -q -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; then
      return 0
    fi
    [ "$try" -lt 6 ] || return 1
    note "apt-get $1 didn't go through; trying again in 10 s"
    sleep 10
  done
}

wait_health() {
  local try
  for try in $(seq 1 30); do
    if curl -fsS --max-time 2 http://127.0.0.1:7700/health >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

[ "$(id -u)" -eq 0 ] || die "run me as root (sudo bash $0)"
# shellcheck source=/dev/null
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this is for Ubuntu (found ${PRETTY_NAME:-something else})"
[ "${VERSION_ID:-}" = 24.04 ] || warn "made for Ubuntu 24.04 LTS; this is ${PRETTY_NAME:-unknown}. Going on anyway."
for f in kiori.service cloudflared.service kiori-backup.service kiori-backup.timer backup.sh restore.sh kiori-cli.sh \
         kiori.env.example config.example.yml; do
  [ -f "$HERE/$f" ] || die "$HERE/$f is missing: copy the whole deploy folder, not just this script"
done
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------------------------------------------------
say "Packages"
apt_get update
apt_get install -y --no-install-recommends ca-certificates curl gnupg xz-utils sqlite3 rsync ufw unattended-upgrades

# ---------------------------------------------------------------------------------------------------------------------
say "Node.js $NODE_VERSION (pinned, official build from nodejs.org)"
case "$(dpkg --print-architecture)" in
  amd64) node_arch=x64 ;;
  arm64) node_arch=arm64 ;;
  *) die "no official Node build for $(dpkg --print-architecture)" ;;
esac
node_name="node-v$NODE_VERSION-linux-$node_arch"
node_changed=0
prev_node="$(readlink "$NODE_ROOT/current" 2>/dev/null || true)"
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  # Checked against nodejs.org's SHASUMS256.txt for that release before anything is unpacked
  curl -fsSL --retry 3 -o "$TMP/$node_name.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/$node_name.tar.xz"
  curl -fsSL --retry 3 -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  want="$(awk -v f="$node_name.tar.xz" '$2 == f { print $1 }' "$TMP/SHASUMS256.txt")"
  got="$(sha256sum "$TMP/$node_name.tar.xz" | cut -d' ' -f1)"
  if [ -z "$want" ] || [ "$want" != "$got" ]; then die "checksum mismatch for $node_name.tar.xz: not installing it"; fi
  install -d -m 0755 "$NODE_ROOT"
  rm -rf "${NODE_ROOT:?}/$node_name"
  tar -xJf "$TMP/$node_name.tar.xz" -C "$NODE_ROOT" --no-same-owner
  # Older versions stay in /opt/node (to go back: point /opt/node/current at one and restart kiori)
  ln -sfn "$NODE_ROOT/$node_name" "$NODE_ROOT/current"
  for b in node npm npx; do ln -sfn "$NODE_ROOT/current/bin/$b" "/usr/local/bin/$b"; done
  node_changed=1
fi
/usr/local/bin/node --no-warnings -e "new (require('node:sqlite').DatabaseSync)(':memory:').close()" \
  || die "Node $NODE_VERSION can't open SQLite (node:sqlite), which Kiori needs"
note "node $(/usr/local/bin/node --version), at /usr/local/bin/node"
latest="$(curl -fsSL --max-time 10 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt 2>/dev/null \
  | grep -oE 'node-v24\.[0-9]+\.[0-9]+' | head -n1 | sed 's/^node-v//' || true)"
if [ -n "$latest" ] && [ "$latest" != "$NODE_VERSION" ] \
   && [ "$(printf '%s\n%s\n' "$NODE_VERSION" "$latest" | sort -V | tail -n1)" = "$latest" ]; then
  note "Node $latest is out. This server stays on $NODE_VERSION until you change NODE_VERSION here and run setup.sh again."
fi

# ---------------------------------------------------------------------------------------------------------------------
say "cloudflared (Cloudflare's apt repository)"
export GNUPGHOME="$TMP/gnupg"
install -d -m 0700 "$GNUPGHOME"
keyring=/usr/share/keyrings/cloudflare-archive-keyring.gpg
: > "$TMP/cloudflare.gpg"
# Cloudflare's package signing key, under its newer and its older name: whichever pkg.cloudflare.com serves goes in
for url in https://pkg.cloudflare.com/cloudflare-public-v2.gpg https://pkg.cloudflare.com/cloudflare-main.gpg; do
  f="$TMP/key-${url##*/}"
  if ! curl -fsSL --retry 3 -o "$f" "$url" 2>/dev/null; then continue; fi
  if grep -q -- '-----BEGIN PGP' "$f"; then
    gpg --batch --yes --dearmor -o "$f.bin" "$f"
    mv "$f.bin" "$f"
  fi
  if gpg --batch --show-keys "$f" >/dev/null 2>&1; then cat "$f" >> "$TMP/cloudflare.gpg"; fi
done
[ -s "$TMP/cloudflare.gpg" ] || die "couldn't fetch Cloudflare's package key; the current one is named on https://pkg.cloudflare.com/"
install -m 0644 "$TMP/cloudflare.gpg" "$keyring"
echo "deb [signed-by=$keyring] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
apt_get update || die "apt-get update failed. If it's about Cloudflare's key, https://pkg.cloudflare.com/ names the current one"
apt_get install -y cloudflared
note "$(cloudflared --version 2>&1 | head -n1)"

# ---------------------------------------------------------------------------------------------------------------------
say "Users"
id -u kiori >/dev/null 2>&1 \
  || useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin --comment "Kiori API" kiori
id -u cloudflared >/dev/null 2>&1 \
  || useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin --comment "Cloudflare Tunnel" cloudflared
note "kiori (uid $(id -u kiori)), cloudflared (uid $(id -u cloudflared))"

# ---------------------------------------------------------------------------------------------------------------------
say "Folders"
install -d -m 0755 -o root -g root "$APP_DIR"
install -d -m 0700 -o kiori -g kiori "$DATA_DIR" "$BACKUP_DIR"
chown -R kiori:kiori "$DATA_DIR" "$BACKUP_DIR"
chmod 0700 "$DATA_DIR" "$BACKUP_DIR"
install -d -m 0750 -o root -g kiori "$ETC_DIR"
install -d -m 0750 -o root -g cloudflared "$CF_DIR"
note "$APP_DIR (code), $DATA_DIR (data), $BACKUP_DIR (backups), $ETC_DIR (settings), $CF_DIR (tunnel)"

# ---------------------------------------------------------------------------------------------------------------------
say "Settings"
if [ -e "$ETC_DIR/kiori.env" ]; then
  note "$ETC_DIR/kiori.env is there: left as it is"
else
  install -m 0640 -o root -g kiori "$HERE/kiori.env.example" "$ETC_DIR/kiori.env"
  note "wrote $ETC_DIR/kiori.env from kiori.env.example: fill it in (deploy/README.md, step 3)"
fi
chown root:kiori "$ETC_DIR/kiori.env"
chmod 0640 "$ETC_DIR/kiori.env"
if [ -e "$ETC_DIR/backup.env" ]; then chown root:kiori "$ETC_DIR/backup.env"; chmod 0640 "$ETC_DIR/backup.env"; fi
install -m 0640 -o root -g cloudflared "$HERE/config.example.yml" "$CF_DIR/config.example.yml"
# cloudflared runs as its own user, so it must be able to read the config and the credentials JSON
find "$CF_DIR" -maxdepth 1 -type f -exec chown root:cloudflared {} + -exec chmod 0640 {} +
if [ -e "$CF_DIR/config.yml" ]; then
  note "$CF_DIR/config.yml is there"
else
  note "tunnel: $CF_DIR/config.yml and the credentials JSON go in by hand (deploy/README.md, step 5)"
fi

# ---------------------------------------------------------------------------------------------------------------------
say "Commands and systemd units"
install_file "$HERE/backup.sh"    /usr/local/sbin/kiori-backup  0755 root:root || true
install_file "$HERE/restore.sh"   /usr/local/sbin/kiori-restore 0755 root:root || true
install_file "$HERE/kiori-cli.sh" /usr/local/bin/kiori          0755 root:root || true
changed_units=()
for u in kiori.service cloudflared.service kiori-backup.service kiori-backup.timer; do
  if install_file "$HERE/$u" "/etc/systemd/system/$u" 0644 root:root; then changed_units+=("$u"); fi
done
systemctl daemon-reload
note "commands: kiori, kiori-backup, kiori-restore; units: kiori, cloudflared, kiori-backup (+ .timer)"

# ---------------------------------------------------------------------------------------------------------------------
say "Automatic security updates (unattended-upgrades)"
printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/20auto-upgrades
if [ ! -e /etc/apt/apt.conf.d/52kiori-unattended-upgrades ]; then
  cat > /etc/apt/apt.conf.d/52kiori-unattended-upgrades <<'EOF'
// Written once by Kiori's setup.sh (it never overwrites your edits). Ubuntu's security updates install on their own
// every day. Kernel updates only take effect after a reboot. To let the server reboot itself when one needs it
// (Kiori is then down for about a minute), uncomment the two lines below; the time is the server's (UTC).
// Unattended-Upgrade::Automatic-Reboot "true";
// Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
fi
systemctl enable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 \
  || warn "couldn't enable unattended-upgrades' timers"
note "on; kernel updates wait for a reboot (/etc/apt/apt.conf.d/52kiori-unattended-upgrades)"

# ---------------------------------------------------------------------------------------------------------------------
say "Firewall (ufw): SSH in, nothing else"
# The port of this very SSH session, and the ones sshd is configured for (22 if neither can be found)
ssh_ports="$( { if [ -n "${SSH_CONNECTION:-}" ]; then echo "${SSH_CONNECTION##* }"; fi
                sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }'; } | sort -un || true)"
[ -n "$ssh_ports" ] || ssh_ports=22
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for p in $ssh_ports; do ufw allow "$p/tcp" comment SSH >/dev/null; done
ufw --force enable >/dev/null
note "inbound: $(echo "$ssh_ports" | tr '\n' ' ')(tcp) only; the tunnel dials out and needs no open port"

# ---------------------------------------------------------------------------------------------------------------------
if [ "$HARDEN_SSH" = 1 ]; then
  say "SSH: keys only"
  homes=/root
  if [ -n "${SUDO_USER:-}" ]; then homes="$homes $(getent passwd "$SUDO_USER" | cut -d: -f6)"; fi
  has_key=0
  for h in $homes; do
    if [ -s "$h/.ssh/authorized_keys" ] \
       && grep -qE '(ssh-(ed25519|rsa)|ecdsa-sha2-nistp[0-9]+|sk-[a-z0-9-]+@openssh\.com) AAAA' "$h/.ssh/authorized_keys"; then
      has_key=1
    fi
  done
  if [ "$has_key" = 1 ]; then
    cat > "$TMP/10-kiori.conf" <<'EOF'
# Written by Kiori's setup.sh: sign in with an SSH key only. (HARDEN_SSH=0 bash setup.sh leaves this file out.)
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
    if install_file "$TMP/10-kiori.conf" /etc/ssh/sshd_config.d/10-kiori.conf 0644 root:root; then
      mkdir -p /run/sshd
      if sshd -t; then
        systemctl try-reload-or-restart ssh.service || true
        note "password sign-in is off; keys only (this session stays open)"
      else
        rm -f /etc/ssh/sshd_config.d/10-kiori.conf
        warn "sshd didn't accept the change, so SSH is left as it was"
      fi
    else
      note "already keys only"
    fi
  else
    warn "no SSH key in authorized_keys, so password sign-in stays on. Add your key, then run setup.sh again."
  fi
fi

# ---------------------------------------------------------------------------------------------------------------------
say "Network buffers for cloudflared (QUIC)"
printf '%s\n' "# Written by Kiori's setup.sh: the bigger UDP buffers cloudflared's QUIC connections ask for" \
  'net.core.rmem_max = 7500000' 'net.core.wmem_max = 7500000' > "$TMP/90-kiori-cloudflared.conf"
if install_file "$TMP/90-kiori-cloudflared.conf" /etc/sysctl.d/90-kiori-cloudflared.conf 0644 root:root; then
  sysctl -q -p /etc/sysctl.d/90-kiori-cloudflared.conf || warn "couldn't apply them now; they apply at the next boot"
fi
note "net.core.rmem_max / wmem_max = 7500000"

# ---------------------------------------------------------------------------------------------------------------------
say "Services"
if systemctl is-active --quiet kiori.service; then
  if [ "$node_changed" = 1 ] || in_list kiori.service ${changed_units[@]+"${changed_units[@]}"}; then
    systemctl restart kiori.service
    if wait_health; then
      note "kiori restarted on the new setup and answers"
    elif [ "$node_changed" = 1 ] && [ -n "$prev_node" ] && [ -d "$prev_node" ]; then
      # The new Node doesn't run Kiori: back to the one that did
      ln -sfn "$prev_node" "$NODE_ROOT/current"
      systemctl restart kiori.service
      if wait_health; then die "kiori didn't answer on Node $NODE_VERSION, so it runs on $(basename "$prev_node") again (journalctl -u kiori -n 50 says why)"; fi
      die "kiori answers on neither Node $NODE_VERSION nor $(basename "$prev_node"): journalctl -u kiori -n 50"
    else
      die "kiori doesn't answer after the restart: journalctl -u kiori -n 50"
    fi
  else
    note "kiori runs; nothing it depends on changed"
  fi
else
  note "kiori isn't running yet: it starts once the data is in place (deploy/README.md, step 6)"
fi
if systemctl is-active --quiet cloudflared.service; then
  if in_list cloudflared.service ${changed_units[@]+"${changed_units[@]}"}; then
    systemctl restart cloudflared.service
    note "cloudflared restarted (its unit changed)"
  fi
else
  note "cloudflared isn't running: it starts after Kiori (deploy/README.md, step 7)"
fi
if [ -e "$DATA_DIR/kiori.db" ] || [ -e "$DATA_DIR/psyche.db" ]; then
  systemctl enable --now --quiet kiori-backup.timer
  note "nightly backups on (systemctl list-timers kiori-backup.timer)"
fi

say "Done"
if systemctl is-active --quiet kiori.service; then
  note "Kiori runs here. Run this script again any time; it only changes what differs."
else
  note "Next (deploy/README.md): 3. fill in $ETC_DIR/kiori.env   4. deploy/update.sh --sync-only (from your machine)"
  note "6. the tunnel files in $CF_DIR (don't start cloudflared yet)   7. the rehearsal with kiori-restore"
fi
