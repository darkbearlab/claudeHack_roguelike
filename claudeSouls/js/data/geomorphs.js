// The tiles a floor is built from.
//
// A TILE IS ITS ART. That is the whole design, and it is what makes extending
// this cheap: to add a tile you draw it. Nothing else has to be told.
//
//   - Sockets are `+` on the border, at index 4-5 of each 10-wide edge
//     segment, so every rotation of every tile lines up with every other.
//   - The footprint is the art's size in units of 10: 10x10 is one cell,
//     20x10 is two, 20x20 is four.
//   - Anchors for a situation are lowercase letters, mapped to names in the
//     tile's `anchors` table. The letter is floor (or whatever `tile` says).
//
// Why tiles at all: see docs/DESIGN.md, "the map is assembled from tiles".
// Short version - the rooms-and-corridors generator produced geometry, and
// the things that went wrong in it were all "two features wanted the same
// ground". A tile owns its ground by construction. Every passage is drawn two
// wide, so the corridor-width rule is a property of the drawings rather than
// a repair pass; and a situation is a tile with a cast list, which is what it
// always was.
//
// Legend:  # wall   . floor   I pillar   % rubble   O pit   ~ chasm
//          (terrain glyphs are never lowercase letters - those are anchors)
//          = bridge  < stairs up  * bonfire   D door   + socket   a-z anchor

export const GEOMORPHS = {
  // ==== the random pile ====================================================
  // `weight` is how many copies are in the pile.

  cross: { weight: 2, art: [
    '####++####',
    '#........#',
    '#........#',
    '#........#',
    '+........+',
    '+........+',
    '#........#',
    '#........#',
    '#........#',
    '####++####',
  ]},

  hall: { weight: 2, art: [
    '####++####',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '####++####',
  ]},

  // A passage with a widening: two wide, with somewhere to turn round.
  landing: { weight: 2, art: [
    '####++####',
    '####..####',
    '####..####',
    '###....###',
    '###....###',
    '###....###',
    '###....###',
    '####..####',
    '####..####',
    '####++####',
  ]},

  // A short single-file stretch. Narrow places are tactics - a corridor is a
  // real answer to a pack of hounds - and the only rule is that they must be
  // SHORT: four tiles here, which is MAX_STRAIT exactly and never more.
  squeeze: { weight: 4, art: [
    '####++####',
    '###....###',
    '###....###',
    '####.#####',
    '####.#####',
    '####.#####',
    '####.#####',
    '###....###',
    '###....###',
    '####++####',
  ]},

  // A two-wide passage pinched to one by a pillar, twice. Short and narrow,
  // and you can see straight through it.
  //
  // The pillars are offset by three rows, not two. Placed diagonally next to
  // each other they left only a corner-to-corner step between them, and the
  // game's corner-cutting rule refuses that - so the tile was passable to the
  // test's walker and a wall to the player. Nothing narrow may depend on a
  // diagonal.
  pinch: { weight: 4, art: [
    '####++####',
    '####..####',
    '####.I####',
    '####..####',
    '####..####',
    '####..####',
    '####I.####',
    '####..####',
    '####..####',
    '####++####',
  ]},

  bend: { weight: 3, art: [
    '####++####',
    '####..####',
    '####..####',
    '####.....#',
    '####.....+',
    '####.....+',
    '####.....#',
    '##########',
    '##########',
    '##########',
  ]},

  tee: { weight: 3, art: [
    '####++####',
    '###....###',
    '###....###',
    '#........#',
    '+........+',
    '+........+',
    '#........#',
    '##########',
    '##########',
    '##########',
  ]},

  pillared: { weight: 2, art: [
    '####++####',
    '#........#',
    '#..I..I..#',
    '#........#',
    '+........+',
    '+........+',
    '#........#',
    '#..I..I..#',
    '#........#',
    '####++####',
  ]},

  // A wall across the room with two ways through: whichever you take, the
  // other side is where something can come at you from.
  split: { weight: 2, art: [
    '####++####',
    '#........#',
    '#........#',
    '#........#',
    '#..####..#',
    '#..####..#',
    '#........#',
    '#........#',
    '#........#',
    '####++####',
  ]},

  // A wall with one single-leaf door in it. The narrowest thing in the game,
  // one tile long, and a real door: the diagonal rule still bites here, and
  // that is what keeps a doorway usable as a place to hold.
  slot: { weight: 2, art: [
    '####++####',
    '#........#',
    '#........#',
    '#........#',
    '#####D####',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '####++####',
  ]},

  nook: { weight: 1, art: [
    '####++####',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '#........#',
    '##########',
  ]},

  // A long hall in two cells, so that not every big space is a situation.
  gallery: { weight: 1, art: [
    '####++########++####',
    '#..................#',
    '#..................#',
    '#........##........#',
    '+........##........+',
    '+........##........+',
    '#........##........#',
    '#..................#',
    '#..................#',
    '####++########++####',
  ]},

  // ==== the special stack ==================================================
  // `special` names the situation in chambers.js that supplies the cast and
  // the intent. The geometry is here; what stands where is there.

  broken: { special: 'centrepiece', anchors: { m: 'rim', n: 'ring' }, art: [
    '####++####',
    '#mmmmmmmm#',
    '#mnnnnnnm#',
    '#mn.%%.nm#',
    '+mn%%%%nm+',
    '+mn%%%%nm+',
    '#mn.%%.nm#',
    '#mnnnnnnm#',
    '#mmmmmmmm#',
    '####++####',
  ]},

  colonnade: { special: 'colonnade', anchors: { l: 'lane', f: 'flank' }, art: [
    '####++########++####',
    '#ffffffffffffffffff#',
    '#fI.f.I..f.I.f.I.ff#',
    '#..................#',
    '+llllllllllllllllll+',
    '+llllllllllllllllll+',
    '#..................#',
    '#fI.f.I..f.I.f.I.ff#',
    '#ffffffffffffffffff#',
    '####++########++####',
  ]},

  // The span: a bridge wall to wall, and the banks reachable only from OTHER
  // tiles - across the drop, in sight, in range, and not on foot. That is the
  // corridor drawn in danger rather than in stone.
  //
  // `allEnds`: every socket must connect. The bridge's two because a bridge
  // ending at the map edge is a bridge to a wall; the banks' two because a
  // bank nothing can reach is not a bank, it is a wall you can see over, and
  // the whole point of the situation is that the far side is somewhere the
  // archers stand and you can eventually get to.
  span: { special: 'gauntlet', allEnds: true,
          anchors: { s: { name: 'span', tile: 'BRIDGE' }, h: { name: 'head', tile: 'BRIDGE' }, d: 'ledge' },
          art: [
    '####++########++####',
    '#dddddddddddddddddd#',
    '#dddddddddddddddddd#',
    '#~~~~~~~~~~~~~~~~~~#',
    '+sssssssssssssssssh+',
    '+sssssssssssssssssh+',
    '#~~~~~~~~~~~~~~~~~~#',
    '#dddddddddddddddddd#',
    '#dddddddddddddddddd#',
    '####++########++####',
  ]},

  // ==== fixed pieces =======================================================
  // Placed by the assembler on purpose rather than drawn from a pile.

  // Where you arrive. The stair and the fire beside it, as on every floor.
  stairIn: { fixed: true, art: [
    '####++####',
    '#........#',
    '#........#',
    '#........#',
    '#...<*...+',
    '#........+',
    '#........#',
    '#........#',
    '#........#',
    '####++####',
  ]},

  // The dragon's hall. Open ground and nothing else in it.
  //
  // A socket on every side of every cell. The hall does not grow its own
  // tiles (see geomorph.js), so these are the places the floor can join it,
  // and with only two of them half the boss floors needed a piece beside the
  // hall swapped out before it could be reached at all. Any socket nothing
  // arrives at is written as wall, so the hall still has as many doors as it
  // has neighbours that reached it - usually two or three, not eight.
  dragonHall: { fixed: true, art: [
    '####++########++####',
    '#..................#',
    '#..................#',
    '#..................#',
    '+..................+',
    '+..................+',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '+..................+',
    '+..................+',
    '#..................#',
    '#..................#',
    '#..................#',
    '####++########++####',
  ]},
};

