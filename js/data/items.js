// The object table, and the identification game built on top of it.
//
// The identification game is the reason this file is shaped the way it is. A
// potion has a *true* identity (healing) and an *appearance* (a swirly potion).
// The mapping between the two is shuffled once per game from the seed, so:
//
//   - the same seed always produces the same shuffle, which makes runs
//     reproducible and shareable;
//   - knowing "swirly is healing" is knowledge about *this run only*, which is
//     what makes drinking an unknown potion a decision rather than a chore.
//
// Every class that has an appearance pool participates. Classes that do not
// (weapons, armour, food) are recognised on sight, exactly as in NetHack.

// glyph classes: ) weapon  [ armour  ! potion  ? scroll  / wand  = ring
//                " amulet  ( tool    % food    * gem     $ gold  + spellbook

const W = (key, name, dmgN, dmgD, hit, wt, cost, opts = {}) =>
  ({ key, name, cls: 'weapon', glyph: ')', colour: '#b8bcc4', dmgN, dmgD, hit, wt, cost,
     sprite: opts.sprite ?? 'item_sword', ...opts });

const A = (key, name, ac, slot, wt, cost, opts = {}) =>
  ({ key, name, cls: 'armor', glyph: '[', colour: '#9aa4b0', ac, slot, wt, cost,
     sprite: opts.sprite ?? 'item_armor', ...opts });

const P = (key, name, cost, opts = {}) =>
  ({ key, name, cls: 'potion', glyph: '!', colour: '#d05a7a', wt: 20, cost,
     sprite: 'item_potion', stackable: true, ...opts });

const S = (key, name, cost, opts = {}) =>
  ({ key, name, cls: 'scroll', glyph: '?', colour: '#e8e0c8', wt: 5, cost,
     sprite: 'item_scroll', stackable: true, ...opts });

const R = (key, name, cost, opts = {}) =>
  ({ key, name, cls: 'ring', glyph: '=', colour: '#d8c060', wt: 3, cost,
     sprite: 'item_ring', ...opts });

const Wd = (key, name, cost, opts = {}) =>
  ({ key, name, cls: 'wand', glyph: '/', colour: '#8ac0d8', wt: 7, cost,
     sprite: 'item_wand', charges: [4, 8], ...opts });

const Am = (key, name, cost, opts = {}) =>
  ({ key, name, cls: 'amulet', glyph: '"', colour: '#e0c040', wt: 20, cost,
     sprite: 'item_amulet', ...opts });

const B = (key, name, level, cost, opts = {}) =>
  ({ key, name, cls: 'spellbook', glyph: '+', colour: '#a070c0', wt: 50, cost,
     sprite: 'item_book', spellLevel: level, ...opts });

const F = (key, name, nutrition, wt, cost, opts = {}) =>
  ({ key, name, cls: 'food', glyph: '%', colour: '#c08a4a', nutrition, wt, cost,
     sprite: 'item_food', stackable: true, ...opts });

const Tl = (key, name, wt, cost, opts = {}) =>
  ({ key, name, cls: 'tool', glyph: '(', colour: '#a0a8b0', wt, cost,
     sprite: opts.sprite ?? 'item_key', ...opts });

const G = (key, name, cost, opts = {}) =>
  ({ key, name, cls: 'gem', glyph: '*', colour: '#70c0e0', wt: 1, cost,
     sprite: 'item_gem', stackable: true, ...opts });

