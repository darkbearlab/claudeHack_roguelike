// The people you can be.
//
// Skills belong to a person now, not to a weapon. That reverses the design the
// game was built on, and the reason is measured rather than aesthetic: twelve
// weapons produced only NINE distinct shape pairs, `front` alone carried nine
// of the twenty-four attacks, and longsword, mace and paired blades were
// mechanically the same weapon. The variety was in the numbers, not the verbs.
//
// A weapon is now a carrier for affixes. What you can DO comes from who you
// are.
//
// The thing that actually distinguishes these three is not their shapes, it is
// **how each of them pays**. One has a tiny pool and cannot chain anything.
// One has almost no passive recovery and has to hit things to refuel, and can
// spend health when that is not enough. One is slow at everything and carries
// a spell that gives it back. Three answers to the same question, and the
// stamina economy is therefore a property of the person rather than a global
// constant - which is what `PLAYER` in skills.js used to be for everybody.

// Each of them has their own art now rather than borrowing their kit's armour.
// Two pieces: a top-down figure for the map and the hall, and a flat front
// portrait for conversation - the map sprite is a shape seen from overhead and
// shrinking it into a dialogue box shows you the top of a head.
/**
 * Everybody, including the ones you cannot pick yet.
 *
 * `PLAYABLE` is what the hall stands up and what the title screen offers.
 * `HEROES` stays the full list, because the rules that apply to a hero should
 * go on applying to one who is parked - the stamina economy, the roll price,
 * the commitment band, the art. A character taken out of the game and out of
 * the tests at the same time comes back rotten.
 */
