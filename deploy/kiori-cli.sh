#!/usr/bin/env bash
# `kiori` on the server (setup.sh installs this as /usr/local/bin/kiori): Kiori's command line, bin/kiori.mjs, run as
# the kiori user with the same settings and data folder as the service.
#
#   sudo kiori projects                         sudo kiori login --project prj_...
#   sudo kiori project create "Studio" --own    sudo kiori errors --days 7
#
# Use this, not `node bin/kiori.mjs ...` in /opt/kiori: that reads neither /etc/kiori/kiori.env nor /var/lib/kiori,
# and quietly makes a second, empty database in /opt/kiori/data/local whose keys work nowhere.
# Give --out an absolute path the kiori user may write to (/tmp/brains, say).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || exec sudo -- "$0" "$@"

# A terminal when there is one (so Ctrl-C works), plain pipes when there isn't (scripts, ssh host 'kiori ...')
if [ -t 0 ] && [ -t 1 ]; then io=--pty; else io=--pipe; fi

exec systemd-run --quiet --wait --collect "$io" --expand-environment=no \
  --uid=kiori --gid=kiori \
  -p EnvironmentFile=/etc/kiori/kiori.env \
  -p WorkingDirectory=/opt/kiori \
  /usr/bin/env KIORI_DATA=/var/lib/kiori KIORI_HOST=127.0.0.1 PORT=7700 \
  /usr/local/bin/node /opt/kiori/bin/kiori.mjs "$@"
