// The two kinds of thing that take turns.
//
// Player and Monster do not share a base class, on purpose. They overlap in
// about six fields and diverge in everything that matters: the player has an
// identification state, a hunger clock, six attributes and an inventory the UI
// walks; a monster has a species, an AI state machine and at most a weapon. A
// shared `Actor` would have been mostly `if (this.isPlayer)`.
//
// What they *do* share is the energy protocol, which is the only thing the turn
// scheduler cares about: `energy`, `speed`, and `takesTurn()`.

import { MONSTER_BY_KEY, monsterXP } from '../data/monsters.js';
import { ROLE_BY_KEY, xpForLevel, conHpBonus, carryCapacity,
         strHitBonus, strDamBonus, dexHitBonus, MAX_XP_LEVEL } from '../data/roles.js';
import { objBase, objWeight, armorClassOf } from './obj.js';

export const NORMAL_SPEED = 12;

// Intrinsics an object confers just by being worn or carried.
const RING_INTRINSIC = {
  'poison resistance': 'poisonRes',
  'fire resistance':   'fireRes',
  'cold resistance':   'coldRes',
  'shock resistance':  'shockRes',
  'free action':       'freeAction',
  'see invisible':     'seeInvis',
  'invisibility':      'invisible',
  'levitation':        'levitation',
  'stealth':           'stealth',
  'searching':         'searching',
  'warning':           'warning',
  'regeneration':      'regeneration',
  'sustain ability':   'sustainAbility',
  'aggravate monster': 'aggravate',
  'conflict':          'conflict',
  'teleportation':     'teleportitis',
  'slow digestion':    'slowDigestion',
};
const AMULET_INTRINSIC = {
  'ESP':                'telepathy',
  'life saving':        'lifeSaving',
  'versus poison':      'poisonRes',
  'reflection':         'reflection',
  'magical breathing':  'breathing',
  'unchanging':         'unchanging',
  'strangulation':      'strangled',
  'restful sleep':      'restfulSleep',
};

export class Player {
  constructor(roleKey, name) {
    const role = ROLE_BY_KEY[roleKey] || ROLE_BY_KEY.valkyrie;
    this.isPlayer = true;
    this.role = role.key;
    this.roleName = role.name;
    this.name = name || 'Wanderer';
    this.sprite = role.sprite;
    this.glyph = '@';
    this.colour = '#ffffff';

    this.x = 0; this.y = 0;
    this.depth = 1;
    this.maxDepth = 1;

    this.attr = { ...role.attr };
    this.attrMax = { ...role.attr };

    this.xpLevel = 1;
    this.xp = 0;
    this.hpMax = role.hpBase + conHpBonus(role.attr.con);
    this.hp = this.hpMax;
    this.pwMax = role.pwBase;
    this.pw = this.pwMax;
    this.baseAC = role.ac;

    this.gold = role.startGold ?? 0;
    this.nutrition = 900;
    this.luck = 0;
    this.speed = role.speed;
    this.energy = 0;

    this.inventory = [];
    this.equip = { weapon: null, body: null, cloak: null, helm: null, gloves: null,
                   boots: null, shield: null, ringL: null, ringR: null, amulet: null,
                   quiver: null, light: null };

    this.statuses = new Map();          // name -> turns left (-1 = until removed)
    this.intrinsics = new Set(role.intrinsics);
    this.skills = { ...role.skills };
    this.backstab = !!role.backstab;
    this.alignment = role.alignment;

    this.spells = [];                    // {key, level, fail}
    for (const s of role.startSpells ?? []) this.spells.push({ key: s, level: 1, memory: 20000 });

    this.turns = 0;
    this.hasAmulet = false;
    this.escaped = false;
    this.killer = null;
    this.deathReason = null;
    this.lastAttacker = null;
    this.hidden = false;
    this.trapped = 0;                    // turns stuck in a pit/web
    this.searchBonus = 0;
    this.conductFoodless = true;
    this.conductWeaponless = true;
    this.kills = new Map();
  }

  // ------------------------------------------------------------- statuses

  hasStatus(s) { return this.statuses.has(s); }
  statusTurns(s) { return this.statuses.get(s) ?? 0; }
  setStatus(s, turns) {
    const cur = this.statuses.get(s) ?? 0;
    if (turns < 0) this.statuses.set(s, -1);
    else this.statuses.set(s, cur < 0 ? -1 : cur + turns);
  }
  clearStatus(s) { this.statuses.delete(s); }
  tickStatuses() {
    const expired = [];
    for (const [k, v] of this.statuses) {
      if (v < 0) continue;
      if (v <= 1) { this.statuses.delete(k); expired.push(k); }
      else this.statuses.set(k, v - 1);
    }
    return expired;
  }

