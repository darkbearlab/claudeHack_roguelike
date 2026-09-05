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

export const HEROES = [
  {
    key: 'knight',
    name: '老騎士',
    blurb: '一把長劍,一套用了四十年的動作。他不快,但他知道那一刀要往哪裡去。',

    // A small pool, recovering normally. Max caps how much you can chain;
    // regen caps how long you can keep going. His limit is the first: he
    // cannot parry twice in a row, so the counter has to be chosen rather
    // than leaned on.
    stamina: { max: 12, regen: 4 },
    roll: { cost: 4, distance: 2 },

    skills: ['thrust', 'sweep', 'turnaside'],
    kit: { armour: 'mail', item: 'flask', magic: null },
  },

  {
    key: 'binder',
    name: '攝魂師',
    blurb: '她不帶武器。她借。',

    // The opposite engine: almost nothing comes back on its own, so the basic
    // attack is the refill and standing off doing nothing is starving. Her
    // roll is cheap, so she can dance - but dancing does not feed her, which
    // is what keeps her in the fight instead of circling it.
    stamina: { max: 20, regen: 1 },
    roll: { cost: 2, distance: 2 },

    skills: ['siphon', 'unmake', 'lance'],
    kit: { armour: 'leathers', item: 'flask', magic: null },
  },

  {
    key: 'squire',
    name: '執旗侍從',
    blurb: '旗手死了。旗還在,所以他還在。',

    // Slow at everything, and a spell that buys some of it back. His roll is
    // one tile, which is a real weakness against exactly one attack in the
    // game (see the note on rollDistance in actors.js) - and his answer to
    // that attack is the charge, aimed the other way.
    stamina: { max: 14, regen: 2 },
    roll: { cost: 3, distance: 1 },

    skills: ['pierce2', 'bannersweep', 'onward'],
    kit: { armour: 'brigandine', item: 'flask', magic: 'rally' },
  },
];

export const HERO_BY_KEY = Object.fromEntries(HEROES.map((h) => [h.key, h]));
