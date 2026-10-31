# The who-knows-what benchmark

Does each character know only what they could know? This benchmark plays scripted stories through a chat model, with and without Kiori, and scores every line and every answer against a ground truth that is computed, not judged: who was there, in which mode, who told whom.

Everything runs on fakes by default and spends nothing. A real run spends money, and the owner approves it first.

```sh
node bench/run.mjs --scenario 1 --arm kiori --fake        # one scenario, a local Kiori on a fake provider
node bench/run.mjs --season --arm no-kiori                 # all eleven, as one story of 754 messages
node bench/run.mjs --help
node --test test/bench.test.mjs                            # the benchmark's own tests (also part of npm test)
```

A run prints its metrics and where its replay went (`bench/results/`, which git ignores; keep a run with `git add -f`).

## What's here

| | |
|---|---|
| `engine.mjs` | The ground truth: who knows what, from the spine and the free lines, by perception mode. Pure functions. |
| `scorer.mjs` | The metrics, deterministic first, with a judge hook for the cases that need one. |
| `run.mjs` | The runner: arms, models, the local server, the cost estimate, the replay. |
| `replay.mjs` | The replay file: building it, writing it, validating it against the schema below. |
| `fake.mjs` | The fake model provider behind the local Kiori, and the fake chat models. |
| `scenarios/` | The eleven scenarios, the cast, and their schema ([scenarios/README.md](scenarios/README.md)). |

## How a run goes

The story is played message by message. Spine messages (narration, the player, the scripted lines that tell, lie, whisper or announce) are fixed. Free turns are written by the chat model under test. Each free turn:

1. **recall** for the speaker (Kiori arms), with the last six messages as the moment;
2. **the chat model**, with one prompt template for every arm: the rules, who the speaker is, `WHAT <SPEAKER> KNOWS:` (the recall block, or a note that the story below is all they have), and `THE STORY SO FAR:` (the arm's window);
3. **check** (Kiori arms), whose fix is what enters the story;
4. **organize** every 12 messages (Kiori arms; Kiori's own `every` 12 and `hold` 4), with the story's characters and the walk-ons around lately, at most 12 brains a call.

Probes are asked on a fork: recall, the chat model and check run as for a free turn, with the question as the last message, and the answer never enters the story. A checkpoint is taken after every probe round and every organize.

The ground-truth engine scans every free line as shown: a canary said by someone who holds that fact spreads to whoever heard it; said by someone who doesn't, it is a leak (and the hearers now know it too: the story contains it). So the truth follows the live story, and probes are scored against the truth at that moment, not against what the script expected.

### Arms

| Arm | Mind | Story window | Presence sent to Kiori |
|---|---|---|---|
| `kiori` | recall block | last 20 messages | none: Kiori places people itself |
| `kiori-given-presence` | recall block | last 20 messages | the spine's, on every message |
| `no-kiori` | none | last 150 messages | (no Kiori) |
| `oracle-filter` | none | last 150 messages the speaker perceived, as they perceived them | (no Kiori) |

The brain model is the same in every Kiori arm, so arms compare Kiori, not models. `oracle-filter` is the honest upper bound of "just filter the transcript": where Kiori beats it, the value is long-range memory rather than filtering.

**Presence and today's server.** Kiori 2.0.0 reads `present` as names only: a `{ name, mode }` entry becomes a name nobody has, so that person counts as absent. The runner therefore sends names (`--present-as hearers`, the default: those in `full` or `heard` mode, which is what 2.0.0 makes of modes anyway). `--present-as room` sends everyone awake in the room, as an app without modes would, which shows the whisper leak. `--present-as modes` (or `--send-modes`) sends `{ name, mode }` objects, for a server that reads them; it stays off until one does. The modes always stay in the ground truth.

## The ground truth

`K[person][fact] = { state, via, origin, at }`, with `state` one of `knows`, `believes_lie`, `half` (only some parts) or `none`. Each spine message applies by mode:

| Mode | Narration | Speech |
|---|---|---|
| `full` | sees | hears |
| `heard` (radio, blindfold) | no | hears |
| `overheard` (through a wall) | no | only the parts the line's `half` names |
| `saw` (a whisper, behind glass) | sees | no |
| `asleep` | no | no |

- `via` is the first hop: who they heard it from (none when they saw it, own it, or it's talk going around). `origin` is whom the teller said it came from.
- A false fact (`lie_of`) is believed unless they know the truth, wholly or in part; learning the truth later exposes it (`knows`, with `exposed`).
- The speaker of a line keeps a `told` record of who heard it; a liar's lists who they lied to.
- An announcement (`public`) reaches each group when `world_time` gets to its step; it's dated at the message it arrived with.
- A forgetting sets `none` with `forgot`.

## Metrics

| Metric | Definition | Scored by |
|---|---|---|
| **Leak rate** | Free lines and probe answers giving away a fact the speaker can't know at that point ÷ the lines and answers where someone else knew a fact they didn't. Also before the check (`leak_rate_drafts`) and how many the check caught. | Canary match; a judge for topic words without the canary |
| **False-ignorance rate** | Probe facts the target holds whose answer lacks every canary (or denies knowing) ÷ such facts | Canary match; a judge when the answer has the canary and a denial |
| **Attribution accuracy** | Probes asking how they know, whose answer names the true first hop (and origin, when asked) ÷ such probes | Name match (`mentions`); a judge when other names appear |
| **Lie consistency** | Liar → victim probes that keep the lie canary and show no truth canary, and believer probes that hold the lie ÷ such probes; lie slips in free lines counted apart | Canary match |
| **Gossip propagation F1** | Over (character, fact, holds?, via) for every probe fact, against the truth | From probe results |
| **Half-heard vagueness** | Half-known probe facts answered with a part they have and no more ÷ such facts | Part canaries |
| **Cost and latency** | Kiori's spend (from `/v1/usage`), the chat model's and the judge's (from the provider), and a list-price estimate from tokens; average ms per call kind and per free turn; per scenario, with cast size and brains per organize | Counted |

Without `--judge-model`, the judge cases are decided the deterministic way and counted as `undecided`.

## Cost

Unit costs from `docs/concepts.md` (Haiku 5.5). Every run prints its estimate first, fake runs included (as what the same run would cost on real models).

| Line | Per | Unit |
|---|---|---|
| Placement (`kiori` arm only) | 12 messages | $0.002 |
| Learning | present brain per 12 messages | $0.002 |
| Recall | call | $0.00001 |
| Check | call | $0.001 |
| Sleep | message | $0.00002 |
| Chat model | call: 8k in / 0.3k out with Kiori, 4k in without, at `--chat-price` (Haiku: $0.10 / $0.50 per million) | $0.00095 / $0.00055 |
| Judge | about half the probes | $0.0005 |

For the season (754 messages, 334 free turns, 106 probes) with Haiku 5.5 as chat and brain model and a judge: about **$1.51** for `kiori`, **$1.38** for `kiori-given-presence`, **$0.27** for `no-kiori` and `oracle-filter`. The measured averages run 20-30% under these units.

### A real run

Real runs need `--spend`, and the owner's approval before anyone adds it. Without it the runner prints the estimate, says what it would have called, and exits with code 2 having called nothing. Keys come from the environment only:

| Variable | |
|---|---|
| `KIORI_BENCH_CHAT_KEY`, `KIORI_BENCH_CHAT_URL` | The chat model's provider key, and its OpenAI-compatible address (default OpenRouter) |
| `KIORI_BENCH_BRAIN_KEY`, `KIORI_BENCH_BRAIN_URL` | The brain API key for the local Kiori the runner boots (its provider is recognized from the key) |
| `KIORI_BENCH_JUDGE_KEY`, `KIORI_BENCH_JUDGE_URL` | The judge's (default: the chat model's) |
| `KIORI_BENCH_KIORI_KEY` | A Kiori key, with `--server` |

A run stops when it has spent `--cap` dollars (default twice the estimate) and writes what it has. The local server runs in the runner's own process on a throwaway data folder, with its own model address set to a dead one, so only the key given here can reach a provider.

```sh
# The baseline on today's code: Haiku 5.5 for chat and brains, a judge of another family, both main arms
node bench/run.mjs --season --arm kiori    --chat-model anthropic/claude-haiku-5.5 --brain-model anthropic/claude-haiku-5.5 --judge-model deepseek/deepseek-v4.1-flash --spend
node bench/run.mjs --season --arm no-kiori --chat-model anthropic/claude-haiku-5.5 --judge-model deepseek/deepseek-v4.1-flash --spend
```

## The replay file (`"replay": 1`)

Every run writes `bench/results/<date>-<arm>-<chat model>[-<scenarios>].replay.json` (no suffix for the season). It is the playground's input, so its schema is fixed: a change a reader would notice bumps `replay`. The file is JSON with one line per entry. Texts are written once and referred to by message number; recall blocks are pooled; memories are a table by id.

```jsonc
{
  "replay": 1,
  "run": { "date", "started", "finished", "arm", "chat_model", "brain_model", "judge_model", "scope", "server", "kiori",
           "options": { "window", "history", "every", "hold", "check", "present_as" }, "estimate_usd", "errors": [], "stopped"? },
  "player": "Leo",
  "people": { "Mira": { "role": "character" | "npc" | "player", "groups": ["light"] } },
  "facts": { "s3:crate": { "truth", "canaries": [], "parts"?: { "where": ["ice-house"] }, "lie_of"? } },
  "scenarios": [ { "id": "s3", "title", "from": 1, "to": 63 } ],
  "messages": [ { "n": 1, "who": "STORY" | name, "text": "as shown", "present": { "Tom": "full", "Rook": "saw" }, "spine": true, "scene"?: "when it changes" } ],
  "turns": [ { "n": 12, "draft"?: "before the check, when it changed", "issues": [check issues], "leaks": [fact ids], "draft_leaks"?, "slips"?, "spread"?: [{ "name", "fact" }] } ],
  "probes": [ { "id": "s3-p1", "at": 21, "scenario", "target", "asker", "ask", "facts": [ids], "answer", "draft"?, "issues"?,
                "held": { "block": 7, "memories": [["m_x", 0.71]] } | null,
                "score": { "leaks": [], "facts": { "s3:alibi": { "truth", "said": "full" | "parts" | "none", "ignorant"?, "vague"? } },
                           "attribution"?: { "expected", "named", "ok" }, "lie"?: { "fact", "role", "ok" }, "judged": [], "undecided": [] } } ],
  "organize": [ { "at": 24, "sent": [names], "learned": [Kiori's learned[]], "rewound", "waiting", "warnings"? } ],
  "blocks": [ "a recall text block" ],
  "memories": { "m_x": { "kind", "title", "from"?, "to"?, "source"?, "confidence"?, "strength"? } },
  "checkpoints": [ { "at": 24, "kind": ["organize"] | ["probes"] | ["organize", "probes"] | ["end"],
                     "truth": { "Rook": { "s3:crate": ["half", null, null, 2, ["where"]], "s3:alibi": ["knows", "Tom", null, 15] } },
                     "held": { "Rook": { "block": 3, "memories": [["m_y", 0.52]] } } | null,
                     "cost": { "kiori_usd", "chat_usd", "judge_usd", "estimated_usd" }, "latency_ms": { "recall", "chat", "check", "organize" } } ],
  "metrics": { the metrics above, "cost", "latency_ms", "scale": { "s11": { "messages", "cast", "usd_per_message", "estimated_usd_per_message", "brains_per_organize" } }, "by_scenario": { … } }
}
```

- `truth` lists only what someone holds, as `[state, via, origin, at]`, plus the parts when `half`. Costs and latencies are cumulative.
- `held` is what Kiori actually had: at an organize, for the brains that learned; at a probe, the block the answer was written from; at the end, the main cast. Memory bodies are in the block they came back in, not repeated in `memories`.
- `memories[].source` and `confidence` appear once Kiori writes them (today's 2.0.0 doesn't).
- `validateReplay` in `replay.mjs` checks all of this; the runner refuses to write a replay that fails it.

## Fakes and tests

- **The fake provider** behind the local Kiori: the organizer writes one memory per line it was shown, quoting it; placement starts a scene at each line of narration that opens a place or time and puts everyone who speaks or is named in it there for all of it (the coarse placement the late-arrival scenario measures); the auditor flags a name or number in a character's line that others' blocks or the recent messages hold and theirs doesn't. Token counts are about the size of the text, so a fake run's list-price estimate is realistic.
- **Fake chat models**: `fake/parrot` (default) answers with the sentences of its prompt that best match the question or stage direction; `fake/oracle` answers from the ground truth (it scores no leaks and full attribution); `fake/leaky` answers from the whole transcript (it gets caught).
- `test/bench.test.mjs` runs the engine on every scenario (hand-checked final tables for scenarios 1-6 and 9), the scorer with the oracle and the leaky model, a judge stub, the runner end to end on scenario 1 against the fake provider (its replay validated), and the `--spend` refusal.

## Known gaps

- The season is 754 messages, not the 1000 the plan had in mind: eleven scenarios of 60-128 messages each.
- Talk going around by `world_time` (scenario 7, and the crier in 11) has no counterpart in Kiori 2.0.0, so the Kiori arms are expected to score false ignorance there until the world brain exists.
- Kiori 2.0.0 drops `{ name, mode }` in `present`, so the given-presence arm sends names only (see above).
- The drop-in endpoint is not part of a run yet; a smoke run through it is planned with the real runs.
