# Testing

There is no test framework and no test runner. The game core has no DOM
dependency, so it runs under Node directly with a stub UI, and the three
harnesses in `tools/` are plain scripts that exit non-zero on failure.

That structural property — **the core never touches `window`, `document` or
`localStorage` at module scope** — is what makes all of this possible. Breaking
it silently disables every check below.

```bash
node tools/systest.mjs                 # 22 assertions. The contract.
node tools/smoketest.mjs 40 3000       # random-input crash fuzzing
node tools/botrun.mjs 12 30000         # a bot that plays to win
node tools/botrun.mjs --god 3 20000    # an unkillable bot, to reach level 26
```

---

## What each harness can actually prove

The three answer genuinely different questions, and it is worth being precise
about which, because it is easy to run the wrong one and believe the wrong
thing.

### `systest.mjs` — correctness

Asserts. Deterministic. Roughly 8 seconds. This is the suite; the other two are
instruments.

| check | what it establishes |
| --- | --- |
| all 26 depths x 12 seeds | every level generates, has stairs, and the down stair is reachable from the up stair |
| secret squares | every secret door or corridor is adjacent to reachable floor, so it can be found |
| 200 object types | each instantiates and produces a sane name both unidentified and identified |
| appearance shuffle | bijective per class; identical for one seed, different across seeds |
| 24 potions x 3 BUC | every potion can be drunk in blessed, uncursed and cursed form |
| 20 scrolls x 3 BUC | as above for scrolls |
| 23 wands x 9 directions | including at oneself, with a monster in the beam |
| 15 spells x 6 casts | covers both the success and failure paths |
| 14 trap types x 8 | every trap fires |
| 63 corpses + 12 foods | every corpse and food can be eaten, including the ones that kill you |
| 63 species x 25 turns | every monster can be created and run its AI |
| difficulty band | depth 1 caps at monster level 1; depth 26 spans 5–15 and generates no vermin |
| save round trip | 8 levels, ~59 monsters, ~53 items; every field, every tile array, and the **object graph** (equipment points at inventory objects; shops point at their shopkeeper and stock) |
| save size | a fully-explored 26-level dungeon fits in ~505 KB, against a 5 MB budget |
| the win path | take the Amulet, walk 26 levels up, leave: the run ends `ascended` with a score over 20000 |
| the non-win path | leaving level 1 *without* the Amulet does not win |
| permadeath | death ends the run and deletes the save |
| 6 roles | each starts alive, equipped, lit, unencumbered and not inside a wall |
| determinism | one seed produces identical dungeons and identical identity shuffles |
| resting | #rest heals to full, stops the instant a hostile is in view, and will not rest you into starvation |
| the Sanctum vault | exactly one locked door and no other opening, across 15 seeds |
| special rooms | 20 whole dungeons produce every special room type, and at least 19 contain a shop |

The connectivity check runs in three tiers, by how much work the hero has to do
about doors: what is already walkable, plus locked doors that can be kicked,
plus secret doors that have to be searched out. Reachability through *any* door
is required; needing to kick a locked one is counted and allowed (currently
about 70 levels in 312, and kicking is one command); needing to **find a secret
door** is asserted to be zero, because searching every wall to reach the stairs
is tedium rather than difficulty.

### `smoketest.mjs` — does it ever throw?

Presses random keys, thousands of times, across many seeds, with a stub UI that
answers prompts randomly. Movement dominates the command distribution because
it dominates real play and because it is what drives the hero into everything
else. Every 900 commands it does a save/load round trip, because a save bug that
only appears after twenty levels is exactly what a soak test is for.

**What it cannot tell you:** anything about balance. It plays terribly and dies
on dungeon level 1 almost every time. Reading its death rate as a difficulty
signal is a mistake — although one useful thing did come out of doing exactly
that: the deaths were so absurd (turn 11, sewer rat, full-health Valkyrie) that
they pointed at a real to-hit bug behind the noise.

Its actual value is finding rare paths. Its very first run found
`game.animateTrail is not a function`, which would have crashed every thrown
object and every wand beam in the game, because the fuzzer presses `t` and `f`
far more often than a person does.

### `botrun.mjs` — does the rest of the game exist?

A greedy policy: heal when hurt, eat when weak, kill what is adjacent, wear
armour, pick things up, walk to the down staircase or toward unexplored space.
It reaches dungeon level 5–8 and then dies, because it never flees and never
uses a ranged attack.

`--god` makes it unkillable. That is not a balance cheat, it is the only way the
deep half of the dungeon executes at all: without it, levels 6–26, the Sanctum,
the Amulet and the win condition are never reached outside a real playthrough.
A god run reaches level 26 and generates every level type.

It also carries a **stall detector**: 200 consecutive commands that spend no
turn throws rather than spinning. That is how the "peaceful shopkeeper in the
path" deadlock was found — a command that raises a confirmation the bot declines
spends no turn, so a path through a shopkeeper locks the run at zero turns per
command forever.

---

## The pattern worth reusing

Three observations from building these, in rough order of how much time each
saved:

**1. Make the core headless before you need to.** The decision to keep
`js/game/` free of DOM references was made for tidiness hours before any test
existed. It is what turned "play it in a browser and look" — every observation
costing a screenshot — into "run 40 seeds in 0.7 seconds".

**2. A fuzzer and a bot are not substitutes.** The fuzzer proves nothing
crashes; it never leaves level 1. The bot proves the game *exists* past level 1;
it is far too slow at finding rare paths. Both, cheaply, beats either.

**3. Assert the invariant, not the symptom.** After fixing the monster
difficulty band, the test added was not "a level-1 hero survives 50 turns"
(flaky, and a balance claim). It was "depth 1 never generates a monster above
level 1" — the actual property, deterministic, and it names the bug in its
failure message if it regresses.

---

## Continuous integration

`.github/workflows/ci.yml` runs `systest.mjs`, then a smoke run, a bot run and a
deep god-bot run, on every push and pull request. The whole thing takes well
under a minute because none of it needs a browser, and it installs nothing —
there are no dependencies to install.
