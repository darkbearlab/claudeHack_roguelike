# Design notes

This document is the *why*. The code says what happens; this says what was
being aimed at, what alternative was rejected, and what would break if someone
changed it back.

---

## 1. The constraint that shaped everything: no build step

The brief was "a NetHack-like that runs entirely on a web page". The narrowest
reading of that — plain ES modules, no bundler, no npm, no framework — turned
out to be the right one, and not only for tidiness:

- **GitHub Pages serves it as-is.** There is no build to break, no lockfile to
  rot, no toolchain version to pin. The repository *is* the deployment.
- **It stays readable.** Every file in `js/` can be opened in the browser's
  sources panel and matched line-for-line against the repository.
- **It made the game core testable under Node for free.** Node runs ES modules
  natively. Because the core never touches the DOM, the entire game — turn
  loop, combat, level generation, saving — runs headless with a forty-line stub
  UI. That is what made the test suite in `tools/` possible at all, and it is
  the single highest-value structural decision in the project.

The cost is real and worth naming: no minification, no tree shaking, and about
sixty HTTP requests on a cold load. For a game whose total payload is under a
megabyte including all 57 sprites, that is a good trade.

**The rule this implies:** nothing in `js/core`, `js/map`, `js/sys`, `js/data`
or `js/game` may reference `window`, `document` or `localStorage` at module
scope. `js/game/save.js` touches `localStorage` but only inside functions, so
the module still loads under Node. Breaking this rule silently disables the
entire test suite.

---

## 2. The turn model is energy, not rounds

Every actor accumulates `speed` points per tick and spends 12 to act. The hero
is speed 12; a giant ant is 18, a kobold is 6, a bat is 22.

This is not decoration. In a round-based model, "fast" has to be expressed as
"sometimes gets a bonus attack", which the player cannot reason about. With
energy, a speed-18 monster gets exactly three moves to your two, forever, and
the player can *count*. Deciding whether you can outrun something to the stairs
is the core tactical question of a roguelike, and it only exists if speed is
legible.

The protocol is deliberately two methods, not one:

```js
gainEnergy()   // called exactly once per tick
canAct()       // called repeatedly; spends 12 each time it returns true
```

They were originally folded into a single `takesTurn()` that both added energy
and checked it, called in a `while` loop. That meant a monster gained *more*
energy for every extra action it took, compounding into four attacks per turn.
A speed-10 giant rat killed a full-health level-1 Valkyrie in four turns. The
split is the fix, and the comment in `js/game/actors.js` says so, because it is
exactly the kind of thing someone would "simplify" back.

---

## 3. To-hit: NetHack's formula, including the ugly part

A blow lands when `rnd(20) < AC_VALUE(defender AC) + attacker level + 1`.

Two properties matter:

- **Lower AC is better and can go negative.** This is unintuitive to anyone who
  has not played NetHack, and it is kept because it makes the whole armour
  economy work: every point of AC is a flat 5% reduction in incoming blows, all
  the way down, with no diminishing returns and no immunity.
- **`AC_VALUE` randomises AC below 3.** `3 - rnd(3 - ac)`. So AC 0 behaves as
  0, 1 or 2 depending on the roll, and AC -10 spans -10 to 2. Without this,
  deep armour would be a smooth 5%-a-point grind; with it, heavy armour makes
  you *unpredictably* hard to hit, which is what makes stacking AC feel like it
  is doing something.

The first implementation had `10 + AC + bonuses` on both sides. Everything hit
everything, armour was decorative, and a sewer rat was lethal. The stray `+10`
is called out in a comment in `js/game/combat.js` for the same reason as above.

---

## 4. The identification game is the game

Potions, scrolls, wands, rings, amulets and spellbooks have a *true identity*
and an *appearance*. The mapping is shuffled once per run from the run seed:

```
potion of healing  <->  "the swirly potion"      (this run only)
```

Three consequences, all intentional:

1. **Drinking an unknown potion is a decision, not a chore.** It might be
   healing; it might be paralysis while a soldier ant stands next to you.
2. **Knowledge is per-run and non-transferable.** You cannot learn the game
   once and be done.
3. **The seed carries it.** Two players given the same seed get the same
   dungeon *and* the same shuffle, so a run is genuinely shareable.

`game.discover()` is called from inside each effect rather than by the command
layer. That is deliberate: an effect the hero can observe identifies the object,
and an effect they cannot ("nothing seems to happen") does not. Putting the call
at the call site would have made every effect's observability the caller's
problem to remember.