export const HEROES = [
  {
    key: 'knight',
    sprite: 'hero_knight',       // on the map, and standing in the hall
    face: 'face_knight',         // in conversation
    name: '老騎士',
    blurb: '一把長劍,一套用了四十年的動作。他不快,但他知道那一刀要往哪裡去。',

    // A small pool, recovering normally. Max caps how much you can chain;
    // regen caps how long you can keep going. His limit is the first: he
    // cannot parry twice in a row, so the counter has to be chosen rather
    // than leaned on.
    stamina: { max: 12, regen: 4 },
    // 7, not 4. At 4 his roll cost exactly equalled his recovery, so he could
    // dodge every turn for ever and no wind-up in the game meant anything to
    // him - which is what made telegraphs read as theatre. At 7 a bar of
    // continuous rolling lasts four turns.
    roll: { cost: 7, distance: 2 },

    skills: ['thrust', 'sweep', 'turnaside'],
    // "一把長劍" - so he holds one, and every blade he finds is a version of
    // it. The family is what he can pick up; the weapon does not tell him what
    // to do, it only sharpens what he already knows.
    family: 'blade',
    kit: { armour: 'mail', main: 'sword', item: 'flask', magic: null },
    about: ['我學會的第一件事,是不要跟比你快的東西比快。',
            '看它舉手。看它要往哪裡去。然後把它推到別的地方去。'],
  },

  {
    key: 'binder',
    sprite: 'hero_binder',       // on the map, and standing in the hall
    face: 'face_binder',         // in conversation
    name: '攝魂師',
    blurb: '她不帶武器。她借。',

    // The opposite engine: almost nothing comes back on its own, so the basic
    // attack is the refill and standing off doing nothing is starving. Her
    // roll is cheap, so she can dance - but dancing does not feed her, which
    // is what keeps her in the fight instead of circling it.
    //
    // A quarter per turn, not one. At 1 she recovered a roll every other turn
    // and siphon was an accelerator rather than her only engine; at 0.25 it
    // takes eight turns to afford one roll and twenty to afford Unmake, so
    // waiting is not a plan. It is deliberately NOT zero: siphon is the one
    // skill of hers that does not accept payment in health, so a rate of zero
    // is a state she could never act her way out of.
    stamina: { max: 20, regen: 0.25 },
    roll: { cost: 2, distance: 2 },

    skills: ['siphon', 'unmake', 'lance'],
    // She carries no weapon, which left her with nothing to hang an affix on -
    // so a third of what the dungeon drops would have been dead to her. A
    // focus is the carrier: no edge, no reach, just what the debt is kept on.
    family: 'focus',
    kit: { armour: 'leathers', main: 'tally', item: 'flask', magic: null },
    about: ['我身上沒有多的東西。要用,就得先拿。',
            '所以不要停下來。停下來的人會發現自己什麼都沒有。'],
  },

  {
    key: 'squire',
    sprite: 'hero_squire',       // on the map, and standing in the hall
    face: 'face_squire',         // in conversation
    name: '執旗侍從',
    blurb: '旗手死了。旗還在,所以他還在。',

    // Slow at everything, and a spell that buys some of it back. His roll is
    // one tile, which is a real weakness against exactly one attack in the
    // game (see the note on rollDistance in actors.js) - and his answer to
    // that attack is the charge, aimed the other way.
    stamina: { max: 14, regen: 2 },
    // 5, not 3. Same reason as the knight, one step gentler: he drained a
    // point a turn, which is fourteen turns of dodging - long enough to be
    // for ever inside one fight.
    roll: { cost: 5, distance: 1 },

    skills: ['pierce2', 'bannersweep', 'onward'],
    // The banner is on a shaft, so what he can hold is a shaft. His family has
    // the heaviest ladder in the game (spear 5, pike 9, halberd 10) and his
    // recovery is 2, so trading up is a real decision rather than a pickup.
    family: 'polearm',
    kit: { armour: 'brigandine', main: 'spear', item: 'flask', magic: 'rally' },
    about: ['他倒下的時候旗還舉著。我只是把它接住而已。',
            '我跑起來就停不下來。師傅說那總有一天會害死我。'],
  },

  {
    key: 'farwayer',
    sprite: 'hero_farwayer',
    face: 'face_farwayer',
    name: '巡禮者',
    blurb: '銀髮,黑羽的披風。她走過的地方都留著記號。',

    // The fourth engine, and the first one that is not paid for in stamina.
    //
    // Her bar is small and comes back fast on purpose: the point is that
    // stamina is NOT her constraint. Beats are. A turn holds two of them, an
    // attack spends one, and so does a roll - so what a dodge actually costs
    // her is the second half of a phrase, which is where her own heal and her
    // banked beats live. Being made to move is the expensive thing, exactly
    // as it should be for someone whose whole kit is a sequence.
    //
    // If this makes her simply easier, the difficulty has to come from
    // somewhere named - reach, positioning, the five-turn clock on her marks -
    // and not from an accident. That is an open question in docs/FARWAYER.md,
    // not a settled one.
    // The spec guessed 10/5 with a 3-cost roll. Two existing rules refused it
    // within a minute of her existing, and both were right:
    //
    //   "nobody can dodge for ever" - at cost 3 against a recovery of 5 she
    //   gained stamina by rolling, so no wind-up in the game meant anything to
    //   her. Exactly the bug the old knight had at cost 4 against regen 4.
    //
    //   "commitment is priced by the rule" - a cost you can pay by waiting is
    //   not a cost, and at recovery 5 a 3-point eight-tile sweep is free.
    //
    // The fix is on brief rather than against it. Her ATTACKS stay cheap, so
    // she can always sing; her DODGE is the most expensive in the game. That
    // is precisely what the design asked for - what bites her is being made to
    // move, not the swinging.
    // 20, not 16: her phrase is six beats costing 18, and a bar that cannot
    // hold one sequence is a character who can never do the thing she is for.
    // Measured on a punching post before the number moved.
    stamina: { max: 20, regen: 4 },
    roll: { cost: 7, distance: 2 },
    beats: 2,

    skills: ['pace', 'reach', 'return'],
    // Two blades, two beats. The weapon is the mechanic.
    family: 'paired',
    kit: { armour: 'leathers', main: 'knives', item: 'flask', magic: null },
    about: ['我不記路。我在路上留記號,然後跟著記號走。',
            '停下來的時候要小心。停下來的時候,記號會開始消失。'],
  },
];

export const HERO_BY_KEY = Object.fromEntries(HEROES.map((h) => [h.key, h]));

/** The ones you can actually be. The hall and the title screen use this. */
export const PLAYABLE = HEROES.filter((h) => !h.wip);
