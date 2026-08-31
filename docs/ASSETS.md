# The art: what the pipeline did, and what it taught

All 57 sprites in `assets/` were generated during this session with the shared
toolkit at `c:/claude_project/asset_generator`. This is the write-up the brief
asked for: the numbers, the findings, and the two places where the pipeline's
shape changed the game's design rather than the other way round.

---

## The numbers

| | |
| --- | --- |
| Sprites generated this session | 54 |
| Reused from the existing library | 3 (stone wall, crate, barrel) |
| Failures | 0 |
| Cost | **$0.2673**, about $0.0049 each |
| Wall clock | ~22 minutes, unattended, in the background |
| Output | 48x64 PNG, 4-bit indexed, 15 colours + transparency |
| Average file | **869 bytes** |
| Whole art set | **48 KB** |

Forty-eight kilobytes for a complete tileset is worth pausing on. The
quantisation stage is not decoration — it is the reason this game can ship its
art inline on a page with no loading screen and no atlas.

## What was made

```
heroes (4)    fighter, wizard, rogue, ranger
monsters (24) rat jackal kobold orc floating-eye gnome spider skeleton zombie
              ant dragon newt mold cockatrice mindflayer minotaur wraith troll
              snake bat lich soldier wolf beholder
items (16)    potion scroll wand ring amulet sword dagger axe bow armor shield
              helmet food gold gem book key bones
features (8)  stairs-down stairs-up door chest altar fountain trap boulder
reused (3)    wall crate barrel
```

Sixty-three monster species share 24 monster sprites. That is deliberate: a
wolf sprite serves warg and winter wolf, a skeleton serves every skeletal
undead. A distinct silhouette per species would have cost three times the art
for a distinction the glyph and the colour already carry, and at 25 px on a
phone the silhouettes would not have read as different anyway.

The brief said to generate a few extras beyond what was strictly needed. The
ones that earned their place were `feat_boulder`, `feat_chest` and `item_key` —
none was in the original plan and all three ended up used (the chest doubles as
the throne). `mon_beholder` was pure indulgence and became the Sanctum guardian.

---

## Finding 1: the generator makes objects, not tiles — and that decided the renderer

This is the important one.

The pipeline produces **background-removed objects**. It has no tiling path: no
seam check, no power-of-two sizes, no guarantee that an image joins to itself.
The toolkit's own `--list-kinds` says so plainly, which saved an experiment.

The naive plan — one sprite per terrain type — would have produced a floor with
visible seams at every cell boundary and a wall with gaps at the joins. So
terrain in claudeHack is drawn procedurally: `fillRect` with a per-cell
deterministic hash for variation, plus a light top edge and dark bottom edge on
walls to read as solid blocks.

That turned out better than the sprite version would have been, for reasons that
have nothing to do with the generator's quality:

- it tiles perfectly, by construction;
- it costs zero bytes and zero requests;
- it takes the lighting multiplier for free, so "seen but not currently visible"
  is one `dim` factor rather than a second dimmed sprite set;
- it scales to any cell size, which matters when the same page runs at 25 px on
  a phone and 60 px on a desktop.

**The generalisable lesson:** match the tool to the *class* of asset, not to the
asset list. Objects that stand on a floor with a transparent background are
exactly what this pipeline is good at. Repeating textures are exactly what it is
not. Discovering which is which before generating anything cost one `--list-kinds`
call and saved a wasted batch.

---

## Finding 2: palette set count — a measured answer to a parked question

The toolkit's handover notes parked a comparison of 4 versus 8 palette sets
until the library passed twenty assets, on the grounds that four sets over four
assets is a structural artefact and proves nothing. Adding 54 assets took the
library to 59, which made the question answerable.

`--build-palette` and `--regenerate-all` are both free, so the whole experiment
cost nothing but time. Three configurations, same 59 assets, same pipeline:

| palette sets | median fit error | mean | worst | `PALETTE_SET_POOR_FIT` |
| --- | --- | --- | --- | --- |
| 4 | 9.22 | 9.85 | 25.94 | 16 / 59 |
| 8 | 7.93 | 8.77 | 29.45 | 12 / 59 |
| **12** | **6.36** | **7.23** | **16.11** | **6 / 59** |

Twelve sets wins on every measure, and the worst case improves most: 25.94 to
16.11. That is the number that matters, because the worst-fitting asset is the
one a player notices.

The library is left at 12 sets.

**Two caveats, stated because a table without them is misleading:**

1. Twelve is not hardware-authentic. The SNES PPU had eight sprite palettes and
   the toolkit's design is explicitly modelled on that. This game renders to a
   canvas with no palette hardware, so the constraint that motivated eight does
   not apply — but a project targeting real sprite hardware should not read this
   table as "use twelve".
