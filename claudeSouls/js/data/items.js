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
  // Which hero can hold it. Skills bind to the person, so a weapon no longer
  // says what you DO with it - the family is what is left of a weapon's
  // identity, and it is what makes a found longsword mean something different
  // to the old knight than to the squire. A weapon outside your family is not
  // rubbish: it goes back to the hall for whoever it does fit. See docs/META.
  family: o.family,
  // A small flat bonus, 0 to 2. Deliberately small: damage lives on the skill,
  // and the contract this game is built on is that three to five blows kill
  // you. A weapon ladder steep enough to be exciting is steep enough to break
  // that.
  power: o.power ?? 0,
  // What the heavy end pays. Armour has carried a `regen` field since it
  // existed and this is the same field for the same reason.
  //
  // It is NOT derived from weight, and that was measured rather than assumed:
  // the load curve steps every 5 points, and across all three heroes' families
  // exactly one weapon swap - spear to halberd - crosses a step. A trade that
  // only exists for one item in the game is not a trade, so the cost is
  // written on the weapon where it can be read and tuned.
  regen: o.regen ?? 0,
  // The other way a heavy weapon can charge you: more stamina per swing.
  //
  // Two currencies rather than one, because recovery cannot price everything.
  // The binder's declared recovery is 1 and the rate is floored at 1, so a
  // `regen: -1` focus cost her exactly nothing and the heaviest one in her
  // family was free power - the same collapse the whole family system exists
  // to prevent, hiding in a Math.max.
  cost: o.cost ?? 0,
  primary: o.primary,
  secondary: o.secondary,
  affixes: o.affixes ?? [],     // innate; two of them means nothing more fits
  desc: o.desc,
});

/**
 * What the binder holds instead of a weapon.
 *
 * "她不帶武器。她借。" - so she cannot be given a sword, but she still needs
 * something to carry affixes or a third of the loot table means nothing to
 * her. A focus is that carrier: no reach, no edge, just the thing the debt is
 * written on.
 */
const focus = (key, o) => weapon(key, { ...o, family: 'focus', hands: 1 });

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
  // Proportional, not flat. A flat -1 is worth 50% against a two-damage bite
  // and 17% against a six-damage pyre, so it blunted exactly the chip damage
  // the light kit suffers most from - measured, the same weapon in the same
  // fight cost 7.3 health bars in leathers and 3.9 in mail. A percentage
  // makes armour do what its own description promises: survive the big
  // telegraphed blow, rather than ignore the small ones.
  reduce: o.reduce ?? 0,        // fraction of a blow turned aside
  regen: o.regen ?? 0,          // added to stamina recovery
  // The artwork belongs to the armour, not to the character. See the `sprite`
  // getter in actors.js for why this is stored here rather than on the player.
  sprite: o.sprite,
  heavy: o.heavy ?? false,
  desc: o.desc,
});