export const OBJECTS = [
  // ------------------------------------------------------------- weapons
  W('dagger',            'dagger',            1, 4,  2,  10,   4, { freq: 30, skill: 'dagger', throwable: true, stackable: true, sprite: 'item_dagger' }),
  W('elven dagger',      'elven dagger',      1, 5,  2,  10,   4, { freq: 8,  skill: 'dagger', throwable: true, stackable: true, sprite: 'item_dagger', elven: true }),
  W('orcish dagger',     'orcish dagger',     1, 3,  2,  10,   4, { freq: 12, skill: 'dagger', throwable: true, stackable: true, sprite: 'item_dagger', orcish: true }),
  W('knife',             'knife',             1, 3,  0,   5,   4, { freq: 20, skill: 'dagger', throwable: true, stackable: true, sprite: 'item_dagger' }),
  W('short sword',       'short sword',       1, 6,  0,  30,  10, { freq: 22, skill: 'short sword' }),
  W('long sword',        'long sword',        1, 8,  0,  40,  15, { freq: 26, skill: 'long sword' }),
  W('two-handed sword',  'two-handed sword',  1, 12, 0, 150,  50, { freq: 12, skill: 'two-handed sword', twoHanded: true }),
  W('scimitar',          'scimitar',          1, 8,  0,  40,  15, { freq: 12, skill: 'scimitar' }),
  W('mace',              'mace',              1, 6,  0,  30,   5, { freq: 22, skill: 'mace', sprite: 'item_axe' }),
  W('war hammer',        'war hammer',        1, 6,  0,  50,   5, { freq: 14, skill: 'hammer', sprite: 'item_axe' }),
  W('club',              'club',              1, 6,  0,  30,   3, { freq: 14, skill: 'club', sprite: 'item_axe' }),
  W('quarterstaff',      'quarterstaff',      1, 6,  0,  40,   5, { freq: 12, skill: 'staff', twoHanded: true, sprite: 'item_axe' }),
  W('axe',               'axe',               1, 6,  0,  60,   8, { freq: 18, skill: 'axe', sprite: 'item_axe' }),
  W('battle-axe',        'battle-axe',        2, 6,  0, 120,  40, { freq: 10, skill: 'axe', twoHanded: true, sprite: 'item_axe' }),
  W('spear',             'spear',             1, 6,  0,  30,   3, { freq: 20, skill: 'spear', throwable: true }),
  W('trident',           'trident',           1, 6,  0,  25,   5, { freq: 8,  skill: 'trident' }),
  W('bow',               'bow',               1, 2,  0,  30,  60, { freq: 18, skill: 'bow', launcher: 'arrow', twoHanded: true, sprite: 'item_bow' }),
  W('arrow',             'arrow',             1, 6,  0,   1,   2, { freq: 30, skill: 'bow', ammo: 'bow', stackable: true, throwable: true, sprite: 'item_dagger' }),
  W('crossbow',          'crossbow',          1, 2,  0,  50,  40, { freq: 8,  skill: 'crossbow', launcher: 'bolt', twoHanded: true, sprite: 'item_bow' }),
  W('crossbow bolt',     'crossbow bolt',     1, 6,  0,   1,   2, { freq: 14, skill: 'crossbow', ammo: 'crossbow', stackable: true, throwable: true, sprite: 'item_dagger' }),
  W('dart',              'dart',              1, 3,  0,   1,   2, { freq: 22, skill: 'dart', throwable: true, stackable: true, sprite: 'item_dagger' }),
  W('shuriken',          'shuriken',          1, 8,  2,   1,   5, { freq: 6,  skill: 'dart', throwable: true, stackable: true, sprite: 'item_dagger' }),

  // -------------------------------------------------------------- armour
  A('leather armor',     'leather armor',     2, 'body',   150,   5, { freq: 26 }),
  A('studded leather',   'studded leather armor', 3, 'body', 200, 15, { freq: 20 }),
  A('ring mail',         'ring mail',         3, 'body',   250, 100, { freq: 16 }),
  A('scale mail',        'scale mail',        4, 'body',   250,  45, { freq: 16 }),
  A('chain mail',        'chain mail',        5, 'body',   300,  75, { freq: 18 }),
  A('splint mail',       'splint mail',       6, 'body',   400,  80, { freq: 10 }),
  A('banded mail',       'banded mail',       6, 'body',   350,  90, { freq: 10 }),
  A('plate mail',        'plate mail',        7, 'body',   450, 600, { freq: 6 }),
  A('mithril coat',      'dwarvish mithril-coat', 6, 'body', 150, 240, { freq: 5 }),
  A('elven mithril',     'elven mithril-coat', 5, 'body',  150, 240, { freq: 4 }),
  A('small shield',      'small shield',      1, 'shield',  30,   3, { freq: 20, sprite: 'item_shield' }),
  A('large shield',      'large shield',      2, 'shield', 100,  10, { freq: 12, sprite: 'item_shield' }),
  A('orcish helm',       'orcish helm',       1, 'helm',    30,  10, { freq: 14, sprite: 'item_helmet', orcish: true }),
  A('dwarvish helm',     'dwarvish iron helm', 2, 'helm',   30,  20, { freq: 10, sprite: 'item_helmet' }),
  A('helmet',            'helmet',            1, 'helm',    30,  10, { freq: 14, sprite: 'item_helmet' }),
  A('leather gloves',    'leather gloves',    1, 'gloves',  10,   8, { freq: 16 }),
  A('low boots',         'low boots',         1, 'boots',   10,   8, { freq: 16 }),
  A('high boots',        'high boots',        2, 'boots',   20,  12, { freq: 10 }),
  A('cloak of protection','cloak of protection', 3, 'cloak', 10, 50, { freq: 5, mc: 3, magic: true }),
  A('cloak of displacement','cloak of displacement', 1, 'cloak', 10, 50, { freq: 5, magic: true, displaces: true }),
  A('cloak of magic resistance','cloak of magic resistance', 1, 'cloak', 10, 50, { freq: 2, magic: true, magicRes: true }),
  A('elven cloak',       'elven cloak',       1, 'cloak',   10,  60, { freq: 6, magic: true, stealth: true, elven: true }),
  A('dwarvish cloak',    'dwarvish cloak',    1, 'cloak',   10,  50, { freq: 6 }),

  // ------------------------------------------------------------- potions
  P('healing',           'healing',            20,  { freq: 57 }),
  P('extra healing',     'extra healing',     100,  { freq: 47 }),
  P('full healing',      'full healing',      200,  { freq: 10 }),
  P('gain level',        'gain level',        300,  { freq: 20 }),
  P('gain energy',       'gain energy',       150,  { freq: 42 }),
  P('gain ability',      'gain ability',      300,  { freq: 42 }),
  P('restore ability',   'restore ability',   100,  { freq: 62 }),
  P('speed',             'speed',              50,  { freq: 42 }),
  P('see invisible',     'see invisible',      50,  { freq: 42 }),
  P('levitation',        'levitation',        200,  { freq: 42 }),
  P('invisibility',      'invisibility',      150,  { freq: 40 }),
  P('monster detection', 'monster detection', 150,  { freq: 40 }),
  P('object detection',  'object detection',  150,  { freq: 42 }),
  P('confusion',         'confusion',         100,  { freq: 42, bad: true }),
  P('blindness',         'blindness',         150,  { freq: 40, bad: true }),
  P('paralysis',         'paralysis',         300,  { freq: 42, bad: true }),
  P('sleeping',          'sleeping',           100, { freq: 42, bad: true }),
  P('hallucination',     'hallucination',     100,  { freq: 40, bad: true }),
  P('sickness',          'sickness',           50,  { freq: 42, bad: true }),
  P('acid',              'acid',              250,  { freq: 10, bad: true }),
  P('booze',             'booze',              50,  { freq: 42, bad: true }),
  P('fruit juice',       'fruit juice',        50,  { freq: 42 }),
  P('water',             'water',               0,  { freq: 92, noAppearance: true, appearance: 'clear' }),
  P('polymorph',         'polymorph',         200,  { freq: 10, bad: true }),

  // ------------------------------------------------------------- scrolls
  S('identify',          'identify',           20, { freq: 180 }),
  S('light',             'light',              50, { freq: 90 }),
  S('enchant weapon',    'enchant weapon',     60, { freq: 80 }),
  S('enchant armor',     'enchant armor',      80, { freq: 63 }),
  S('remove curse',      'remove curse',       80, { freq: 65 }),
  S('destroy armor',     'destroy armor',     100, { freq: 45, bad: true }),
  S('confuse monster',   'confuse monster',   100, { freq: 53 }),
  S('scare monster',     'scare monster',     100, { freq: 35 }),
  S('blank paper',       'blank paper',        60, { freq: 28 }),
  S('teleportation',     'teleportation',     100, { freq: 55 }),
  S('gold detection',    'gold detection',    100, { freq: 33 }),
  S('food detection',    'food detection',     30, { freq: 25 }),
  S('magic mapping',     'magic mapping',     100, { freq: 45 }),
  S('fire',              'fire',              100, { freq: 30 }),
  S('punishment',        'punishment',        300, { freq: 15, bad: true }),
  S('create monster',    'create monster',    200, { freq: 45, bad: true }),
  S('taming',            'taming',            200, { freq: 15 }),
  S('amnesia',           'amnesia',           200, { freq: 35, bad: true }),
  S('charging',          'charging',          300, { freq: 15 }),
  S('genocide',          'genocide',          300, { freq: 15 }),

  // --------------------------------------------------------------- wands
  Wd('light',            'light',              100, { freq: 95 }),
  Wd('nothing',          'nothing',            100, { freq: 25 }),
  Wd('digging',          'digging',            150, { freq: 55, ray: false }),
  Wd('magic missile',    'magic missile',      150, { freq: 50, ray: true, attack: true }),
  Wd('striking',         'striking',           150, { freq: 75, beam: true, attack: true }),
  Wd('fire',             'fire',               175, { freq: 40, ray: true, attack: true }),
  Wd('cold',             'cold',               175, { freq: 40, ray: true, attack: true }),
  Wd('sleep',            'sleep',              175, { freq: 50, ray: true }),
  Wd('lightning',        'lightning',          175, { freq: 28, ray: true, attack: true }),
  Wd('slow monster',     'slow monster',       150, { freq: 50, beam: true }),
  Wd('speed monster',    'speed monster',      150, { freq: 50, beam: true }),
  Wd('undead turning',   'undead turning',     150, { freq: 50, beam: true }),
  Wd('polymorph',        'polymorph',          200, { freq: 10, beam: true }),
  Wd('cancellation',     'cancellation',       200, { freq: 45, beam: true }),
  Wd('teleportation',    'teleportation',      200, { freq: 45, beam: true }),
  Wd('make invisible',   'make invisible',     150, { freq: 45, beam: true }),
  Wd('probing',          'probing',            150, { freq: 30, beam: true }),
  Wd('opening',          'opening',            150, { freq: 25, beam: true }),
  Wd('locking',          'locking',            150, { freq: 25, beam: true }),
  Wd('create monster',   'create monster',     200, { freq: 45 }),
  Wd('secret door detection','secret door detection', 150, { freq: 50 }),
  Wd('enlightenment',    'enlightenment',      150, { freq: 15 }),
  Wd('wishing',          'wishing',            500, { freq: 1, charges: [1, 2] }),

  // --------------------------------------------------------------- rings
  R('adornment',         'adornment',          100, { freq: 10 }),
  R('protection',        'protection',         100, { freq: 30, plus: true }),
  R('increase accuracy', 'increase accuracy',  150, { freq: 30, plus: true }),
  R('increase damage',   'increase damage',    150, { freq: 30, plus: true }),
  R('regeneration',      'regeneration',       200, { freq: 30, hunger: 2 }),
  R('searching',         'searching',          200, { freq: 30 }),
  R('stealth',           'stealth',            200, { freq: 30 }),
  R('sustain ability',   'sustain ability',    100, { freq: 30 }),
  R('warning',           'warning',            100, { freq: 30 }),
  R('see invisible',     'see invisible',      150, { freq: 30 }),
  R('invisibility',      'invisibility',       150, { freq: 20 }),
  R('poison resistance', 'poison resistance',  150, { freq: 20 }),
  R('fire resistance',   'fire resistance',    200, { freq: 20 }),
  R('cold resistance',   'cold resistance',    200, { freq: 20 }),
  R('shock resistance',  'shock resistance',   200, { freq: 20 }),
  R('free action',       'free action',        200, { freq: 15 }),
  R('levitation',        'levitation',         200, { freq: 20 }),
  R('slow digestion',    'slow digestion',     200, { freq: 20, hunger: -1 }),
  R('teleportation',     'teleportation',      200, { freq: 20, bad: true }),
  R('conflict',          'conflict',           300, { freq: 10, hunger: 3 }),
  R('aggravate monster', 'aggravate monster',  150, { freq: 20, bad: true }),
  R('hunger',            'hunger',             100, { freq: 20, bad: true, hunger: 4 }),

  // -------------------------------------------------------------- amulets
  Am('ESP',              'telepathy',          150, { freq: 175 }),
  Am('life saving',      'life saving',        150, { freq: 75 }),
  Am('strangulation',    'strangulation',      150, { freq: 135, bad: true }),
  Am('restful sleep',    'restful sleep',      150, { freq: 135, bad: true }),
  Am('versus poison',    'versus poison',      150, { freq: 165 }),
  Am('change',           'change',             150, { freq: 130, bad: true }),
  Am('unchanging',       'unchanging',         150, { freq: 45 }),
  Am('reflection',       'reflection',         150, { freq: 75 }),
  Am('magical breathing','magical breathing',  150, { freq: 65 }),

  // ----------------------------------------------------------- spellbooks
  B('force bolt',        'force bolt',        1,  100, { freq: 35, spell: 'force bolt' }),
  B('healing',           'healing',           1,  100, { freq: 40, spell: 'healing' }),
  B('detect monsters',   'detect monsters',   1,  100, { freq: 43, spell: 'detect monsters' }),
  B('light',             'light',             1,  100, { freq: 45, spell: 'light' }),
  B('sleep',             'sleep',             1,  100, { freq: 50, spell: 'sleep' }),
  B('confuse monster',   'confuse monster',   2,  200, { freq: 30, spell: 'confuse monster' }),
  B('cure blindness',    'cure blindness',    2,  200, { freq: 25, spell: 'cure blindness' }),
  B('magic missile',     'magic missile',     2,  200, { freq: 45, spell: 'magic missile' }),
  B('slow monster',      'slow monster',      2,  200, { freq: 30, spell: 'slow monster' }),
  B('extra healing',     'extra healing',     3,  300, { freq: 27, spell: 'extra healing' }),
  B('haste self',        'haste self',        3,  300, { freq: 33, spell: 'haste self' }),
  B('remove curse',      'remove curse',      3,  300, { freq: 25, spell: 'remove curse' }),
  B('dig',               'dig',               5,  500, { freq: 20, spell: 'dig' }),
  B('magic mapping',     'magic mapping',     5,  500, { freq: 45, spell: 'magic mapping' }),
  B('finger of death',   'finger of death',   7,  700, { freq: 5,  spell: 'finger of death' }),

  // ---------------------------------------------------------------- food
  F('food ration',       'food ration',       800, 20,  45, { freq: 380 }),
  F('cram ration',       'cram ration',       600, 15,  35, { freq: 20 }),
  F('lembas wafer',      'lembas wafer',      800,  5,  45, { freq: 20 }),
  F('K-ration',          'K-ration',          400, 10,  45, { freq: 0 }),
  F('apple',             'apple',              50,  2,   7, { freq: 15, vegan: true }),
  F('pear',              'pear',               50,  2,   7, { freq: 10, vegan: true }),
  F('melon',             'melon',             100,  5,   7, { freq: 10, vegan: true }),
  F('carrot',            'carrot',             50,  2,   7, { freq: 15, vegan: true, curesBlind: true }),
  F('tripe ration',      'tripe ration',      200, 10,  15, { freq: 140, tripe: true }),
  F('lump of royal jelly','lump of royal jelly',200, 2, 15, { freq: 10, gainStr: true }),
  F('candy bar',         'candy bar',         100,  2,  10, { freq: 13, vegan: true }),
  F('fortune cookie',    'fortune cookie',     40,  1,   7, { freq: 55, vegan: true, fortune: true }),

  // ---------------------------------------------------------------- tools
  Tl('pick-axe',         'pick-axe',          100,  50, { freq: 20, dig: true, weapon: true, dmgN: 1, dmgD: 6, sprite: 'item_axe' }),
  Tl('oil lamp',         'oil lamp',           20,  10, { freq: 45, light: 4, fuel: 1500 }),
  Tl('magic lamp',       'magic lamp',         20,  50, { freq: 2,  light: 5, fuel: -1, magic: true }),
  Tl('wax candle',       'wax candle',          2,  10, { freq: 20, light: 2, fuel: 400, stackable: true }),
  Tl('bag of holding',   'bag of holding',     15, 100, { freq: 10, container: true, magic: true }),
  Tl('sack',             'sack',                15, 2,  { freq: 35, container: true }),
  Tl('unicorn horn',     'unicorn horn',       20, 100, { freq: 6,  magic: true, cures: true, weapon: true, dmgN: 1, dmgD: 12 }),
  Tl('magic whistle',    'magic whistle',       3,  10, { freq: 10, magic: true }),
  Tl('skeleton key',     'skeleton key',        3,  10, { freq: 30, unlocks: true }),
  Tl('lock pick',        'lock pick',           4,  20, { freq: 25, unlocks: true }),
  Tl('blindfold',        'blindfold',           2,  20, { freq: 25 }),
  Tl('mirror',           'looking glass',      13,  10, { freq: 20 }),
  Tl('tinning kit',      'tinning kit',       100,  30, { freq: 5 }),
  Tl('magic marker',     'magic marker',        2,  50, { freq: 8, magic: true, charges: [30, 60] }),

  // ----------------------------------------------------------------- gems
  G('diamond',           'diamond',          4000, { freq: 3,  hard: true }),
  G('ruby',              'ruby',             3500, { freq: 4,  hard: true }),
  G('emerald',           'emerald',          2500, { freq: 5,  hard: true }),
  G('sapphire',          'sapphire',         3000, { freq: 4,  hard: true }),
  G('opal',              'opal',              800, { freq: 8 }),
  G('turquoise',         'turquoise',         2000, { freq: 6 }),
  G('amethyst',          'amethyst',          600, { freq: 8 }),
  G('agate',             'agate',             200, { freq: 10 }),
  G('jasper',            'jasper',            500, { freq: 8 }),
  G('worthless glass',   'worthless piece of glass', 6, { freq: 40, worthless: true }),
  G('luckstone',         'luckstone',         60, { freq: 8,  wt: 10, stone: true, luck: 3 }),
  G('flint stone',       'flint stone',        1, { freq: 10, wt: 10, stone: true }),
  G('rock',              'rock',               0, { freq: 20, wt: 10, stone: true, throwable: true }),

  // ------------------------------------------------------------ specials
  { key: 'gold', name: 'gold piece', cls: 'coin', glyph: '$', colour: '#e0c040',
    wt: 0, cost: 1, sprite: 'item_gold', stackable: true, freq: 0 },
  { key: 'Amulet of Yendor', name: 'Amulet of Yendor', cls: 'amulet', glyph: '"',
    colour: '#ffd75f', wt: 20, cost: 30000, sprite: 'item_amulet', freq: 0,
    unique: true, invoke: true, noAppearance: true },
  { key: 'corpse', name: 'corpse', cls: 'food', glyph: '%', colour: '#a06a5a',
    wt: 50, cost: 0, sprite: 'item_bones', freq: 0, corpse: true },
];