  // ---------------------------------------------------------- derived stats

  /** Everything the hero resists, from role, items and temporary effects. */
  has(prop) {
    if (this.intrinsics.has(prop)) return true;
    for (const slot of ['ringL', 'ringR']) {
      const r = this.equip[slot];
      if (r && !r.cancelled && RING_INTRINSIC[r.key] === prop) return true;
    }
    const am = this.equip.amulet;
    if (am && AMULET_INTRINSIC[am.key] === prop) return true;
    const cl = this.equip.cloak;
    if (cl) {
      const b = objBase(cl);
      if (prop === 'magicRes' && b?.magicRes) return true;
      if (prop === 'stealth'  && b?.stealth)  return true;
      if (prop === 'displacement' && b?.displaces) return true;
    }
    if (prop === 'fast' && this.hasStatus('fast')) return true;
    if (prop === 'invisible' && this.hasStatus('invisible')) return true;
    if (prop === 'levitation' && this.hasStatus('levitating')) return true;
    if (prop === 'seeInvis' && this.hasStatus('see invisible')) return true;
    return false;
  }

  get ac() {
    let ac = this.baseAC;
    for (const slot of ['body', 'cloak', 'helm', 'gloves', 'boots', 'shield']) {
      const it = this.equip[slot];
      if (it) ac -= armorClassOf(it);
    }
    for (const slot of ['ringL', 'ringR']) {
      const r = this.equip[slot];
      if (r && r.key === 'protection') ac -= (r.enchant || 1);
    }
    if (this.intrinsicProtection) ac -= this.intrinsicProtection;
    return ac;
  }

  get effSpeed() {
    let s = this.speed;
    if (this.has('fast')) s += 6;
    if (this.hasStatus('slow')) s -= 4;
    if (this.encumbrance() >= 2) s -= 3;
    return Math.max(3, s);
  }

  get maxCarry() { return carryCapacity(this.attr.str, this.attr.con); }

  totalWeight() {
    let w = Math.ceil(this.gold / 100);
    for (const o of this.inventory) w += objWeight(o);
    return w;
  }

  /** 0 unencumbered .. 4 overtaxed */
  encumbrance() {
    const cap = this.maxCarry;
    const w = this.totalWeight();
    if (w <= cap) return 0;
    if (w <= cap * 1.5) return 1;
    if (w <= cap * 2) return 2;
    if (w <= cap * 2.5) return 3;
    return 4;
  }

  hitBonus() {
    let b = 1 + this.xpLevel + strHitBonus(this.attr.str) + dexHitBonus(this.attr.dex);
    b += this.skills.melee ?? 0;
    const w = this.equip.weapon;
    if (w) b += (w.enchant ?? 0) + (objBase(w)?.hit ?? 0) - (w.erode ?? 0);
    for (const slot of ['ringL', 'ringR']) {
      const r = this.equip[slot];
      if (r && r.key === 'increase accuracy') b += (r.enchant || 1);
    }
    if (this.hasStatus('confused')) b -= 2;
    if (this.hasStatus('stunned')) b -= 2;
    if (this.hasStatus('blind')) b -= 2;
    if (this.luck) b += Math.sign(this.luck) * Math.min(3, Math.abs(this.luck));
    return b;
  }

  damageBonus() {
    let b = strDamBonus(this.attr.str);
    const w = this.equip.weapon;
    if (w) b += (w.enchant ?? 0) - (w.erode ?? 0);
    for (const slot of ['ringL', 'ringR']) {
      const r = this.equip[slot];
      if (r && r.key === 'increase damage') b += (r.enchant || 1);
    }
    return b;
  }

  get lightSource() {
    const l = this.equip.light;
    if (l && (l.lit || objBase(l)?.magic)) return objBase(l)?.light ?? 3;
    return 0;
  }

  gainXP(amount, game) {
    this.xp += amount;
    while (this.xpLevel < MAX_XP_LEVEL && this.xp >= xpForLevel(this.xpLevel + 1)) {
      this.levelUp(game);
    }
  }

  levelUp(game) {
    const role = ROLE_BY_KEY[this.role];
    this.xpLevel++;
    const [flat, die] = role.hpLevel;
    const gain = flat + game.rng.rnd(die) + Math.max(0, conHpBonus(this.attr.con));
    this.hpMax += gain; this.hp += gain;
    const [pf, pd] = role.pwLevel;
    const pgain = pf + game.rng.rnd(Math.max(1, pd));
    this.pwMax += pgain; this.pw += pgain;
    game.msg(`Welcome to experience level ${this.xpLevel}.`, 'good');
  }

