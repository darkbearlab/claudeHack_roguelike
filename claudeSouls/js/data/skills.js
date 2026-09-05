// The player's verbs.
//
// Three rules govern this table:
//
// 1. **Stamina is the real cost, cooldowns are the flavour.** Stamina makes
//    attacking and dodging compete for the same pool, which is the whole
//    Souls emotion: "one more hit, or keep enough to get out?" Cooldowns only
//    stop one answer being right every single turn.
//
// 2. **A kill refunds one turn of every cooldown - if your weapon reaps.**
//    This was everyone's rule, always, and it turned a fight into a combo:
//    kill, cooldowns come back, next skill, kill again. It is an affix now
//    (`reaping`, innate on the paired blades, which were built around it).
//    As a default it paid out at the wrong moment - the turn a thing dies is
//    the turn you are under the least pressure - so it rewarded the exchange
//    you had already won rather than the one you were losing.
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

  {
    key: 'block',
    name: 'Block',
    hint: 'raise the shield the way you drag; it holds until your next turn',
    // Cheap on purpose. The price of a block is not paid here - it is paid
    // every turn you carry the shield at all, through its weight and therefore
    // your recovery rate (see Player.regenRate),
    // because enemies telegraph and so a defensive reaction is always correctly
    // timed. Charging for the use could never make it a decision; charging for
    // owning the option can.
    //
    // It advances the turn, which is what keeps it from dominating the roll:
    // rolling does not, so wherever there is room to move, moving is better.
    // Block is what you do when there is nowhere to go.
    stamina: 2,
    cooldown: 0,
    advancesTurn: true,
    defend: true,
    needsShield: true,
  },

  // =========================================================================
  // The roster. Skills belong to a person - see js/data/heroes.js.
  //
  // Three new payment rules live here rather than in the code that reads them,
  // so a skill's whole cost is visible in one place:
  //
  //   refund      landing this gives stamina back. The binder's engine.
  //   bleed       may be paid for in health when stamina runs out.
  //   disrupt     CANCELS a wind-up rather than delaying it. The existing
  //               stagger only did `timer++` - the blow still arrived, one
  //               turn later - and both the knight and the binder want it
  //               actually gone.
  // =========================================================================

  // ---- the old knight -----------------------------------------------------
  {
    key: 'turnaside',
    name: 'Turn Aside',
    hint: '化解一個正在舉手的鄰敵:取消那一擊,把它推開一格,你補上它的位置',
    // Not a block and not a parry-on-timing. It reads the telegraph and spends
    // it, which makes the thing the whole game is built on into a resource
    // rather than only information. Legal on 35% of melee turns, measured.
    //
    // It cannot be used on anything that cannot be pushed, so a 2x2 is immune -
    // the old knight's signature move does nothing to the largest things in
    // the game, and that is his shape.
    pattern: 'front',
    damage: 0,
    impact: 0,
    stamina: 5,
    cooldown: 0,
    advancesTurn: true,
    disrupt: { needsPush: true, shove: 1, advance: true, random: true },
  },

  // ---- the soulbinder -----------------------------------------------------
  {
    key: 'siphon',
    name: 'Siphon',
    hint: '普通攻擊,但命中會把精力抽回來——她沒有別的回復方式',
    pattern: 'front',
    damage: 2,
    impact: 1,
    stamina: 2,
    refund: 5,             // on a hit. Missing feeds you nothing.
    cooldown: 0,
    advancesTurn: true,
  },
  {
    key: 'unmake',
    name: 'Unmake',
    hint: '前方三格:傷害,而且取消它們正在準備的攻擊、讓它們停一回合',
    pattern: 'arc3',
    damage: 3,
    impact: 2,
    stamina: 9,
    bleed: true,
    cooldown: 0,
    advancesTurn: true,
    // No push needed, so unlike Turn Aside this works on anything - the two
    // characters cancel by different grammar, and hers reaches what his
    // cannot.
    disrupt: { needsPush: false, stun: 1 },
  },
  {
    key: 'lance',
    name: 'Soul Lance',
    hint: '五格貫穿',
    pattern: 'line5',
    damage: 4,
    impact: 2,
    stamina: 10,
    bleed: true,
    cooldown: 0,
    advancesTurn: true,
  },

  // ---- the squire ---------------------------------------------------------
  {
    key: 'pierce2',
    name: 'Level Spear',
    hint: '長矛前刺兩格',
    pattern: 'reach2',
    damage: 3,
    impact: 2,
    stamina: 4,
    cooldown: 0,
    advancesTurn: true,
  },
  {
    key: 'bannersweep',
    name: 'Banner Sweep',
    hint: '揮出去打第二格的三格——貼身的反而打不到',
    pattern: 'arcfar',
    damage: 4,
    impact: 3,
    stamina: 6,
    cooldown: 0,
    recovery: 1,
    advancesTurn: true,
  },
  {
    key: 'onward',
    name: 'Onward',
    hint: '立刻衝出去,而且下一回合只能朝同一個方向再衝一次',
    // No wind-up: it goes at once. The price is not that it can be interrupted
    // (it cannot), it is that **you cannot stop** - next turn is spent going
    // the same way whether or not that is where you want to be. Escaping the
    // dragon's pyre with it works; escaping into a wall also works.
    rush: { times: 1, advance: 2 },
    forced: { times: 1 },
    damage: 4,
    impact: 4,
    stamina: 6,
    cooldown: 0,
    advancesTurn: true,
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
    cooldown: 0, recovery: 1,
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
    cooldown: 0, recovery: 1,
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
    cooldown: 0, recovery: 1,
    advancesTurn: true,
  },
  {
    key: 'rend',
    name: 'Rend',
    hint: 'a five-tile wall of your own',
    pattern: 'arc5',
    windup: 1,
    damage: 6,
    impact: 6,
    stamina: 9,
    cooldown: 0, recovery: 1,
    advancesTurn: true,
  },

  // ---- bow ----------------------------------------------------------------
  // The bow is where wind-up earns its place. Recovery is a cost you pay by
  // being reachable, so at range 11 it is worth nothing - which is why ranged
  // attacks are exempt from the recovery rule and priced by cooldown instead.
  // A wind-up is the opposite: it costs you *exactly* at range, because in the
  // turn between the draw and the loose the target walks somewhere, and a lane
  // you aimed at a moving thing is a lane it has left. Pierce trades half its
  // cooldown for that, and becomes a shot you have to lead.
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
    hint: 'drawn all the way back - it lands next turn, so lead the target',
    ranged: true,
    damage: 5,
    impact: 2,
    range: 11,
    projectile: { speed: 4, glyph: '/', colour: '#e8dcb8' },
    stamina: 8,
    cooldown: 2, windup: 1,
    advancesTurn: true,
  },

  // ---- halberd: the two-stage sweep, finally on the player's side ---------
  // Press one then the other and you have the swordsman's combo. No new
  // mechanic: the shapes already existed, the sequence is expressed by the
  // button order, and it costs you two turns like it costs them.
  {
    key: 'hew', name: 'Hew', hint: 'the left half of a sweep',
    pattern: 'sweepL', damage: 4, impact: 4, stamina: 6, cooldown: 0, recovery: 1, advancesTurn: true,
  },
  {
    key: 'backsweep', name: 'Backsweep', hint: 'the other half; follow a Hew with it',
    pattern: 'sweepR', damage: 4, impact: 4, stamina: 5, cooldown: 0, recovery: 1, advancesTurn: true,
  },

  // ---- warhammer: the answer to being surrounded, and a gamble ------------
  {
    key: 'pound', name: 'Pound', hint: 'slow and very heavy',
    pattern: 'front', damage: 5, impact: 6, stamina: 7, cooldown: 0, advancesTurn: true,
  },
  {
    key: 'sunder', name: 'Sunder', hint: 'everything around you - then you are standing still for two turns',
    // Recovery, not a long cooldown, and deliberately not both. Being expensive
    // only makes you use it less; being helpless afterwards makes it a gamble -
    // you clear the ring and then stand in the middle of what is left of it.
    pattern: 'around', damage: 4, impact: 5, stamina: 9, cooldown: 0, recovery: 2,
    advancesTurn: true,
  },

  // ---- pike: reach past everything ---------------------------------------
  {
    key: 'brace', name: 'Brace', hint: 'three tiles of lane',
    pattern: 'line3', damage: 3, impact: 3, stamina: 6, cooldown: 0, recovery: 1, advancesTurn: true,
  },
  {
    key: 'impale', name: 'Impale', hint: 'six tiles of lane, and a long recovery',
    pattern: 'line6', damage: 4, impact: 3, stamina: 8, cooldown: 0, windup: 1, recovery: 1,
    advancesTurn: true,
  },

  // ---- paired blades: cheap, fast, feeds the kill-refunds-cooldowns engine -
  {
    key: 'slice', name: 'Slice', hint: 'barely costs anything',
    pattern: 'front', damage: 2, impact: 1, stamina: 2, cooldown: 0, advancesTurn: true,
  },
  {
    key: 'flurry', name: 'Flurry', hint: 'three tiles, still cheap',
    pattern: 'arc3', damage: 2, impact: 2, stamina: 5, cooldown: 2, advancesTurn: true,
  },

  // ---- falchion: the push ------------------------------------------------
  {
    key: 'chop', name: 'Chop', hint: 'knocks them back a tile',
    pattern: 'front', damage: 4, impact: 3, stamina: 5, cooldown: 0, knock: 1, advancesTurn: true,
  },
  {
    key: 'shove', name: 'Shove', hint: 'almost no damage - it is for moving them',
    // Position is this game's language, so a tool that only moves things is a
    // real weapon: push something out of your lane, or into the lane the horned
    // one is about to charge down.
    pattern: 'front', damage: 1, impact: 4, stamina: 3, cooldown: 2, knock: 2, advancesTurn: true,
  },

  // ---- hatchet: ranged in ONE hand, which the bow cannot be ---------------
  {
    key: 'sling', name: 'Sling', hint: 'thrown, and you keep your off hand',
    ranged: true, damage: 3, impact: 1, range: 6,
    projectile: { speed: 3, glyph: '/', colour: '#c8b48a' },
    stamina: 4, cooldown: 1, advancesTurn: true,
  },
  {
    key: 'bury', name: 'Bury', hint: 'up close, if they reached you',
    pattern: 'front', damage: 4, impact: 3, stamina: 5, cooldown: 2, advancesTurn: true,
  },
];

export const SKILL_BY_KEY = Object.fromEntries(SKILLS.map((s) => [s.key, s]));

export const PLAYER = {
  hpMax: 12,          // three heavy hits, or five light ones
  staminaMax: 20,
  staminaRegen: 3,    // just under one light roll, on purpose
  speed: 12,
};
