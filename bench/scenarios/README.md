# Scenarios

Eleven short stories set in Saltmere, a fishing town with a lighthouse, a tavern called the Drowned Bell, and a wreck nobody talks about. Each one tests one way knowledge moves, or doesn't, between people. Played back to back they make one season of 754 messages.

| # | File | Tests | Messages | Free | Probes |
|---|---|---|---|---|---|
| 1 | `01-closed-room.json` | A secret told behind a bolted hatch (isolation baseline) | 67 | 28 | 10 |
| 2 | `02-gossip-chain.json` | Mira → Tom → Ines → Rook, with a garbled last hop | 64 | 28 | 8 |
| 3 | `03-cover-story.json` | Tom's lie; Rook saw part of the truth | 63 | 24 | 9 |
| 4 | `04-through-the-wall.json` | An address half heard through a wall | 61 | 24 | 7 |
| 5 | `05-whisper.json` | Two whispers at a full table | 60 | 29 | 10 |
| 6 | `06-late-arrival.json` | Someone walks in mid-scene (today's leak path) | 60 | 27 | 9 |
| 7 | `07-announcement.json` | A notice read in the square, spreading by `world_time` | 63 | 28 | 11 |
| 8 | `08-false-belief.json` | A wrong story corrected in front of some, not others | 62 | 29 | 9 |
| 9 | `09-asleep.json` | Asleep in the room, and listening on the radio | 64 | 29 | 8 |
| 10 | `10-forgetting.json` | A blow to the head takes an evening away | 62 | 28 | 6 |
| 11 | `11-scale.json` | The Lantern Fair: 40 walk-on brains, 2-6 per scene | 128 | 60 | 19 |

The cast is in `cast.json`: Mira (keeper of the light), Tom (her brother), Ines (landlady of the Bell), Rook (net-mender and watchman), the player Leo, and forty townspeople for scenario 11. Every person has a `who`, a `voice` and `groups` (which talk reaches them; see `public` below).

## A scenario file

```json
{
  "id": "s3", "title": "Tom's cover story", "summary": "…", "player": "Leo",
  "cast": ["Mira", "Tom", "Ines", "Rook"],
  "npcs": [],
  "facts": {
    "crate": { "truth": "Tom hid a crate of Velloran brandy under the sawdust in the old ice-house.",
               "canaries": ["Velloran", "under the sawdust"], "parts": { "where": ["ice-house"] }, "known_by": ["Tom"] },
    "alibi": { "truth": "(false) Tom says he spent the night at Old Hennick's.", "canaries": ["Hennick"], "lie_of": "crate" }
  },
  "spine": [
    { "scene": "The end of the quay, past midnight", "present": ["Tom", { "name": "Rook", "mode": "saw" }], "world_time": 3 },
    { "who": "STORY", "text": "…Tom Voss, hauling a crate… into the old ice-house…", "carries": ["crate.where"] },
    { "who": "Tom", "text": "I was at Old Hennick's all night…", "lie": { "fact": "alibi", "to": ["Ines", "Leo"] } },
    { "free": ["Ines", "Tom"], "hint": "Ines teases Tom about his night; Tom embroiders his story." },
    { "probe": { "target": "Ines", "ask": "Ines, where was Tom last night?", "expect": { "believes": ["alibi"], "via": "Tom" } } }
  ]
}
```

### Facts

| Field | |
|---|---|
| `truth` | The fact in one sentence. A false one starts with "(false)". |
| `canaries` | Unique, unguessable words that only this fact produces ("Velloran", "19 Ropewalk"). Saying one is knowing the fact. |
| `parts` | Named pieces of the fact, each with its own canaries: what a half-heard or half-seen version can hold (the street, not the house number). |
| `lie_of` | This fact is false, and denies that one. Hearing it means believing it, unless you know the truth (even part of it). |
| `known_by`, `believed_by` | Who holds it from the start. |

Facts are namespaced by scenario when loaded (`s3:crate`), so the season can carry all of them at once.

### The spine

Entries are read in order. Messages are numbered across the whole story; a free turn is one numbered message per speaker, so every number is fixed before anything runs.

| Entry | |
|---|---|
| `{ "scene", "present", "world_time"? }` | A new scene: who is there, in which mode (a name alone is `full`). Not a message. |
| `{ "who", "text", … }` | A message. `who` is `STORY` (narration), the player, or a person. |
| `{ "free": [speakers], "hint"?, "present"? }` | Free turns: each speaker's line is written by the chat model under test. `hint` is a stage direction for it. |
| `{ "probe": { "target", "asker"?, "ask", "expect" } }` | A question asked on a fork of the story at this point; its answer never enters the story. `asker` is the player by default. |

On a message:

| Field | |
|---|---|
| `carries` | Facts (or `fact.part`) the message conveys: shown, for narration; said, for a person's line. |
| `says`, `shows` | The same, by channel, for a line that both speaks and shows something. |
| `lie` | `{ fact, to? }`: the speaker says a false fact knowingly, to these people. Kept in the liar's `told` record. |
| `origin` | The person the speaker says it came from ("Mira says…"). |
| `half` | `{ fact: [parts] }`: what someone who `overheard` the line caught. Nothing else gets through a wall. |
| `enter` | People who come in with this message (there for it). |
| `leave` | People who go after this message (there for it, gone after). |
| `modes` | Modes for this message only: a whisper is everyone but its listener in `saw`. |
| `becomes` | Modes from this message on: falling asleep, waking up. |
| `forgets` | `{ person: [facts] }`: they lose these, from here. |
| `public` | `{ spread: [{ after, groups }] }`: an announcement. Its facts reach everyone whose `groups` match a step once `world_time` reaches the message's time plus `after` (`"*"` is everyone). |
| `world_time` | Moves the story's clock (on a scene or a message). Units are the story's own (days, here). |

### Modes

| Mode | Narration | Speech |
|---|---|---|
| `full` | sees it | hears it |
| `heard` (on the radio, blindfolded) | no | hears it |
| `overheard` (through a wall) | no | only the parts in `half` |
| `saw` (a whisper, behind glass) | sees it | no |
| `asleep` | no | no |

### Expectations

`expect` says what the target should show, as written: `knows`, `not`, `believes` (a false fact), `half` (only parts), `lie` (keeps up this lie toward the asker), `via` (who told them), `origin` (who that one had it from). They describe the spine as scripted; a live run scores against the ground truth at that moment instead, because a free turn may have spread something on.

## Rules for writing one

`lint` in `bench/engine.mjs` checks all of these, and the tests run it on every scenario and on the season:

- Every canary in a spine line is declared on that line, and every declared fact's words are in its text.
- Probe questions and free-turn hints never contain a canary or a part.
- Every probe's expectation holds in the ground truth of the spine alone.
- A scenario has 60 to 150 messages.

And by hand: give each scene an opening line of narration that says where it is and who's there (a real model places people from that), narrate arrivals and departures, and keep canaries out of everyday speech (a part like "the chapel" would turn every churchgoer into a leak).
