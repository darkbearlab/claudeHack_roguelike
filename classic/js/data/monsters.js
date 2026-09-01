// The bestiary.
//
// Fields, and why they exist:
//   lvl    difficulty. Drives generation depth, XP, to-hit and HP (d(lvl,8)).
//   spd    energy gained per turn; the hero is 12. 18 is "gets three moves to
//          your two" and is the single stat that most changes how a fight goes.
//   ac     lower is harder to hit, NetHack-style, and can go negative.
//   mr     percent chance to shrug off a hostile spell or wand effect.
//   freq   relative generation weight. 0 means "never generated randomly".
//   atk    [type, dice, sides, effect]. A monster may have several.
//   sprite name in the generated asset library, or null to fall back to glyph.
//
// Sprites are shared where the roster is denser than the art: a wolf sprite
// serves warg and winter wolf, a skeleton serves every skeletal undead. That is
// deliberate - a distinct silhouette per species would cost far more art than
// it adds, and the glyph and colour still separate them.

const M = (key, name, glyph, colour, lvl, spd, ac, mr, freq, atk, sprite, flags = {}) =>
  ({ key, name, glyph, colour, lvl, spd, ac, mr, freq, atk, sprite, ...flags });

// atk helper: a(type, n, d, effect)
const a = (type, n, d, effect = null) => ({ type, n, d, effect });