export const OBJ_BY_KEY = Object.fromEntries(OBJECTS.map((o) => [o.key + '/' + o.cls, o]));

/** Look an object type up by key; classes are unique per key except where noted. */
export function objType(key, cls = null) {
  if (cls) return OBJ_BY_KEY[key + '/' + cls] || null;
  return OBJECTS.find((o) => o.key === key) || null;
}

// ===========================================================================
// appearances
// ===========================================================================

export const APPEARANCES = {
  potion: ['ruby', 'pink', 'orange', 'yellow', 'emerald', 'dark green', 'cyan', 'sky blue',
           'brilliant blue', 'magenta', 'purple-red', 'puce', 'milky', 'swirly', 'bubbly',
           'smoky', 'cloudy', 'effervescent', 'black', 'golden', 'brown', 'fizzy', 'dark',
           'white', 'murky'],
  scroll:  ['ZELGO MER', 'JUYED AWK YACC', 'NR 9', 'XIXAXA XOXAXA XUXAXA', 'PRATYAVAYAH',
            'DAIYEN FOOELS', 'LEP GEX VEN ZEA', 'PRIRUTSENIE', 'ELBIB YLOH', 'VERR YED HORRE',
            'VENZAR BORGAVVE', 'THARR', 'YUM YUM', 'KERNOD WEL', 'ELAM EBOW', 'DUAM XNAHT',
            'ANDOVA BEGARIN', 'KIRJE', 'VE FORBRYDERNE', 'HACKEM MUCHE', 'VELOX NEB',
            'FOOBIE BLETCH', 'TEMOV', 'GARVEN DEH', 'READ ME'],
  wand:    ['glass', 'balsa', 'crystal', 'maple', 'pine', 'oak', 'ebony', 'marble', 'tin',
            'brass', 'copper', 'silver', 'platinum', 'iridium', 'zinc', 'aluminium', 'uranium',
            'iron', 'steel', 'hexagonal', 'short', 'runed', 'long', 'curved', 'forked',
            'spiked', 'jewelled'],
  ring:    ['pearl', 'iron', 'twisted', 'steel', 'wire', 'engagement', 'shiny', 'bronze',
            'brass', 'copper', 'silver', 'gold', 'ivory', 'emerald', 'wooden', 'granite',
            'opal', 'clay', 'coral', 'black onyx', 'moonstone', 'tiger eye', 'jade',
            'agate', 'topaz', 'sapphire', 'ruby', 'diamond'],
  amulet:  ['circular', 'spherical', 'oval', 'triangular', 'pyramidal', 'square', 'concave',
            'hexagonal', 'octagonal', 'lopsided', 'cubical', 'warped'],
  spellbook: ['parchment', 'vellum', 'ragged', 'dog eared', 'mottled', 'stained', 'cloth',
              'leathery', 'white', 'pink', 'red', 'orange', 'yellow', 'velvet', 'turquoise',
              'cyan', 'indigo', 'magenta', 'purple', 'plaid', 'light green', 'dark green',
              'gray', 'wrinkled', 'dusty', 'bronze', 'copper', 'silver', 'gold', 'glittering',
              'shining', 'thin', 'thick'],
};

