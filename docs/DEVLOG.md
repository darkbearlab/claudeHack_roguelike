# Development log

Written as the work happened, in order. The point of this file is the *process*:
what was done first and why, what went wrong, and how each problem was actually
found — because in most cases the finding was harder than the fixing.

Everything below was built in one session on 2026-09-01.

---

## The brief

> Build a NetHack-like that plays entirely in a web page. Use the asset
> generator at `c:/claude_project/asset_generator` to make all the art it needs
> — and a few extras even if they are not strictly required. Write down what you
> learn. Deploy to `darkbearlab/claudeHack_roguelike`, always merged to `main`.
> No further discussion; produce the finished thing.

Mid-build, one addition: **it must be fully usable in a mobile browser.**

Working without checkpoints changes the approach. With no chance to ask "is this
what you meant", the right move is to build the thing that can *prove itself* —
which is why an unusual share of the effort went into test harnesses, and why
this log exists at all.

---

## Order of work, and why

Art first, code second. The asset generator is a network- and money-bound
process at roughly twenty seconds per sprite; 54 sprites is about twenty
minutes of wall clock that runs perfectly well in the background while code gets
written. Starting the batch was the first substantive action of the session.
By the time the object tables needed sprite names, the sprites existed.

Then, in order:

1. **Core** — seeded RNG, shared helpers. Everything random goes through one
   generator so a run is reproducible from its seed alone.
2. **Map** — tile table, the `Level` object, four generators.
3. **Systems** — field of view (recursive shadowcasting), pathfinding (A* plus
   flow fields).
4. **Data** — 63 monsters, 200 objects, 6 roles, as pure tables.
5. **Game** — actors, combat, monster AI, effects, the turn loop, save/load.
6. **UI** — canvas renderer, input, menus, prompts.
7. **Test harnesses** — and this is where the session actually turned.

---

## The turn where it changed: writing a bot instead of playing

After the first playable build, the obvious next step was to play it in the
browser and look for bugs. Two rounds of that found one bug and took a long
time. The browser is a bad instrument: every observation costs a screenshot, and
the interesting bugs are the rare ones.

The game core has no DOM dependency — that was a deliberate structural choice
made hours earlier, and this is where it paid. Three harnesses got written:

**`tools/smoketest.mjs`** — presses random keys, thousands of times, across many
seeds, with a stub UI that answers prompts randomly. It is a *crash* test. It
answers "does this ever throw", not "is this fun". First run, first result:

```
TypeError: game.animateTrail is not a function
```

`effects.js` called `game.animateTrail(...)`; only the UI had that method.
Every thrown object and every wand beam in the game would have crashed. Playing
by hand had not found it because the fuzzer presses `t` and `f` far more often
than a person does.

**`tools/botrun.mjs`** — a greedy bot with an actual policy: heal when hurt, eat
when weak, kill what is adjacent, walk toward the down staircase or toward
unexplored space. Written because the random fuzzer *never left dungeon level
one*, which meant levels 2–26, shops, mazes, caverns, the Sanctum, the Amulet
and the win condition had never executed at all.

Later it gained `--god`, which makes the bot unkillable. That is not a balance
cheat — it is the only way the deep half of the dungeon runs at all, because a
greedy melee bot dies around level 5. The first god run reached level 26 and
generated a Sanctum.

**`tools/systest.mjs`** — the real suite. 19 checks that assert rather than
sample: every potion quaffed in all three blessed/uncursed/cursed states, every
scroll, every wand in all nine directions, every spell, every trap, every one of
63 monster species given 25 turns, all 26 depths generated across 12 seeds with
a connectivity proof, the save format including its object graph, and the win
condition driven end to end.

Whole suite: about 8 seconds. It is the thing that made the rest of the session
possible.

---

## The bugs that mattered

### 1. Monsters got four turns for every one of yours

Found by: playing four moves in the browser and watching a giant rat take a
17 HP Valkyrie to 2.

The scheduler looked like this:

```js
while (m.takesTurn() && guard++ < 6) { monsterTurn(game, m); }
```

and `takesTurn()` both *added* `speed` energy and *checked* it. So each extra
action granted more energy, which granted another action. A speed-10 monster
got three or four attacks per tick. Fixed by splitting the protocol into
`gainEnergy()` (once per tick) and `canAct()` (repeatedly, spending). The
comment in `actors.js` names the bug, because the two methods look redundant and
someone will want to merge them.

### 2. Armour was decorative

Found by: reading the fuzzer output and refusing to accept it. Thirty seeds, all
dead on dungeon level 1, several before turn 20. The easy conclusion was "the
fuzzer plays badly", which was true and also a distraction.