export const MONSTERS = [
  // ---------------------------------------------------------------- vermin
  M('newt',        'newt',            ':', '#d9c84a',  0, 6, 8,  0, 60, [a('bite',1,3)], 'mon_newt',
    { animal: true, tiny: true, nutrition: 20 }),
  M('sewer rat',   'sewer rat',       'r', '#8a6a45',  0, 12, 7, 0, 70, [a('bite',1,3)], 'mon_rat',
    { animal: true, tiny: true, carnivore: true, nutrition: 12 }),
  M('grid bug',    'grid bug',        'x', '#b06ad0',  0, 12, 9, 0, 45, [a('bite',1,1,'elec')], null,
    { animal: true, tiny: true, mindless: true, noDiagonal: true, nutrition: 10 }),
  M('lichen',      'lichen',          'F', '#8fbf6a',  0, 3, 9,  0, 40, [a('touch',0,0,'stick')], 'mon_mold',
    { neverMove: false, mindless: true, breathless: true, nutrition: 200, vegan: true }),
  M('jackal',      'jackal',          'd', '#c8a24a',  0, 12, 7, 0, 65, [a('bite',1,2)], 'mon_jackal',
    { animal: true, carnivore: true, group: [2,4], nutrition: 250 }),
  M('bat',         'bat',             'B', '#9b7a52',  0, 22, 8, 0, 45, [a('bite',1,4)], 'mon_bat',
    { animal: true, flies: true, erratic: true, nutrition: 20 }),
  M('kobold',      'kobold',          'k', '#6faa4a',  0, 6, 10, 0, 45, [a('weapon',1,4)], 'mon_kobold',
    { humanoid: true, opensDoors: true, picksUp: true, poisonous: true, nutrition: 100 }),

  // ------------------------------------------------------------- low tier
  M('giant rat',   'giant rat',       'r', '#a06a3a',  1, 10, 7, 0, 45, [a('bite',1,3)], 'mon_rat',
    { animal: true, carnivore: true, nutrition: 30 }),
  M('large kobold','large kobold',    'k', '#4e8f3a',  1, 6, 10, 0, 35, [a('weapon',1,6)], 'mon_kobold',
    { humanoid: true, opensDoors: true, picksUp: true, poisonous: true, nutrition: 150 }),
  M('gnome',       'gnome',           'G', '#c85a4a',  1, 6, 10, 4, 40, [a('weapon',1,6)], 'mon_gnome',
    { humanoid: true, opensDoors: true, picksUp: true, group: [1,3], nutrition: 100 }),
  M('giant ant',   'giant ant',       'a', '#3c3c44',  2, 18, 3, 0, 40, [a('bite',1,4)], 'mon_ant',
    { animal: true, carnivore: true, nutrition: 10 }),
  M('cave spider', 'cave spider',     's', '#4a4a52',  1, 12, 3, 0, 40, [a('bite',1,2)], 'mon_spider',
    { animal: true, carnivore: true, tiny: true, nutrition: 50 }),
  M('acid blob',   'acid blob',       'b', '#8fd44a',  1, 3, 8, 0, 30, [a('passive',1,8,'acid')], 'mon_mold',
    { neverMove: true, mindless: true, breathless: true, acidic: true, nutrition: 30 }),
  M('green mold',  'green mold',      'F', '#4aa04a',  1, 0, 9, 0, 30, [a('passive',1,4,'acid')], 'mon_mold',
    { neverMove: true, mindless: true, breathless: true, acidic: true, vegan: true, nutrition: 30 }),
  M('yellow mold', 'yellow mold',     'F', '#c8c04a',  1, 0, 9, 0, 30, [a('passive',1,4,'poison')], 'mon_mold',
    { neverMove: true, mindless: true, breathless: true, poisonous: true, vegan: true, nutrition: 30 }),
  M('homunculus',  'homunculus',      'i', '#5aa06a',  2, 12, 6, 10, 25, [a('bite',1,3,'sleep')], 'mon_kobold',
    { humanoid: true, flies: true, poisonRes: true, nutrition: 100 }),
  M('gnome lord',  'gnome lord',      'G', '#d06a4a',  3, 8, 10, 4, 25, [a('weapon',1,8)], 'mon_gnome',
    { humanoid: true, opensDoors: true, picksUp: true, nutrition: 120 }),
  M('hill orc',    'hill orc',        'o', '#5c9a3a',  2, 9, 10, 0, 45, [a('weapon',1,6)], 'mon_orc',
    { humanoid: true, opensDoors: true, picksUp: true, group: [2,5], orc: true, nutrition: 200 }),
  M('wolf',        'wolf',            'd', '#8a8a92',  5, 12, 4, 0, 35, [a('bite',2,4)], 'mon_wolf',
    { animal: true, carnivore: true, group: [2,4], nutrition: 250 }),

  // ------------------------------------------------------------- mid tier
  M('floating eye','floating eye',    'e', '#4a8ad0',  2, 1, 9, 10, 40, [a('passive',0,70,'paralyze')], 'mon_floating_eye',
    { flies: true, mindless: false, breathless: true, nutrition: 10, telepathyCorpse: true }),
  M('rothe',       'rothe',           'q', '#8a5a3a',  2, 9, 7, 0, 30, [a('butt',1,3),a('bite',1,8)], 'mon_wolf',
    { animal: true, nutrition: 600 }),
  M('giant beetle','giant beetle',    'a', '#2c2c34',  5, 6, 4, 0, 25, [a('bite',3,6)], 'mon_ant',
    { animal: true, poisonous: true, nutrition: 10 }),
  M('snake',       'snake',           'S', '#4aa04a',  4, 15, 3, 0, 35, [a('bite',1,6,'poison')], 'mon_snake',
    { animal: true, poisonRes: true, poisonous: true, swims: true, nutrition: 100 }),
  M('water moccasin','water moccasin','S', '#5ab05a',  4, 15, 3, 0, 20, [a('bite',1,4,'poison')], 'mon_snake',
    { animal: true, poisonRes: true, poisonous: true, swims: true, group: [2,4], nutrition: 80 }),
  M('giant spider','giant spider',    's', '#2a2a32',  5, 15, 4, 0, 25, [a('bite',2,4,'poison')], 'mon_spider',
    { animal: true, poisonRes: true, poisonous: true, carnivore: true, nutrition: 100 }),
  M('soldier ant', 'soldier ant',     'a', '#3a3a44',  3, 18, 3, 0, 30, [a('bite',2,4),a('sting',3,4,'poison')], 'mon_ant',
    { animal: true, poisonRes: true, poisonous: true, nutrition: 10 }),
  M('orc-captain', 'orc-captain',     'o', '#3c7a2a',  5, 5, 10, 0, 20, [a('weapon',2,4),a('weapon',2,4)], 'mon_orc',
    { humanoid: true, opensDoors: true, picksUp: true, orc: true, nutrition: 350 }),
  M('gnome king',  'gnome king',      'G', '#e07a4a',  5, 10, 10, 20, 15, [a('weapon',2,6)], 'mon_gnome',
    { humanoid: true, opensDoors: true, picksUp: true, nutrition: 150 }),
  M('dwarf',       'dwarf',           'h', '#b0763a',  2, 6, 10, 10, 30, [a('weapon',1,8)], 'mon_gnome',
    { humanoid: true, opensDoors: true, picksUp: true, digs: true, nutrition: 300 }),
  M('zombie',      'human zombie',    'Z', '#6a9a5a',  4, 6, 8, 0, 35, [a('claw',1,8)], 'mon_zombie',
    { undead: true, humanoid: true, mindless: true, breathless: true, poisonRes: true, coldRes: true,
      group: [1,3], nutrition: 250 }),
  M('skeleton',    'skeleton',        'Z', '#d8d4c8',  12, 8, 4, 0, 20, [a('claw',2,6),a('weapon',2,6)], 'mon_skeleton',
    { undead: true, humanoid: true, mindless: true, breathless: true, poisonRes: true, coldRes: true,
      opensDoors: true, picksUp: true, nutrition: 5 }),
  M('gnome zombie','gnome zombie',    'Z', '#7aa06a',  1, 6, 10, 0, 25, [a('claw',1,6)], 'mon_zombie',
    { undead: true, humanoid: true, mindless: true, breathless: true, poisonRes: true, coldRes: true, nutrition: 50 }),
  M('mummy',       'human mummy',     'M', '#b8a878',  6, 12, 4, 30, 20, [a('claw',2,4)], 'mon_zombie',
    { undead: true, humanoid: true, mindless: true, breathless: true, poisonRes: true, coldRes: true,
      opensDoors: true, nutrition: 200 }),
  M('gargoyle',    'gargoyle',        'g', '#8a8a94',  6, 10, -4, 0, 22, [a('claw',2,6),a('claw',2,6),a('bite',2,4)], 'mon_troll',
    { humanoid: true, breathless: true, nutrition: 200 }),
  M('leocrotta',   'leocrotta',       'q', '#c8b088',  6, 18, 4, 10, 20, [a('kick',2,6),a('bite',2,6)], 'mon_wolf',
    { animal: true, nutrition: 500 }),
  M('cockatrice',  'cockatrice',      'c', '#d8c04a',  5, 6, 6, 30, 20, [a('bite',1,3,'stone'),a('touch',0,0,'stone')], 'mon_cockatrice',
    { animal: true, poisonRes: true, poisonous: true, stoner: true, nutrition: 30 }),
  M('chameleon',   'chameleon',       ':', '#8ac86a',  6, 5, 6, 10, 10, [a('bite',4,2)], 'mon_newt',
    { animal: true, shapeshifter: true, nutrition: 100 }),
  M('quasit',      'quasit',          'i', '#6a4a8a',  3, 15, 2, 20, 20, [a('claw',1,2,'dexdrain'),a('bite',1,4)], 'mon_kobold',
    { humanoid: true, poisonRes: true, nutrition: 200 }),
  M('imp',         'imp',             'i', '#c85a5a',  3, 12, 2, 20, 20, [a('claw',1,4)], 'mon_kobold',
    { humanoid: true, regen: true, wantsToStayAway: true, nutrition: 10 }),
  M('wererat',     'wererat',         '@', '#8a6a5a',  2, 12, 9, 10, 15, [a('weapon',2,4,'lycanthropy')], 'mon_soldier',
    { humanoid: true, opensDoors: true, picksUp: true, poisonRes: true, nutrition: 400 }),
  M('soldier',     'soldier',         '@', '#c04a4a',  6, 10, 3, 0, 25, [a('weapon',4,4)], 'mon_soldier',
    { humanoid: true, opensDoors: true, picksUp: true, group: [1,3], human: true, nutrition: 400 }),
  M('watchman',    'watchman',        '@', '#4a7ac0',  6, 10, 10, 0, 0, [a('weapon',4,4)], 'mon_soldier',
    { humanoid: true, opensDoors: true, picksUp: true, human: true, nutrition: 400, peaceful: true }),

  // ------------------------------------------------------------ high tier
  M('owlbear',     'owlbear',         'Y', '#a08a5a',  5, 12, 5, 0, 20, [a('claw',1,6),a('claw',1,6),a('crush',2,8,'wrap')], 'mon_troll',
    { animal: true, carnivore: true, nutrition: 700 }),
  M('troll',       'troll',           'T', '#4a8a4a',  7, 12, 4, 0, 22, [a('weapon',4,2),a('claw',4,2),a('bite',2,6)], 'mon_troll',
    { humanoid: true, carnivore: true, regen: true, opensDoors: true, picksUp: true, revives: true, nutrition: 350 }),
  M('ettin',       'ettin',           'H', '#7a6a5a',  10, 12, 3, 0, 15, [a('weapon',2,6),a('weapon',2,6)], 'mon_minotaur',
    { humanoid: true, opensDoors: true, picksUp: true, nutrition: 1700 }),
  M('minotaur',    'minotaur',        'H', '#8a5a3a',  15, 15, 6, 0, 12, [a('claw',3,10),a('claw',3,10),a('butt',2,8)], 'mon_minotaur',
    { humanoid: true, carnivore: true, nutrition: 700 }),
  M('wraith',      'wraith',          'W', '#5a5a6a',  6, 12, 4, 15, 20, [a('touch',1,6,'drain')], 'mon_wraith',
    { undead: true, humanoid: true, breathless: true, poisonRes: true, coldRes: true, unsolid: true,
      levelDrain: true, nutrition: 0, corpseLevelUp: true }),
  M('barrow wight','barrow wight',    'W', '#7a7a8a',  3, 12, 5, 5, 18, [a('weapon',1,4),a('spell',0,0,'sleep')], 'mon_wraith',
    { undead: true, humanoid: true, breathless: true, poisonRes: true, coldRes: true, nutrition: 0 }),
  M('vampire',     'vampire',         'V', '#a04a5a',  10, 12, 1, 25, 15, [a('bite',1,6,'drain'),a('claw',1,6)], 'mon_wraith',
    { undead: true, humanoid: true, breathless: true, poisonRes: true, coldRes: true, flies: true,
      regen: true, opensDoors: true, nutrition: 400 }),
  M('mind flayer', 'mind flayer',     'h', '#9a5ac0',  9, 12, 5, 90, 12, [a('touch',2,1,'intdrain'),a('touch',2,1,'intdrain')], 'mon_mindflayer',
    { humanoid: true, telepathic: true, opensDoors: true, picksUp: true, nutrition: 400 }),
  M('lich',        'lich',            'L', '#8ac8d8',  11, 6, 0, 30, 12, [a('touch',1,10,'cold'),a('spell',0,0,'cast')], 'mon_lich',
    { undead: true, humanoid: true, breathless: true, poisonRes: true, coldRes: true, spellcaster: true,
      opensDoors: true, picksUp: true, nutrition: 100 }),
  M('demilich',    'demilich',        'L', '#a8d8e8',  14, 9, -2, 60, 8, [a('touch',3,4,'cold'),a('spell',0,0,'cast')], 'mon_lich',
    { undead: true, humanoid: true, breathless: true, poisonRes: true, coldRes: true, spellcaster: true,
      opensDoors: true, picksUp: true, nutrition: 100 }),
  M('beholder',    'floating sphere', 'e', '#a05ac0',  9, 13, 4, 50, 10, [a('gaze',0,0,'random'),a('bite',1,6)], 'mon_beholder',
    { flies: true, breathless: true, seeInvis: true, nutrition: 10 }),
  M('winter wolf', 'winter wolf',     'd', '#7ac0d8',  7, 12, 4, 20, 15, [a('bite',2,6),a('breath',4,6,'cold')], 'mon_wolf',
    { animal: true, carnivore: true, coldRes: true, nutrition: 300 }),
  M('hell hound',  'hell hound',      'd', '#d05a2a',  12, 14, 2, 20, 12, [a('bite',3,6),a('breath',3,6,'fire')], 'mon_wolf',
    { animal: true, carnivore: true, fireRes: true, nutrition: 300 }),
  M('baby dragon', 'baby red dragon', 'D', '#c04a3a',  12, 9, 2, 10, 10, [a('bite',2,6)], 'mon_dragon',
    { animal: true, carnivore: true, fireRes: true, nutrition: 500 }),
  M('red dragon',  'red dragon',      'D', '#e0402a',  15, 9, -1, 20, 8, [a('breath',6,6,'fire'),a('bite',3,8),a('claw',1,4),a('claw',1,4)], 'mon_dragon',
    { animal: true, carnivore: true, fireRes: true, flies: true, nutrition: 1500 }),
  M('gold dragon', 'gold dragon',     'D', '#e0c040',  15, 9, -1, 20, 6, [a('breath',6,6,'light'),a('bite',3,8),a('claw',1,4),a('claw',1,4)], 'mon_dragon',
    { animal: true, carnivore: true, flies: true, nutrition: 1500 }),
  M('nazgul',      'Nazgul',          'W', '#3a3a4a',  13, 12, 0, 25, 6, [a('weapon',1,4,'drain'),a('spell',0,0,'sleep')], 'mon_wraith',
    { undead: true, humanoid: true, breathless: true, poisonRes: true, coldRes: true, flies: true,
      opensDoors: true, picksUp: true, nutrition: 0 }),

  // --------------------------------------------------------- named / unique
  M('shopkeeper',  'shopkeeper',      '@', '#e0c040',  12, 18, 0, 50, 0, [a('weapon',4,4),a('weapon',4,4)], 'mon_soldier',
    { humanoid: true, human: true, opensDoors: true, picksUp: true, peaceful: true, unique: false,
      seeInvis: true, nutrition: 400, noCorpse: false }),
  M('watch captain','watch captain',  '@', '#4a9ad0',  10, 10, 3, 0, 0, [a('weapon',4,4)], 'mon_soldier',
    { humanoid: true, human: true, opensDoors: true, picksUp: true, peaceful: true, nutrition: 400 }),
  M('wizard',      'the Wizard of Yendor', '@', '#c060e0', 18, 12, -8, 100, 0,
    [a('claw',2,12),a('spell',0,0,'cast')], 'mon_lich',
    { humanoid: true, human: true, spellcaster: true, opensDoors: true, picksUp: true,
      seeInvis: true, covetous: true, regen: true, unique: true, teleports: true, nutrition: 400 }),
  M('amulet guard','sanctum guardian','&', '#d04a8a',  16, 12, -4, 65, 0,
    [a('claw',3,6),a('claw',3,6),a('breath',4,6,'fire')], 'mon_beholder',
    { humanoid: true, fireRes: true, poisonRes: true, seeInvis: true, flies: true, unique: false, nutrition: 0 }),
];