---

## 5. Three separate kinds of map memory

Each cell carries three independent facts:

| | meaning | recomputed |
| --- | --- | --- |
| `visible` | in the hero's field of view this turn | every move |
| `seen` | the hero has ever seen this terrain | never cleared, except by amnesia |
| `memObj` | a snapshot of the topmost object seen here | only when the cell is seen again |

The third is the interesting one. Objects need their own memory because they
persist in the mind after the light moves on — and because a monster can pick
one up while you are not looking, at which point your memory is *wrong*, and it
should be. Nothing re-syncs `memObj` except seeing the cell again. Walking back
to where you left a wand and finding nothing there is a feature.

Lighting is separate from field of view. An unlit room shows only the square you
stand on and its neighbours; a lit room reveals entirely the moment you step
inside, walls included. That is why a light source matters, and why deep levels
generate more unlit rooms.

---

## 6. `passable()` answers a monster's question, not the hero's

This caused two separate bugs and is worth stating plainly.

A closed door is a **wall** to anything without hands. It is **not** a wall to
the hero, who opens it by walking into it. Conflating them meant:

- a flood fill out of a room with its doors shut reported the rest of the level
  unreachable, so autoexplore refused to move;
- the map-connectivity test reported false failures.

`Level.passable(x, y, mon)` now treats `mon === null` as the hero and lets them
through closed (not locked) doors. `Level.hazard()` was added alongside it for
the separate question "should automatic movement *route* me through this" —
lava is passable and also a way to die, and travel marching you into it is not
a feature.

---

## 7. One diagonal rule, in one place

NetHack forbids moving diagonally into, out of, or past the frame of a doorway.
Three subsystems need the rule: movement, A*, and the flow field.

They were implemented separately and disagreed. The pathfinder planned a
diagonal step onto an open door; movement refused it; and because it was the
*only* downhill step in the gradient, autoexplore concluded the level was fully
explored one square inside the first room and said so, forever.

The rule now lives in exactly one function, `diagonalOk(level, fx, fy, tx, ty)`
in `js/map/tiles.js`, and checks **both** endpoints and **both** corners. The
earlier versions checked the destination and the corners but not the origin,
which is why leaving a doorway diagonally slipped through.

Any future subsystem that moves something on the grid must call it.

---

## 8. Four generators, chosen by depth with a random tail

| generator | share | what it is for |
| --- | --- | --- |
| rooms | ~78% | the classic. A 5x3 lattice of candidate cells, a room in some, a randomised spanning tree of corridors between grid neighbours, plus a few extra edges |
| maze | ~9% (depth 10+) | recursive backtracker on the odd lattice, then *braided*: a third of dead ends are knocked out |
| cavern | ~5% (depth 4+) | cellular automata over noise, largest region kept |
| big room | ~4% (depth 6–14) | one enormous pillared hall, appears rarely |
| sanctum | depth 26 | hand-built: an outer hall with lava braziers around a one-door vault holding the Amulet |

The rooms generator dominates because it is the one that produces *tactics*.
Doorways to fight in, corridors to retreat down, rooms to be ambushed in. A
dungeon of pure caverns is prettier and much worse to play.

The extra loop edges matter too. A pure spanning tree gives a dungeon with no
alternative routes, which means no escaping a chase — you can only ever run
deeper into a dead end.

The maze is braided for the same reason. A perfect maze with a hunting monster
in it is not a challenge, it is a formality.

---

## 9. Monster AI: a priority list, not a state machine

Each turn a monster asks, in order: can I act, am I afraid, can I see the hero,
do I remember where they were, what is interesting nearby. The first "yes"
decides the turn. A state machine was rejected because it invites states that
never get left.

The piece that does the most work for the least code is **`lastKnown`**. A
monster that loses sight of the hero walks to where the hero *was*, not to
where they are. That one field is the whole difference between "monsters cheat"
and "monsters hunt", and it is what makes breaking line of sight a real tactic
rather than a cosmetic one.

Monster lookup by position is the hottest path in the game: A* asks "is anything
standing here" for every node it expands, thousands of times per monster per
turn. A linear scan over the monster list made deep levels visibly stutter. The
level now keeps a lazily-rebuilt position index; anything that moves, adds or
kills a monster calls `markMonstersDirty()`.

---

## 10. Two render modes that cannot disagree

