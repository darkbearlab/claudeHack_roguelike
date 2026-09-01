// Equipment.
//
// The point of this file is one sentence: **a weapon is a set of verbs, not a
// damage number.** Attacks in this game always land and damage is fixed, so a
// "+2 sword" would make existing fights blunter without making them different.
// A weapon that arrives carrying `reach2` and `line3` changes where you have to
// stand, which is the only kind of power this game can actually express.
//
// The rules, all of which come from the design conversation:
//
//   * Every weapon has a **primary** and a **secondary** skill.
//   * In the **off hand you only get the primary.** That one line is the whole
//     loadout trade: dual wielding gives you three attack verbs but only one of
//     them is a weapon's special, while a two-hander gives you two and both of
//     them are that weapon's own.
//   * Some weapons need **both hands**, which locks the off hand entirely.
//   * Shields go in the off hand and block an arc around the way you are
//     facing - one direction for a small shield, three for a big one.
//
// Weight is the axis everything defensive is balanced on. It makes rolling
// dearer and recovery slower (see Player.rollCost / regenRate), and the gap
// between the two armours is deliberately wide - with a narrow spread the two
// kits came out on identical regeneration, which is no trade at all.

export const SLOT = { MAIN: 'main', OFF: 'off', ARMOUR: 'armour' };

const weapon = (key, o) => ({
  key,
  name: o.name,
  kind: 'weapon',
  hands: o.hands ?? 1,
  weight: o.weight,
  primary: o.primary,
  secondary: o.secondary,
  desc: o.desc,
});

const shield = (key, o) => ({
  key,
  name: o.name,
  kind: 'shield',
  hands: 1,
  weight: o.weight,
  // `arc` is how many of the eight directions it covers: 1 is the way you are
  // facing, 3 adds the two either side of it. Nothing covers everything, so
  // being surrounded is dangerous however big your shield is.
  block: { arc: o.arc, reduce: o.reduce, stamina: o.stamina },
  desc: o.desc,
});

const armour = (key, o) => ({
  key,
  name: o.name,
  kind: 'armour',
  weight: o.weight,
  hp: o.hp,
  reduce: o.reduce ?? 0,
  heavy: o.heavy ?? false,
  desc: o.desc,
});

export const ITEMS = [
  // ---- weapons ------------------------------------------------------------
  weapon('sword', {
    name: 'longsword', weight: 4, primary: 'strike', secondary: 'sweep',
    desc: '一手一柄,前方一格,次要技能掃三格。',
  }),
  weapon('dagger', {
    name: 'dagger', weight: 1, primary: 'lunge', secondary: 'gut',
    desc: '很輕。主要技能會前衝兩格,適合追打收招。',
  }),
  weapon('spear', {
    name: 'spear', weight: 5, primary: 'thrust', secondary: 'skewer',
    desc: '縱深兩格,次要技能打穿一整條直線。',
  }),
  weapon('mace', {
    name: 'mace', weight: 6, primary: 'crush', secondary: 'smash',
    desc: '衝擊值極高,是唯一能單招打斷重招的武器。',
  }),
  weapon('greataxe', {
    name: 'greataxe', hands: 2, weight: 11, primary: 'cleave', secondary: 'rend',
    desc: '雙手。次要技能是你自己的五格牆。',
  }),
  weapon('bow', {
    name: 'shortbow', hands: 2, weight: 4, primary: 'hurl', secondary: 'pierce',
    desc: '雙手。箭在你的回合結束後仍然在飛。',
  }),

  // ---- shields ------------------------------------------------------------
  shield('buckler', {
    name: 'buckler', weight: 3, arc: 1, reduce: 2, stamina: 2,
    desc: '只擋你正對的方向,但很輕——你還滾得動。',
  }),
  shield('tower', {
    name: 'tower shield', weight: 10, arc: 3, reduce: 4, stamina: 3,
    desc: '擋正面和左右兩側,代價是你幾乎不再是一個會移動的東西。',
  }),

  // ---- armour -------------------------------------------------------------
  armour('leathers', {
    name: 'leathers', weight: 2, hp: 12, reduce: 0, heavy: false,
    desc: '打不起,但可以一直閃。',
  }),
  armour('mail', {
    name: 'mail', weight: 12, hp: 16, reduce: 1, heavy: true,
    desc: '受到的傷害 −1,但你得看得更遠、更早決定。',
  }),
];

export const ITEM_BY_KEY = Object.fromEntries(ITEMS.map((i) => [i.key, i]));

export const isWeapon = (it) => !!it && it.kind === 'weapon';
export const isShield = (it) => !!it && it.kind === 'shield';
export const isArmour = (it) => !!it && it.kind === 'armour';

/** Which slots a thing may legally go in. */
export function slotsFor(it) {
  if (!it) return [];
  if (isArmour(it)) return [SLOT.ARMOUR];
  if (isShield(it)) return [SLOT.OFF];
  if (isWeapon(it)) return it.hands === 2 ? [SLOT.MAIN] : [SLOT.MAIN, SLOT.OFF];
  return [];
}

/**
 * The skills a piece of equipment grants in a given slot.
 *
 * The whole off-hand rule lives in these four lines: main hand gives you both
 * of a weapon's skills, off hand gives you only its primary, and a shield gives
 * you a block rather than an attack.
 */
export function skillsFrom(it, slot) {
  if (!isWeapon(it)) return [];
  if (slot === SLOT.MAIN) return [it.primary, it.secondary].filter(Boolean);
  if (slot === SLOT.OFF) return [it.primary].filter(Boolean);
  return [];
}

/** What a run starts with. The vow picks the armour and nothing else. */
export const STARTING_KIT = {
  light: { main: 'sword', off: 'dagger', armour: 'leathers', pack: ['spear', 'buckler'] },
  heavy: { main: 'sword', off: 'dagger', armour: 'mail', pack: ['mace', 'tower'] },
};
