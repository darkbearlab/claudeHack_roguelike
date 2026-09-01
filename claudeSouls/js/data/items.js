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


// ---------------------------------------------------------------------------
// Consumables and spells.
//
// Both work the same way and that is the point: you **prepare** one of each
// from the pack, it occupies its own button, and changing what is prepared
// costs a turn like any other swap. On eight buttons you cannot have a
// twenty-item inventory reachable mid-fight, and forcing the choice earlier
// turns inventory management into a plan made at the bonfire rather than a menu
// scrubbed through while something winds up.
//
// Charges refill at a bonfire, not on pickup. That is what makes them a
// resource for the stretch between fires rather than a stack to hoard.

const consumable = (key, o) => ({
  key,
  name: o.name,
  kind: o.kind,                 // 'item' | 'magic'
  weight: o.weight ?? 0,
  charges: o.charges,
  stamina: o.stamina ?? 0,
  directional: o.directional ?? false,
  heal: o.heal ?? 0,
  damage: o.damage ?? 0,
  impact: o.impact ?? 0,
  pattern: o.pattern ?? null,
  projectile: o.projectile ?? null,
  range: o.range ?? 0,
  desc: o.desc,
});

export const CONSUMABLES = [
  // The one that fixes a measured problem rather than adding a new one: health
  // only came back at a bonfire, so a run was a slow slide from full to dead
  // with nothing you could do about it mid-floor. Limited, prepared in advance,
  // and it costs you the turn.
  // Drinking costs stamina, and that is the whole reason it is interesting.
  //
  // Costing only the turn made it a binary read - "is anything winding up right
  // now?" - rather than a decision, because it competed with nothing. On the
  // stamina bar it competes with rolling and blocking, so the game's central
  // question just applies to healing too: one more mouthful, or keep enough to
  // get out? Six is about a roll and a half for a light kit.
  //
  // Charge count is deliberately NOT something souls can buy. An extra flask
  // shifts the whole difficulty curve down a step, and there is no mechanism
  // that absorbs that - so it stays a constant we tune, not one players raise.
  consumable('flask', {
    name: 'ember flask', kind: 'item', charges: 3, heal: 5, weight: 1, stamina: 6,
    desc: '回 5 點生命,花 6 點精力。三次,在篝火補滿。和翻滾、格擋搶同一條資源。',
  }),
  consumable('whetstone', {
    name: 'whetstone', kind: 'item', charges: 2, weight: 1,
    desc: '磨利手上的武器:下一擊傷害 +3。',
    damage: 3,
  }),
  consumable('firebolt', {
    name: 'firebolt', kind: 'magic', charges: 3, weight: 0, stamina: 4,
    directional: true, damage: 5, impact: 3, range: 8,
    projectile: { speed: 3, glyph: '*', colour: '#ff9a3c' },
    desc: '一發火球,會飛過去。三次。',
  }),
  consumable('quake', {
    name: 'quake', kind: 'magic', charges: 2, weight: 0, stamina: 6,
    directional: true, damage: 4, impact: 6, pattern: 'arc5',
    desc: '前方五格,衝擊值極高——打得斷幾乎任何招式。兩次。',
  }),
];

export const CONSUMABLE_BY_KEY = Object.fromEntries(CONSUMABLES.map((c) => [c.key, c]));
export const isConsumable = (key) => !!CONSUMABLE_BY_KEY[key];

/** What a run starts with. The vow picks the armour and nothing else. */
export const STARTING_KIT = {
  light: { main: 'sword', off: 'dagger', armour: 'leathers',
           pack: ['spear', 'buckler'], item: 'flask', magic: 'firebolt' },
  heavy: { main: 'sword', off: 'dagger', armour: 'mail',
           pack: ['mace', 'tower'], item: 'flask', magic: 'quake' },
};