The formula was `10 + AC + level + 1` as the target for `rnd(20)`. With a
Valkyrie's AC 2 that is a target of 13 — a 60% chance to be hit by a *sewer
rat*. NetHack's actual formula has no `+10`; the stray constant made every
attack in the game land. With it removed and `AC_VALUE`'s sub-3 randomisation
restored, AC 2 becomes a 10% chance, which is what wearing armour is supposed to
buy.

The same `+10` was in the thrown-weapon check.

### 3. Dungeon level 1 handed out hill orcs

Found by: the same fuzzer output, after fixing the real bug above and still
seeing early deaths.

`maxLvl = floor((depth + heroLevel) / 2) + 1` with weighting `freq * (1 + lvl)`.
On depth 1 with a level-1 hero that admits level-2 monsters and then *biases
toward them*. A hill orc (level 2, 1d6 weapon, appears in groups of 2–5) on the
first level is not a difficulty curve. Both ends of the band now move with
depth, and the in-band bias is mild: `freq * (1 + lvl/3)`.

`systest.mjs` now asserts the band directly — depth 1 caps at monster level 1,
depth 26 spans 5–15 — so this cannot silently regress.

### 4. Autoexplore stopped one square from every door

The best bug of the session, because it was three bugs wearing a trenchcoat.

Symptom: press Ctrl-F, take one step, then "You cannot reach anywhere new."
forever, on a level 4% explored.

- **First layer.** `stepAlong` (gradient descent over a flow field) did not know
  about the no-diagonal-through-a-doorway rule, so it proposed a step that
  movement then refused. Added the check.
- **Second layer.** Still stuck. The *flow field itself* was built with
  eight-way movement including illegal diagonals, so its distances assumed moves
  the game would not allow, and the only downhill neighbour was unreachable.
  Added the check to `flowField` too.
- **Third layer.** *Still* stuck. Dumped the field in the browser console:

  ```
  4:2  4:2  3:2
  4:11 3:2  3:2      <- hero at centre, value 3
  -1:1 -1:1 2:5      <- value 2, tile 5 = open door, diagonal
  ```

  The rule as implemented checked the destination and the two corners but **not
  the origin**. Expanding *from* the door *to* the hero passed every test,
  because the door was the origin. Movement checked the destination, so the two
  disagreed in exactly one case: leaving a doorway diagonally.

Fixed properly by moving the rule into one function, `diagonalOk()`, that checks
both endpoints and both corners, and making movement, A* and the flow field all
call it. Three copies of a rule is three chances to get it subtly different.

### 5. `passable()` treated the hero as a handless monster

Related to the above and found the same way. A closed door is a wall to
something without hands; it is not a wall to the hero, who opens it by walking
into it. With the hero treated as a monster, a flood fill out of a room with its
doors shut reported the rest of the level unreachable.

This *also* explained a system-test failure that had been dismissed as a test
bug: "down stair unreachable, 21/245 reached". It was the test using the same
predicate. The test now floods in two tiers and reports how many levels need a
door opened, kicked or searched out — currently 2 in 312, which is the intended
NetHack-ish texture rather than a defect.

### 6. `randomFreeSpot` was quadratic, and every wandering monster called it

Found by: a god-bot run that did not finish in ten minutes.

`randomFreeSpot` walked every cell and called `monsterAt()` per cell;
`monsterAt()` was a linear scan of the monster list. Every wandering monster
called it whenever it needed a new destination. On a busy level that is
`cells x monsters x monsters` per turn.

Two fixes: occupancy is now gathered once per call, and `monsterAt` is backed by
a lazily-rebuilt position index. The index rebuild is `O(monsters)` and happens
once per move rather than once per query, which matters because A* asks the
question thousands of times per search.

### 7. 95 pixels of nothing at the bottom of a phone screen

Found by: measuring instead of squinting. The status bar looked too tall in a
mobile screenshot, so:

```js
const h = el => Math.round(document.getElementById(el).getBoundingClientRect().height);
({ status: h('status'), s1: h('status1'), s2: h('status2') })
// => { status: 125, s1: 15, s2: 15 }
```

Two 15px lines inside a 125px container. `#status` had `white-space: pre-wrap`,
which was also preserving the newlines *between the two `<div>`s in the HTML
source*. Moving `pre-wrap` onto the lines themselves took the container from
125px to 35px and gave the map 90 more pixels — on a phone, three more rows of
dungeon.

### 8. Two self-inflicted tooling wounds

Worth recording because both cost time and neither was a game bug.

- **The dev server deadlocked the page.** `socketserver.TCPServer` handles one
  request at a time; a browser opens several parallel connections to fetch a
  module graph. The page hung with no error anywhere. `ThreadingHTTPServer`
  fixed it.
- **The browser cached ES modules.** An edit-reload loop that serves stale
  modules does not just waste time, it *lies*: a fix appears not to work, so you
  go looking for a deeper cause that does not exist. `tools/devserver.py` now
  sends `Cache-Control: no-store`.