const APPEARANCE_SUFFIX = {
  potion: (a) => `${a} potion`,
  scroll: (a) => `scroll labeled ${a}`,
  wand:   (a) => `${a} wand`,
  ring:   (a) => `${a} ring`,
  amulet: (a) => `${a} amulet`,
  spellbook: (a) => `${a} spellbook`,
};

/**
 * Shuffle appearances onto true identities. Called once per game with the run
 * RNG, so the mapping is a property of the seed.
 */
export function buildIdentityMap(rng) {
  const map = {};      // "cls/key" -> appearance string
  for (const cls of Object.keys(APPEARANCES)) {
    const types = OBJECTS.filter((o) => o.cls === cls && !o.noAppearance && !o.unique);
    const pool  = rng.shuffle([...APPEARANCES[cls]]);
    types.forEach((t, i) => {
      const raw = pool[i % pool.length];
      map[`${cls}/${t.key}`] = APPEARANCE_SUFFIX[cls](raw);
    });
    // Fixed-appearance types keep theirs.
    for (const t of OBJECTS.filter((o) => o.cls === cls && (o.noAppearance || o.unique))) {
      map[`${cls}/${t.key}`] = t.appearance ? APPEARANCE_SUFFIX[cls](t.appearance) : t.name;
    }
  }
  return map;
}

