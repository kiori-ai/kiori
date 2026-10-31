# Integration

Kiori never writes your chat and never keeps it. Your app keeps the conversation, the model and the prompts; Kiori gives every character a brain, as a JSON file you keep. Three calls do everything: **create**, **recall** and **organize**, plus **check** when you want it.

## Before you start

1. **Get access** on [kiori.io](https://kiori.io/#access). Your project is made right away, and the page gives you a sign-in link that opens the console. Open it in the browser you'll use for the console: it works once, within 7 days. If it runs out before you open it, ask again with the same email for a new one; once you've signed in, write to [help@kiori.io](mailto:help@kiori.io) for another.
2. **Add your brain API key** in the console: an OpenRouter, OpenAI or Gemini key. Kiori recognizes the provider from the key, checks that it works, and suggests a model you can change. Kiori builds and updates brains with this key, and you pay your provider directly.
3. **Make a Kiori key** for your app. It's shown once; Kiori keeps only a hash of it.

The API is at `https://api.kiori.io`. Every call carries your Kiori key: `Authorization: Bearer kio_...`.

The clients are `kiori` on npm (Node 18+) and `kiori-ai` on PyPI (Python 3.8+). Without a package manager, copy the single file instead: [kiori.mjs](https://kiori.io/sdk/kiori.mjs) or [kiori.py](https://kiori.io/sdk/kiori.py).

```js
// npm install kiori
import { Kiori } from 'kiori';
const kiori = new Kiori({ apiKey: process.env.KIORI_API_KEY });
```

```python
# pip install kiori-ai
import os
from kiori import Kiori
kiori = Kiori(os.environ["KIORI_API_KEY"])
```

## Keeping brains

A brain is one character in one conversation. Keep it wherever you keep that conversation:

- **In your database**: one JSON column per character per conversation. A brain is tens of kilobytes, and stays under a few hundred however long the chat runs.
- **On your player's device**: a local app or a frontend can keep it next to the chat itself. That's how the SillyTavern extension works.

Build a character's brain once and keep it as a template. Each new conversation starts from a copy, so conversations never mix: what Leo told Mira in one chat isn't in the brain of another.

## 1. Create, once per character

```js
const template = await kiori.create({ character_card: card });   // or { name, description, lore }
```

- `character_card`: a Tavern / SillyTavern card (v1, v2 or v3) as JSON, or a card PNG in base64. Its scenario, first message and example dialogue stay on the brain's card; its lorebook becomes the world's canon.
- `depth: "full"` (the default) writes a whole past from the card: memories, people, places, beliefs, secrets, habits, and how a few human mechanisms work in them. About a minute, and around a cent on your key.
- `depth: "light"` makes the brain from the card alone, at once and for free. The conversation teaches it the rest. Good for platforms where players make thousands of characters a day.
- `others`: the other characters of the world (`["Rook", { "name": "Ines", "who": "a harbor trader" }]`), so the brain knows who they are.

## 2. Recall, every turn

```js
const { text, check_recommended } = await kiori.recall({ brain, messages, player: user.name });
const system = `${yourCharacterPrompt}\n\n${text}`;
```

`text` is a ready-to-use block: how they differ from an average person, their mood and plans, the people in their life, what they know for sure, their story so far, the memories this moment brings up, and ground rules about what they can't know. The same data comes as JSON in `characters[0]`.

Recall is search, not generation: one embedding call on your key, a fraction of a second, a tiny fraction of a cent. The brain isn't changed, so there's nothing to save.

`messages` are OpenAI-style (`{ id, role, content }`); the last six are the moment. `query` recalls for something else instead. `budget` caps the text (in characters, 6000 by default).

## 3. Organize, after each reply

```js
({ brain } = await kiori.organize({ brain, messages: chat.messages.slice(-40), player: user.name }));
await db.save(conversation.id, character.id, brain);
```

Send the conversation's recent messages **as they are now**, oldest first: at least the last 30, not only the new ones, ideally with your own message ids. Kiori lines them up with what the brain already learned (it keeps the fingerprints of the last messages it learned), then:

- **learns what's new and settled.** The newest 4 messages wait (`hold`), since they may still be rerolled, and learning waits until 12 settled messages are new (`every`). So calling organize after every reply costs nothing most of the time. `now: true` learns whatever is settled at once.
- **notices a learned message that was edited, rerolled or deleted**, takes back what it taught, and learns that stretch again.
- **keeps only what the chat proves**: every memory quotes the words it came from.

The answer says what happened: `learned` (for each brain: messages read, memories written, and how many the auditor dropped), `rewound`, and `waiting` (settled messages not learned yet). Always keep the brain that comes back, even when nothing was learned.

## 4. Check, when it matters

```js
if (check_recommended) reply = (await kiori.check({ brain, messages, draft: reply })).fixed;   // the draft itself when nothing was wrong
```

The auditor reads the draft against what the character really knows and fixes it with minimal edits: **leaks** (knowing what happened where they weren't, or someone else's secret), **contradictions** with their memories, **invented pasts** (going along with a shared history nobody can find) and **unsupported** claims. `check_recommended` is true when the player brings up the past, which is when models slip. A check costs about a tenth of a cent.

## Group chats

Send every character's brain at once: `brains: [mira, rook]` instead of `brain`. Answers come back in the same order.

- **Recall**: send the brains of the characters about to speak.
- **Organize**: send all of them. Kiori works out who was in each scene (one small model call for the new stretch), and each brain learns only the scenes it was in. Rook never learns what Mira told Leo while he was out on his boat. If you know who's there, send `present: ["Mira", "Leo"]` on a message and that's used as it is.
- Messages from characters carry their name: `{ role: "assistant", name: "Rook", content: "..." }`. The player's name comes from `player`, or from the `name` on their messages.

## The drop-in

If your app already talks to an OpenAI-compatible chat API, it can send the request through Kiori with the brains in the body. Kiori adds each character's mind to your system prompt and passes the request on to your model, on your brain API key. Streaming works.

```js
const ai = new OpenAI({ baseURL: 'https://api.kiori.io/v1', apiKey: process.env.KIORI_API_KEY });
const reply = await ai.chat.completions.create({
  model: 'your/chat-model', messages, stream: true,
  kiori: { brain },                    // or { brains: [...] }; player, check and budget go here too
});
```

- `kiori.check`: `auto` (the default: when the player brings up the past, the reply is held, checked and fixed before it's sent, even on a streaming request), `true` or `false`. The answer's `X-Kiori-Check` header says what happened.
- Your model's provider is your brain API key's. To use another one, send both `X-Kiori-Upstream-Url` and `X-Kiori-Upstream-Key`: that key goes to that address, and the key Kiori keeps for you stays out of it.
- Your provider's errors come back as they came, except a refused key or one out of credits: those are `402 BAD_KEY` and `402 CREDITS`, so a 401 always means the Kiori key.
- Nothing is kept: call `organize` afterwards so the brain learns.

## SillyTavern

In SillyTavern, open Extensions, then Install extension, and paste `https://github.com/kiori-ai/SillyTavern-Kiori`. Or download the zip from your console, unzip it into SillyTavern's `data/default-user/extensions` folder and reload SillyTavern. Paste your Kiori key in Extensions, Kiori, and chat as usual.

Each character gets a brain the first time you talk. It's kept in the chat file on your own computer (with a fresh copy on the character's card, so a new chat starts from it) and grows after every reply. In a group chat, each reply gets only the mind of the character speaking. Edits, swipes and deletions are handled.

## Errors and retries

Every error looks like `{ "error": { "message", "code", "request_id" } }`. The ones to handle:

| Status | Code | What to do |
|---|---|---|
| 400 | `BAD_REQUEST`, `BAD_BRAIN`, `BAD_JSON` | Fix the input. `BAD_BRAIN`: what was sent as a brain isn't one; send brains back as Kiori returned them. |
| 400 | `UNKNOWN_KEY`, `UNSUPPORTED_KEY`, `UNKNOWN_MODEL`, `BAD_KEY` | Setting your brain API key: the key or model can't be used. The message says why. |
| 401 | `UNAUTHORIZED` | The Kiori key is missing, wrong or revoked. |
| 402 | `NEEDS_KEY`, `BAD_KEY`, `CREDITS` | Your brain API key is missing, refused by your provider, or out of credits. Fix it in the console. |
| 429 | `RATE_LIMITED` | Slow down; try again after `Retry-After`. |
| 502 | `PROVIDER`, `INCOMPLETE` | Your model provider failed, even after Kiori tried again; try again shortly. `INCOMPLETE`: the model's answers stayed unusable; try another model if it keeps happening. |
| 504 | `PROVIDER` | The drop-in: your model provider didn't answer in time. |

A failed organize changes nothing: keep the brain you had, and the next call picks up where it left off.

Every call is safe to repeat. The SDKs try again on their own, twice at most, when Kiori or your model provider is briefly unavailable (`408`, `429`, `502`, `503`, or a network error): after `Retry-After` when there is one (up to 20 seconds), otherwise after about 1 second, then 2. They don't try again after a timeout (a full brain may still be building), a missing key, missing credits, `INCOMPLETE`, or a longer `Retry-After` (the error carries it as `retryAfter` / `retry_after`). Each error also carries the call's `requestId` / `request_id`. `maxRetries` (JavaScript) or `max_retries` (Python) changes how many times; `0` turns it off.

## Going live

- **Keep your Kiori key on your server.** Never ship it in an app or a web page other people use. In the browser, it's fine only when the person using the page owns the key, as with your own key in SillyTavern.
- **Give Kiori a provider key of its own,** with a spending limit set at your provider. Then a mistake, or a leaked Kiori key, can only spend so much.
- **Save the brain after every organize,** and start each new conversation from a copy of the template.
- **Handle 402s** by telling whoever runs the app: they mean the brain API key needs attention.
- **Mention the `request_id`** (or the `X-Request-Id` header) when you write to us about a call that went wrong.
