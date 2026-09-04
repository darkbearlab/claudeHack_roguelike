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
    name: 'the span',

    // A corridor variant whose walls are missing.
    //
    // Two wrong turns got here. The first built the flanks out of PITS - a
    // wall you can see over, which contradicts the whole sentence. The second
    // removed the terrain entirely, which lost the thing that made it a
    // corridor at all: it became a room with archers in it.
    //
    // What it wants is both. The route is real, made and narrow, and what
    // borders it is not stone but ABSENCE - so the far side is ground you can
    // see, be seen from, and be shot from, and cannot reach without walking
    // all the way round. That is the corridor drawn in danger, with the danger
    // standing on solid ground where you can eventually get at it.
    //
    // Two lanes wide, not one. A one-wide span is a one-wide corridor and the
    // generator has a measured rule against those - every attack shape
    // collapses, the only movement is forward and back. Two lanes leaves the
    // sidestep and still reads as a bridge.
    intent: '一條有欄杆的橋,兩側不是牆是空的:看得到對面、被對面射得到、走不過去。'
          + '所以是低頭走完這座橋,還是繞一大圈上去把守橋的人解決掉。',

    minDepth: 4,
    fits: (r) => r.w >= 10 && r.h >= 6,

    build(lvl, room) {
      const anchors = { span: [], ledge: [], head: [] };
      // The drop runs the length of the room; the span crosses it lengthwise.
      //
      // A one-tile margin of solid ground is kept all the way round, and that
      // is a connectivity rule rather than a decorative one: a door opens onto
      // the tile inside the wall it is in, and a door opening onto thin air is
      // a floor cut in half. The test caught exactly that.
      const top = room.y + Math.floor((room.h - 2) / 2);
      const bottom = top + 1;
      const x0 = room.x + 2, x1 = room.x + room.w - 3;
      const y0 = room.y + 1, y1 = room.y + room.h - 2;

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (lvl.at(x, y) !== T.FLOOR) continue;
          lvl.set(x, y, (y === top || y === bottom) ? T.BRIDGE : T.CHASM);
        }
      }
      for (let y = room.y; y < room.y + room.h; y++) {
        for (let x = room.x; x < room.x + room.w; x++) {
          const t = lvl.at(x, y);
          if (t === T.BRIDGE) anchors.span.push({ x, y });
          // Solid ground the other side of the drop: in plain sight, in range,
          // and only reachable the long way round.
          else if (t === T.FLOOR && (y < top || y > bottom) &&
                   x >= x0 && x <= x1) {
            // The far bank: solid, in sight, in range, across the drop.
            anchors.ledge.push({ x, y });
          }
        }
      }
      anchors.ledge.sort((a, b) => (a.x - b.x) || (a.y - b.y));
      anchors.head.push(...anchors.span.filter((t) => t.x >= x1));
      return anchors;
    },

    // Archers on the ledges either side, so no angle on the bridge answers
    // both of them, and something holding the far end so the crossing is not
    // simply a walk.
    cast: [
      { role: 'ranged', at: 'ledge', n: [2, 3], aware: true, spread: true },
      { role: 'blocker', at: 'head', n: [1, 1], aware: true },
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
