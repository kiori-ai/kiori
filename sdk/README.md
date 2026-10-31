# Kiori for JavaScript and Python

**Brains for characters.** Kiori gives every character in your app a mind of its own: a past, a personality, people they love and resent, memories that fade or stay, and a strict sense of what they could possibly know.

These are Kiori's official clients. Each is one file with no dependencies.

| | Install | Import |
|---|---|---|
| JavaScript: Node 18+ and browsers, types included | `npm install kiori` | `import { Kiori } from 'kiori'` |
| Python 3.8+ | `pip install kiori-ai` | `from kiori import Kiori` |

On PyPI the package is called **kiori-ai**, because the name `kiori` there belongs to an unrelated project. The module you import is still `kiori`. Don't install that other `kiori` package in the same environment: its `kiori` package would hide this module, and `from kiori import Kiori` would fail.

If you don't use a package manager, copy the single file instead: [kiori.mjs](https://kiori.io/sdk/kiori.mjs) with its types [kiori.d.ts](https://kiori.io/sdk/kiori.d.ts), or [kiori.py](https://kiori.io/sdk/kiori.py).

## How it works

Kiori stores no brains and no chats. A brain is a JSON object you keep, in your database or on your player's device. You send it with each call, and calls that change it give it back.

- **create**: once per character, a brain from its card. Keep it as the character's template, and start each new conversation from a copy.
- **recall**: every turn, what the character knows right now, as a ready-to-use block for your prompt.
- **organize**: after each reply, the brain learns from the chat. Keep the brain that comes back.
- **check** (optional): the auditor reads your model's draft against what the character really knows, and fixes leaks, contradictions and invented pasts.

## Before you start

