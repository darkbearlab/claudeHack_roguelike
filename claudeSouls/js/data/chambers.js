// Situations, not rooms.
//
// A pool of room shapes generates geometry, and geometry is not a situation.
// Two rows of pillars are only a colonnade if there is something behind them
// worth losing sight of; a walkable line between two open flanks is only a
// gauntlet if something is shooting across it. See docs/SITUATIONS.md - that
// file is the spec format, this one is the implementation of it.
//
// So a chamber carries three things together:
//
//   build()   the geometry, and the named ANCHORS inside it
//   cast      who stands on which anchor, **by role rather than by species**
//   intent    the decision it is supposed to force on the player
//
// `intent` is not decoration. It is the standard the result is judged against,
// it goes in the documentation, and the tests are written from it.
//
// Casting by role is what lets the same situation field a hound at depth 2 and
// a horned one at depth 8 without being rewritten. `ROLES` below owns the
// mapping, so adding a creature does not mean revisiting every chamber.
//
// This generalises a pattern the generator already had exactly once:
// placeStoreroom and placeGuards co-decide geometry, loot, species, position
// and starting awareness. That worked; it was just the only one.

import { T } from '../map/tiles.js';

/**
 * What a role means, in species, at a depth.
 *
 * Ordered worst-to-best so that picking is "the deepest one this floor allows",
 * which keeps a chamber's *shape* constant while its teeth grow.
 */
export const ROLES = {
  // Applies pressure across open ground. The whole point of a sight line.
  ranged: ['archer', 'flamekeeper'],
  // Slow, tough, stands in the way. What makes a route cost something.
  blocker: ['husk', 'brute', 'warden'],
  // Closes distance and punishes standing still.
  charger: ['hound', 'crawler', 'minotaur'],
  // Holds a spot rather than hunting. Awake from the start.
  guard: ['sentinel', 'swordsman', 'warden'],
};

/** The deepest species of this role the floor is allowed to field. */
export function castFor(role, depth, byKey) {
  const pool = (ROLES[role] ?? []).filter((k) => byKey[k] && depth >= byKey[k].minDepth);
  return pool.length ? pool[pool.length - 1] : null;
}

export const CHAMBERS = [
  {
    key: 'colonnade',
    name: 'the colonnade',

    // The decision. Everything below exists to force it.
    //
    // The pillars do two things, and the second one had to be argued for.
    //
    // They cut the archers' LINE OF FIRE: measured across 133 colonnades, an
    // archer can shoot only about a third of the lane. That alone would make
    // the chamber work.
    //
    // They also cut YOUR line of sight, which collides with the oldest rule in
    // the generator - every room is lit, because a wind-up you cannot see is
    // not a telegraph. The collision is worth it, because a colonnade you can
    // see through is decoration and an ambush needs somewhere to hide.
    // Measured: 225 creatures concealed against 123 in the open.
    //
    // The rule survives intact anyway. Anything mid-swing is forced visible
    // (see Game.afterMove), so you can be surprised by something being there
    // and never by a blow landing. Before that guarantee was added, 0 of 2097
    // wind-ups were hidden in practice - anything close enough to reach you is
    // close enough to see - but this is not a rule to leave to geometry.
    intent: '你會被埋伏,但不會被沒預告的攻擊打到。柱子藏得住「有東西在那」,'
          + '藏不住「它要出手了」——而它同時切掉三分之二的射界,'
          + '所以問題是「我什麼時候穿過空隙」。',

    minDepth: 3,
    // Needs to be wide enough for two pillar rows and three lanes between them.
    fits: (r) => r.w >= 9 && r.h >= 5,

    /**
     * Two rows of pillars along the long axis, leaving a central lane and two
     * flanking aisles. Gaps between pillars on purpose: the colonnade must be
     * crossable, or it is a wall with extra steps.
     */
    build(lvl, room) {
      const anchors = { lane: [], flank: [] };
      const midY = room.y + (room.h >> 1);
      const rowA = midY - 1, rowB = midY + 1;

      for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
        // Every other tile, so there is always a way between them.
        const solid = (x - room.x) % 2 === 1;
        for (const y of [rowA, rowB]) {
          if (solid && lvl.at(x, y) === T.FLOOR) lvl.set(x, y, T.PILLAR);
        }
      }
      for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
        if (lvl.at(x, midY) === T.FLOOR) anchors.lane.push({ x, y: midY });
        for (const y of [rowA - 1, rowB + 1]) {
          if (y > room.y - 1 && y < room.y + room.h && lvl.at(x, y) === T.FLOOR) {
            anchors.flank.push({ x, y });
          }
        }
      }
      return anchors;
    },

    // Ranged behind the pillars, awake - a threat you cannot see coming is an
    // ambush, and this is meant to be a decision. The blocker stands in the
    // lane so the straight route is the one that costs.
    cast: [
      { role: 'ranged', at: 'flank', n: [2, 2], aware: true, spread: true },
      { role: 'blocker', at: 'lane', n: [1, 1], aware: true },
    ],
  },
];

export const CHAMBER_BY_KEY = Object.fromEntries(CHAMBERS.map((c) => [c.key, c]));
