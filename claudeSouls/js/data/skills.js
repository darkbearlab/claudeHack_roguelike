// The player's verbs.
//
// Three rules govern this table:
//
// 1. **Stamina is the real cost, cooldowns are the flavour.** Stamina makes
//    attacking and dodging compete for the same pool, which is the whole
//    Souls emotion: "one more hit, or keep enough to get out?" Cooldowns only
//    stop one answer being right every single turn.
//
// 2. **A kill refunds one turn of every cooldown.** This is what turns a fight
//    from a list of separate decisions into a combo - kill, cooldowns come
//    back, next skill, kill again. It also rewards correct target *order*,
//    which is exactly the thinking the game is supposed to be about.
//
// 3. **Almost every skill belongs to a weapon.** Roll and block are the only
//    ones you always have. Everything else arrives on a piece of equipment,
//    which is what makes finding a weapon interesting: you are not picking up
//    +2 damage, you are picking up a *shape*. See js/data/items.js.
//
// This file stays the one place a skill is defined. Weapons refer to skills by
// key rather than carrying their own copies, so the icon generator, the tests
// and the tooltips all still have exactly one table to read.
//
// Everything here is directional. That keeps the touch interface uniform: press
// the skill, drag out from your character, release. There is no "pick a tile"
// mode to learn separately.

export const SKILLS = [
  // ---- always available ---------------------------------------------------
  {
    key: 'roll',
    name: 'Roll',
    hint: 'two tiles, costs stamina, and does NOT end your turn',
    // The single most important line in this file. Rolling not advancing the
    // turn is what moves the clock from turns to stamina, and it is why a good
    // player can weave through a room while a careless one gets caught flat.
    dash: 2,
    dashHeavy: 1,
    stamina: 4,
    staminaHeavy: 7,
    cooldown: 0,
    advancesTurn: false,
    move: true,
    always: true,
  },

  // ---- sword --------------------------------------------------------------
  {
    key: 'strike',
    name: 'Strike',
    hint: 'the plain one; also what you do by walking into something',
    pattern: 'front',
    damage: 3,
    impact: 2,          // poise damage: enough to stagger something small
    stamina: 4,
    cooldown: 0,
    advancesTurn: true,
  },
  {
    key: 'sweep',
    name: 'Sweep',
    hint: 'three tiles in front - for when they came in a group',
    pattern: 'arc3',
    damage: 3,
    impact: 3,
    stamina: 6,
    cooldown: 3,
    advancesTurn: true,
  },

  // ---- dagger -------------------------------------------------------------
  {
    key: 'lunge',
    name: 'Lunge',
    hint: 'close two tiles and hit; how you punish a long wind-up',
    pattern: 'front',
    damage: 4,
    impact: 4,          // the interrupt tool: breaks a mid-tier wind-up alone
    stamina: 6,
    cooldown: 3,
    advancesTurn: true,
    dash: 2,
  },
  {
    key: 'gut',
    name: 'Gut',
    hint: 'one deep cut into one body',
    pattern: 'front',
    damage: 6,
    impact: 2,
    stamina: 7,
    cooldown: 3,
    advancesTurn: true,
  },

  // ---- spear: reach, so retreating in a line does not save them ------------
  {
    key: 'thrust',
    name: 'Thrust',
    hint: 'two tiles deep - you hit before they arrive',
    pattern: 'reach2',
    damage: 3,
    impact: 2,
    stamina: 5,
    cooldown: 0,
    advancesTurn: true,
  },
  {
    key: 'skewer',
    name: 'Skewer',
    hint: 'a whole lane, three deep',
    pattern: 'line3',
    damage: 3,
    impact: 3,
    stamina: 7,
    cooldown: 3,
    advancesTurn: true,
  },

  // ---- mace: the poise breaker --------------------------------------------
  {
    key: 'crush',
    name: 'Crush',
    hint: 'slow, but things stop what they were doing',
    pattern: 'front',
    damage: 4,
    impact: 5,
    stamina: 6,
    cooldown: 0,
    advancesTurn: true,
  },
  {
    key: 'smash',
    name: 'Smash',
    hint: 'breaks a heavy wind-up on its own',
    pattern: 'arc3',
    damage: 4,
    impact: 7,
    stamina: 8,
    cooldown: 4,
    advancesTurn: true,
  },

  // ---- greataxe: the wall --------------------------------------------------
  {
    key: 'cleave',
    name: 'Cleave',
    hint: 'three tiles, and it hurts',
    pattern: 'arc3',
    damage: 5,
    impact: 4,
    stamina: 7,
    cooldown: 0,
    advancesTurn: true,
  },
  {
    key: 'rend',
    name: 'Rend',
    hint: 'a five-tile wall of your own',
    pattern: 'arc5',
    damage: 6,
    impact: 6,
    stamina: 9,
    cooldown: 4,
    advancesTurn: true,
  },

  // ---- bow ----------------------------------------------------------------
  {
    key: 'hurl',
    name: 'Loose',
    hint: 'an arrow, in a straight line; it keeps flying after your turn ends',
    ranged: true,
    damage: 3,
    impact: 1,
    range: 9,
    projectile: { speed: 3, glyph: '/', colour: '#cfd6dd' },
    stamina: 5,
    cooldown: 2,
    advancesTurn: true,
  },
  {
    key: 'pierce',
    name: 'Pierce',
    hint: 'drawn all the way back',
    ranged: true,
    damage: 5,
    impact: 2,
    range: 11,
    projectile: { speed: 4, glyph: '/', colour: '#e8dcb8' },
    stamina: 8,
    cooldown: 4,
    advancesTurn: true,
  },
];

export const SKILL_BY_KEY = Object.fromEntries(SKILLS.map((s) => [s.key, s]));

export const PLAYER = {
  hpMax: 12,          // three heavy hits, or five light ones
  staminaMax: 20,
  staminaRegen: 3,    // just under one light roll, on purpose
  speed: 12,
};
