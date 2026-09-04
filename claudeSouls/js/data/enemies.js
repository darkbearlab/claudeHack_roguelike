// The bestiary.
//
// An enemy is a **rhythm**, not a bag of numbers:
//
//   windup    turns of telegraph before the blow lands. **0 means no telegraph.**
//   recovery  turns helpless afterwards - your punish window
//   pattern   which tiles it covers, relative to facing (see game/patterns.js)
//   step      tiles it moves forward as it strikes; the telegraph already
//             accounts for this, so it is honest, just harder to walk out of
//   next      a follow-up that begins the instant this one lands, with no gap
//   poise     how much interruption it can absorb during a wind-up
//   stamina   how many blows it can throw before it must stop and breathe
//
// ---------------------------------------------------------------------------
// Three rules govern this table, and all three came out of play testing rather
// than design:
//
// 1. **Everything telegraphs. Every blow in this game is announced.**
//    This was not always true, and reverting to it is the single largest
//    correction the roster has had - see the hound below for the numbers. What
//    replaces concealment is **commitment**: an attack can step forward as it
//    lands, so reading it does not mean walking out of it for free. Being
//    unable to see a blow coming is not difficulty, it is arithmetic, and with
//    no dice anywhere in this game arithmetic is all it can ever be.
//
// 2. **Every shape wants a different answer.** When every attack was reach-1,
//    one step backwards solved the entire game - and stepping back is free,
//    so the stamina system never engaged. Lines punish retreating along them,
//    wide arcs and radial attacks need two tiles of movement (so: roll), and
//    combinations punish the instinctive sidestep.
//
// 3. **Poise decides what can be interrupted.** Without it a 4-stamina jab
//    could postpone a 7-stamina overhead for ever, and 1v1 was solved by
//    standing still and swinging.

const E = (key, o) => ({
  key,
  name: o.name,
  glyph: o.glyph,
  colour: o.colour,
  sprite: o.sprite ?? null,
  hp: o.hp,
  speed: o.speed ?? 12,
  stamina: o.stamina ?? 12,
  staminaRegen: o.staminaRegen ?? 3,
  poise: o.poise ?? 3,
  sight: o.sight ?? 9,
  minDepth: o.minDepth ?? 1,
  maxDepth: o.maxDepth ?? 99,
  freq: o.freq ?? 10,
  group: o.group ?? null,
  opensDoors: o.opensDoors ?? false,
  keepsDistance: o.keepsDistance ?? false,
  charges: o.charges ?? false,
  attacks: o.attacks,
  boss: o.boss ?? false,
  // Tiles on a side. Anything above 1 is room-bound - see the note on the
  // First Flame, and Level.bodyFits.
  size: o.size ?? 1,
});

const atk = (o) => ({
  name: o.name,
  kind: o.kind ?? 'melee',
  windup: o.windup,                 // 0 = no telegraph, resolves at once
  recovery: o.recovery,
  pattern: o.pattern ?? 'front',
  range: o.range ?? 1,
  damage: o.damage,
  cost: o.cost ?? 4,
  step: o.step ?? 0,                // tiles moved forward on resolve
  weight: o.weight ?? 1,            // how often it is picked among the options
  next: o.next ?? null,             // follow-up, begins immediately, no gap
  reaim: o.reaim ?? false,          // a follow-up that turns to face you again
  unblockable: o.unblockable ?? false,   // a shield is no help against this
  projectile: o.projectile ?? null,
  // { times, advance } - a charge that swings, moves and repeats. The area it
  // hits is the attacker's own footprint moved forward, not a pattern, so it
  // scales with the body. See rushStops in ai.js.
  rush: o.rush ?? null,
});

