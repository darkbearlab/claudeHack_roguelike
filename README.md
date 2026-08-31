# claudeHack

A roguelike in the NetHack tradition that runs entirely in a browser — on a
desktop with a keyboard, or on a phone with a thumb. No install, no build step,
no server, no dependencies.

**Play:** https://darkbearlab.github.io/claudeHack_roguelike/

```
      _                 _      _   _   _            _
  ___| | __ _ _   _  __| | ___| | | | | | __ _  ___| | __
 / __| |/ _` | | | |/ _` |/ _ \ |_| |_| |/ _` |/ __| |/ /
| (__| | (_| | |_| | (_| |  __/  _   _  | (_| | (__|   <
 \___|_|\__,_|\__,_|\__,_|\___|_| |_| |_|\__,_|\___|_|\_\
```

## What it is

Descend 26 dungeon levels, take the Amulet of Yendor out of the Sanctum at the
bottom, and carry it back to the surface. One life. No undo. The dungeon is
different every run and the identities of every potion, scroll, wand, ring and
amulet are reshuffled at the start of each game, so "the blue potion" means
something different tomorrow.

| | |
| --- | --- |
| Dungeon | 26 levels, four generators (rooms, maze, cavern, big room) plus the Sanctum |
| Monsters | 63 species with speed, resistances, group spawning, ranged attacks and spellcasting |
| Objects | 200 types across 12 classes, with a per-run identification shuffle |
| Roles | 6, each with a structural ability rather than just a different sword |
| Special rooms | shops with a working shopkeeper, zoos, graveyards, barracks, treasure rooms |
| Input | keyboard (NetHack bindings), on-screen d-pad, tap-to-travel, swipe, long-press |
| Persistence | one save slot in `localStorage`, deleted on death |
| Dependencies | none |

## Playing

### Keyboard

```
h j k l    west, south, north, east          > <   stairs down / up
y u b n    diagonals                         , i   pick up, inventory
Shift+dir  run                               d D   drop one / several
arrows     the same, if you prefer           w W   wield, wear
.          wait a turn                       T P R take off, put on, remove
s          search for secrets                q r z quaff, read, zap
_          travel to a chosen spot           Z e a cast, eat, apply
Ctrl-F     explore automatically             t f   throw, fire
;  :       examine a spot / look here        E p   engrave, pay
\  Ctrl-X  discoveries / attributes          #     extended commands
?          help          S  save and quit    v     version
```

### Touch

Everything above is reachable without a keyboard.

- **Tap** an adjacent square to step or attack; **tap** a distant one to travel.
- **Swipe** in any of eight directions to take one step.
- **Press and hold** a square to examine what is on it.
- The **d-pad** covers all eight directions plus wait.
- The **?** button opens a command palette: every command as a labelled button.
- Menus, prompts and the direction picker all render tappable controls.

## Running it locally

Any static file server works; the game is plain ES modules, so `file://` will
not (the browser blocks module loads from it).

```bash
python tools/devserver.py 8778
```

Then open http://localhost:8778. `tools/devserver.py` sends `Cache-Control:
no-store` and is threaded, which matters when iterating — see
[docs/DEVLOG.md](docs/DEVLOG.md) for why both of those cost time to learn.

## Tests

There is no test framework; the game core has no DOM dependency, so it runs
under Node directly with a stub UI.

```bash
node tools/systest.mjs                 # 19 system checks; the real suite
node tools/smoketest.mjs 40 3000       # random-input crash fuzzing
node tools/botrun.mjs 12 30000         # a greedy bot that plays to win
node tools/botrun.mjs --god 3 20000    # an unkillable bot, to reach level 26
```

`systest.mjs` covers every potion, scroll, wand, spell, trap, monster species
and role, all 26 depths of map generation with a connectivity proof, the save
format including its object graph, and the win condition. See
[docs/TESTING.md](docs/TESTING.md).

## Layout

```
index.html            the whole page
css/style.css         one stylesheet, mobile-first
js/
  core/               seeded RNG, small shared helpers
  map/                tiles, the Level object, four level generators
  sys/                field of view, A* and flow-field pathfinding
  data/               monsters, objects, roles - pure tables
  game/               actors, combat, AI, effects, the turn loop, save
  ui/                 canvas renderer, input, menus, prompts
assets/               57 generated sprites (PNG) with their recipes
tools/                dev server, test harnesses, asset generation scripts
docs/                 design notes, development log, asset write-up
```

## Documentation

- **[docs/DESIGN.md](docs/DESIGN.md)** — the decisions and the reasoning: the
  turn model, the identification game, the memory model, why terrain is drawn
  procedurally while everything else is a sprite.
- **[docs/DEVLOG.md](docs/DEVLOG.md)** — how it was actually built, in order,
  including every bug that mattered and how it was found.
- **[docs/ASSETS.md](docs/ASSETS.md)** — the art pipeline: 54 sprites for $0.27,
  what the generator is good and bad at, and a measured palette experiment.
- **[docs/TESTING.md](docs/TESTING.md)** — the three harnesses and what each one
  is actually able to prove.

## Credits and licence

Written by Claude (Opus 5) in a single session, for DarkBearLab.
Sprites generated with the local asset toolkit at `c:/claude_project/asset_generator`
(gpt-image behind a deterministic quantisation pipeline).

Deeply indebted to **NetHack**, whose formulas, vocabulary and cruelty this
borrows from openly. It is not a port and shares no code with it.

MIT licensed — see [LICENSE](LICENSE).
