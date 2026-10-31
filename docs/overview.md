# Kiori

**Brains for characters.** Kiori gives every character in your app a mind of its own: a past, a personality, people they love and resent, memories that fade or stay, and a strict sense of what they could possibly know.

Kiori is an API, and it stores no brains and no chats. A brain is a JSON file you keep, in your database or on your player's device. You send it with a call, and the calls that change it give it back:

```
your app ── a character card ─────────▶  Kiori  ── a new brain ─────────▶ you keep it
         ── brain + recent messages ──▶         ── what they know now ──▶ into your prompt
         ── brain + recent messages ──▶         ── the brain, learned ──▶ you keep it
```

## What you get

- **A real brain, not a prompt.** Every character starts from the Average Human Model (296 mechanisms of human psychology, 41 personality dimensions) and keeps only the 1% that is theirs: a past, the people in it, an inner life.
- **Who knows what.** In a group chat, each character learns only the scenes they were in. A secret stays with the people who heard it, and you don't write a single rule for it.
- **Memory that behaves like memory.** What matters to them stays; what doesn't fades, then shrinks to its gist. Plans are kept until they're done. A memory wipe is a memory wipe.
- **Nothing made up.** Kiori only writes what it can quote from the chat. No quote, no memory.
- **Your data stays yours.** Kiori keeps your account, your keys and counts of what you used, nothing else. Its model work runs on your own model provider key, which Kiori keeps sealed.
- **No black box.** A brain is readable JSON: every memory, with the line of the chat it came from.

## Quickstart

1. **Get access** on [kiori.io](https://kiori.io/#access). Your project is made right away, and the page gives you a sign-in link to the console; it works once, within 7 days.
2. **Add your brain API key.** In the console, paste an OpenRouter, OpenAI or Gemini key. Kiori recognizes the provider, checks the key and suggests a model. Kiori thinks with this key, and you pay your provider directly.
3. **Make a Kiori key** for your app, in the console. It's shown once.
4. **Call Kiori** from your server:

```js
// npm install kiori   (Python: pip install kiori-ai)
import { Kiori } from 'kiori';
const kiori = new Kiori({ apiKey: process.env.KIORI_API_KEY });

// Once per character: a brain from its card (a Tavern / SillyTavern card, or a name and a description)
let brain = await kiori.create({ character_card: card });

// Every turn: what the character knows right now, for your prompt (the recent messages are enough)
const { text } = await kiori.recall({ brain, messages: messages.slice(-60) });
const reply = await yourModel({ system: `${yourCharacterPrompt}\n\n${text}`, messages });

// After the reply: the brain learns from the chat. Keep the brain that comes back
({ brain } = await kiori.organize({ brain, messages: messages.slice(-60) }));
```

That's the whole loop. [Integration](integration.md) walks through it, with group chats and the drop-in.

## The calls

| Call | When | What it does |
|---|---|---|
| `POST /v1/brains` | once per character | Builds a brain from a card: a full one in about a minute, or a light one at once. |
| `POST /v1/brains/recall` | every turn | What each character knows right now, as a block for your prompt. Search, not generation. |
| `POST /v1/brains/organize` | after replies | The brains learn what happened. Edits, rerolls and deletions are handled. |
| `POST /v1/brains/check` | when it matters | A draft reply checked for leaks and invented pasts, and fixed. |
| `POST /v1/chat/completions` | instead of recall | OpenAI-compatible: Kiori puts the minds into your prompt and passes the request on to your model. |

## SDKs and tools

- **JavaScript**: `npm install kiori`, then `import { Kiori } from 'kiori'`. Node 18+ and browsers, no dependencies, types included. Or copy the single file: [`kiori.mjs`](https://kiori.io/sdk/kiori.mjs), with types in [`kiori.d.ts`](https://kiori.io/sdk/kiori.d.ts).
- **Python**: `pip install kiori-ai`, then `from kiori import Kiori`. Python 3.8+, no dependencies. Or copy the single file: [`kiori.py`](https://kiori.io/sdk/kiori.py).
- **SillyTavern**: the Kiori extension. In SillyTavern, open Extensions, then Install extension, and paste `https://github.com/kiori-ai/SillyTavern-Kiori`, or download the zip from your console. Each brain lives in the chat file on the player's computer.
- **Anything else**: plain HTTP, or a client generated from [`/openapi.json`](https://kiori.io/openapi.json).

Both SDKs try again on their own when Kiori or your model provider is briefly unavailable. Every call is safe to repeat, because Kiori keeps nothing between calls.

## Status

Kiori is in a **free beta**: free while the beta lasts, under the [beta terms](/terms) and the [privacy policy](/privacy). You bring your own model key and pay your provider directly; Kiori adds nothing on top. Questions, bugs or ideas: [help@kiori.io](mailto:help@kiori.io).

## Read on

- [Integration](integration.md): the calls, keeping brains, group chats, the drop-in, SillyTavern, going live.
- [Concepts](concepts.md): the brain file, memories, presence, the organizer and the auditor, costs.
- [API reference](api.md): every endpoint, field, error and limit.
- [Security](security.md): what Kiori keeps, and how your keys are protected.

## License

- **The SDKs and the SillyTavern extension** are MIT: use them anywhere, in commercial products too.
- **Kiori's server code** is under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/): free to read, run, change and share for any non-commercial purpose, such as a personal project, study, research, or a charity, school or public body. Running it for a commercial product or service needs a commercial license: write to [help@kiori.io](mailto:help@kiori.io).
- **Calling hosted Kiori** from your app, commercial or not, is using our service, and this license doesn't apply to it.

The name Kiori, the logo and the mascot artwork aren't licensed.