Both are commented in the file, at the top, where the next person will hit them.

---

## The second pass: bugs the tests found only after other bugs were fixed

Three of the most interesting problems were invisible until something else was
fixed first. That is worth recording, because it is an argument for fixing
things properly rather than working around them: each proper fix made the *next*
problem measurable.

### 9. The Amulet's vault had a hole punched in its wall

`ensureConnected` guarantees the whole walkable map is one region, tunnelling
where it is not. It flooded through walkable tiles only — and the Sanctum's
vault is a sealed room whose single entrance is a *locked door*, which is not
walkable. So every Sanctum generated looked like it had an unreachable region,
and the generator obligingly dug a corridor through the vault wall.

Nothing failed. The Amulet was still there, still guarded, still reachable. It
was simply not the room it was designed to be. Found by writing a test for a
property nobody had checked — "the vault has exactly one door and no other
opening" — while investigating something else.

### 10. Fixing that made an existing problem measurable

With connectivity flooding through doors, `ensureConnected` stopped digging
detours around every closed door. The connectivity test's "needs a door opened,
kicked or found" count jumped from 2 levels in 312 to 107.

That number had always been the truth; the generator had just been papering over
it. Splitting it into "needs a locked door kicked" (51) and "needs a secret door
found" (56) made the decision obvious:

- A locked door is fine. Kicking is one command, always available, and it makes
  noise that wakes the level — a real decision with a real cost.
- A secret door on the only route down is not fine. It turns a level into "walk
  every wall pressing `s`", which is tedium wearing difficulty's clothes.

So generation now reveals secret doors along one route to the down staircase,
and leaves every other secret alone. The test asserts **zero** levels require a
search to descend. Secret doors still hide side rooms, vaults and shortcuts,
which is what they are for.

### 11. Shops were a coin flip

`specialRooms` picked a random room, then asked whether it could be a shop. A
shop needs a room with exactly one door, and only about 40% of rooms have one,
so the intended 12% chance became roughly 5% per level — a 28% chance of a whole
dungeon with no shop in it.

Found by looking for a shop to screenshot and failing to find one in 26 levels.
Rolling the type first and then finding a room to suit it took shops from about
1 per dungeon to about 3.6, and the test now asserts the *rate* rather than the
code path: 20 dungeons must produce at least one of every special room type, and
at least 19 of 20 must contain a shop.

### 12. The bot found a UI dead end the fuzzer never could

The stall detector fired: 200 consecutive commands spending no turn. The
diagnostic printed the last key and the last three messages:

```
stalled at turn 43 on dlvl 1 last key "W"
msgs="You must take off your cloak first. | ... | ..."
```

The bot wanted to wear body armour, was wearing a cloak, and the game correctly
refused — every single time, forever. The fix worth making was not "teach the
bot about cloaks" but a general guard: any command that spends no turn is
blocked until one does. There are many legitimate refusals in a roguelike and a
bot cannot know them all.

---

## Things that went right first time

Not everything was a bug hunt, and it is worth noting what did not need fixing,
because it says something about where care pays off.

- **Recursive shadowcasting FOV.** Written once from the octant transform table,
  worked immediately, never touched again. Well-specified algorithms are worth
  implementing exactly rather than approximately.
- **The save format.** 19 system-test assertions on a round trip — including
  that shop → shopkeeper → stock pointers are restored as *identity*, not as
  copies — passed on the first run. Writing the serialiser as explicit
  index-mapping rather than trying to be clever with a JSON replacer is why.
- **The identification shuffle.** Bijection per class, stable per seed, verified
  by test. Straightforward when the RNG is seeded and centralised.
- **The async prompt design.** Converting the command layer to `await ui.pickItem(...)`
  removed a whole class of bug (half-finished commands leaking on Escape) before
  any of them were written.

---

## Final state

```
22 system checks             PASS
250 fuzz seeds x 4000        1,000,000 commands, 0 crashes
20 bot runs                  0 crashes, deepest level 9
god-bot runs                 0 crashes, deepest level 26, Sanctum generated
312 generated levels         all connected, 0 requiring a search to descend
```

| | |
| --- | --- |
| Source | 8,343 lines of JavaScript across 21 modules |
| Data | 63 monsters, 200 object types, 6 roles, 14 traps, 15 spells |
| Art | 57 sprites, $0.27 |
| Dependencies | none |
| Build step | none |

## If someone picks this up

Run `node tools/systest.mjs` first. It takes eight seconds and it is the
contract. If it is green, the game works; if you change something and it goes
red, the message tells you which of the eighteen invariants you broke.

The four things most likely to be "simplified" back into bugs, all commented in
place:

