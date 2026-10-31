# Changelog

All notable changes to Kiori are written down here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A test workflow: `npm test` runs on Node 22 and 24 for every push to `main` and every pull request.
- A release workflow: a version tag builds the Python SDK from `sdk/`, checks that the tag, `pyproject.toml` and `package.json` agree on the version, and publishes it to PyPI by trusted publishing, with no token.
- A test badge in the READMEs, and the server's current size in lines of code.
- This changelog, issue templates for bugs and questions, and a pull request template.

### Changed

- The install instructions in the READMEs, the docs and the console now point at the published homes: `npm install kiori`, `pip install kiori-ai`, and the SillyTavern extension's repository, https://github.com/kiori-ai/SillyTavern-Kiori, for Extensions → Install extension. The single files and the zip stay as the alternative.

## [2.0.0] - 2026-10-31

The first public release. Kiori gives each character in a character AI a brain: memories, personality, and who knows what. Your app keeps the chat, the model and the brains.

### Added

- Stateless brains. A brain is a JSON object that you keep and send with each call; calls that change it give it back. Kiori stores no brains and no chats.
- `create`: a whole brain from a character card, or a name and a paragraph, on your brain API key. `depth: "light"` builds one from the card alone, at once and free.
- `organize`: send the brain and the recent chat, and it learns. Each character learns only from the messages they were present for. Edits, rerolls and deleted messages are noticed and unlearned.
- `recall`: what a character knows right now, ready to drop into your prompt. It's search, not generation.
- `check`: a draft reply checked for leaks, contradictions and an invented past, and fixed before it's shown.
- `export`: a brain as an Obsidian vault in a zip.
- Group chats: up to 12 brains in one call.
- The drop-in: an OpenAI-compatible `POST /v1/chat/completions`. Each character's mind goes into your system prompt and the request goes on to your model. Streaming works, the reply is checked (`kiori.check`, `auto` by default), and the `X-Kiori-Check` header says what happened.
- The console: sign in with a link, make and revoke Kiori keys, and set your brain API key (OpenRouter, OpenAI, Gemini, or another OpenAI-compatible provider). You pay your provider directly.
- The JavaScript SDK (`sdk/kiori.mjs`, with types) and the Python SDK (`sdk/kiori.py`): single files, no dependencies, retries on their own. Their package names are `kiori` on npm and `kiori-ai` on PyPI.
- The SillyTavern extension (`sillytavern/`): each character's brain is kept in the chat files on the player's computer.
- The server: one Node.js process (22.13 or newer) and one SQLite file, no dependencies. `GET /health` reports its version, every answer carries an `X-Request-Id`, and `/openapi.json` describes the API.
- The deploy kit (`deploy/`): a small Ubuntu server behind a Cloudflare Tunnel, hardened systemd units, nightly backups, a safe restore, and updates that roll themselves back.
- The docs (`docs/`) and the site (`site/`).

### Security

- Your brain API key is sealed at rest (AES-256-GCM, with a key made from a secret kept apart from the database), bound to its project, never shown back whole, and blanked out of provider errors.
- Model calls go over https to public addresses only. Private networks, the server itself and cloud metadata addresses are refused when the connection is made, and a provider's redirect is never followed.
- Only an owner key changes project settings: the brain API key, the provider address and the Kiori keys. The keys your app uses get `403 FORBIDDEN`, so a key that leaks from your app can't send your calls elsewhere.
- Kiori keys are stored only as hashes and shown once. Revoking one takes effect at once.
- Sign-in links hold no key, only a one-time token, kept as a hash and good for 7 days. A used link opens nothing, and a new link cancels the project's earlier ones.
- The SDKs refuse redirects (`REDIRECT`), so your key and brains don't go where one leads.
- `KIORI_TRUST_PROXY=cloudflare` reads the caller's address from `CF-Connecting-IP` behind Cloudflare's tunnel; left empty, the header isn't trusted.
- Calls are rate-limited per project (1200 a minute, 64 model calls at once), and wrong keys and sign-ins per address.
- The console page runs only its own script, sends no referrer, and can't be framed.

[Unreleased]: https://github.com/kiori-ai/kiori/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/kiori-ai/kiori/releases/tag/v2.0.0