/** Classes whose members must be identified before their true name is shown. */
export const NEEDS_ID = new Set(['potion', 'scroll', 'wand', 'ring', 'amulet', 'spellbook']);

// ===========================================================================
// random object generation
// ===========================================================================

// How often each class turns up on the floor. NetHack's mkobj probabilities,
// rounded. Weapons and armour are common because they are the things a fresh
// character actually needs; gems are rare because they are mostly worthless.
export const CLASS_FREQ = [
  ['coin',      16],
  ['weapon',    10],
  ['armor',     10],
  ['food',      20],
  ['potion',    16],
  ['scroll',    16],
  ['wand',       4],
  ['ring',       3],
  ['amulet',     2],
  ['tool',       8],
  ['gem',        9],
  ['spellbook',  4],
];

export function randomObjectKey(rng, depth = 1) {
  const cls = rng.pickWeighted(CLASS_FREQ, (e) => e[1])[0];
  if (cls === 'coin') return { key: 'gold', cls: 'coin' };
  const pool = OBJECTS.filter((o) => o.cls === cls && (o.freq ?? 0) > 0 && !o.unique);
  if (!pool.length) return { key: 'gold', cls: 'coin' };
  const pick = rng.pickWeighted(pool, (o) => o.freq);
  return { key: pick.key, cls };
}