1. Merging `gainEnergy()` and `canAct()` in `js/game/actors.js`.
2. Adding a constant back to the to-hit target in `js/game/combat.js`.
3. Re-implementing the diagonal-doorway rule locally instead of calling
   `diagonalOk()` in `js/map/tiles.js`.
4. Making `Level.passable()` treat the hero like a monster in `js/map/level.js` —
   a closed door is a wall to one and a door to the other.

## Postscript: the scheduler bug came back in the other game

Item 1 in that list — merging `gainEnergy()` and `canAct()` — is there because
splitting them was what stopped claudeHack's monsters taking four turns each.
claudeSouls copied the scheduler and then reintroduced the same class of bug
from the other side.

There, the two calls stayed split, but `gainEnergy()` sat *above* the
`if (busy) continue;` guard. So an enemy went on banking energy through its
wind-up and its recovery, with no cap:

```
turn 7: hound moved 0 tiles, state=ready,   energy=36
turn 9: hound moved 0 tiles, state=recover, energy=48   <- still climbing
```

A hound coming out of a bite had enough saved to cross three tiles in one turn,
which made disengaging from one arithmetically impossible and its chip damage
unavoidable by construction. It accounted for a quarter of all recorded deaths
and presented as the bestiary being over-tuned — I nearly rebalanced the roster
around it.

The general shape, which is the part worth keeping: **an actor that is busy
must not accrue the resource it will spend on being free.** Whether that shows
up as double-gaining or as unbounded banking depends on which side of the guard
the line lands, and both look like a balance problem rather than a scheduler
one, because the symptom is always "this monster is too strong".

claudeSouls now has a test that pins the consequence rather than the mechanism —
a silent attacker's damage per turn must stay under its own recovery ceiling —
because the mechanism has now been got wrong twice in two different ways, and
the consequence is what actually matters.

The other lesson from that round is in `claudeSouls/docs/DESIGN.md`: the bot is
the only balance instrument these games have, and when it dies a lot the first
question is whether it is playing badly, not whether the numbers are wrong.
Three "balance problems" in a row turned out to be the bot.

## Documents drift in a particular direction

Three separate places had gone stale in the same way, and it is worth naming the
pattern because it is not "we forgot to update the docs".

`claudeSouls/docs/DESIGN.md` was written as a pre-work spec and then had each
round of playtest feedback appended to it. That is a good record of *how* the
game got here and a bad answer to *what the game is now*: the "current numbers"
section still described the roster from before attack shapes, poise and
untelegraphed attacks existed, because nothing about appending a new chapter
forces you to revisit an old one. The document now opens by saying which half is
which, and the current state lives in one section built from the live data
rather than retyped.

The root README claimed poise was among the things "rejected and why". It had
been rejected — I argued against it — and then the user was right and it shipped.
A sentence describing a decision is exactly the sentence that rots when the
decision is reversed, and nothing in the code will ever contradict it.

The in-game splash line, by contrast, had not drifted at all, because it is
`${DUNGEON_DEPTH} 層 · ${ENEMIES.length} 種敵人` — generated from the data it
describes. That is the whole lesson: **the parts of the documentation that never
went stale are the parts that were derived rather than written.** Where that is
possible it should be done (the guide is generated and CI checks it; the skill
icons are generated from the pattern table). Where it is not — design rationale,
rejected options — the fix is not discipline, it is putting the volatile claims
where a reader will see them next to the thing that supersedes them.

## The anti-drift lesson, and then drifting again

The section above says the documentation that never went stale is the part that
was derived rather than written. Having written that, I let claudeSouls's design
document go stale twice more — far enough that it still claimed "nothing in the
dungeon drops anything" after storerooms, guarded chests, corpses you walk back
for, elites and a soul economy had all shipped.

So the lesson needed sharpening. "Keep the docs updated" is not a practice, it
is a wish. What actually worked, both times I fixed it:

**Build the current-state section from the modules.** Every number in it - depth
count, species count, how many attacks have a second stage, how many of those
re-aim, the longest corridor a floor can contain - is read out of the live data
before the section is written, not recalled. Recalled numbers are the ones that
rot, and they rot silently because nothing contradicts them.

**Say which half of the document is which.** The design doc is now explicitly
two things: what the game is today, and how it got here. The second half is
allowed to be wrong, and superseded passages are labelled as historical
snapshots rather than deleted - a document that keeps only the conclusions that
turned out right reads as though every decision was correct first time, which is
a lie and invites the next person to make the same mistakes.

**Keep a section for mistakes that will recur.** claudeSouls now has one, and
its entries are all shaped the same way: a step function whose edge landed on
the standard loadout, every automated check sharing one starting kit so an
entire class of equipment bug was structurally invisible, four rounds of
guessing beaten by one line of diagnostics, and a probe that measured nothing
for forty turns because the state it set decays after twelve. None of those are
things you avoid by being careful. They are things you avoid by having read that
they happened before.
