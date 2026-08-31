// Player roles.
//
// A role is three things at once and it is worth separating them mentally:
//   - a starting kit, which decides the first twenty turns;
//   - a set of attribute weights, which decides the first two thousand;
//   - one or two structural abilities, which decide how the role is *played*.
//
// The last is the part that matters. A Rogue that is just "a Valkyrie with a
// smaller sword" is not a role. Backstab, searching, spellcasting and the bow
// are what make the six of these actually different games.
//
// Strength here is a plain 3..25 integer rather than NetHack's 18/xx exceptional
// band. The band adds a table lookup and a display special case in exchange for
// granularity nobody notices; a straight scale with the same end points reads
// better and behaves the same at the extremes.

export const ROLES = [
  {
    key: 'valkyrie',
    name: 'Valkyrie',
    sprite: 'hero_fighter',
    blurb: 'A shieldmaiden of the north. Hits hard, is hard to hit, ignores the cold. The forgiving choice.',
    attr: { str: 17, dex: 12, con: 16, int: 8,  wis: 10, cha: 8 },
    hpBase: 16, hpLevel: [4, 8],       // d(1,8)+4 per level
    pwBase: 2,  pwLevel: [0, 2],
    ac: 6,
    speed: 12,
    intrinsics: ['coldRes'],
    skills: { melee: 2, ranged: 0, magic: 0, stealth: 0, search: 0 },
    startItems: [
      { key: 'long sword',   cls: 'weapon', enchant: 1, wield: true },
      { key: 'dagger',       cls: 'weapon', count: 1 },
      { key: 'small shield', cls: 'armor',  enchant: 3, wear: true },
      { key: 'food ration',  cls: 'food',   count: 1 },
    ],
    alignment: 'neutral',
  },
  {
    key: 'barbarian',
    name: 'Barbarian',
    sprite: 'hero_fighter',
    blurb: 'Enormous, unsubtle, immune to poison. Swings a two-handed sword and does not read.',
    attr: { str: 18, dex: 12, con: 18, int: 7,  wis: 8,  cha: 8 },
    hpBase: 18, hpLevel: [4, 8],
    pwBase: 1,  pwLevel: [0, 1],
    ac: 7,
    speed: 12,
    intrinsics: ['poisonRes'],
    skills: { melee: 3, ranged: 0, magic: -2, stealth: 0, search: 0 },
    startItems: [
      { key: 'two-handed sword', cls: 'weapon', wield: true },
      { key: 'ring mail',        cls: 'armor',  wear: true },
      { key: 'food ration',      cls: 'food',   count: 1 },
    ],
    alignment: 'neutral',
  },
  {
    key: 'wizard',
    name: 'Wizard',
    sprite: 'hero_wizard',
    blurb: 'Frail, clever, and the only role that starts with a wand and a spell. Dies to a jackal if careless.',
    attr: { str: 10, dex: 12, con: 12, int: 18, wis: 12, cha: 10 },
    hpBase: 10, hpLevel: [0, 4],
    pwBase: 12, pwLevel: [2, 6],
    ac: 9,
    speed: 12,
    intrinsics: [],
    skills: { melee: -1, ranged: 0, magic: 3, stealth: 1, search: 1 },
    startSpells: ['force bolt'],
    startItems: [
      { key: 'quarterstaff', cls: 'weapon', enchant: 1, wield: true },
      { key: 'cloak of magic resistance', cls: 'armor', enchant: 1, wear: true },
      { key: 'force bolt',   cls: 'spellbook' },
      { key: 'magic missile', cls: 'wand' },
      { key: 'food ration',  cls: 'food',  count: 1 },
    ],
    alignment: 'chaotic',
  },
  {
    key: 'rogue',
    name: 'Rogue',
    sprite: 'hero_rogue',
    blurb: 'Stabs things in the back for triple damage, picks every lock, and is not seen coming.',
    attr: { str: 12, dex: 18, con: 12, int: 12, wis: 10, cha: 8 },
    hpBase: 12, hpLevel: [1, 6],
    pwBase: 3,  pwLevel: [0, 3],
    ac: 8,
    speed: 12,
    intrinsics: ['stealth'],
    skills: { melee: 1, ranged: 2, magic: 0, stealth: 3, search: 2 },
    backstab: true,
    startItems: [
      { key: 'short sword',   cls: 'weapon', wield: true },
      { key: 'dagger',        cls: 'weapon', count: 6 },
      { key: 'leather armor', cls: 'armor',  wear: true },
      { key: 'lock pick',     cls: 'tool' },
      { key: 'food ration',   cls: 'food',   count: 1 },
    ],
    alignment: 'chaotic',
  },
  {
    key: 'ranger',
    name: 'Ranger',
    sprite: 'hero_ranger',
    blurb: 'Kills things at range and finds the secret doors. Weak in a corner, deadly across a room.',
    attr: { str: 13, dex: 16, con: 13, int: 13, wis: 14, cha: 11 },
    hpBase: 13, hpLevel: [2, 6],
    pwBase: 4,  pwLevel: [0, 3],
    ac: 8,
    speed: 12,
    intrinsics: ['searching'],
    skills: { melee: 0, ranged: 3, magic: 0, stealth: 2, search: 3 },
    startItems: [
      { key: 'bow',           cls: 'weapon', enchant: 1, wield: true },
      { key: 'arrow',         cls: 'weapon', count: 50, enchant: 2 },
      { key: 'dagger',        cls: 'weapon', count: 1 },
      { key: 'cloak of displacement', cls: 'armor', enchant: 2, wear: true },
      { key: 'food ration',   cls: 'food',   count: 1 },
    ],
    alignment: 'chaotic',
  },
  {
    key: 'healer',
    name: 'Healer',
    sprite: 'hero_wizard',
    blurb: 'Starts with more healing than anyone and less capacity to fight. A puzzle role.',
    attr: { str: 9,  dex: 13, con: 14, int: 13, wis: 16, cha: 15 },
    hpBase: 11, hpLevel: [1, 5],
    pwBase: 10, pwLevel: [1, 5],
    ac: 9,
    speed: 12,
    intrinsics: ['poisonRes'],
    skills: { melee: -1, ranged: 0, magic: 2, stealth: 0, search: 0 },
    startSpells: ['healing'],
    startItems: [
      { key: 'knife',          cls: 'weapon', wield: true },
      { key: 'leather gloves', cls: 'armor',  enchant: 1, wear: true },
      { key: 'healing',        cls: 'potion', count: 4 },
      { key: 'extra healing',  cls: 'potion', count: 1 },
      { key: 'healing',        cls: 'spellbook' },
      { key: 'apple',          cls: 'food',   count: 2 },
    ],
    startGold: 400,
    alignment: 'neutral',
  },
];

