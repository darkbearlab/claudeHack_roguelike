// The people at the fire.
//
// They are not enemies and they are not scenery. The distinction is enforced
// by where they live rather than by a flag: every attack in this game resolves
// through `level.enemyAt`, so an NPC - which is in `level.npcs` - cannot be hit
// by anything, ever, without someone writing a special case to allow it. That
// is a much stronger guarantee than `invulnerable: true`, which is only as good
// as everybody remembering to check it.
//
// What they are *for* is docs/META.md. The Fire Keeper below says the run's
// statistics, which is a placeholder holding the seat - the point of building
// her now is the conversation system underneath, so the story has somewhere to
// grow into later.
//
// **Every seed has someone at the fire.** That is decided, and it is why this
// is a list rather than a single hard-coded person: the variation between
// seeds will be *which* of these turns up and what they say, never whether
// anybody does. An empty fire is just a room with nothing in it; a stranger
// sitting at it is a lead. It also means no player can miss the thread by
// being unlucky with seeds, which is the failure mode a story told through
// random encounters usually dies of.

import { HEROES } from './heroes.js';

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

/**
 * The heroes, standing in the hall as people you can talk to.
 *
 * Built from the roster rather than written out, so a hero added to
 * heroes.js turns up in the hall without anybody remembering to put them
 * there - the layout of the room IS the character select, and a menu that can
 * disagree with the roster is a menu that eventually will.
 *
 * They wear their own kit's armour, so no new art was needed: the knight is
 * the figure in mail, the binder the one in leathers.
 */
export const HERO_NPCS = HEROES.map((h) => ({
  key: `hero:${h.key}`,
  hero: h.key,
  name: h.name,
  sprite: h.sprite,
  face: h.face,
  glyph: '@',
  colour: '#e8dcb8',
  // Standing, not seated - they are waiting to go, not tending anything.
  still: true,
  greeting: [h.blurb],
  about: h.about,
}));

export const NPC_BY_KEY = Object.fromEntries(
  [...NPCS, ...HERO_NPCS].map((n) => [n.key, n]));
