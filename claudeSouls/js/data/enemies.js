// The bestiary.
//
// A completely different schema from claudeHack's. There, an enemy was
// (level, speed, armour class, damage dice) - a bag of numbers that resolves
// against a die roll. Here an enemy is a **rhythm**:
//
//   windup   how many turns it telegraphs before the blow lands
//   recovery how many turns it is helpless afterwards - your punish window
//   pattern  which tiles the blow covers, relative to where it is facing
//   stamina  how many blows it can throw before it has to stop and breathe
//
// Those four fields are the whole design. Difficulty is tuned by changing the
// *rhythm*, not by inflating hit points: a slow enemy with a three-turn wind-up
// and a four-turn recovery is a puzzle you solve, and the same enemy with a
// one-turn wind-up is a threat you flee. Neither needs more health.
//
// `speed` is energy per turn against a baseline of 12, and it decides one thing
// above all: **can the player walk away?** Under 12 means yes, over 12 means no.
// A level needs both, or "run past it" stops being a real option and the walk
// back from a bonfire becomes a punishment rather than a challenge.
//
// Sprites are reused from claudeHack's library. The roster is deliberately
// small - ten behaviours you can read beat sixty you cannot.

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
  sight: o.sight ?? 9,
  minDepth: o.minDepth ?? 1,
  maxDepth: o.maxDepth ?? 99,
  freq: o.freq ?? 10,
  group: o.group ?? null,
  opensDoors: o.opensDoors ?? false,
  keepsDistance: o.keepsDistance ?? false,
  attacks: o.attacks,
  boss: o.boss ?? false,
});

// windup / recovery are in turns. cost is stamina.
const atk = (o) => ({
  name: o.name,
  kind: o.kind ?? 'melee',          // 'melee' | 'ranged'
  windup: o.windup,
  recovery: o.recovery,
  pattern: o.pattern ?? 'front',    // see js/game/patterns.js
  range: o.range ?? 1,              // melee: pattern reach. ranged: max distance
  damage: o.damage,
  cost: o.cost ?? 4,
  projectile: o.projectile ?? null, // {speed, glyph, colour}
});

