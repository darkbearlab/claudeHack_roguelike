// Object instances: making them, naming them, pricing them.
//
// Naming is the part with all the rules in it, and they are game rules rather
// than presentation: what an object is *called* is exactly the information the
// hero has about it. "a scroll labeled ZELGO MER" and "a scroll of identify"
// are the same object; which one you see is the identification game.

import { OBJECTS, objType, NEEDS_ID, randomObjectKey } from '../data/items.js';
import { withArticle, signed, capitalise } from '../../../engine/util.js';

let nextId = 1;
export function resetObjIds(n = 1) { nextId = n; }

/** Create one object instance. `opts` overrides anything on the base type. */
export function makeObj(key, cls, rng, opts = {}) {
  const type = objType(key, cls);
  if (!type) throw new Error(`no such object: ${key} (${cls})`);

  const o = {
    oid: nextId++,
    key: type.key,
    cls: type.cls,
    count: opts.count ?? 1,
    bless: opts.bless ?? 0,          // -1 cursed, 0 uncursed, +1 blessed
    blessKnown: opts.blessKnown ?? false,
    ided: opts.ided ?? false,
    enchant: opts.enchant ?? 0,
    erode: opts.erode ?? 0,          // rust/corrosion, 0..3
    charges: null,
    userName: null,
    stackable: !!type.stackable,
    x: 0, y: 0,
    worn: false, wielded: false, quivered: false,
    shopPrice: 0,                    // >0 means unpaid shop stock
  };

  if (type.charges) {
    o.charges = Array.isArray(type.charges)
      ? (rng ? rng.int(type.charges[0], type.charges[1]) : type.charges[0])
      : type.charges;
    o.chargesKnown = false;
  }
  if (type.fuel) o.fuel = type.fuel;
  if (type.container) o.contents = [];

  if (rng && opts.random !== false) {
    // Blessed/uncursed/cursed at NetHack's 10/80/10, unless caller fixed it.
    if (opts.bless === undefined) {
      const r = rng.rn2(100);
      o.bless = r < 10 ? 1 : r < 90 ? 0 : -1;
    }
    // Enchantment: mostly +0, occasionally better, sometimes cursed-negative.
    if (opts.enchant === undefined && (type.cls === 'weapon' || type.cls === 'armor')) {
      if (rng.rn2(100) < 10) o.enchant = o.bless < 0 ? -rng.rne(3) : rng.rne(3);
      else if (o.bless < 0 && rng.oneIn(4)) o.enchant = -rng.rnd(2);
    }
    if (type.cls === 'weapon' && type.stackable && opts.count === undefined) {
      o.count = rng.oneIn(2) ? rng.int(2, 8) : 1;
    }
  }

  if (opts.corpseOf) { o.corpseOf = opts.corpseOf; o.age = opts.age ?? 0; }
  Object.assign(o, opts.raw ?? {});
  return o;
}

export function makeGold(amount) {
  const o = makeObj('gold', 'coin', null, { count: amount, random: false });
  return o;
}

/** A random object appropriate to a depth. */
export function randomObj(rng, depth) {
  const { key, cls } = randomObjectKey(rng, depth);
  if (cls === 'coin') return makeGold(rng.int(1, 10 + depth * 12));
  return makeObj(key, cls, rng);
}

export function objBase(o) { return objType(o.key, o.cls); }

// ===========================================================================
// naming
// ===========================================================================

/**
 * The hero-facing name of an object.
 * @param {object} o     the instance
 * @param {object} disc  discovery state {idMap, known:Set, calledBy:Map}
 * @param {object} opts  {article:'a'|'the'|'your'|false, count:true}
 */
export function objName(o, disc, opts = {}) {
  const base = objBase(o);
  if (!base) return 'strange object';
  const article = opts.article ?? 'a';
  let name;

  if (o.cls === 'coin') {
    name = `${o.count} gold piece${o.count === 1 ? '' : 's'}`;
    return name;
  }

  if (o.corpseOf) {
    name = `${o.corpseOf} corpse`;
    return decorate(o, name, disc, opts, article, false);
  }

  const idKey = `${o.cls}/${o.key}`;
  const needsId = NEEDS_ID.has(o.cls);
  const known = !needsId || o.ided || (disc && disc.known.has(idKey));

  if (known) {
    name = trueName(base);
  } else {
    name = (disc && disc.idMap[idKey]) || base.name;
    const called = disc && disc.calledBy.get(idKey);
    if (called) name += ` called ${called}`;
  }

  return decorate(o, name, disc, opts, article, known);
}