  loseLevel(game) {
    if (this.xpLevel <= 1) { this.hpMax = Math.max(1, this.hpMax - 4); this.hp = Math.min(this.hp, this.hpMax); return; }
    const role = ROLE_BY_KEY[this.role];
    this.xpLevel--;
    this.xp = xpForLevel(this.xpLevel);
    const loss = role.hpLevel[0] + game.rng.rnd(role.hpLevel[1]);
    this.hpMax = Math.max(1, this.hpMax - loss);
    this.hp = Math.min(this.hp, this.hpMax);
    game.msg('You feel weaker.', 'bad');
  }

  adjustAttr(which, delta, game) {
    if (delta < 0 && this.has('sustainAbility')) { return false; }
    const before = this.attr[which];
    this.attr[which] = Math.max(3, Math.min(25, before + delta));
    if (which === 'con') {
      const d = conHpBonus(this.attr.con) - conHpBonus(before);
      this.hpMax = Math.max(1, this.hpMax + d * this.xpLevel);
      this.hp = Math.min(this.hp, this.hpMax);
    }
    return this.attr[which] !== before;
  }

  // The energy protocol. `gainEnergy` is called exactly once per game tick;
  // `canAct` is then called repeatedly and spends a turn's worth each time it
  // returns true. Keeping them separate matters: folding them into one method
  // means a fast monster gains *more* energy for every extra action it takes,
  // which compounds into several attacks per tick. That bug existed here and
  // turned a speed-10 giant rat into something that killed a level-1 hero in
  // four turns.
  gainEnergy() { this.energy += this.effSpeed; }
  canAct() {
    if (this.energy >= NORMAL_SPEED) { this.energy -= NORMAL_SPEED; return true; }
    return false;
  }
  takesTurn() { this.gainEnergy(); return this.canAct(); }
}

// ===========================================================================

let monUid = 1;
export function resetMonUids(n = 1) { monUid = n; }

export class Monster {
  constructor(specKey, rng, opts = {}) {
    const spec = MONSTER_BY_KEY[specKey];
    if (!spec) throw new Error(`no such monster: ${specKey}`);
    this.uid = monUid++;
    this.isPlayer = false;
    this.specKey = specKey;
    this.spec = spec;
    this.name = spec.name;
    this.glyph = spec.glyph;
    this.colour = spec.colour;
    this.sprite = spec.sprite;

    const lvl = Math.max(1, spec.lvl);
    this.hpMax = opts.hp ?? (spec.lvl === 0 ? rng.rnd(4) : rng.d(lvl, 8));
    this.hp = this.hpMax;
    this.level = spec.lvl;
    this.ac = spec.ac;
    this.speed = spec.spd;
    this.energy = rng.rn2(12);
    this.x = 0; this.y = 0;
    this.alive = true;

    this.peaceful = opts.peaceful ?? !!spec.peaceful;
    this.tame = opts.tame ?? false;
    this.asleep = opts.asleep ?? false;
    this.statuses = new Map();
    this.inventory = [];
    this.weapon = null;
    this.seenHero = false;
    this.lastKnown = null;              // {x,y} where the hero was last noticed
    this.fleeing = 0;
    this.strategy = 'idle';
    this.shopkeeper = false;
    this.shop = null;
    this.summonedBy = null;
    this.xpValue = monsterXP(spec);
    this.appearAs = null;               // hallucination / mimic display override
  }

  hasStatus(s) { return this.statuses.has(s); }
  setStatus(s, turns) {
    const cur = this.statuses.get(s) ?? 0;
    this.statuses.set(s, turns < 0 ? -1 : cur < 0 ? -1 : cur + turns);
  }
  clearStatus(s) { this.statuses.delete(s); }
  tickStatuses() {
    for (const [k, v] of this.statuses) {
      if (v < 0) continue;
      if (v <= 1) this.statuses.delete(k); else this.statuses.set(k, v - 1);
    }
  }

  has(prop) { return !!this.spec[prop]; }

  get effSpeed() {
    let s = this.speed;
    if (this.hasStatus('fast')) s += 6;
    if (this.hasStatus('slow')) s = Math.max(3, s - 6);
    return s;
  }

  get canMove() {
    return !this.spec.neverMove && !this.hasStatus('paralyzed') &&
           !this.hasStatus('sleeping') && !this.asleep;
  }

  gainEnergy() { this.energy += this.effSpeed; }
  canAct() {
    if (this.energy >= NORMAL_SPEED) { this.energy -= NORMAL_SPEED; return true; }
    return false;
  }
  takesTurn() { this.gainEnergy(); return this.canAct(); }

  /** Display name, with "the" where a unique needs it. */
  displayName(article = 'the') {
    if (this.customName) return this.customName;
    if (this.spec.unique) return this.name;
    if (article === false) return this.name;
    return `${article} ${this.name}`;
  }
}
