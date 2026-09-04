// The people at the fire.
//
// They are not enemies and they are not scenery. The distinction is enforced
// by where they live rather than by a flag: every attack in this game resolves
// through `level.enemyAt`, so an NPC - which is in `level.npcs` - cannot be hit
// by anything, ever, without someone writing a special case to allow it. That
// is a much stronger guarantee than `invulnerable: true`, which is only as good
// as everybody remembering to check it.
//
// What they are *for* is docs/META.md: the plan is that some seeds have someone
// at the fire who tells you a piece of a broken story and hands you something
// to carry out. None of that exists yet. The Fire Keeper below says the run's
// statistics, which is a placeholder holding the seat - the point of building
// her now is the conversation system underneath, so the story has somewhere to
// grow into later.

export const NPCS = [
  {
    key: 'firekeeper',
    name: '火防女',
    sprite: 'npc_firekeeper',      // on the map, top-down
    // A separate piece of art for the conversation. The map sprite is drawn
    // from directly overhead - it is a shape, not a face - and shrinking it
    // into a dialogue box shows you the top of a hood. Same pipeline, the
    // generator's `portrait` kind, which is a flat front view.
    face: 'npc_firekeeper_face',
    glyph: 'F',
    colour: '#cbb9d8',
    // She sits. The art is a seated, veiled figure, so she must never be drawn
    // rotated to face you - see ART_FACING and the note in render.js.
    still: true,
    greeting: [
      '灰燼還沒有冷。',
      '你要下去多少次都可以——火會記得。',
    ],
  },
];

export const NPC_BY_KEY = Object.fromEntries(NPCS.map((n) => [n.key, n]));