export const MONSTER_BY_KEY = Object.fromEntries(MONSTERS.map((m) => [m.key, m]));

/** Species that can turn up from ordinary random generation. */
const RANDOM_POOL = MONSTERS.filter((m) => m.freq > 0);

/**
 * NetHack's rule, simplified: difficulty is capped by the average of the depth
 * and the hero's experience level, and the floor rises with depth so that
 * level 20 stops handing you newts.
 */
export function pickMonsterSpec(rng, depth, heroLevel) {
  // The band, not the weighting, is what makes depth mean something. An earlier
  // version added +1 to the ceiling and weighted by (1 + level), which put
  // level-2 hill orcs and rothes on dungeon level 1 and killed a fresh Wizard
  // in about five turns. Both ends now move with depth and the bias inside the
  // band is mild.
  const maxLvl = Math.max(1, Math.floor((depth + heroLevel) / 2));
  const minLvl = Math.max(0, Math.floor(depth / 4) - 1);
  let pool = RANDOM_POOL.filter((m) => m.lvl <= maxLvl && m.lvl >= minLvl);
  if (!pool.length) pool = RANDOM_POOL.filter((m) => m.lvl <= maxLvl);
  if (!pool.length) pool = RANDOM_POOL;
  return rng.pickWeighted(pool, (m) => m.freq * (1 + m.lvl / 3));
}

export function monsterXP(spec) {
  let xp = 1 + spec.lvl * spec.lvl;
  if (spec.ac < 3) xp += (7 - spec.ac) * (7 - spec.ac);
  if (spec.spd > 12) xp += 20 + (spec.spd - 12) * 3;
  for (const at of spec.atk) if (at.effect) xp += 10;
  if (spec.spellcaster) xp += 50;
  return xp;
}