export const ROLE_BY_KEY = Object.fromEntries(ROLES.map((r) => [r.key, r]));

// Experience thresholds. NetHack doubles up to level 10 then goes linear-ish;
// this keeps the same shape without the 30-entry table.
export function xpForLevel(n) {
  if (n <= 1) return 0;
  if (n <= 10) return 10 * (1 << (n - 1));
  return 10000 * (n - 9);
}

export const MAX_XP_LEVEL = 30;

/** Attribute bonuses. One table, used by to-hit, damage, AC and carry capacity. */
export function strHitBonus(str) {
  if (str < 6) return -2;
  if (str < 8) return -1;
  if (str < 17) return 0;
  if (str < 19) return 1;
  if (str < 21) return 2;
  return 3;
}
export function strDamBonus(str) {
  if (str < 6) return -1;
  if (str < 16) return 0;
  if (str < 18) return 1;
  if (str < 19) return 2;
  if (str < 21) return 3;
  if (str < 23) return 5;
  return 6;
}
export function dexHitBonus(dex) {
  if (dex < 4) return -3;
  if (dex < 6) return -2;
  if (dex < 8) return -1;
  if (dex < 14) return 0;
  return dex - 14;
}
export function conHpBonus(con) {
  if (con <= 3) return -2;
  if (con <= 6) return -1;
  if (con <= 14) return 0;
  if (con <= 16) return 1;
  if (con <= 17) return 2;
  if (con <= 18) return 3;
  return 4;
}
export function carryCapacity(str, con) {
  return Math.min(1000, 25 * (str + con) + 50);
}