function trueName(base) {
  switch (base.cls) {
    case 'potion':    return `potion of ${base.name}`;
    case 'scroll':    return base.key === 'blank paper' ? 'scroll of blank paper' : `scroll of ${base.name}`;
    case 'wand':      return `wand of ${base.name}`;
    case 'ring':      return `ring of ${base.name}`;
    case 'amulet':    return base.key === 'Amulet of Yendor' ? base.name : `amulet of ${base.name}`;
    case 'spellbook': return `spellbook of ${base.name}`;
    default:          return base.name;
  }
}

function decorate(o, name, disc, opts, article, known) {
  const base = objBase(o);
  const bits = [];

  // Erosion and enchantment come before the noun.
  if (o.erode > 0) bits.push(['', 'rusty', 'very rusty', 'thoroughly rusty'][Math.min(3, o.erode)]);
  if (o.blessKnown) bits.push(o.bless > 0 ? 'blessed' : o.bless < 0 ? 'cursed' : 'uncursed');
  if ((o.cls === 'weapon' || o.cls === 'armor') && (o.ided || o.enchantKnown)) {
    bits.push(signed(o.enchant));
  }

  let out = `${bits.join(' ')}${bits.length ? ' ' : ''}${name}`;

  if (o.count > 1) {
    out = `${o.count} ${pluraliseName(out)}`;
  }

  // Trailing state.
  const tail = [];
  if (o.wielded) tail.push('weapon in hand');
  if (o.worn)    tail.push(base.slot === 'shield' ? 'being worn' : o.cls === 'ring' ? 'on hand' : o.cls === 'amulet' ? 'being worn' : 'being worn');
  if (o.quivered) tail.push('in quiver');
  if (o.charges !== null && o.chargesKnown) tail.push(`${o.charges}:${o.recharged ?? 0}`);
  if (o.shopPrice > 0) tail.push(`unpaid, ${o.shopPrice} zorkmids`);
  if (tail.length) out += ` (${tail.join(', ')})`;

  if (article === false) return out;
  if (article === 'the') return `the ${out}`;
  if (article === 'your') return `your ${out}`;
  if (o.count > 1) return out;
  if (base.unique) return `the ${out}`;
  return withArticle(out);
}

function pluraliseName(n) {
  // Handles the shapes this game's vocabulary actually produces.
  if (/potion|scroll|wand|ring|amulet|spellbook/.test(n) && / of /.test(n)) {
    return n.replace(/^(\w+)/, (m) => m + 's');
  }
  if (/\bcorpse$/.test(n)) return n.replace(/corpse$/, 'corpses');
  if (/(s|x|z|ch|sh)$/.test(n)) return n + 'es';
  if (/[^aeiou]y$/.test(n)) return n.replace(/y$/, 'ies');
  if (/(knife)$/.test(n)) return n.replace(/knife$/, 'knives');
  return n + 's';
}

export function objNameCap(o, disc, opts) { return capitalise(objName(o, disc, opts)); }

// ===========================================================================
// value and weight
// ===========================================================================

export function objWeight(o) {
  const base = objBase(o);
  if (!base) return 0;
  if (o.cls === 'coin') return Math.ceil(o.count / 100);
  let w = (base.wt ?? 10) * o.count;
  if (o.contents) for (const c of o.contents) w += objWeight(c);
  return w;
}

export function objValue(o) {
  const base = objBase(o);
  if (!base) return 0;
  if (o.cls === 'coin') return o.count;
  let v = base.cost ?? 0;
  if (o.enchant > 0) v += 10 * o.enchant;
  return Math.max(1, v) * o.count;
}

/** What a shopkeeper charges. Cha matters; so does whether it is stock or loot. */
export function shopPriceOf(o, player) {
  let v = Math.max(1, objValue(o) / o.count);
  if (player.attr.cha > 18) v = v / 2;
  else if (player.attr.cha > 17) v = (v * 2) / 3;
  else if (player.attr.cha > 15) v = (v * 3) / 4;
  else if (player.attr.cha < 6)  v = v * 2;
  else if (player.attr.cha < 8)  v = (v * 3) / 2;
  else if (player.attr.cha < 11) v = (v * 4) / 3;
  return Math.max(1, Math.round(v)) * o.count;
}

// ===========================================================================
// misc predicates used all over the game
// ===========================================================================

export const isWeapon = (o) => o.cls === 'weapon' || (o.cls === 'tool' && objBase(o)?.weapon);
export const isArmor  = (o) => o.cls === 'armor';
export const isFood   = (o) => o.cls === 'food';
export const canWield = (o) => o.cls !== 'coin';
export const isEdible = (o) => o.cls === 'food';

export function damageDice(o) {
  const base = objBase(o);
  if (!base) return [1, 2];
  return [base.dmgN ?? 1, base.dmgD ?? 2];
}

export function armorClassOf(o) {
  const base = objBase(o);
  return (base?.ac ?? 0) + (o.enchant ?? 0) - (o.erode ?? 0);
}

/** Everything generated at level start that is not gold. */
export function allObjectTypes() { return OBJECTS; }
