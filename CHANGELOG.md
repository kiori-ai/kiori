# Changelog

All notable changes to Kiori are written down here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- A test workflow: `npm test` runs on Node 22 and 24 for every push to `main` and every pull request.
- A release workflow: a version tag builds the Python SDK from `sdk/`, checks that the tag, `pyproject.toml` and `package.json` agree on the version, and publishes it to PyPI by trusted publishing, with no token.
- A test badge in the READMEs, and the server's current size in lines of code.
- This changelog, issue templates for bugs and questions, and a pull request template.
- Sources: every memory and fact learned from a conversation says how the character knows it (`source`: `how`, `by`, `origin`, `at`) and how much they believe it (`confidence`). Kiori works the source out from the message the evidence quote is in, not from what the organizer claims, and the organizer can only lower the confidence. Recall lists what a character was told apart from what they know for sure, with the teller, the origin and how much they believe it, and memory headers show their source.
- Gossip: a character who passes something on keeps a `told` memory (`told_to`, `said`), written only from their own line and only for listeners who were there; the rest are counted in `learned[].dropped.told`.
- `placed` in the organize answer: who Kiori placed in each message of a group chat. Sent back as `present`, those messages are never placed again. Placing a stretch now lists only the characters it can involve (named in it or just before it, or present just before it); a cast of up to 8 is still listed whole.
- Partial presence: a `present` entry can be `{ "name", "mode" }` as well as a name (which stays `full`). Modes are `full`, `heard` (only what is said), `overheard` (what is said, with about 40% of the words lost, the same ones every time), `saw` (what is seen, not the words: a whisper's other people) and `asleep` (nothing). Kiori cuts each message to what the character took in before learning from it, and checks what is learned against that text, so a word they missed can't be learned; check shows them recent messages the same way. A `told` record is kept only for listeners in `full` or `heard`. A 2.0.0 server reads an object entry as a name nobody has, so that person counts as absent: the safe direction (nothing leaks), but they learn nothing either.
- Placement gives modes and arrivals: someone who arrives or leaves mid-scene is placed only for the messages they were there for (before, they were placed for the whole scene and learned what was said before they came in), and someone in the next room, on the phone, outside a whisper or asleep gets that mode. `placed` carries the modes back. An answer in the old shape (`present`: names) is still read, as everyone in full for the whole scene. `place: true` places a one-on-one chat too.
- The check issue type `misattribution`: naming a source the character's brain doesn't give, or speaking as an eyewitness of hearsay. A client that parses `type` strictly should expect it.
- Brain file fields, all optional (the format stays `kiori: 1`, and a 2.0.0 brain loads unchanged): `source`, `confidence`, `told_to`, `lie`, `said`, `truth`, `truth_ref` and `audience` on memories; the kinds `told`, `lore` and `event`; `role` and `groups` on a brain. `lie`, `truth`, `audience`, `role`, `groups`, `lore` and `event` are kept but not used yet. A 2.0.0 server reads such a brain but drops the new fields (and reads `told`, `lore` and `event` as plain memories), so keep self-hosted servers on this version or newer once brains carry them.
- The beta terms and the privacy policy, at `/terms` and `/privacy` on the site and the server (`legal/`, with the facts they depend on in `src/legal.mjs`). They're linked from the site, the console, the docs and the READMEs. Neither has been reviewed by a lawyer yet.

### Changed

- Access is self-serve. A valid request from the form on kiori.io makes the project at once, on the customer's own brain API key, and the answer carries its one-time sign-in link, which the page shows. The same email again gets a new link to that project while nobody has signed in to it yet, and `409` once someone has. Requests left waiting from before are still approved in the console. The beta is now called a free beta rather than a private one.
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
