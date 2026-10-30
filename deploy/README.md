# Kiori deploy kit

Everything to run Kiori on a small Ubuntu 24.04 server: one Node process behind a Cloudflare Tunnel, hardened systemd units, nightly backups, a safe restore, and code updates that roll themselves back. It works for a new Kiori and for moving one that already runs somewhere else, with its database and keys.

## What this is

```
callers ──https──▶ Cloudflare (your hostname) ◀── outbound tunnel ── cloudflared ──▶ kiori (node, 127.0.0.1:7700)
                                                                     └──────── the server ────────┘     │
                                                                                                        ▼
                                                                                /var/lib/kiori: kiori.db, secret.key, admin.key
```

The server opens no port for the API. The tunnel dials out to Cloudflare, so the firewall lets in SSH and nothing else.

## Files

| File | Ends up | What it does |
|---|---|---|
| `setup.sh` | run on the server | One-time (and re-runnable) setup as root: Node 24.22.2 pinned and checksum-verified, sqlite3, cloudflared from Cloudflare's apt repo, the `kiori` and `cloudflared` users, folders, commands, units, unattended-upgrades, ufw (SSH only), SSH keys only. Starts nothing. |
| `kiori.service` | `/etc/systemd/system/` | Kiori as user `kiori`, `KIORI_DATA=/var/lib/kiori`, `Restart=always`, journald logs, hardened (`ProtectSystem=strict` with the data folder as the only writable path, `NoNewPrivileges`, `PrivateTmp`, syscall filter and more). Refuses to start on an empty data folder. |
| `cloudflared.service` | `/etc/systemd/system/` | Your named tunnel, as unprivileged user `cloudflared`, hardened. `systemctl start` returns once the tunnel is connected. |
| `config.example.yml` | `/etc/cloudflared/config.yml` (filled in by hand) | Tunnel id, credentials path, your hostname → `http://127.0.0.1:7700`, a local `/ready` page. |
| `kiori.env.example` | `/etc/kiori/kiori.env` (filled in by hand) | Kiori's settings on the server: model key, public URL, optional overrides. |
| `backup.sh` | `/usr/local/sbin/kiori-backup` | Nightly: a consistent SQLite copy (`VACUUM INTO`) plus `secret.key`, `admin.key` and the settings, in one checksummed `.tar.gz`, 14 days kept. Optional encrypted offsite copy (R2/S3) and backup ping, commented out. |
| `kiori-backup.service`, `.timer` | `/etc/systemd/system/` | Run `backup.sh` as `kiori` every night at about 03:15 UTC; a missed night runs at the next boot. |
| `restore.sh` | `/usr/local/sbin/kiori-restore` | Puts a database (and keys) in place safely: checks it, folds in a `-wal`, moves the old files aside, fixes owner and mode, checks the secret opens the sealed keys, starts Kiori, waits for `/health`. For a move and for restoring backups. |
| `check-data.mjs` | shipped with the code | Read-only check of a data folder: integrity, counts, secret and admin key fingerprints, "secret opens all N sealed model keys". Run it on the old machine and on the server and compare. |
| `kiori-cli.sh` | `/usr/local/bin/kiori` | `sudo kiori projects`, `sudo kiori login ...`: the command line with the service's user, settings and data. |
| `update.sh` | run on your machine | Tests, rsync over SSH, restart, health checks on the server and through Cloudflare; rolls the code back by itself if the new code won't start. `--sync-only` copies only. Works with macOS's own bash and rsync. |

## Order of use

1. A server, a region and an SSH key (Choices, below). Root signs in with the key only.
2. Copy the kit to the server and run `setup.sh` there: `scp -r deploy <server>:/root/`, then `ssh <server> 'bash /root/deploy/setup.sh'`.
3. Fill in `/etc/kiori/kiori.env` (from `kiori.env.example`).
4. Ship the code from your machine: `KIORI_VPS=<server> deploy/update.sh --sync-only`.
5. The tunnel: a Cloudflare named tunnel for your hostname. Its `config.yml` (from `config.example.yml`) and credentials JSON go in `/etc/cloudflared/`.
6. The data:
   - **A new Kiori:** `sudo kiori projects` once makes the empty database; then `systemctl start kiori`.
   - **Moving one:** stop the old Kiori, copy its database, `secret.key` and `admin.key` over, and put them in place with `kiori-restore <folder>`, which starts Kiori. `node deploy/check-data.mjs` on both sides should agree.