Tile mode draws the generated sprites; ASCII mode draws glyphs. They are one
renderer with a branch per cell, not two renderers, and they share the viewport
maths, the lighting model and the draw order.

That is a correctness property, not a tidiness one. An ASCII mode that shows a
monster the tile mode hides is a cheat, and two independent renderers drift into
exactly that.

### Terrain is procedural; everything else is a sprite

This is the one place where the art pipeline dictated the design. The available
generator (see [ASSETS.md](ASSETS.md)) produces **background-removed objects**.
It has no tiling path — no seam checking, no power-of-two sizes, no guarantee
that an image joins to itself. A floor built from such images shows seams and a
wall built from them has gaps at the joins.

So floors and walls are drawn with `fillRect` plus a per-cell deterministic hash
for variation. They tile perfectly, cost nothing to load, are stable between
frames, and take a lighting multiplier for free. Monsters, items and features —
which are objects, standing on a floor, with transparent backgrounds — are
exactly what the generator is good at, and those are sprites.

Sprites are also drawn *bottom-anchored* inside their cell rather than centred,
so a tall thing stands on the floor instead of floating over it.

---

## 11. Prompts are promises

`w` has to stop and ask *which weapon*, and the answer arrives from a DOM event
several frames later. The whole command path is `async` and awaits the UI:

```js
const o = await this.ui.pickItem('What do you want to wield?', entries);
if (!o) return false;
```

This replaced a callback-driven design that leaked half-finished commands every
time the player pressed Escape. With promises, a command that asks three
questions still reads as a straight line, and cancelling is a `null` return.

The cost is that any *synchronous* caller of an effect that wants to prompt
cannot. That is why `playerAttack()` does not contain its own "really attack
this peaceful creature?" confirmation — the confirmation lives in the movement
command, and the comment in `combat.js` says why.

---

## 12. Touch is a first-class input, not a fallback

The requirement arrived mid-build and changed the UI layer rather than adding to
it. The standard the code holds itself to: **every command reachable from the
keyboard is reachable from a thumb.**

- The map takes taps (step / attack / travel), swipes (step) and long presses
  (examine).
- The d-pad covers all eight directions plus wait.
- The `?` button opens a command palette where every command is a labelled
  button — not a help screen, an actual dispatcher.
- Every prompt renders its own controls: yes/no buttons, a 3x3 direction grid,
  a real `<input>` for text so the on-screen keyboard appears.
- Menus are tappable rows; the letter shortcuts still work for keyboards.

Layout is mobile-first with `100dvh` and safe-area insets. On a phone the chrome
tightens: two message lines instead of three, smaller status text, a 40px
minimum on every control — below that a thumb starts missing, and a mis-tapped
move in a roguelike costs a turn you cannot take back.

---

## 13. One save slot, deleted on death

Permadeath is not permadeath if the player can reload. The save is written on a
timer, on `pagehide` and on tab-hide — a phone that gets backgrounded must not
lose a run — and it is **deleted** by `die()` and by `win()`.

The awkward part of saving a roguelike is not the data, it is the *graph*. A
shop points at a room, a shopkeeper and a list of stock; the shopkeeper points
back at the shop; the hero's equipment slots point at objects that are also in
the inventory array. JSON has no notion of identity, so every one of those
becomes an index or an object id on the way out and a lookup on the way back in.
All of that lives in `js/game/save.js` so no other file has to think about it,
and `systest.mjs` asserts the graph is restored — not just the field values.

Typed arrays are base64-encoded rather than written as JSON number arrays: 1680
bytes becomes 2.2 KB instead of about 6 KB, and a fully-explored 26-level
dungeon comes to roughly 505 KB against a 5 MB budget shared with everything
else on the origin.

---

## 14. What was deliberately left out

- **Dungeon branches.** The Mines, Sokoban, the Quest. Each is a special-level
  format plus its own generator plus its own content; one linear dungeon with
  four generators and five special-room types gives most of the variety for a
  fraction of the surface area.
- **Player polymorph into other species.** Polymorph instead scrambles
  attributes and hit points. A second creature model for the hero would touch
  combat, inventory, movement and rendering, for one item.
- **Pets.** Taming exists (`scroll of taming` makes a monster peaceful and
  tame), but there is no starting pet and no pet AI. A pet that follows you
  badly is worse than no pet.
- **Multiple save slots and a scoreboard.** Both are anti-permadeath.
- **Sound.** Nothing to say with it that the message line does not.
