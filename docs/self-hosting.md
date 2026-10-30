# Running a Kiori server

For whoever runs Kiori itself; this page isn't part of the public docs on kiori.io. Running it on a server is in `deploy/` (start with `deploy/README.md`).

Kiori is one Node.js process and one SQLite file: no other services, nothing to install. The database holds accounts only (projects, hashes of their keys, sealed brain API keys, sign-in links not yet used, usage counts, access requests from the site's form, and a note of each call that failed on the server's side, kept 30 days). Brains and chats are never stored.

**License:** the server code is under the PolyForm Noncommercial License 1.0.0 (see `LICENSE`). Running your own Kiori for any non-commercial purpose is free; running it for a commercial product or service needs a commercial license: write to [help@kiori.io](mailto:help@kiori.io).

## Requirements

- Node.js 22.13 or newer (it uses the built-in `node:sqlite`); the server runs 24.22.2.
- For projects on this server's own key: a key for any OpenAI-compatible model endpoint (OpenRouter by default). Customer projects bring their own.

## Settings (`.env` in the project folder, or the environment)

The older `PSYCHE_*` names are still read, so an existing `.env` keeps working.

| Variable | Default | |
|---|---|---|
| `KIORI_LLM_KEY` | none | The model key for projects on this server's own key (`llm_mode` "server"). |
| `KIORI_LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint, for this server's own key. |
| `KIORI_ORGANIZER_MODEL` | `anthropic/claude-haiku-5.5` | Writes brains: building, scenes, learning. |
| `KIORI_AUDITOR_MODEL` | `anthropic/claude-haiku-5.5` | Checks drafts, and sleep. |
| `KIORI_FALLBACK_MODEL` | `deepseek/deepseek-v4.1-flash` | The last attempt on OpenRouter when the main model refuses or answers badly. |
| `KIORI_PROVIDER_SORT` | `throughput` | On OpenRouter, the fastest provider of a model (`price`, `latency`, or empty). |
| `KIORI_EMBED_MODEL` | `openai/text-embedding-3-small` | Recall by meaning; `KIORI_EMBED=0` turns it off. |
| `KIORI_LEARN_EVERY` | `12` | Settled new messages before organizing learns (a request can say otherwise). |
| `KIORI_LEARN_HOLD` | `4` | The newest messages organizing leaves for later. |
| `KIORI_MAX_AT_ONCE` | `64` | Calls that set the model to work (create, organize, check, the drop-in) one project may have running at once. |
| `PORT` | `7700` | |
| `KIORI_HOST` | `127.0.0.1` | The address to listen on; `0.0.0.0` in a container, or behind a reverse proxy on another machine. The rate limits go by the caller's address: behind a proxy on this machine, the last address in `X-Forwarded-For` (the one your proxy added), and an IPv6 caller counts by its /64. A proxy on another machine counts as one caller for everyone it passes on. |
| `KIORI_TRUST_PROXY` | empty | `cloudflare` when Cloudflare's tunnel is the proxy on this machine: the caller's address is then read from `CF-Connecting-IP`. Leave it empty behind any other proxy (nginx, Caddy): it passes that header on just as the client wrote it. |
| `KIORI_PUBLIC_URL` | this machine | Where customers reach this Kiori, e.g. `https://api.kiori.io`; sign-in links point here. |
| `KIORI_SECRET` | a random secret in `data/local/secret.key` | Seals customers' brain API keys. Keep it with your backups: a database without it can't open them. If you set it, use 32 random characters or more (`openssl rand -base64 32`). |
| `KIORI_PROXY_ALLOW_LOCAL` | `0` | `1` allows model providers on this machine or the local network, and plain http. Leave it off on a public server: with it off, customers' provider addresses must be https on the public internet, checked on every connection. |
| `KIORI_DATA` | `data/local` | Where the database (`kiori.db`), `secret.key` and `admin.key` live. |

## Commands

```bash
node bin/kiori.mjs serve                            # API + console + docs
node bin/kiori.mjs project create "Studio" --own    # a customer project on its own brain API key: its key once, and a sign-in link
node bin/kiori.mjs key create --project prj_...     # another key
node bin/kiori.mjs login --project prj_...          # a console sign-in link: one use, 7 days, holds no key
node bin/kiori.mjs rotate-secret                    # a new sealing secret; every kept key is sealed again with it
node bin/kiori.mjs errors --days 7                  # the calls that failed on the server's side (status and code, never content)
node bin/kiori.mjs stats --weeks 12                 # how Kiori is used, week by week
node bin/kiori.mjs site                             # the public site as static files, in dist/
npm test                                            # the tests (a fake model provider: nothing is spent)
```

The admin console is the same `/console`, signed in with `data/local/admin.key`. It approves access requests (which makes the customer's project and a one-time sign-in link to send them) and shows the weekly numbers. The admin key is kept only while that browser tab is open.

## Secrets and keys

- `secret.key` is the file that matters most: it opens every sealed brain API key. Kiori makes a random one on first start. Keep a copy in your password manager, and keep it out of the code.
- Sealed keys are bound to their project and setting; keys sealed the older way (`sealed:`) still open, and the server seals them again the current way when it starts.
- `kiori rotate-secret` puts a new secret in front of the old one, seals every kept key again with it, then moves the old secret aside to `secret.key.old-<date>`. A server running meanwhile picks the new secret up when it meets a key sealed with it. Delete the old file once your backups hold the new `secret.key`. With `KIORI_SECRET` set instead, the command says how to do it by hand.
- On start, the server makes `secret.key` and `admin.key` readable by their owner only, if they weren't.

## Data and backups

`data/local/kiori.db` (SQLite, WAL mode) holds the accounts and usage: back it up together with `secret.key`. There is nothing else to back up, since brains live with the customers. `deploy/backup.sh` does it nightly on the server.

A database from before brains moved out still has its old tables (characters, stories, memories). Nothing reads them; `kiori export-old` turns them into brain files, and you can delete them when you're done.