export const ITEMS = [
  // ---- weapons ------------------------------------------------------------
  weapon('sword', {
    name: 'longsword', family: 'blade', power: 1, weight: 4, primary: 'strike', secondary: 'sweep',
    desc: '一手一柄,前方一格,次要技能掃三格。',
  }),
  weapon('dagger', {
    name: 'dagger', family: 'blade', power: 0, weight: 1, primary: 'lunge', secondary: 'gut',
    desc: '很輕。主要技能會前衝兩格,適合追打收招。',
  }),
  weapon('spear', {
    name: 'spear', family: 'polearm', power: 1, weight: 5, primary: 'thrust', secondary: 'skewer',
    desc: '縱深兩格,次要技能打穿一整條直線。',
  }),
  weapon('mace', {
    name: 'mace', family: 'blunt', power: 1, weight: 6, primary: 'crush', secondary: 'smash',
    desc: '衝擊值極高,是唯一能單招打斷重招的武器。',
  }),
  weapon('greataxe', {
    name: 'greataxe', hands: 2, family: 'axe', power: 2, regen: -1, weight: 11, primary: 'cleave', secondary: 'rend',
    desc: '雙手。次要技能是你自己的五格牆。',
  }),
  weapon('bow', {
    name: 'shortbow', hands: 2, family: 'bow', power: 1, weight: 4, primary: 'hurl', secondary: 'pierce',
    desc: '雙手。箭在你的回合結束後仍然在飛。',
  }),

  weapon('halberd', {
    name: 'halberd', hands: 2, family: 'polearm', power: 2, regen: -1, weight: 10, primary: 'hew', secondary: 'backsweep',
    desc: '雙手。先左掃再右掃——敵人的那套兩段掃,終於在你手上。',
  }),
  // Two innate affixes, so nothing can ever be added: the strong found weapon
  // and the customisable one are different weapons, and that is the trade.
  weapon('warhammer', {
    name: 'warhammer', hands: 2, family: 'blunt', power: 2, regen: -1, weight: 14, primary: 'pound', secondary: 'sunder',
    affixes: ['tempered', 'frost'],
    desc: '雙手。次要技能清掉你周圍一圈,然後你會站在原地兩回合。',
  }),
  weapon('pike', {
    name: 'pike', hands: 2, family: 'polearm', power: 2, regen: -1, weight: 9, primary: 'brace', secondary: 'impale',
    desc: '雙手。六格長的一條線,和牛頭人的衝鋒一樣長。',
  }),
  weapon('blades', {
    name: 'paired blades', family: 'blade', power: 0, weight: 2, primary: 'slice', secondary: 'flurry',
    // Innate, because the description has always promised it and it was a
    // global rule until now. This is the weapon the kill-refund was for.
    affixes: ['reaping'],
    desc: '很輕、很便宜。一條精力砍十次,配合擊殺退還 CD。',
  }),
  weapon('falchion', {
    name: 'falchion', family: 'blade', power: 1, weight: 5, primary: 'chop', secondary: 'shove', affixes: ['keen'],
    desc: '命中會把東西推開。次要技能幾乎不造成傷害——它是用來搬動敵人的。',
  }),
  // The blade family's heavy end. Without it the old knight's entire ladder
  // was power 0, 0, 1, 1 - four weapons and no decision in them.
  weapon('greatsword', {
    name: 'greatsword', hands: 2, family: 'blade', power: 2, regen: -1, weight: 10,
    primary: 'cleave', secondary: 'rend',
    desc: '雙手。他這輩子只用過一把劍,但這把劍會讓他慢下來。',
  }),
  weapon('hatchet', {
    name: 'hatchet', family: 'axe', power: 0, weight: 2, primary: 'sling', secondary: 'bury',
    desc: '單手遠程,所以你還留著副手。射程短、傷害低。',
  }),

  // ---- focuses (the binder's family) --------------------------------------
  // Light, because she is the one hero whose economy is built on moving and
  // whose recovery is almost nothing. A heavy focus would not be a trade for
  // her, it would just be a mistake.
  focus('tally', {
    name: 'bone tally', weight: 1, power: 0, primary: 'siphon', secondary: 'unmake',
    desc: '她借了多少,都刻在上面。輕得像沒有拿東西。',
  }),
  focus('reliquary', {
    name: 'reliquary', weight: 3, power: 1, primary: 'siphon', secondary: 'unmake',
    affixes: ['keen'],
    desc: '裡面裝著別人的東西。它讓她拿得更深一點。',
  }),
  focus('censer', {
    name: 'hanging censer', weight: 5, power: 2, cost: 1, primary: 'siphon', secondary: 'unmake',
    desc: '一直在燒。每一次動作都比較貴,但借得更多。',
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

  shield('bone', {
    name: 'bone shield', weight: 1, arc: 1, reduce: 1, stamina: 2,
    desc: '幾乎不佔重量——輕裝流終於帶得起盾。',
  }),
  shield('kite', {
    name: 'kite shield', weight: 6, arc: 3, reduce: 2, stamina: 3,
    desc: '寬而薄:擋三個方向,但每一下都會漏一點。',
  }),
  // ---- armour -------------------------------------------------------------
  armour('leathers', {
    sprite: 'hero_leathers',
    name: 'leathers', weight: 2, hp: 12, reduce: 0, heavy: false,
    desc: '打不起,但可以一直閃。',
  }),
  armour('mail', {
    sprite: 'hero_mail',
    name: 'mail', weight: 12, hp: 16, reduce: 0.25, heavy: true,
    desc: '擋下四分之一的傷害——大招砍得少,小傷還是照吃。你得看得更遠、更早決定。',
  }),
  // Rags need an upside of their own, not just "less weight". With a light
  // weapon the weight thresholds put them level with leathers, so they were
  // simply worse: same rolls, same recovery, two less health. Unencumbered
  // recovery is the extreme end of the axis rather than the bottom of it.
  armour('rags', {
    sprite: 'hero_rags',
    name: 'rags', weight: 0, hp: 10, reduce: 0, heavy: false, regen: 1,
    desc: '幾乎沒有防護,但精力回得比誰都快。',
  }),
  armour('brigandine', {
    sprite: 'hero_brigandine',
    name: 'brigandine', weight: 6, hp: 14, reduce: 0.1, heavy: false,
    desc: '中間的選擇:多一點血、擋一成,還滾得動。',
  }),
  armour('plate', {
    sprite: 'hero_plate',
    name: 'plate', weight: 22, hp: 18, reduce: 0.4, heavy: true,
    desc: '擋下四成的傷害。你幾乎不再是一個會移動的東西。',
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
  restore: o.restore ?? 0,      // stamina given back, for the squire's banner
  damage: o.damage ?? 0,
  impact: o.impact ?? 0,
  knock: o.knock ?? 0,
  grants: o.grants ?? null,     // a permanent affix for the main hand
  tempAffix: o.tempAffix ?? null,
  teleport: o.teleport ?? 0,
  shield: o.shield ?? 0,
  pattern: o.pattern ?? null,
  projectile: o.projectile ?? null,
  range: o.range ?? 0,
  desc: o.desc,
});

export const CONSUMABLES = [
  // The squire's answer to being slow at everything. Not healing and not
  // damage: the one thing he cannot get any other way is a turn's worth of
  // breath, and the flavour and the mechanic are the same sentence - he lifts
  // the banner and it costs him the turn to do it.
  consumable('rally', {
    name: 'rally', kind: 'magic', charges: 2, weight: 0, stamina: 0,
    restore: 8,
    desc: '舉起軍旗:立刻回復 8 點精力。',
  }),
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
  consumable('knife', {
    name: 'throwing knife', kind: 'item', charges: 3, weight: 1, stamina: 3,
    directional: true, damage: 3, impact: 1, range: 7,
    projectile: { speed: 3, glyph: '/', colour: '#cfd6dd' },
    desc: '丟出去。三次。',
  }),
  consumable('firebomb', {
    name: 'firebomb', kind: 'item', charges: 2, weight: 1, stamina: 4,
    directional: true, damage: 4, impact: 3, pattern: 'arc3', knock: 1,
    desc: '前方三格,並把它們推開一格。兩次。',
  }),
  consumable('stone_keen', {
    name: 'keening stone', kind: 'item', charges: 1, weight: 1,
    grants: 'keen',
    desc: '永久給主手武器「銳利」:主要技能命中後推開一格。武器已有兩條天生詞條的話用不了。',
  }),
  consumable('stone_light', {
    name: 'paring stone', kind: 'item', charges: 1, weight: 1,
    grants: 'light',
    desc: '永久給主手武器「輕量」:重量 −3。',
  }),
  consumable('oil_ember', {
    name: 'ember oil', kind: 'item', charges: 2, weight: 1,
    tempAffix: 'ember',
    desc: '接下來 5 次命中傷害 +2。抹在手上那把武器上。',
  }),
  consumable('oil_frost', {
    name: 'frost oil', kind: 'item', charges: 2, weight: 1,
    tempAffix: 'frost',
    desc: '接下來 5 次命中衝擊 +2——打得斷本來打不斷的東西。',
  }),
  consumable('ward', {
    name: 'ward', kind: 'magic', charges: 2, weight: 0, stamina: 5, shield: 1,
    desc: '這一回合下一次受到的傷害完全無效——**不看方向**。無視盾牌的招式也擋得住。',
  }),
  consumable('blink', {
    name: 'blink', kind: 'magic', charges: 2, weight: 0, stamina: 4,
    directional: true, teleport: 4,
    desc: '瞬移四格,穿過擋路的東西。推進回合。',
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
