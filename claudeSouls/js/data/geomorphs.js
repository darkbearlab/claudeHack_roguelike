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
//   - An edge whose middle pair (index 4-5) is drawn as floor is an OPEN
//     edge: no wall, no door. Two open edges facing each other merge into one
//     space; an open edge facing a wall is a wall; one facing nothing is floor
//     against rock. A situation or a fixed piece may only have one if it says
//     `openOk: true`, because their rooms are meant to be rooms.
//   - `enemies: [lo, hi]` (or `{ n: [lo, hi], aware: true }`) is how many
//     the tile wants standing in it. populate rolls the number, picks each
//     species for the depth, and counts them against the floor's budget the
//     way a situation's cast is counted - so a tile that asks for three is
//     not three more enemies on the floor, it is three of the floor's
//     enemies standing somewhere that was drawn for them. The room is claimed
//     for it: no random top-up, no fire, no chest. Tiles that say nothing are
//     filled by the ordinary random placement as before.
//   - `enemies: { at: 'post' }` puts one on EVERY cell of that anchor - the
//     way to say "something stands exactly here". Add `n: [lo, hi]` to take
//     only some of the marked cells instead of all of them. The species is
//     still drawn for the depth; only the ground is fixed.
//   - `role: 'ranged' | 'blocker' | 'charger' | 'guard'` on such an entry
//     asks for a KIND rather than whatever the depth offers, using the same
//     table a situation's cast uses. `enemies` may be a list of these, so one
//     tile can want shooters at the back and something solid in front.
//   - `enemies: { ..., nest: true }` holds those enemies back instead of
//     placing them: they come out when a SIGNAL wakes them. See docs/AMBUSH.md.
//   - `signal: { at: 'signal', oneIn: 2 }` is an unseen sensing area. Step
//     within SIGNAL_RADIUS of it and every nest within WAKE_RADIUS empties at
//     once. Live on only some seeds, and never on floor 1.
//   - A tile that asks for a role it cannot get is never placed that shallow:
//     `minDepth` is DERIVED from the roles used (nothing is `ranged` above
//     floor 2), so the drawing cannot promise something the floor cannot
//     supply. An explicit `minDepth` raises it further.
//   - A socket drawn `^^` instead of `++` is the ARROW: the board game's
//     marked entrance. A tile with an arrow can only be placed with the arrow
//     facing the tile it is placed from, so it is always entered there; its
//     other sockets are exits. A tile without one may be entered by any
//     socket. Most tiles want none. The span wants one, because entering it
//     from the far bank puts you behind the archers instead of under them.
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
//          = bridge  < stairs up  * bonfire   D door   + socket   ^ arrow socket   a-z anchor