2. More sets means less sharing, and less sharing means a *less coherent* look.
   Error went down monotonically; coherence was not measured. With 59 assets in
   one style the difference was not visible to the eye, but the trend does not
   continue forever — at 59 sets each asset would have its own private palette
   and score perfectly while looking like 59 unrelated games.

`PALETTE_SET_POOR_FIT` also behaved exactly as the toolkit documents: it is a
*fixable* warning, and rebuilding the sets fixed 10 of 16 instances. It should
not be confused with `HIGH_QUANT_ERROR`, which is the subject being too complex
for a 15-colour budget and which no palette work will fix.

---

## Finding 3: flat subjects survive, textured ones do not

The cookbook says this and the batch confirmed it without exception.

The 14 assets still carrying `HIGH_QUANT_ERROR` at 12 palette sets are the ones
with gradients or fine texture in the source render: the fountain (water),
gemstone (facets), spellbook (cover detail), amulet (metal sheen), pile of gold
(dozens of coin edges). The ones that came out cleanest are exactly the flat,
boldly-coloured, single-shape subjects — key, armour, dagger, sword, altar,
boulder.

The prompt wording that worked, every time: **a colour, a material, one shape.**

```
"a gold ring set with a green gem"          clean
"a rolled parchment scroll tied with a red ribbon"   clean
"a pile of gold coins"                      HIGH_QUANT_ERROR
"a round stone fountain full of blue water" HIGH_QUANT_ERROR
```

The failures are all cases where the description implies *many small things*
(coins, facets, ripples). Where a game needs such an object, the fix is to ask
for a simpler version of it, not to spend re-rolls chasing a look the colour
budget cannot hold.

`BACKDROP_COLOUR_IN_PALETTE` fired on 14 assets and was harmless in every case —
it means an enclosed gap (a ring's hole, the space between a bow and its string)
kept the backdrop colour, because a flood fill cannot reach inside it. At 25–50
px it is invisible. The toolkit's advice to look at the PNG before acting on a
warning was correct: none of these needed anything done.

---

## Finding 4: batch, do not iterate

Generation is ~20 s per sprite and costs real money per call. The whole 54-asset
list went into one shell script, run in the background, while the game's core
was being written. When the object tables needed sprite names, the sprites
existed.

The alternative — generate, look, adjust, generate — would have serialised
twenty minutes of network latency against the coding, and each "adjust" would
have been a `--new-image` re-roll at full price for art that was already fine.

The script (`tools/gen_assets.sh`) is checked in, skips anything already in the
library, logs per-asset, and continues past failures. Re-running it costs
nothing and generates nothing.

The complementary discipline: **name the assets when you generate them.**
Passing `--name mon_rat` rather than accepting the default
`unit-topdown_a-giant-brown-rat_64` meant the game's data tables could reference
sprite names that were decided before the art existed. The three reused
pre-existing assets are the ones that had to be renamed by hand afterwards.

---

## Finding 5: two facts about the export model worth knowing up front

The library is **pull, not push**: assets are made in the library and stay
there; a project copies out what it needs with `--export`. The copy is
deliberately allowed to go stale — rebuilding a palette in the library does not
change art a game has already shipped.

That is right, and it has a consequence worth planning for: **rebuild the
palettes before exporting, not after.** The palette experiment above was run
first and the 57 exports were taken from the 12-set state. Doing it the other
way round would have meant either shipping the worse art or re-exporting all 57
files.

Second: `--export` copies the `.png` *and* its `.recipe.json`, and they are
meant to travel together. `assets/` in this repository holds both. The recipe is
what makes an exported sprite traceable — which style pack, which tool versions,
which prompt — and `--check-stale` needs it. It costs about 400 bytes per asset
and it is the difference between a folder of PNGs and a reproducible art set.

---

## Summary for the next project

1. Ask `--list-kinds` what the pipeline **cannot** do before planning around it.
   Repeating textures are not on the menu; objects are.
2. Batch the whole list in the background at the start of the session. It is
   free wall clock.
3. Name assets deliberately; the code will reference those names.
4. Rebuild palettes *before* exporting.
5. Describe subjects as **one colour, one material, one shape**. Anything that
   means "many small things" will trip `HIGH_QUANT_ERROR` and no amount of
   re-rolling will fix it.
6. Read warnings as advice, not errors. Look at the PNG. Of 34 warnings across
   57 assets, exactly zero required action beyond one free palette rebuild.
7. Design the renderer around what the pipeline produces, not around what you
   imagined. Procedural terrain plus generated objects was a better outcome than
   the all-sprite plan, and cost less.

Total spend for a complete 57-sprite tileset: **$0.27**.
