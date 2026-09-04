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

  {
    key: 'gauntlet',
    name: 'the causeway',

    // "A long narrow passage whose sides are not walls but open space, with
    // something across the gap that pins your movement and shoots at you."
    //
    // The passage is drawn in PITS, and that is the whole trick. A pit stops
    // feet and not arrows - it is documented that way in tiles.js, one deciding
    // who can reach whom and the other who can shoot whom - so the flanks are
    // ground you can see across and be shot across but cannot walk across.
    // The corridor is made of threat and a hole in the floor; there is not one
    // wall in it.
    //
    // The pit strips stop short of both ends deliberately. Without a way round
    // this is not a decision, it is a toll.
    intent: '兩側是坑不是牆:看得到、被射得到、但走不過去。'
          + '所以只有直線衝過去吃箭,或者繞到盡頭——實測多花 3 到 7 步。',

    minDepth: 4,
    fits: (r) => r.w >= 9 && r.h >= 6,

    build(lvl, room) {
      const anchors = { causeway: [], far: [], end: [] };
      // TWO tiles wide, not one, and that is not a detail.
      //
      // A one-wide causeway is a one-wide corridor, and the generator has a
      // measured rule against those: every attack shape collapses to a single
      // effective tile, the only movement left is forward and back, and block
      // stops being the "nowhere to go" option and becomes mandatory. The
      // first version of this chamber walked straight into the thing
      // MAX_STRAIT exists to prevent - the test caught it.
      //
      // Two wide keeps the situation intact (you still cannot cross the pits,
      // and everything beyond them can still shoot you) while leaving the
      // sidestep that makes the fight a fight.
      const yA = room.y + (room.h >> 1) - 1, yB = yA + 1;
      const gap = 2;                       // columns left open at each end
      const x0 = room.x + gap, x1 = room.x + room.w - 1 - gap;

      for (let x = x0; x <= x1; x++) {
        for (const y of [yA - 1, yB + 1]) {
          if (lvl.at(x, y) === T.FLOOR) lvl.set(x, y, T.PIT);
        }
      }
      for (let x = room.x; x < room.x + room.w; x++) {
        for (const y of [yA, yB]) {
          if (lvl.at(x, y) === T.FLOOR) anchors.causeway.push({ x, y });
        }
        // Beyond the pits: in plain sight, in range, and reachable only by
        // walking all the way round the end.
        for (let y = room.y; y < room.y + room.h; y++) {
          if (y >= yA - 1 && y <= yB + 1) continue;
          if (x >= x0 && x <= x1 && lvl.at(x, y) === T.FLOOR) anchors.far.push({ x, y });
        }
      }
      const far = anchors.causeway.filter((t) => t.x >= x1);
      anchors.end.push(...(far.length ? far : anchors.causeway.slice(-1)));
      return anchors;
    },

    cast: [
      { role: 'ranged', at: 'far', n: [2, 2], aware: true, spread: true },
      { role: 'blocker', at: 'end', n: [1, 1], aware: true },
    ],
  },

  {
    key: 'centrepiece',
    name: 'the broken floor',

    // The opposite of a colonnade, on purpose. There the sight lines break and
    // the ground is open; here the ground breaks and the sight lines are open.
    //
    // Rubble stops feet without stopping eyes, so everything in the room can
    // see you and shoot you the whole time, and the only thing the terrain
    // takes away is the straight route. Circling the mound is the answer to
    // one enemy and the mistake against three.
    intent: '視線全開,斷掉的是路。中央的碎石擋腳不擋眼,'
          + '所以繞它可以躲開一個人的近身,卻躲不開任何一支箭。',

    minDepth: 2,
    fits: (r) => r.w >= 8 && r.h >= 5,

    build(lvl, room) {
      const anchors = { rim: [], ring: [] };
      const cx = room.x + (room.w >> 1), cy = room.y + (room.h >> 1);
      // A compact mound, not a scatter - it has to be worth walking round.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > 1 + (dx && dy ? 0 : 1)) continue;
          if (lvl.at(cx + dx, cy + dy) === T.FLOOR) lvl.set(cx + dx, cy + dy, T.RUBBLE);
        }
      }
      for (let y = room.y; y < room.y + room.h; y++) {
        for (let x = room.x; x < room.x + room.w; x++) {
          if (lvl.at(x, y) !== T.FLOOR) continue;
          const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
          if (d >= 3) anchors.rim.push({ x, y });        // the outer edge
          else if (d === 2) anchors.ring.push({ x, y }); // just off the mound
        }
      }
      return anchors;
    },

    // Spread around the outside so there is no angle that answers all of them,
    // and one thing already close enough to make standing still expensive.
    cast: [
      { role: 'ranged', at: 'rim', n: [1, 2], aware: true, spread: true },
      { role: 'charger', at: 'rim', n: [1, 1], aware: true },
      { role: 'blocker', at: 'ring', n: [1, 1], aware: true },
    ],
  },
];

export const CHAMBER_BY_KEY = Object.fromEntries(CHAMBERS.map((c) => [c.key, c]));