import { ROLES } from './chambers.js';
import { ENEMY_BY_KEY } from './enemies.js';

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

  // Four pillars and a pair holding the middle. The pillars are not
  // decoration: they break the archers' line and give the player something to
  // put between themselves and a wind-up.
  hall: { weight: 2,
    anchors: { a: 'floor' },
    enemies: { at: 'floor', n: [1, 2] },
    art: [
    '####++####',
    '#........#',
    '#.I....I.#',
    '#....a...#',
    '#........#',
    '#........#',
    '#...a....#',
    '#.I....I.#',
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

  // A dry gully. You walk the length of it and nothing is there; the signal
  // sits at the mouth, and what was waiting comes out behind you. On the seeds
  // where the signal is dead the same three are simply standing in it, and you
  // fight a normal fight without ever learning what you walked past.
  //
  // Chargers, because a corridor ambush is about tempo. A blocker in front and
  // a blocker behind, with no room to sidestep, is a death sentence rather
  // than an ambush - which is why `role` is required on a nest at all.
  // Two or three of the four corners, not all four: without `n` this put four
  // chargers in every gully, and at weight 2 that was eight enemies a floor
  // out of a budget of eleven. Measured, floors ran to 28.
  gully: { weight: 1,
    anchors: { a: 'nest', s: 'signal' },
    enemies: { at: 'nest', role: 'charger', n: [2, 3], nest: true },
    signal: { at: 'signal', oneIn: 2 },
    art: [
    '####++####',
    '####..####',
    '###a..a###',
    '###....###',
    '+...ss...+',
    '+...ss...+',
    '###....###',
    '###a..a###',
    '####..####',
    '####++####',
  ]},


  // ---- narrow ground, and things standing in it --------------------------
  //
  // Narrow ground existed on two tiles in the entire catalogue, and a corridor
  // is the real answer to a pack. These add three, and every one of them
  // brings its own garrison - a tile that says nothing about enemies is a tile
  // the floor has to fill at random, which is how you get a fight nobody sited.

  // A neck that opens into a pocket. You cannot fight what is in the pocket
  // from the corridor, and you cannot leave the pocket except back through the
  // neck - so the decision is whether to go in at all.
  throat: { weight: 3,
    anchors: { a: 'post' },
    enemies: { at: 'post', n: [2, 3], role: 'blocker' },
    art: [
    '####++####',
    '####.#####',
    '####.#####',
    '##a....a##',
    '##......##',
    '##......##',
    '##a....a##',
    '####.#####',
    '####.#####',
    '####++####',
  ]},

  // A switchback: two single-file turns, and something at the far bend that
  // can see the whole last leg. That is the shape which makes a bow
  // frightening rather than annoying.
  hairpin: { weight: 3,
    anchors: { a: 'watch' },
    enemies: { at: 'watch', role: 'ranged', aware: true },
    art: [
    '####++####',
    '####.#####',
    '##...#####',
    '##.#######',
    '##.....###',
    '######.###',
    '####a..###',
    '####.#####',
    '####.#####',
    '####++####',
  ]},

  // Two lanes around a middle you can only enter from one side. What is inside
  // comes out at you; what you want is to meet it in a lane, not in there.
  warren: { weight: 2,
    anchors: { a: 'nest' },
    // No `role`. Asking for a charger meant asking for whatever the depth
    // calls a charger, and past floor 7 that is a 2x2 body which could not be
    // seated in here at all - ten floors in 595 staged a nest with nothing in
    // it, a tile whose entire idea is "something lives in there". Let the
    // depth pick, and the chamber can always hold what it picked.
    enemies: { at: 'nest', n: [1, 2] },
    art: [
    '####++####',
    '##......##',
    '##.####.##',
    '##.#aaa..#',
    '+..#aaa..+',
    '+..#aaa..+',
    '##.#aaa..#',
    '##.####.##',
    '##......##',
    '####++####',
  ]},

  // A rubble line across a room with something shooting over it. Rubble blocks
  // the feet and not the eye, so the archers are behind a wall that does not
  // stop their own shot - and you have to come round it.
  barricade: { weight: 2,
    anchors: { a: 'front', b: 'back' },
    enemies: [
      { at: 'front', role: 'blocker', n: [1, 2] },
      { at: 'back', role: 'ranged', n: [1, 2], aware: true },
    ],
    art: [
    '####++####',
    '#........#',
    '#..a..a..#',
    '#%%.%%.%%#',
    '+........+',
    '+........+',
    '#%%.%%.%%#',
    '#..b..b..#',
    '#........#',
    '####++####',
  ]},

  // A gate. Two marked cells either side of the way through, and something
  // standing on each of them - this is `enemies: { at }`, the way to say
  // "exactly here" rather than "somewhere in this tile". Awake, because two
  // things you have to get past are a decision and two things asleep are a
  // corridor.
  gatepost: { weight: 1, enemies: { at: 'post', aware: true }, anchors: { a: 'post' }, art: [
    '####++####',
    '####..####',
    '####..####',
    '###....###',
    '+..a..a..+',
    '+........+',
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

  // Open on the east. Beside another cavern it is one wide space; beside a
  // walled tile it is a room with a rock wall; beside nothing, a cave mouth.
  // Rubble is cover you can see over and cannot walk through, which is what an
  // open cave wants: the shape of the fight changes without the room getting
  // smaller. The east side stays an open edge.
  cavern: { weight: 2,
    // It has an open edge AND a garrison, so it has to say so: a tile that
    // claims its room is held to a room's rules unless it opts out.
    openOk: true,
    anchors: { a: 'floor' },
    enemies: { at: 'floor', n: [1, 3] },
    art: [
    '####++####',
    '#%.......%',
    '#...%.a...',
    '#.%.......',
    '#....a%...',
    '#..a......',
    '#.......%.',
    '#..%...a..',
    '#%....%...',
    '####++####',
  ]},

  // Open on two adjacent sides. Two of these corner to corner make an L; four
  // make a hall bigger than any tile.
  // A courtyard with a broken colonnade down one side, something posted in it
  // and something watching from the far end.
  court: { weight: 1,
    // It has an open edge AND a garrison, so it has to say so: a tile that
    // claims its room is held to a room's rules unless it opts out.
    openOk: true,
    anchors: { a: 'post', b: 'watch' },
    enemies: [
      { at: 'post', role: 'blocker', n: [1, 2] },
      { at: 'watch', role: 'ranged', n: [1, 1] },
    ],
    art: [
    '####++####',
    '#....b....',
    '#.I.....I.',
    '#.........',
    '+....a....',
    '+.........',
    '#.I.....I.',
    '#....a....',
    '#.%.....%.',
    '#.........',
  ]},

  // A causeway. You arrive on the bridge from the south and cross a gulf that
  // runs out to both edges - beside another chasm-edged tile it is one wide
  // drop - into a landing three rows deep with the way on at the north.
  // Drawn by the author in the editor; the catalogue's first tile that was.
  //
  // The bridge is the decision: two wide, five long, and while you are on it
  // there is nowhere sideways to go. The landing holds two shooters at the
  // back and two solid things in front of them, so crossing means arriving
  // into a blocked line while being shot down its length - and the shooters
  // are the reason you cannot simply wait on the near side.
  //
  // `blocker` for the front pair rather than `charger`: a charger would come
  // out onto the bridge and turn the crossing into a fight in a corridor,
  // which is a different tile. One word if that is ever wanted instead.
  //
  // Measured before `enemies` existed, the ordinary fill left this empty 78%
  // of the time.
  causeway: { weight: 1,
    anchors: { a: 'front', b: 'back' },
    enemies: [
      { at: 'back', role: 'ranged', aware: true },
      { at: 'front', role: 'blocker', aware: true },
    ],
    art: [
    '####++####',
    '..........',
    '...b..b...',
    '....aa....',
    '~~~~==~~~~',
    '~~~~==~~~~',
    '~~~~==~~~~',
    '~~~~==~~~~',
    '~~~~==~~~~',
    '~~~~^^~~~~',
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
  // The largest piece in the random pile: 136 open cells, every one of them
  // bare floor. Two aisles either side of a spine now, archers at the spine's
  // ends and something heavy in each aisle - a room you cross under fire
  // rather than a field you walk over.
  gallery: { weight: 1,
    anchors: { a: 'aisle', b: 'spine' },
    enemies: [
      { at: 'aisle', role: 'blocker', n: [1, 2] },
      { at: 'spine', role: 'ranged', n: [1, 2] },
    ],
    art: [
    '####++########++####',
    '#.......#b#........#',
    '#.I...........I....#',
    '#...a....##....a...#',
    '+........##........+',
    '+........##........+',
    '#...a....##....a...#',
    '#....I.........I...#',
    '#.......#b#........#',
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
  // `^` on the west end: you arrive ON the bridge, and the head - where the
  // blocker stands - is at the far end. Placed the other way round the same
  // drawing is a walk along a bank behind two archers, which is not a span.
  span: { special: 'gauntlet', allEnds: true,
          anchors: { s: { name: 'span', tile: 'BRIDGE' }, h: { name: 'head', tile: 'BRIDGE' }, d: 'ledge' },
          art: [
    '####++########++####',
    '#dddddddddddddddddd#',
    '#dddddddddddddddddd#',
    '#~~~~~~~~~~~~~~~~~~#',
    '^sssssssssssssssssh+',
    '^sssssssssssssssssh+',
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
  let sockets = 0, arrows = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = art[y][x];
    if (c === '+' || c === '^') {
      sockets++;
      if (c === '^') arrows++;
      const onEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      const at = (x === 0 || x === w - 1) ? y % 10 : x % 10;
      if (!onEdge || (at !== 4 && at !== 5)) bad.push(`${name}: socket at ${x},${y} is not at 4-5 of an edge`);
      else {
        // its partner cell must be a socket too
        const px = (x === 0 || x === w - 1) ? x : (at === 4 ? x + 1 : x - 1);
        const py = (x === 0 || x === w - 1) ? (at === 4 ? y + 1 : y - 1) : y;
        if (art[py]?.[px] !== c) bad.push(`${name}: socket at ${x},${y} is one cell wide - both 4 and 5 must be ${c}`);
      }
    } else if (/[a-z]/.test(c) && !t.anchors?.[c]) {
      bad.push(`${name}: anchor letter '${c}' has no name`);
    } else if (!/[#.I%O~=<>*D+^ ]/.test(c) && !/[a-z]/.test(c)) {
      bad.push(`${name}: unknown character '${c}' at ${x},${y}`);
    }
  }
  // Open edges: an edge segment's middle pair is all-socket, all-wall, or
  // all-floor. A mixed pair is ambiguous - half a doorway - and refused.
  const standable = (c) => c === '.' || c === '=' || /[a-z]/.test(c);
  let openEdges = 0;
  const pairs = [];
  for (let cx = 0; cx < w / 10; cx++) { pairs.push([[cx * 10 + 4, 0], [cx * 10 + 5, 0]]); pairs.push([[cx * 10 + 4, h - 1], [cx * 10 + 5, h - 1]]); }
  for (let cy = 0; cy < h / 10; cy++) { pairs.push([[0, cy * 10 + 4], [0, cy * 10 + 5]]); pairs.push([[w - 1, cy * 10 + 4], [w - 1, cy * 10 + 5]]); }
  for (const [[ax, ay], [bx, by]] of pairs) {
    const a = art[ay]?.[ax], b = art[by]?.[bx];
    const kind = (c) => (c === '+' || c === '^') ? 'socket' : c === '#' ? 'wall' : standable(c) ? 'open' : 'other';
    if (kind(a) !== kind(b)) bad.push(`${name}: edge middle at ${ax},${ay}/${bx},${by} is '${a}${b}' - half open, half not`);
    else if (kind(a) === 'open') { openEdges++; sockets++; }
    // 'other' - a chasm, a pit, rubble - is a closed edge drawn as itself:
    // nothing grows through it and nothing is ever written onto it. That is
    // what "the sides are open space, not stone" looks like on a border.
  }
  if (openEdges && (t.special || t.fixed) && !t.openOk) {
    bad.push(`${name}: an open edge on a ${t.special ? 'situation' : 'fixed piece'} - its room is meant to be a room; say openOk: true if you mean it`);
  }
  if (!sockets && !t.fixed) bad.push(`${name}: no sockets - nothing could ever be placed next to it`);
  // Two cells make one arrow socket; more than that is two entrances, and a
  // tile with two entrances has none.
  if (arrows > 2) bad.push(`${name}: ${arrows / 2} arrow sockets - a tile has one entrance or none`);
  if (arrows && t.fixed) bad.push(`${name}: an arrow on a fixed piece - fixed pieces are placed by hand and are not entered`);
  // enemies: a range, small, and not on a situation - a situation has a cast.
  if (t.enemies != null) {
    const drawn = new Set();
    for (const row of art) for (const c of row) {
      if (!/[a-z]/.test(c)) continue;
      const a = t.anchors?.[c];
      drawn.add(typeof a === 'string' ? a : a?.name);
    }
    for (const entry of enemyEntries(t)) {
      const { at, role, n } = entry;
      // `n` is required without `at` (there is nothing else to go on) and
      // optional with it (no `n` means every marked cell).
      if (n != null || !at) {
        if (!Array.isArray(n) || n.length !== 2 || !Number.isInteger(n[0]) || !Number.isInteger(n[1]) || n[0] < 0 || n[1] < n[0] || n[1] > 8) {
          bad.push(`${name}: enemies must be [lo, hi] with 0 <= lo <= hi <= 8`);
        }
      }
      // The anchor has to be one this tile actually draws, or the tile asks
      // for enemies on ground that does not exist and silently gets none.
      if (at && !drawn.has(at)) bad.push(`${name}: enemies at '${at}', but no cell is drawn with that anchor`);
      if (role && !ROLES[role]) bad.push(`${name}: unknown role '${role}' - one of ${Object.keys(ROLES).join(', ')}`);
      if (role && !at) bad.push(`${name}: role '${role}' without at - a role needs cells to stand on`);
      // A nest without a role would draw whatever the depth offers, and in a
      // corridor that can be a blocker at each end with nowhere to step - a
      // death sentence rather than an ambush.
      if (entry.nest && !role) bad.push(`${name}: a nest must name a role - see docs/AMBUSH.md`);
      if (entry.nest && !at) bad.push(`${name}: a nest must name the cells it comes out of`);
    }
    if (t.signal) {
      if (!t.signal.at) bad.push(`${name}: signal needs an "at" naming its cells`);
      else if (!drawn.has(t.signal.at)) bad.push(`${name}: signal at '${t.signal.at}', but no cell is drawn with that anchor`);
      const one = t.signal.oneIn;
      if (!Number.isInteger(one) || one < 1) bad.push(`${name}: signal.oneIn must be a whole number of 1 or more`);
    }
    if (t.special) bad.push(`${name}: enemies on a situation - a situation casts by role; use its cast list`);
    if (t.fixed) bad.push(`${name}: enemies on a fixed piece - the entry and the hall are populated by hand`);
  }
  // Sockets only ever sit at an edge's middle; that was checked above. The
  // rest of the border may be anything - wall, floor, chasm - because an edge
  // may be open now.
  return bad;
}

/**
 * What a tile's `enemies` says, always as a list of entries.
 *
 * Three shorthands grew here - a bare range, one object, a list - and every
 * reader had been re-deciding which it was looking at. One place decides now.
 */
export function enemyEntries(t) {
  const e = t?.enemies;
  if (e == null) return [];
  if (Array.isArray(e)) {
    // [lo, hi] is a count; anything else is a list of entries.
    if (e.length === 2 && typeof e[0] === 'number') return [{ n: e }];
    return e;
  }
  return [e];
}

/**
 * The shallowest floor this tile may appear on.
 *
 * Derived from the roles it asks for, because nothing is `ranged` above floor
 * 2 and a tile promising a shooter down there would get whatever the depth
 * happened to offer instead. An explicit `minDepth` raises it further; it can
 * never lower it below what the drawing needs.
 */
export function tileMinDepth(t) {
  let d = t?.minDepth ?? 1;
  for (const { role } of enemyEntries(t)) {
    const pool = role ? ROLES[role] : null;
    if (!pool?.length) continue;
    const shallowest = Math.min(...pool.map((k) => ENEMY_BY_KEY[k]?.minDepth ?? 99));
    d = Math.max(d, shallowest);
  }
  return d;
}

/** Every tile's art is the right shape, or the loader says which one is not. */
export function validateGeomorphs() {
  const bad = [];
  for (const [name, t] of Object.entries(GEOMORPHS)) bad.push(...validateTile(name, t));
  return bad;
}

/**
 * Tiles that contain narrow ground: a floor cell walled on two opposite sides.
 *
 * Derived from the art rather than declared, so it cannot drift from what the
 * tile actually looks like - the same reason `tileMinDepth` is derived from
 * the roles a tile uses. A corridor is the real answer to a pack of hounds, so
 * a floor with none of them has quietly removed an answer.
 */
export const NARROW = new Set(Object.entries(GEOMORPHS).filter(([, t]) => {
  const g = t.art;
  // Ground you can stand on, not merely "not a wall". A chasm is neither, and
  // counting it as open made a bridge over one look like an open hall.
  const open = (x, y) => {
    const c = g[y]?.[x];
    return c != null && ('.=<>*D'.includes(c) || /[a-z]/.test(c));
  };
  for (let y = 1; y < g.length - 1; y++) {
    for (let x = 1; x < g[0].length - 1; x++) {
      if (!open(x, y)) continue;
      if (open(x, y - 1) && open(x, y + 1) && !open(x - 1, y) && !open(x + 1, y)) return true;
      if (open(x - 1, y) && open(x + 1, y) && !open(x, y - 1) && !open(x, y + 1)) return true;
    }
  }
  return false;
}).map(([k]) => k));
