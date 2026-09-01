// The player's verbs.
//
// Two rules govern this table, and both come out of the design discussion:
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
// Everything here is directional. That keeps the touch interface uniform: press
// the skill, drag out from your character, release. There is no "pick a tile"
// mode to learn separately.

export const SKILLS = [
  {
    key: 'strike',
    name: 'Strike',
    hint: 'the free one; also what you do by walking into something',
    pattern: 'front',
    damage: 3,
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
    stamina: 6,
    cooldown: 3,
    advancesTurn: true,
  },
  {
    key: 'lunge',
    name: 'Lunge',
    hint: 'close two tiles and hit; how you punish a long wind-up',
    pattern: 'front',
    damage: 4,
    stamina: 6,
    cooldown: 3,
    advancesTurn: true,
    dash: 2,
  },
  {
    key: 'hurl',
    name: 'Hurl',
    hint: 'a knife, in a straight line; it keeps flying after your turn ends',
    ranged: true,
    damage: 3,
    range: 9,
    projectile: { speed: 3, glyph: '/', colour: '#cfd6dd' },
    stamina: 5,
    cooldown: 2,
    advancesTurn: true,
  },
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
  },
];

export const SKILL_BY_KEY = Object.fromEntries(SKILLS.map((s) => [s.key, s]));

/** What the player starts a run with. The rest is a hook for later. */
export const STARTING_SKILLS = ['strike', 'roll', 'sweep', 'lunge', 'hurl'];

export const PLAYER = {
  hpMax: 12,          // three heavy hits, or five light ones
  staminaMax: 20,
  staminaRegen: 3,    // just under one light roll, on purpose
  speed: 12,
};
