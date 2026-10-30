# Concepts

Kiori rests on a few ideas: the **brain file**, **memories**, **presence**, and the two minds that tend brains, the **organizer** and the **auditor**.

## The 99/1 brain

Most of what a person is, is shared: how emotions work, attachment, defense mechanisms, biases, humor, conflict. Kiori keeps this once, as the **Average Human Model**: 296 mechanisms in 12 regions, and 41 personality dimensions (the Big Five and beyond: attachment anxiety and avoidance, empathy, impulsivity, shame, need for control...). A brain keeps only what makes this character *them*.

## The brain file

A brain is one character in one conversation, as JSON. Kiori stores none: you keep it, send it with each call, and keep what comes back.

| Part | What it is |
|---|---|
| `card` | Who they are: looks, personality, voice, core, and from their card the description, lore, scenario, first message and examples. |
| `personality` | 41 values from 0 to 100. 50 is the average person; only the deviations go into prompts. |
| `memories` | `core` ones (their past before this conversation, written when the brain was built) and `chat` ones (learned in this conversation). |
| `relations` | How they feel about people: trust, closeness, respect, resentment and attraction, from 0 to 100, from their past and from this conversation. |
| `state` | Their mood, what's on their mind, what they want. |
| `chat` | Where learning stands: the last message learned, and the fingerprints of the last ones, so the next call can line the chat up and notice edits. |
| `embed` | Which embedding model made the memories' meaning fingerprints (each memory's `v`, 256 bytes). |

Build a character once, keep that brain as their template, and start each conversation from a copy, so conversations never mix. A brain stays small (tens of kilobytes, a few hundred at most) because sleep keeps it to what a mind holds.

Everything in a brain is readable and yours to edit. A memory you change is used as you wrote it: its old fingerprint is set aside (recall goes by its words meanwhile), and it gets a new one the next time the brain learns. Otherwise, send a brain back as Kiori returned it: one that isn't a brain is refused (`BAD_BRAIN`).

## Memories

Every memory has a **kind**, a **title**, a **body** in the character's own voice, **keys** (words that bring it to mind), **about** (the people in it), **importance**, **emotion** and **strength**.

- **Strength** decides how clearly it's recalled: clear, fading or faded. After each stretch of conversation, memories that don't matter to the character lose a little strength. Important or emotional ones hold.
- **Sleep** presses faded memories down to their gist (the meaning stays, the details go) and merges memories that say the same thing. When a brain grows past what a mind holds, its faintest conversation memories go; never its core, its facts or its plans.
- **Evidence**: every memory learned from a conversation carries the exact words it came from.
- Special kinds: `fact` (something they now know for sure), `intention` (a plan or a promise, kept until it's done or dropped) and `forgot` (something they were made to forget: nothing they say may show they still know it).

## Presence: who knows what

Presence is who was physically in the scene for each message, and it decides who knows what:

- In a one-on-one chat, every message happens in front of the character and the player.
- In a group chat, a message's `present` list is used as it is. Without one, the organizer reads the new stretch scene by scene: changes of place and time, someone described but not named, and the message that moves the story somewhere new belongs to the new scene.
- A character learns only from the messages they were present for. Someone who wasn't there doesn't know what was said, not even as a hint.

Names are matched strictly: a character's name or alias, or a shortened form that fits exactly one character ("Luc" for Luc Moreau). Two full names that share a word are two people, so Ana Moreau being there doesn't put her brother Luc there.

## The organizer

The organizer is the model that writes into brains, on your brain API key. It:

1. **builds** a brain from a card or a description: a sketch of the life, then the past and the inner life;
2. **places** people in scenes, in a group chat;
3. **learns**: for each character, from their scenes only, it writes their memories (in the first person), what they now know for sure, how their feelings toward people changed (trust rises slowly and falls fast), their new state, their plans, and anything they were made to forget. Their personality, and how much they care about someone, decide what matters to them.

## The auditor

The auditor is the model that checks, in three places:

- **When writing** (no model needed): everything the organizer wants to write must quote the chat. If the quote isn't really there, it isn't written.
- **Before a reply is shown** (`/v1/brains/check`): a draft is checked against what each speaking character really knows, for leaks, contradictions, invented pasts and unsupported claims, and fixed with minimal edits.
- **During sleep**: it presses faded memories down to their gist.

## Lining up a chat

Kiori keeps no chats, so each organize call sends the recent messages as they are. The brain remembers the fingerprints of the last 64 messages it learned (and your ids for them), and the call finds where they meet the messages sent: everything after that is new. When a message it learned was edited, rerolled or deleted, the learning that read it is taken back and done again from the messages sent. The newest few messages always wait, since they're the ones still being rerolled.

## Recall

`/v1/brains/recall` is search, not generation: no model writes anything. It scores the brain's memories by rare shared words, by meaning (the fingerprints), and by strength and importance, then brings up memories about the same people as the best hits. It returns a ready-to-use text block, and the same data as JSON.

## What it costs

Kiori's model work runs on your brain API key, so your provider bills it. Measured on the default model (Claude Haiku 5.5 through OpenRouter):

| Work | When | Cost on your key | Time |
|---|---|---|---|
| Create, full | once per character | about $0.01 | about a minute |
| Create, light | once per character | nothing | at once |
| Organize | per brain, every 12 to 24 new messages | about $0.002 | seconds |
| Placing people in scenes | group chats, per new stretch | about $0.002 | seconds |
| Recall | every turn | one embedding, about $0.00001 | a fraction of a second |
| Check | when you ask, per reply | about $0.001 | a few seconds |

During the beta, Kiori itself charges nothing.

## Limits

- Memories are written in English; chats can be in any language.
- A brain holds at most 3000 memories; sleep keeps it around 300 to 800.
- One call takes at most 12 brains.
