# API reference

The base URL is `https://api.kiori.io`. Every call needs a Kiori key, `Authorization: Bearer kio_...`, except the ones marked open. Bodies are JSON. The machine-readable version is [`/openapi.json`](https://kiori.io/openapi.json): import it into Postman or Insomnia, or generate a client from it.

Kiori stores no brains and no chats. A **brain** is a JSON object (see [Concepts](concepts.md)) that you keep and send with each call; calls that change it give it back. Calls that take brains accept `brain` (one) or `brains` (a list, for a group chat, at most 12) and answer in the same shape.

Every answer carries an `X-Request-Id` header. Errors carry the same id as `request_id`; mention it when you write to us about a call.

## Brains

### POST /v1/brains

A new brain, for you to keep.

```json
{ "character_card": { "spec": "chara_card_v2", "data": { "name": "Mira", "description": "..." } }, "depth": "full" }
```

| Field | |
|---|---|
| `character_card` | A Tavern / SillyTavern card (v1, v2 or v3) as JSON, or a card PNG in base64. The card itself can also be the whole body. |
| `name`, `description`, `lore` | Instead of a card, or added to it. |
| `pronouns` | `she`, `he` or `they` (otherwise the organizer decides). |
| `personality`, `archetype` | Values (0 to 100) for some of the 41 dimensions, or an archetype to start from (`GET /v1/personality`). |
| `others` | The other characters of the world: names, or `{ "name", "who" }`. |
| `depth` | `full` (the default): a whole past, about a minute, on your brain API key. `light`: from the card alone, at once, free. |

Answer: `{ "brain": { ... } }`.

### POST /v1/brains/recall

What each character knows right now, for your prompt.

```json
{ "brain": { ... }, "messages": [{ "role": "user", "content": "Is the letter still in the logbook?" }], "player": "Leo" }
```

| Field | |
|---|---|
| `messages` | The chat, OpenAI-style; the last six are the moment. |
| `query` | Recall for this text instead. |
| `player` | The player's name. |
| `budget` | Characters of text per brain (6000 by default, 200 to 60000). |
| `limit` | Memories per brain (10 by default, at most 50). |

Answer: `{ "text", "characters": [{ "name", "text", "memories", "relations", "state", "facts", "forgot", "intentions", "mind" }], "check_recommended" }`. With one brain, `text` is the block for your prompt. The brains are only read.

### POST /v1/brains/organize

The brains learn from the chat.

```json
{ "brain": { ... }, "messages": [{ "id": "m1", "role": "user", "content": "..." }, { "id": "m2", "role": "assistant", "content": "..." }], "player": "Leo" }
```

| Field | |
|---|---|
| `messages` | The recent messages as they are now, oldest first: at least the last 30, at most 400. Your ids let edits and rerolls be noticed exactly; without ids, the words line them up. `role` is `user`, `assistant` or `narrator` (narration, in nobody's voice); `name` says who speaks; `present` who's there, when you know it. |
| `player` | The player's name (otherwise the `name` on their messages, or "Player"). |
| `hold` | The newest messages left for later (4 by default). |
| `every` | Learn once this many settled messages are new (12 by default). |
| `now` | `true`: learn whatever is settled now. |

Answer:

```json
{
  "brain": { ... },
  "learned": [{ "name": "Mira", "from": 1, "to": 16, "messages": 16, "written": 5, "dropped": { "memories": 1, "facts": 0, "intentions": 0, "forgot": 0 } }],
  "rewound": [],
  "waiting": 0,
  "held": 4
}
```

`rewound` lists the brains that unlearned what an edited, rerolled or deleted message taught (from which message, and how many memories went). `waiting` is how many settled messages wait for the next learning. `warnings` appears when something couldn't be done; the brains still come back with whatever did happen. Keep the brains that come back.

### POST /v1/brains/check

A draft reply, checked and fixed before it's shown.

```json
{ "brains": [{ ... }, { ... }], "messages": [ ... ], "draft": "Rook: I know about the letter." }
```

Answer: `{ "ok": false, "issues": [{ "character": "Rook", "type": "leak", "quote": "the letter", "why": "..." }], "fixed": "Rook: I know about something.", "checked": ["Rook"] }`. Issue types are `leak`, `contradiction`, `invented_past` and `unsupported`. When nothing is wrong, `fixed` is the draft itself. With one brain, that character is checked; in a group, whoever speaks in the draft (`Name: words` lines) or is named in it.

### POST /v1/brains/export

`{ "brain": { ... } }` gives back a zip: an Obsidian vault with a note per memory, the people and their links, the card and the profile.

## The drop-in

### POST /v1/chat/completions

An OpenAI-compatible chat completion, with `"kiori": { "brain": ... }` (or `"brains"`) in the body. Each character's mind is added to the system prompt (yours stays first), and the request goes on to your model: the `model` you name, at your brain API key's provider. Streaming works.

In `kiori`: `player`, `check` (`auto` by default, `true` or `false`) and `budget`. The `X-Kiori-Check` header on the answer says `ok`, `fixed`, `skipped` (no brain API key to check with, or no text to check, such as a tool call) or `failed`. A held reply still streams to a streaming client, tool calls and usage included. Nothing is kept.

Your provider's errors come back as they came, except a key it refuses or one out of credits: those are `402 BAD_KEY` and `402 CREDITS`, as everywhere else in the API, so a 401 always means the Kiori key.

To send the request to another provider, give both headers: `X-Kiori-Upstream-Url` (an https base address like `https://openrouter.ai/api/v1`, with no `?` or `#` part) and `X-Kiori-Upstream-Key`. The key goes to that address only. An address without a key is refused (`400`): the key Kiori keeps for you only ever goes to the provider it was saved for. A provider's redirect is never followed.

### GET /v1/models

Your provider's models, passed on (some chat apps list models before they talk). The same headers apply.

## Your project

| | |
|---|---|
| `GET /v1/project` | The project: its name, `llm` (your brain API key, as `{ "set", "provider", "key": "…abcd", "model" }`), and its Kiori keys (label, first characters, created, last used). |
| `PATCH /v1/project` | Needs an owner key (below). `{ "name" }` renames it. `{ "llm": { "key": "sk-or-..." } }` sets your brain API key: the provider is recognized from the key, the key is checked, and a model suggested. `{ "llm": { "model": "..." } }` changes the model; `{ "llm": null }` removes the key. With `base_url` and a key: another OpenAI-compatible provider, at an https base address on the public internet (no `?` or `#` part). |
| `GET /v1/project/models` | The models your brain API key can use: `picks` (a short list, recommended first), `models` (the rest), `current` and `suggested`. |
| `POST /v1/project/keys` | Needs an owner key. `{ "label" }` gives a new Kiori key for your app, shown only this once. |
| `DELETE /v1/project/keys/:prefix` | Needs an owner key. Revokes a key, by its first ten characters. |
| `GET /v1/usage?days=30` | Your calls per endpoint, and the model calls Kiori made on your key (what for, tokens, cost). Counts only, never content. |

**Owner keys.** The key the console makes when you sign in with your link is an owner key, and changing the project (`PATCH /v1/project`, making and revoking keys) takes one. The keys you make for your app can call everything else, so a key that leaks from your app can't move your project's calls to another address or take your keys away.

The brain API key is never shown back, only its provider and last four characters.

## Open endpoints

| | |
|---|---|
| `GET /v1/personality` | The 41 personality dimensions and the archetypes. |
| `POST /v1/access` | Asks for access: `{ "email", "name", "company", "use_case" }`. |
| `POST /v1/signin` | Trades a sign-in link's one-time token for a Kiori key: `{ "token": "kis_..." }` gives `{ "key", "project": { "id", "name" } }`. The console does this when a link opens. A used or expired token gives `401` `LINK_EXPIRED`. |
| `GET /health` | `{ "ok", "name", "version" }`. |

## Errors

Every error is `{ "error": { "message", "code", "request_id" } }`.

| Status | Codes | |
|---|---|---|
| 400 | `BAD_REQUEST`, `BAD_BRAIN`, `BAD_JSON` | Bad input. `BAD_BRAIN`: what was sent as a brain isn't one. `BAD_JSON`: the body isn't a JSON object. |
| 400 | `UNKNOWN_KEY`, `UNSUPPORTED_KEY`, `UNKNOWN_MODEL`, `BAD_KEY` | Setting your brain API key (`PATCH /v1/project`): a key Kiori can't tell the provider of, one it can't use, a model the key's provider doesn't list, or a key the provider refuses. |
| 401 | `UNAUTHORIZED`, `LINK_EXPIRED` | No key, a wrong or revoked one; or a sign-in link that was used or ran out. |
| 403 | `FORBIDDEN` | A key your app uses tried to change the project: that takes an owner key. |
| 402 | `NEEDS_KEY`, `BAD_KEY`, `CREDITS` | Your brain API key is missing, refused by your provider, or out of credits. |
| 404 | `NOT_FOUND` | No such endpoint. |
| 413 | `TOO_LARGE` | The body is over the limit. |
| 429 | `RATE_LIMITED` | Too many calls; `Retry-After` says when to try again. |
| 502 | `PROVIDER`, `INCOMPLETE` | Your model provider failed, after Kiori tried again. `INCOMPLETE`: the model's answers stayed unusable after Kiori's own tries (the SDKs don't ask again). |
| 504 | `PROVIDER` | The drop-in: your model provider didn't answer in time. |

## Limits

| | |
|---|---|
| Calls | 1200 a minute per project. |
| Model work at once | 64 calls that set the model to work (create, organize, check, the drop-in) running at once per project. One more gets `429` with `Retry-After: 5`. |
| Bodies | 24 MB for calls that carry brains, 12 MB for create (a card PNG fits), 1 MB for the rest. |
| Brains | At most 12 in one call; at most 3000 memories in one brain. |
| Wrong keys | Calls with a wrong key are limited per address. |

Kiori asks your model provider again (twice at most) when it's busy or briefly down, before answering `502`. Every call can be repeated safely, since Kiori keeps nothing between calls: after `408`, `429`, `502`, `503` or a network error, try again after `Retry-After` (or a second or two). The SDKs do this on their own. A timeout isn't worth repeating at once: a full brain may still be building.