export const ENEMIES = [

  // ---- fast, and committed ------------------------------------------------
  // These used to strike with no telegraph at all, which was a mistake worth
  // recording. The reason for it was real: when every attack was `front` at
  // reach one, stepping back one tile beat everything, and stepping back is
  // free. But the shape library solved that independently - lines punish
  // retreating along them, sweeps punish the sidestep, arcs need two tiles - so
  // the justification was spent while the side effect stayed.
  //
  // And the side effect was severe. Measured by encounter weight, 54 to 62% of
  // everything you met at every depth carried an unannounced attack, and
  // killing a brute with a sword cost you a third of a light health bar in
  // damage you could not interact with. Against the boss it was 133%: more than
  // your whole pool, spent on an attack you were never allowed to read.
  //
  // The fix is **commitment instead of concealment**. A hound announces its
  // pounce and then comes with you, so backing off does not help - the wind-up
  // already accounts for the step, which makes it honest and still unavoidable
  // by walking. You roll, you block, or you hit it first: at poise 2 a single
  // strike breaks it, so the answer to a pouncing hound is the thing a melee
  // character wanted to do anyway.
  E('hound', {
    name: 'hound', glyph: 'd', colour: '#c8a24a', sprite: 'mon_jackal',
    hp: 4, speed: 18, stamina: 9, staminaRegen: 4, poise: 2,
    minDepth: 1, freq: 20, group: [2, 3],
    // arc3, not front. `step` only closes off *backing away* - the attack tiles
    // are fixed at wind-up and the hound comes with you - but a sidestep still
    // beat it, and measured across the roster a free single step escaped
    // fourteen of eighteen attacks. Width is what answers a sidestep.
    attacks: [atk({
      name: 'pounce', windup: 1, recovery: 2, pattern: 'arc3', damage: 2, cost: 3, step: 1,
      next: atk({ name: 'snap', windup: 1, recovery: 2, pattern: 'front', damage: 2,
                  cost: 0, reaim: true }),
    })],
  }),

  // Long legs: one step back is not out of reach, so the answer is a sidestep
  // or a roll rather than a shuffle.
  E('crawler', {
    name: 'crawler', glyph: 's', colour: '#3a3a44', sprite: 'mon_spider',
    hp: 5, speed: 15, stamina: 10, staminaRegen: 4, poise: 2,
    minDepth: 2, freq: 15, group: [2, 4],
    attacks: [atk({ name: 'lash', windup: 1, recovery: 2, pattern: 'reach2', range: 2,
                    damage: 2, cost: 3 })],
  }),

  // ---- the teaching enemy --------------------------------------------------
  E('husk', {
    name: 'husk', glyph: 'z', colour: '#7aa06a', sprite: 'mon_zombie',
    hp: 7, speed: 6, stamina: 10, staminaRegen: 3, poise: 3,
    minDepth: 1, freq: 20,
    attacks: [atk({ name: 'grasp', windup: 2, recovery: 2, pattern: 'arc3', damage: 3, cost: 4 })],
  }),

  // ---- reach: retreating in a straight line does not work ------------------
  E('sentinel', {
    name: 'sentinel', glyph: 'Z', colour: '#d8d4c8', sprite: 'mon_skeleton',
    hp: 11, speed: 12, stamina: 12, poise: 4,
    minDepth: 2, freq: 16, opensDoors: true,
    attacks: [
      // The lance owns the lane; the sweep that follows owns the two tiles you
      // stepped to in order to leave it. Between them there is somewhere to be,
      // but it is not one free step away.
      atk({
        name: 'lance', windup: 2, recovery: 2, pattern: 'line3', range: 3, damage: 3, cost: 5,
        next: atk({ name: 'sweep', windup: 1, recovery: 2, pattern: 'arc3', damage: 2, cost: 0 }),
      }),
    ],
  }),

  // ---- the combination enemy ----------------------------------------------
  // A jab you cannot see coming, and a two-part sweep you can. Learning which
  // is which is the point of this species.
  E('swordsman', {
    name: 'swordsman', glyph: '@', colour: '#c04a4a', sprite: 'mon_soldier',
    hp: 10, speed: 12, stamina: 13, poise: 4,
    minDepth: 3, freq: 16, opensDoors: true,
    attacks: [
      // The sweep combo already punishes the sidestep, so an unreadable jab on
      // top of it was redundant as well as unfair.
      atk({ name: 'jab', windup: 1, recovery: 2, pattern: 'front', damage: 2, cost: 4, weight: 2 }),
      atk({
        name: 'sweep', windup: 2, recovery: 2, pattern: 'sweepL', damage: 3, cost: 6,
        next: atk({ name: 'backswing', windup: 1, recovery: 2, pattern: 'sweepR', damage: 3, cost: 0 }),
      }),
    ],
  }),

  E('warden', {
    name: 'warden', glyph: 'W', colour: '#8a6ac0', sprite: 'mon_wraith',
    hp: 15, speed: 12, stamina: 14, poise: 6,
    minDepth: 6, freq: 12, opensDoors: true,
    attacks: [
      atk({
        name: 'scythe', windup: 2, recovery: 2, pattern: 'sweepL', damage: 4, cost: 6,
        next: atk({ name: 'return cut', windup: 1, recovery: 2, pattern: 'sweepR', damage: 4, cost: 0 }),
      }),
      atk({ name: 'whirl', windup: 3, recovery: 2, pattern: 'around', damage: 3, cost: 7 }),
    ],
  }),

  // ---- ranged: distance is the resource ------------------------------------
  E('archer', {
    name: 'archer', glyph: 'a', colour: '#b8935a', sprite: 'hero_ranger',
    hp: 6, speed: 10, stamina: 12, staminaRegen: 3, poise: 2, sight: 12,
    minDepth: 2, freq: 16, keepsDistance: true,
    attacks: [atk({
      name: 'loose', kind: 'ranged', windup: 2, recovery: 2, range: 10, damage: 3, cost: 5,
      projectile: { speed: 3, glyph: '→', colour: '#e0d0a0' },
    })],
  }),

  E('flamekeeper', {
    name: 'flamekeeper', glyph: 'L', colour: '#e08a3c', sprite: 'mon_lich',
    hp: 12, speed: 9, stamina: 14, staminaRegen: 3, poise: 5, sight: 12,
    minDepth: 5, freq: 10, keepsDistance: true, opensDoors: true,
    attacks: [atk({
      name: 'cinder', kind: 'ranged', windup: 3, recovery: 3, range: 9, damage: 4, cost: 7,
      projectile: { speed: 2, glyph: '*', colour: '#ff9a3c' },
    })],
  }),

  // ---- the big read --------------------------------------------------------
  // A five-tile wall, and it steps forward as it swings, so backing off one
  // square is not enough. Poise 8 means nothing you own can interrupt it in
  // three turns: you have to move.
  E('brute', {
    name: 'brute', glyph: 'T', colour: '#4a8a4a', sprite: 'mon_troll',
    hp: 18, speed: 9, stamina: 14, staminaRegen: 3, poise: 8,
    minDepth: 3, freq: 12, opensDoors: true,
    attacks: [
      atk({
        name: 'overhead', windup: 3, recovery: 2, pattern: 'arc5', damage: 5, cost: 7, step: 1,
        next: atk({ name: 'return swing', windup: 1, recovery: 2, pattern: 'arc3', damage: 3,
                    cost: 0, reaim: true }),
      }),
      atk({ name: 'backhand', windup: 1, recovery: 2, pattern: 'front', damage: 2, cost: 3, weight: 2 }),
    ],
  }),

  // ---- get out of the lane -------------------------------------------------
  E('minotaur', {
    name: 'horned one', glyph: 'H', colour: '#8a5a3a', sprite: 'mon_minotaur',
    hp: 22, speed: 12, stamina: 16, poise: 8,
    minDepth: 7, freq: 9, opensDoors: true, charges: true,
    // Two tiles a side. That makes it room-bound - a 2x2 fits under 2% of
    // corridor - so it stops being something that follows you through the
    // dungeon and becomes something that owns the room it is in. The charge
    // below is why it is worth the trade.
    size: 2,
    attacks: [
      // A charge in three strides: hit the ground ahead, move into it, again,
      // again. The ground it hits is its own 2x2 footprint moved forward, so
      // what it threatens is exactly the space it is about to occupy - which
      // is both the honest telegraph and, incidentally, the fix for a two-tile
      // bull swinging a one-tile punch.
      //
      // The whole path is drawn during the wind-up. Three strides announced by
      // one telegraph would otherwise be two unannounced blows.
      //
      // Unblockable, and flagged rather than derived. A shield does nothing
      // against something that ran you over - and which attacks ignore a shield
      // is the sort of thing a player has to be able to look up, not infer from
      // geometry. Same reasoning as the wind-up flag.
      atk({ name: 'charge', windup: 2, recovery: 2, damage: 5, cost: 8,
            rush: { times: 3, advance: 2 },
            unblockable: true,
            next: atk({ name: 'gore', windup: 1, recovery: 2, pattern: 'arc3', damage: 3,
                        cost: 0, reaim: true }) }),
      atk({ name: 'gore', windup: 1, recovery: 2, pattern: 'reach2', range: 2, damage: 3, cost: 5, weight: 2 }),
    ],
  }),

  // ---- the bottom of the dungeon -------------------------------------------
  E('firstflame', {
    name: 'the First Flame', glyph: 'D', colour: '#e0402a', sprite: 'mon_dragon',
    hp: 70, speed: 12, stamina: 22, staminaRegen: 4, poise: 12, sight: 14,
    minDepth: 99, freq: 0, boss: true, opensDoors: true,
    // Four squares of dragon. It is the right first big thing precisely
    // because it never has to leave its room: measured over 300 floors, a 2x2
    // body fits half of all room tiles but under 2% of corridor, so anything
    // this size is room-bound by construction. For a wandering monster that
    // would be a defect; for the thing at the bottom of the dungeon it is
    // simply true, and it makes the sanctum the arena rather than a corridor
    // you fight it in one tile at a time.
    size: 2,
    attacks: [
      atk({ name: 'sear', kind: 'ranged', windup: 2, recovery: 2, range: 12, damage: 4, cost: 5,
            projectile: { speed: 4, glyph: '*', colour: '#ff7a3a' } }),
      atk({ name: 'rake', windup: 1, recovery: 2, pattern: 'front', damage: 2, cost: 4, weight: 2 }),
      atk({
        name: 'tail sweep', windup: 2, recovery: 2, pattern: 'sweepL', damage: 4, cost: 6,
        next: atk({ name: 'back sweep', windup: 1, recovery: 2, pattern: 'sweepR', damage: 4, cost: 0 }),
      }),
      atk({ name: 'pyre', windup: 3, recovery: 2, pattern: 'around2', damage: 6, cost: 9 }),
    ],
  }),
];

export const ENEMY_BY_KEY = Object.fromEntries(ENEMIES.map((e) => [e.key, e]));

const POOL = ENEMIES.filter((e) => e.freq > 0);

export function pickEnemy(rng, depth) {
  const pool = POOL.filter((e) => depth >= e.minDepth && depth <= e.maxDepth);
  if (!pool.length) return POOL[0];
  return rng.pickWeighted(pool, (e) => e.freq * (1 + (depth - e.minDepth) * 0.15));
}