7. `systemctl start cloudflared`. Never run two connectors for one tunnel on two machines with two databases: Cloudflare would split the traffic between them.
8. From then on, ship code with `deploy/update.sh`.

## On the server

| Path | What | Owner, mode |
|---|---|---|
| `/opt/kiori` | the code (`update.sh` replaces it; `DEPLOYED` says what's running) | root, readable by all |
| `/opt/kiori.prev` | the code before the last update (`update.sh` rolls back to it) | root |
| `/var/lib/kiori` | data: `kiori.db` (+ `-wal`, `-shm`), `secret.key`, `admin.key` | kiori, 700 |
| `/var/backups/kiori` | nightly backups, 14 days: **they hold secrets** | kiori, 700 |
| `/etc/kiori/kiori.env` | settings (model key, public URL...) | root:kiori, 640 |
| `/etc/cloudflared/` | `config.yml`, `<TUNNEL_ID>.json` | root:cloudflared, 640 |
| `/opt/node/` | pinned Node; `/usr/local/bin/node` points at `current` | root |

## Notes

- **Secrets never travel with the code.** `update.sh` copies only what git knows about, and nothing from `data/` except `data/human-model.json`, which is part of the program: `src/personality.mjs` reads it at startup, and the server won't start without it. It never copies `.env` files, and it never copies a `*.db`, `*.key` or `*.pem` file from anywhere. The database and keys move once, by hand, through `kiori-restore`. The tunnel credentials are copied by hand too.
- **`secret.key` is the file that matters most.** It opens the customers' sealed model keys; a database without it can't. Kiori would quietly make a new one on an empty data folder, which is why `kiori.service` refuses to start without a database and why `kiori-restore` checks that the secret opens every sealed key before starting Kiori.
- **Backups hold secrets**: `secret.key` with the database it unlocks, plus `kiori.env`. They stay in a kiori-only folder; the offsite step encrypts them (age, to a public key) before they leave the server.
- Not in the kit, on purpose: a reverse proxy or TLS certificates (Cloudflare does both), Docker, and auto-updates of Node (pinned, bumped by hand).

## Choices

1. **Server.** Any Ubuntu 24.04 server; a small plan is plenty, since Kiori is one Node process and one SQLite file. Some providers let only a sudo user sign in at first: put your key on root once, then sign in as root with the key.
2. **Region.** Callers reach the server through Cloudflare's network from wherever they are. Kiori's own work goes to the model providers, mostly in the US: an embedding on every recall, and models for create and organize.
   - **North America (near US East):** close to the model providers and to US platforms.
   - **The EU:** EU data protection for the accounts database (it holds the emails from access requests). Each model round trip takes about 100 ms longer than from North America.
3. **SSH key.** A dedicated key for this server, with a passphrase (on a Mac, kept in the Keychain):
   ```
   ssh-keygen -t ed25519 -f ~/.ssh/kiori_vps -C "kiori-vps"
   ssh-add --apple-use-keychain ~/.ssh/kiori_vps
   cat ~/.ssh/kiori_vps.pub          # paste it in when ordering the server
   ```
   `setup.sh` turns password sign-in off. Back the private key up, or add a second key, so a lost laptop doesn't lock you out.

Smaller defaults you can change:

- **Offsite backups:** off until you set them up (`backup.sh`, step 5) or turn on your provider's own backups. Do at least one of the two: local backups die with the server.
- **Automatic reboots for kernel updates:** off, so there is no surprise downtime. One line turns them on (`/etc/apt/apt.conf.d/52kiori-unattended-upgrades`).
- **Node:** pinned to 24.22.2 from nodejs.org's official build rather than NodeSource, so nothing upgrades under Kiori by surprise. `setup.sh` says when a newer 24.x is out. Run the same version wherever you test.
