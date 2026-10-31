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
3. **check** (Kiori arms), whose fix is what enters the story: `--check always` (the default) runs the full check on every line; `auto` does what the drop-in's `auto` does (the pre-check, `check: "fast"`, on every line, and the full check when it has suspects or recall recommends a check); `fast` runs the pre-check alone, which never changes a line; `off` none. The runner keeps the pre-check's `suspects`, every issue with its `type` and `by` (`precheck` or `auditor`), and whether the line changed;
4. **organize** every 12 messages (Kiori arms; Kiori's own `every` 12 and `hold` 4), with the story's characters and the walk-ons around lately, at most 12 brains a call.

Probes are asked on a fork: recall, the chat model and check run as for a free turn, with the question as the last message, and the answer never enters the story. A checkpoint is taken after every probe round and every organize.

The ground-truth engine scans every free line as shown: a canary said by someone who holds that fact spreads to whoever heard it; said by someone who doesn't, it is a leak (and the hearers now know it too: the story contains it). So the truth follows the live story, and probes are scored against the truth at that moment, not against what the script expected.

### Arms

| Arm | Mind | Story window | Presence sent to Kiori |
|---|---|---|---|
| `kiori` | recall block | last 20 messages | none: Kiori places people itself |
| `kiori-given-presence` | recall block | last 20 messages | the spine's, on every message, as `{ name, mode }` |
| `no-kiori` | none | last 150 messages | (no Kiori) |
| `oracle-filter` | none | last 150 messages the speaker perceived, as they perceived them | (no Kiori) |

The brain model is the same in every Kiori arm, so arms compare Kiori, not models. `oracle-filter` is the honest upper bound of "just filter the transcript": where Kiori beats it, the value is long-range memory rather than filtering.

**Presence.** The given-presence arm sends the spine's presence as the API takes it: `{ name, mode }` objects, a plain name for `full` (`--present-as modes`, the default, or `--send-modes`). `--present-as hearers` sends only the names of those who hear (`full` or `heard`), and `--present-as room` everyone awake in the room, as an app without modes would, which shows the whisper leak. The modes always stay in the ground truth.

History: Kiori 2.0.0 read `present` as names only (a `{ name, mode }` entry became a name nobody has, so that person counted as absent), so the runner used to send `hearers`. The server reads modes since the partial-presence change (commit `cf4306a`, after 2.0.0, in the changelog's Unreleased section), and `modes` became the default then. A replay says which it sent in `run.options.present_as`.

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
| **Leak rate** | Free lines and probe answers giving away a fact the speaker can't know at that point ÷ the lines and answers where someone else knew a fact they didn't. Also before the check (`leak_rate_drafts`), and how many the check caught: `caught_by_precheck` when the pre-check found the leaked words itself (an issue `by: "precheck"`, or a `strong` suspect), else `caught_by_auditor` | Canary match; a judge for topic words without the canary |
| **False-ignorance rate** | Probe facts the target holds whose answer lacks every canary (or denies knowing) ÷ such facts | Canary match; a judge when the answer has the canary and a denial |
| **Attribution accuracy** | Probes asking how they know, whose answer names the true first hop (and origin, when asked) ÷ such probes | Name match (`mentions`); a judge when other names appear |
| **Lie consistency** | Liar → victim probes that keep the lie canary and show no truth canary, and believer probes that hold the lie ÷ such probes; the same for the drafts (`lie_consistency_drafts`). Lie slips in free lines counted apart (`lie_slips`, and `lie_slips_drafts` before the check); the check's `lie_slip` issues are counted too (`lie_slips_flagged`, and of those `lie_slips_flagged_real`: the draft did slip), and a liar probe whose answer the check called a slip says so (`lie.flagged`). The check's `lie` issues (a character lying on purpose, never fixed) are `lies_flagged` | Canary match |
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
| Check | call (`--check fast`: nothing; `auto` is priced as if the auditor ran every time) | $0.001 |
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

## The replay file (`"replay": 2`)

Every run writes `bench/results/<date>-<arm>-<chat model>[-<scenarios>].replay.json` (no suffix for the season). It is the playground's input, so its schema is fixed: a change a reader would notice bumps `replay`. The file is JSON with one line per entry. Texts are written once and referred to by message number; recall blocks are pooled; memories are a table by id.

```jsonc
{
  "replay": 2,
  "run": { "date", "started", "finished", "arm", "chat_model", "brain_model", "judge_model", "scope", "server", "kiori",
           "options": { "window", "history", "every", "hold", "check", "present_as" }, "estimate_usd", "errors": [], "stopped"? },
  "player": "Leo",
  "people": { "Mira": { "role": "character" | "npc" | "player", "groups": ["light"], "who": "Mira Voss, keeper of Saltmere Light…",
                        "voice": "Short, dry sentences…", "color": "#2f6f8f", "portrait": "img/cast/mira.jpg" } },
  "facts": { "s3:crate": { "label": "what Tom hid that night", "truth", "canaries": [], "parts"?: { "where": ["ice-house"] }, "lie_of"? } },
  "scenarios": [ { "id": "s3", "title", "from": 1, "to": 63 } ],
  "messages": [ { "n": 1, "who": "STORY" | name, "text": "as shown", "present": { "Tom": "full", "Rook": "saw" }, "spine": true, "scene"?: "when it changes" } ],
  "deltas": [ { "n": 31, "person": "Leo", "fact": "s3:alibi", "state": "knows", "via"?: "Tom", "origin"?, "parts"?: [], "exposed"?: true, "forgot"?: true, "leaked"?: true } ],
  "turns": [ { "n": 12, "draft"?: "before the check, when it changed", "changed": true, "block": 7 | null,
               "suspects"?: [the pre-check's suspects], "issues": [ { "character", "type", "quote", "why"?, "by": "precheck" | "auditor", "real": true, "cut"?: { "word", "at" } } ],
               "leaks": [fact ids], "draft_leaks"?, "slips"?, "draft_slips"?, "spread"?: [{ "name", "fact" }] } ],
  "probes": [ { "id": "s3-p1", "at": 21, "scenario", "target", "asker", "ask", "facts": [ids], "target_mode": "full" | … | null,
                "asker_knows": { "s3:alibi": ["believes_lie", "Tom", null, 15] }, "answer", "draft"?, "changed", "suspects"?, "issues"?,
                "held": { "block": 7, "memories": [["m_x", 0.71]] } | null,
                "score": { "leaks": [], "facts": { "s3:alibi": { "truth", "said": "full" | "parts" | "none", "ignorant"?, "vague"? } },
                           "attribution"?: { "expected", "named", "ok" }, "lie"?: { "fact", "role", "ok", "draft_ok"?, "flagged"? }, "judged": [], "undecided": [] } } ],
  "organize": [ { "at": 24, "sent": [names], "learned": [Kiori's learned[]], "rewound", "waiting", "warnings"? } ],
  "blocks": [ "a recall text block" ],
  "memories": { "m_x": { "kind", "title", "from"?, "to"?, "source"?: { "how", "by"?, "origin"?, "at" }, "confidence"?, "strength"?, "told_to"?, "lie"?: true } },
  "checkpoints": [ { "at": 24, "kind": ["organize"] | ["probes"] | ["organize", "probes"] | ["end"],
                     "truth": { "Rook": { "s3:crate": ["half", null, null, 2, ["where"]], "s3:alibi": ["knows", "Tom", null, 15] },
                                "Leo": { "s3:alibi": ["knows", "Tom", null, 15, null, 31, 31] } },
                     "held": { "Rook": { "block": 3, "memories": [["m_y", 0.52]] } } | null,
                     "cost": { "kiori_usd", "chat_usd", "judge_usd", "estimated_usd" }, "latency_ms": { "recall", "chat", "check", "organize" } } ],
  "metrics": { the metrics above, "cost", "latency_ms", "scale": { "s11": { "messages", "cast", "usd_per_message", "estimated_usd_per_message", "brains_per_organize" } }, "by_scenario": { … } }
}
```

- `people`: `who` and `voice` from `cast.json`. The main cast has five fixed colors (Leo `#6b5bb5`, Mira `#2f6f8f`, Tom `#c0652b`, Ines `#a8457a`, Rook `#5b7a3a`) and a portrait each, at `img/cast/<lowercase name>.jpg` relative to the playground page; everyone else gets a color from their name (the same in every run) and `portrait: ""`.
- `facts[].label`: a few words that name a fact without giving it away, for showing it before anyone knows it. Labels, like probe questions, never contain a canary or a part (the lint checks both).
- `deltas`: the ground truth as it changes, in message order. A delta is a (person, fact) entry that changed at message `n`, as it is after the change: learned, half heard (its `parts` so far), exposed as a lie (`exposed: true`, `state` `knows`), forgotten (`state` `none`, `forgot`), or learned from a leak (`leaked`). `n` is 0 for what people hold from the start; talk going around by world time is dated at the message it arrived with. Playing the deltas up to a message gives the whole table at that message.
- `truth` at a checkpoint lists only what someone holds, as `[state, via, origin, at, parts, exposed, changed_at]`: `parts` is the list when `half`, else null; `exposed` the message that showed the lie false; `changed_at` the last message the entry changed at, when that isn't `at` (a half-heard fact gaining a part, an exposure). Trailing empty fields are left off, so most tuples are `[state, via, origin, at]` as in version 1. Costs and latencies are cumulative.
- `turns[].block` is the recall block the speaker's model received (null without Kiori, or when recall failed), so what Kiori held is there at every free turn; `changed` says whether the check changed the line.
- An issue is the check's, with `by` (`precheck` when the pre-check found it on its own, else `auditor`), and `real` from the ground truth before the line: for a `lie_slip`, whether the draft did slip; for a `lie`, whether the speaker keeps that lie up; for any other type, whether the quote has a word of a canary or part the speaker doesn't hold. `cut` is where the quoted words were in `draft` (`at`, a character offset) when the check took them out.
- `probes[].target_mode` is how the target was there for the last message of the probe's scene (null: they weren't); `asker_knows` is what the one asking held of the facts asked about, as truth tuples.
- `held` is what Kiori actually had: at an organize, for the brains that learned; at a probe, the block the answer was written from; at the end, the main cast. Memory bodies are in the block they came back in, not repeated in `memories`. `source` and `confidence` are on memories learned since the sources change; `told_to` and `lie` on what a character told (a `told` memory).
- `validateReplay` in `replay.mjs` checks all of this, and still accepts a version 1 file as it was; the runner refuses to write a replay that fails it.

### Version 1

The first runs wrote `"replay": 1`: no `deltas`; facts without `label`; people with only `role` and `groups`; turns without `changed`, `block`, `suspects`, and issues as the check returned them; probes without `target_mode`, `asker_knows` and `changed`; truth tuples `[state, via, origin, at]` plus the parts when half.

## Fakes and tests

- **The fake provider** behind the local Kiori, handed the story the runner plays. The organizer writes one memory per line it was shown, quoting it, with how they came by it: `saw` for narration, `heard` for a line, `told` with `via` when the line passes on someone's words ("Tom says", "Mira told him", or the spine's `origin`). It writes a fact for each line that carries one or passes words on, and for a character's own spine lines that tell something, a `told` item for those who heard it; when the spine marks the line as a lie, `lie: true` with its truth, quoted from the scenes when they show it, or as `truth_ref` to a memory of theirs that holds it (without either, Kiori keeps a plain told record, as it should). Its line parser reads a speaker's mode mark ("(you overheard this…)") apart from the name. Placement starts a scene at each line of narration that opens a place or time and puts everyone who speaks or is named in it there for all of it (the coarse placement the late-arrival scenario measures). The auditor flags a name or number in a character's line that others' blocks or the recent messages hold and theirs doesn't, and the pre-check's `lie_slip` suspects that are in the line, and cuts them. Token counts are about the size of the text, so a fake run's list-price estimate is realistic.
- **Fake chat models**: `fake/parrot` (default) answers with the sentences of its prompt that best match the question or stage direction; `fake/oracle` answers from the ground truth (it scores no leaks and full attribution); `fake/leaky` answers from the whole transcript (it gets caught).
- `test/bench.test.mjs` runs the engine on every scenario (hand-checked final tables for scenarios 1-6 and 9), the lint (labels included), the scorer with the oracle and the leaky model, a judge stub, the runner end to end against the fake provider (scenario 1, scenario 3 with its lie and sources, scenario 5 with modes, scenario 7 for what the pre-check caught), the season without Kiori as a version 2 replay whose deltas play back to its end table, replays of both versions through the validator, the fake's line parser, and the `--spend` refusal. A season on a Kiori arm takes about a minute (it meets the local server's 1200 calls a minute), so it is run by hand, not in the tests.

## Known gaps

- The season is 754 messages, not the 1000 the plan had in mind: eleven scenarios of 60-128 messages each.
- Talk going around by `world_time` (scenario 7, and the crier in 11) has no counterpart in Kiori yet, so the Kiori arms are expected to score false ignorance there until the world brain exists.
- The ground truth calls it a slip when anyone with a `told` record of a false fact says the truth whole in front of those they told, a mistake later corrected included (scenario 8); Kiori's `lie_slip` is only for a lie told knowingly. So `lie_slips` and `lie_slips_flagged` count different things, and only `lie_slips_flagged_real` compares them.
- The fake organizer writes `told` items only for spine lines (it can't tell who heard a free line), and finds a lie's truth only in the scenes or the memories Kiori shows it: in the season Tom's lie can end up a plain told record when the memory holding the truth isn't among them.
- The drop-in endpoint is not part of a run yet; a smoke run through it is planned with the real runs.