/**
 * Everything wrong with one tile's drawing, as a list of sentences.
 *
 * Shared with the tile editor (tools/tile-editor.html), so what the editor
 * refuses and what the game refuses are the same rules by construction.
 */
export function validateTile(name, t) {
  const bad = [];
  const art = t?.art ?? [];
  const h = art.length, w = art[0]?.length ?? 0;
  if (!h || !w) { bad.push(`${name}: empty`); return bad; }
  if (h % 10 || w % 10) bad.push(`${name}: ${w}x${h} is not a multiple of 10`);
  if (art.some((r) => r.length !== w)) bad.push(`${name}: ragged rows`);
  let sockets = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = art[y][x];
    if (c === '+') {
      sockets++;
      const onEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      const at = (x === 0 || x === w - 1) ? y % 10 : x % 10;
      if (!onEdge || (at !== 4 && at !== 5)) bad.push(`${name}: socket at ${x},${y} is not at 4-5 of an edge`);
      else {
        // its partner cell must be a socket too
        const px = (x === 0 || x === w - 1) ? x : (at === 4 ? x + 1 : x - 1);
        const py = (x === 0 || x === w - 1) ? (at === 4 ? y + 1 : y - 1) : y;
        if (art[py]?.[px] !== '+') bad.push(`${name}: socket at ${x},${y} is one cell wide - both 4 and 5 must be +`);
      }
    } else if (/[a-z]/.test(c) && !t.anchors?.[c]) {
      bad.push(`${name}: anchor letter '${c}' has no name`);
    } else if (!/[#.I%O~=<>*D+ ]/.test(c) && !/[a-z]/.test(c)) {
      bad.push(`${name}: unknown character '${c}' at ${x},${y}`);
    }
  }
  if (!sockets && !t.fixed) bad.push(`${name}: no sockets - nothing could ever be placed next to it`);
  // every edge cell that is not a socket must be wall, or the tile leaks
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) {
    const c = art[y][x];
    if (c !== '#' && c !== '+') bad.push(`${name}: border at ${x},${y} is '${c}', must be wall or socket`);
  }
  for (let y = 1; y < h - 1; y++) for (const x of [0, w - 1]) {
    const c = art[y][x];
    if (c !== '#' && c !== '+') bad.push(`${name}: border at ${x},${y} is '${c}', must be wall or socket`);
  }
  return bad;
}

/** Every tile's art is the right shape, or the loader says which one is not. */
export function validateGeomorphs() {
  const bad = [];
  for (const [name, t] of Object.entries(GEOMORPHS)) bad.push(...validateTile(name, t));
  return bad;
}