1. Get access on [kiori.io](https://kiori.io/#access): the page gives you a sign-in link that opens the console.
2. In the console, paste your **brain API key** (OpenRouter, OpenAI or Gemini) and create a **Kiori key** for your app. Kiori builds and updates brains on your brain API key, and you pay your provider directly.
3. Keep the Kiori key on your server, for example in `KIORI_API_KEY`.

## Quickstart: JavaScript

```js
import { Kiori } from 'kiori';

const kiori = new Kiori({ apiKey: process.env.KIORI_API_KEY });

// Once per character: a brain from its card (a Tavern/SillyTavern card, or name and description)
let brain = await kiori.create({ character_card: card });

// Every turn: what the character knows right now, for your prompt (the recent messages are enough)
const recent = messages.slice(-60);
const { text, check_recommended } = await kiori.recall({ brain, messages: recent });
let reply = await yourModel({ system: `${yourCharacterPrompt}\n\n${text}`, messages });

// Optional: when the player brings up the past, check the draft before it's shown
if (check_recommended) reply = (await kiori.check({ brain, messages: recent, draft: reply })).fixed;

// After the reply: the brain learns from the chat. Keep the brain that comes back
messages.push({ role: 'assistant', content: reply });
({ brain } = await kiori.organize({ brain, messages: messages.slice(-60) }));
```

The package is ESM only. From CommonJS, load it with `const { Kiori } = await import('kiori')`.

The client also runs in a browser, since all it needs is `fetch`. But a Kiori key inside a public web page is a key anyone can take: call Kiori from your server, or use a key that belongs to the person using the page, the way the SillyTavern extension does.

## Quickstart: Python

```python
import os
from kiori import Kiori

kiori = Kiori(os.environ["KIORI_API_KEY"])

# Once per character: a brain from its card (a dict, or a card PNG in base64)
brain = kiori.create(character_card=card)

# Every turn: what the character knows right now, for your prompt (the recent messages are enough)
recent = messages[-60:]
context = kiori.recall(brain=brain, messages=recent)
reply = your_model(system=your_character_prompt + "\n\n" + context["text"], messages=messages)

# Optional: when the player brings up the past, check the draft before it's shown
if context["check_recommended"]:
    reply = kiori.check(draft=reply, brain=brain, messages=recent)["fixed"]

# After the reply: the brain learns from the chat. Keep the brain that comes back
messages.append({"role": "assistant", "content": reply})
brain = kiori.organize(brain=brain, messages=messages[-60:])["brain"]
```

The Python calls take keyword arguments named like the API's fields, and return plain dicts.

## Messages

Messages are OpenAI-style: `{ "id": "m41", "role": "user", "content": "..." }`, oldest first. For `organize`, send the conversation's recent messages as they are now (the last 60 is a good amount: at least the last 30, not only the new ones, and at most 400), with your own message ids if you have them, so that edits and rerolls are noticed and unlearned. Always keep the brain that comes back, even when nothing was learned.

## Group chats

Send every character's brain at once: `brains` instead of `brain`. Answers come back in the same order, and each brain learns only the scenes its character was in. Messages from characters carry their name: `{ role: "assistant", name: "Rook", content: "..." }`.

```js
[mira, rook] = (await kiori.organize({ brains: [mira, rook], messages, player: 'Leo' })).brains;
```

```python
mira, rook = kiori.organize(brains=[mira, rook], messages=messages, player="Leo")["brains"]
```

## All calls

| JavaScript | Python | |
|---|---|---|
| `create({...})` | `create(...)` | a new brain: from `character_card`, or from `name`, `description` and `lore`. `depth: "full"` (default; a whole past, about a minute, on your brain API key) or `"light"` (from the card alone, free, at once) |
| `recall({...})` | `recall(...)` | what each character knows right now: `text` (one brain), `characters`, `check_recommended` |
| `organize({...})` | `organize(...)` | the brain learns from the chat: `brain` (or `brains`), `learned`, `rewound`, `waiting` |
| `check({...})` | `check(draft, ...)` | a draft reply checked against what each character knows: `ok`, `issues`, `fixed` |
| `exportObsidian(brain)` | `export_obsidian(brain)` | the brain as an Obsidian vault, as zip bytes |
| `personality()` | `personality()` | the 41 personality dimensions and the archetypes |
| `project.get()`, `project.update({...})`, `project.models()`, `project.usage(days)` | `project.get()`, `project.update(...)`, `project.models()`, `project.usage(days)` | your project, its brain API key and model, its usage |
| `project.keys.create(label)`, `project.keys.revoke(prefix)` | `project.create_key(label)`, `project.revoke_key(prefix)` | Kiori keys |

Changing the project (`project.update`, and making or revoking keys) takes an owner key: the one the console makes when you sign in with your link. The keys you make for your app can do everything else, so a key that leaks from your app can't move the project's calls elsewhere or take your keys away.

## Options

| JavaScript | Python | Default | |
|---|---|---|---|
| `apiKey` | `api_key` (the first argument) | | your Kiori key |
| `baseUrl` | `base_url` | `https://api.kiori.io` | another Kiori, for example one you host yourself |
| `timeout` | `timeout` | 150000 ms in JavaScript, 150 s in Python | per request; building a full brain takes about a minute |
| `maxRetries` | `max_retries` | `2` | see Retries; `0` turns them off |

## Retries

Every brain call is safe to repeat, since Kiori keeps nothing between calls. So both clients ask again on their own, twice at most, when Kiori or your model provider is briefly unavailable or out of reach (408, 429, 502, 503 and the like, or a network error): after `Retry-After` when Kiori sends one (up to 20 s), else after about 1 s, then 2 s.

They don't ask again after a timeout (a full brain may still be building), for a missing or refused brain API key, when your provider is out of credits, or when the model's answers stayed unusable after Kiori's own tries (`INCOMPLETE`). Nor when Kiori asks to wait longer than 20 s: the error then carries the wait as `retryAfter` (JavaScript) or `retry_after` (Python).

`maxRetries` (JavaScript) or `max_retries` (Python) changes how many times; `0` turns retries off:

```js
const kiori = new Kiori({ apiKey: process.env.KIORI_API_KEY, maxRetries: 0 });
```

```python
kiori = Kiori(os.environ["KIORI_API_KEY"], max_retries=0)
```

## Errors

A failed call raises `KioriError` (`import { KioriError } from 'kiori'`, `from kiori import KioriError`), with:

- `status`: the HTTP status, or `0` when Kiori couldn't be reached (code `NETWORK`) or didn't answer in time (code `TIMEOUT`)
- `code`: for example `UNAUTHORIZED` (a wrong Kiori key), `NEEDS_KEY`, `BAD_KEY` and `CREDITS` (your brain API key is missing, refused, or out of credits), `RATE_LIMITED`, `PROVIDER`, `BAD_BRAIN`, and `REDIRECT` (the address answered with a redirect, which Kiori never sends: the clients don't follow one, so your key and brains don't go where it leads; check the base URL)
- `retryAfter` (JavaScript) or `retry_after` (Python): the seconds Kiori asked to wait, when it did
- `requestId` (JavaScript) or `request_id` (Python): the call's id, to quote when you write to us about it

A failed organize changes nothing: keep the brain you had, and the next call picks up where it left off. All the codes are in the [error table](https://kiori.io/docs/api#errors).

## Learn more

- [Integration guide](https://kiori.io/docs/integration): the calls, keeping brains, group chats, the drop-in, SillyTavern
- [Concepts](https://kiori.io/docs/concepts): the brain file, presence, organizer, auditor, sleep
- [API reference](https://kiori.io/docs/api), and [openapi.json](https://kiori.io/openapi.json) to generate a client in another language
- [kiori.io](https://kiori.io)
- [Beta terms](https://kiori.io/terms) and [privacy policy](https://kiori.io/privacy)

## License

MIT. The full text is in the LICENSE file that comes with the package. The license covers these client files, not the Kiori service.
