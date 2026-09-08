/**
 * The farwayer's marks.
 *
 * Every beat she lands leaves one of five marks on what it hit. Landing a mark
 * that is already there eats the WHOLE set and fires that mark's effect,
 * multiplied by how many other marks were mixed in - so the shape of her play
 * is "build a diverse set, then close it", and closing early is the small
 * version rather than the wrong version.
 *
 * See docs/FARWAYER.md. Two things there are load-bearing and easy to lose:
 *
 *   - The multiplier scales MAGNITUDE ONLY. Five marks times zero-to-four
 *     others is a 25-cell lookup table if the kind of effect changes too, and
 *     this game is played on a phone.
 *
 *   - Which beat a mark comes from decides which SIDE it helps, not how strong
 *     it is. First beats face the enemy, because a first beat is what you can
 *     still land while something is chasing you. Second beats face the player,
 *     because the second beat is the one you give up when you dodge - so the
 *     reward for singing the phrase out under pressure has to be the thing
 *     that lets you keep doing it. Strength on the second beat would make her
 *     strongest when the fight is already easy, which is backwards.
 */

/** How long a mark sits on a target before it fades. */
export const MARK_TURNS = 5;

/** How long the ember aura holds, and how far it reaches. */
export const AURA_TURNS = 5;
export const AURA_RADIUS = 5;

/**
 * Stamina back for every mark ABOVE the pair, when a set goes off.
 *
 * This is her engine, and it was missing until a punching-post measured her:
 * her phrase is six beats costing 18 stamina across three turns, every one of
 * those turns is an attacking turn, and an attacking turn earns no recovery
 * at all (see EFFORT). She could not afford the sequence she is built around
 * even once from a full bar.
 *
 * Note what it is multiplied by: `mult - 1`, not `mult`. Closing a set with no
 * company feeds you NOTHING. So spamming the basic attack - which always pairs
 * with itself on the second beat, and is the cheapest thing she owns - runs
 * her dry in four turns, while the diverse set she is supposed to build pays
 * for the next one. The design's own thesis is the thing that keeps her alive.
 *
 * Same shape as the soulbinder's `refund`: hitting is how she eats. Different
 * verb - she has to finish a sentence, not land a blow.
 */
export const REFUND_PER_EXTRA = 4;

export const MARKS = [
  {
    key: 'step', name: '步', glyph: '·', colour: '#e8e8f0',
    // Both beats of her basic attack, which makes the basic attack the
    // detonator: two of them in one turn always closes. That is also the floor
    // of the whole system - if you never learn anything else, this still works.
    effect: 'damage', base: 3,
    hint: '追加傷害',
  },
  {
    key: 'thorn', name: '棘', glyph: '†', colour: '#ff7b72',
    effect: 'vulnerable', base: 1, turns: 3,
    hint: '易傷:它受到的傷害提高',
  },
  {
    key: 'spring', name: '泉', glyph: '⊕', colour: '#7ee787',
    effect: 'heal', base: 1,
    hint: '回血',
  },
  {
    key: 'gale', name: '颯', glyph: '≫', colour: '#79c0ff',
    // Knockback, not stun, and the reason is mechanical rather than
    // thematic: the multiplier needs something that scales linearly.
    // stagger() only does anything during WINDUP and only delays it by a turn,
    // so five times nothing is nothing; five turns of stun simply deletes the
    // target. Distance scales cleanly against anything, in any state.
    effect: 'knock', base: 1,
    hint: '擊退並失衡',
  },
  {
    key: 'ember', name: '燼', glyph: '✦', colour: '#ffd75f',
    // The only mark whose effect is not aimed at the target it went off on.
    // It opens a window over the ground instead: for AURA_TURNS, everything
    // inside AURA_RADIUS needs one more turn to wind up.
    //
    // It replaced a bank of spare beats, which was the second stored resource
    // in a character who only needed one - and the banked beats were the
    // number the spec said it trusted least.
    //
    // Note what it does NOT do: it does not stack, and re-earning it while it
    // is up does not extend it. You have to let it lapse and earn it again,
    // which is what keeps it a window you open rather than a pace you set.
    effect: 'aura', base: 1,
    hint: '五回合內,五格內的敵人前搖 +1',
  },
];

export const MARK_BY_KEY = Object.fromEntries(MARKS.map((m) => [m.key, m]));
