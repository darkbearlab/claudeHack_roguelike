import { PLAYER } from './skills.js';

// Souls, and what they are actually for.
//
// **They exist to make you decide when to walk back to the fire.** The stat
// line is the pretext; the tension is the product. "I am carrying twelve
// hundred, I should go bank it" is a decision the player makes against
// themselves, and it costs the designer nothing.
//
// That is why the numbers are small, and why the rules are shaped like this:
//
// 1. **Souls can only make you stronger. They can never unlock progress.**
//    Enemies respawn at bonfires and floors are seeded, so "rest, clear the
//    floor, rest" is an infinite tap. Any design where you *need* souls does
//    not merely permit grinding, it makes grinding optimal - and players will
//    find that, do it, and resent the game for it. Because nothing here is
//    required, running out is never a soft lock; it is just a harder run.
//
// 2. **Nothing bought competes with equipment.** Health comes from armour and
//    damage comes from weapons, so buying either would blur what the pool is
//    for. Stamina and carrying capacity are the two axes no item owns.
//
// 3. **Flask charges are deliberately NOT for sale.** An extra flask shifts the
//    entire difficulty curve down a step and nothing in the game absorbs that,
//    so the count stays a constant we tune rather than one players raise.
//
// The promise, and it is testable: **a run must be winnable with zero
// upgrades.** The bot never buys anything and has beaten the game, so that
// guarantee has evidence rather than intent behind it.

/** What a kill is worth. Small, and flat within a tier. */
export function soulsFor(spec, depth) {
  const base = Math.max(1, Math.round(spec.hp / 3) + Math.round((spec.poise ?? 0) / 3));
  return spec.boss ? base * 8 : base + Math.floor(depth / 3);
}

/**
 * The two things worth buying, and nothing else.
 *
 * Costs rise steeply so that the early ranks are reachable in a run and the
 * later ones are not - the point is a decision about *when to bank*, not a
 * shopping list to complete.
 */
export const TRACKS = [
  {
    key: 'wind',
    name: '氣',
    hint: '精力上限 +2',
    max: 6,
    cost: (rank) => 40 + rank * 55,
    apply: (p, rank) => { p.staminaBonus = rank * 2; },
  },
  {
    key: 'bearing',
    name: '負重',
    hint: '免費重量額度 +2:同樣的裝備,翻滾更便宜、回復更快',
    max: 6,
    cost: (rank) => 50 + rank * 65,
    apply: () => {},          // read directly by Player.rollExtra / regenRate
  },
];

export const TRACK_BY_KEY = Object.fromEntries(TRACKS.map((t) => [t.key, t]));

/** What the next rank of a track costs, or null if it is maxed. */
export function priceOf(ranks, key) {
  const t = TRACK_BY_KEY[key];
  if (!t) return null;
  const rank = ranks[key] ?? 0;
  return rank >= t.max ? null : t.cost(rank);
}