export const ENEMIES = [

  // ---- slow and heavy: outrunnable, punishing if you stand still ----------
  E('husk', {
    name: 'husk', glyph: 'z', colour: '#7aa06a', sprite: 'mon_zombie',
    hp: 7, speed: 6, stamina: 10, staminaRegen: 3, minDepth: 1, freq: 22,
    attacks: [atk({ name: 'grasp', windup: 2, recovery: 2, pattern: 'front', damage: 2, cost: 4 })],
  }),

  E('brute', {
    name: 'brute', glyph: 'T', colour: '#4a8a4a', sprite: 'mon_troll',
    hp: 18, speed: 9, stamina: 14, staminaRegen: 3, minDepth: 3, freq: 12,
    opensDoors: true,
    attacks: [
      // The signature enemy of the game: a three-turn wind-up that covers three
      // tiles for five damage. Impossible to tank, trivial to walk out of, and
      // a four-turn recovery afterwards that is your whole damage window.
      atk({ name: 'overhead', windup: 3, recovery: 4, pattern: 'arc3', damage: 5, cost: 7 }),
      atk({ name: 'backhand', windup: 1, recovery: 1, pattern: 'front', damage: 2, cost: 3 }),
    ],
  }),

  E('sentinel', {
    name: 'sentinel', glyph: 'Z', colour: '#d8d4c8', sprite: 'mon_skeleton',
    hp: 11, speed: 12, stamina: 12, minDepth: 2, freq: 16, opensDoors: true,
    attacks: [
      // Reaches two tiles. Backing off one square does not save you; you have
      // to actually leave, which is what makes it different from the husk.
      atk({ name: 'thrust', windup: 2, recovery: 2, pattern: 'reach2', range: 2, damage: 3, cost: 5 }),
    ],
  }),

  // ---- fast: cannot be outrun, must be dealt with -------------------------
  E('hound', {
    name: 'hound', glyph: 'd', colour: '#c8a24a', sprite: 'mon_jackal',
    hp: 4, speed: 18, stamina: 9, staminaRegen: 4, minDepth: 1, freq: 20,
    group: [2, 3],
    attacks: [atk({ name: 'bite', windup: 1, recovery: 1, pattern: 'front', damage: 2, cost: 3 })],
  }),

  E('crawler', {
    name: 'crawler', glyph: 's', colour: '#3a3a44', sprite: 'mon_spider',
    hp: 5, speed: 15, stamina: 10, staminaRegen: 4, minDepth: 2, freq: 15,
    group: [2, 4],
    attacks: [atk({ name: 'lash', windup: 1, recovery: 2, pattern: 'front', damage: 2, cost: 3 })],
  }),

  // ---- ranged: makes distance a resource ----------------------------------
  E('archer', {
    name: 'archer', glyph: 'a', colour: '#b8935a', sprite: 'hero_ranger',
    hp: 6, speed: 10, stamina: 12, staminaRegen: 3, sight: 12,
    minDepth: 2, freq: 16, keepsDistance: true,
    attacks: [atk({
      name: 'loose', kind: 'ranged', windup: 2, recovery: 3, range: 10, damage: 3, cost: 5,
      projectile: { speed: 3, glyph: '→', colour: '#e0d0a0' },
    })],
  }),

  E('flamekeeper', {
    name: 'flamekeeper', glyph: 'L', colour: '#e08a3c', sprite: 'mon_lich',
    hp: 12, speed: 9, stamina: 14, staminaRegen: 3, sight: 12,
    minDepth: 5, freq: 10, keepsDistance: true, opensDoors: true,
    attacks: [atk({
      name: 'cinder', kind: 'ranged', windup: 3, recovery: 4, range: 9, damage: 4, cost: 7,
      projectile: { speed: 2, glyph: '*', colour: '#ff9a3c' },
    })],
  }),

  // ---- humanoids: the mixed threat ---------------------------------------
  E('swordsman', {
    name: 'swordsman', glyph: '@', colour: '#c04a4a', sprite: 'mon_soldier',
    hp: 10, speed: 12, stamina: 12, minDepth: 3, freq: 16, opensDoors: true,
    attacks: [
      atk({ name: 'slash', windup: 1, recovery: 2, pattern: 'arc3', damage: 3, cost: 5 }),
      atk({ name: 'stab',  windup: 2, recovery: 1, pattern: 'front', damage: 4, cost: 5 }),
    ],
  }),

  E('warden', {
    name: 'warden', glyph: 'W', colour: '#8a6ac0', sprite: 'mon_wraith',
    hp: 15, speed: 12, stamina: 14, minDepth: 6, freq: 12, opensDoors: true,
    attacks: [
      atk({ name: 'scythe', windup: 2, recovery: 3, pattern: 'arc3', damage: 4, cost: 6 }),
      atk({ name: 'spin',   windup: 3, recovery: 3, pattern: 'around', damage: 3, cost: 7 }),
    ],
  }),

  E('minotaur', {
    name: 'horned one', glyph: 'H', colour: '#8a5a3a', sprite: 'mon_minotaur',
    hp: 22, speed: 12, stamina: 16, minDepth: 7, freq: 9, opensDoors: true,
    attacks: [
      atk({ name: 'gore',  windup: 2, recovery: 2, pattern: 'reach2', range: 2, damage: 4, cost: 5 }),
      atk({ name: 'stomp', windup: 3, recovery: 3, pattern: 'around', damage: 5, cost: 8 }),
    ],
  }),

  // ---- the bottom of the dungeon -----------------------------------------
  E('firstflame', {
    name: 'the First Flame', glyph: 'D', colour: '#e0402a', sprite: 'mon_dragon',
    hp: 70, speed: 12, stamina: 20, staminaRegen: 4, sight: 14,
    minDepth: 99, freq: 0, boss: true, opensDoors: true,
    attacks: [
      atk({ name: 'sear',   kind: 'ranged', windup: 2, recovery: 2, range: 12, damage: 4, cost: 5,
            projectile: { speed: 4, glyph: '*', colour: '#ff7a3a' } }),
      atk({ name: 'rake',   windup: 1, recovery: 2, pattern: 'arc3', damage: 4, cost: 5 }),
      atk({ name: 'pyre',   windup: 3, recovery: 4, pattern: 'around2', damage: 6, cost: 9 }),
    ],
  }),
];

export const ENEMY_BY_KEY = Object.fromEntries(ENEMIES.map((e) => [e.key, e]));

const POOL = ENEMIES.filter((e) => e.freq > 0);

/** Which species can appear at this depth, weighted. */
export function pickEnemy(rng, depth) {
  const pool = POOL.filter((e) => depth >= e.minDepth && depth <= e.maxDepth);
  if (!pool.length) return POOL[0];
  // Mild bias towards the deeper end of what is allowed, so descending is felt
  // without ever removing the cheap enemies that make a level readable.
  return rng.pickWeighted(pool, (e) => e.freq * (1 + (depth - e.minDepth) * 0.15));
}
