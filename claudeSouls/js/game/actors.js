// The player and the enemies.
//
// The enemy is a small state machine and that is the whole point of the game:
//
//   READY  -> chooses an attack when it can reach you -> WINDUP
//   WINDUP -> counts down in full view; can be pushed back by being hit
//          -> STRIKE (resolves this turn)
//   STRIKE -> RECOVER
//   RECOVER-> counts down, helpless -> READY
//
// The player can see which state it is in, which tiles the pending attack
// covers, and how much stamina it has left. Nothing is hidden. The difficulty
// is entirely in having enough stamina, and enough room, to act on what you can
// already see.

import { ENEMY_BY_KEY } from '../data/enemies.js';
import { PLAYER, SKILLS, SKILL_BY_KEY } from '../data/skills.js';
import { ITEM_BY_KEY, SLOT, skillsFrom, slotsFor, isArmour,
         CONSUMABLE_BY_KEY } from '../data/items.js';

export const NORMAL_SPEED = 12;

export const STATE = { READY: 'ready', WINDUP: 'windup', RECOVER: 'recover', RESTING: 'resting' };

let uid = 1;
export function resetUids(n = 1) { uid = n; }

export class Player {
  constructor(name) {
    this.isPlayer = true;
    this.name = name || 'Ashen';
    this.sprite = 'hero_fighter';
    this.glyph = '@';
    this.colour = '#ffffff';

    this.x = 0; this.y = 0;
    this.facing = { dx: 0, dy: 1 };
    this.depth = 1;
    this.maxDepth = 1;

    this.hp = PLAYER.hpMax;
    this.staminaMax = PLAYER.staminaMax;
    this.stamina = this.staminaMax;
    this.staminaRegen = PLAYER.staminaRegen;
    this.speed = PLAYER.speed;

    // Equipment, and the backpack it comes out of.
    this.equip = { main: null, off: null, armour: null };
    this.blocking = null;             // {dx,dy} while the shield is up
    this.prep = { item: null, magic: null };
    this.edge = 0;                    // a whetstone's bonus, spent on the next hit
    this.recover = 0;                 // turns you are still swinging
    this.warded = 0;                  // blows a ward will still absorb
    this.charges = {};                // key -> uses left, refilled at a bonfire
    this.pack = [];
    this.unbanked = [];               // picked up since the last fire; dropped on death

    // A cooldown slot for *every* skill in the game, not just the ones you can
    // currently use. Cooldowns therefore survive a weapon swap, which matters:
    // otherwise sheathing and drawing would be a free way to reset them, and
    // swapping already costs a turn precisely so that it is a real decision.
    this.skills = SKILLS.map((s) => ({ key: s.key, cd: 0 }));

    this.deaths = 0;
    this.kills = 0;
    this.turns = 0;
    this.bonfire = null;              // {depth, id, x, y} - where death returns you
    this.alive = true;
  }

  skill(key) { return this.skills.find((s) => s.key === key) ?? null; }

  item(slot) { return ITEM_BY_KEY[this.equip[slot]] ?? null; }

  /** Heavy armour is a property of what you are wearing, not of who you are. */
  get heavyArmour() { return !!this.item(SLOT.ARMOUR)?.heavy; }

  get armourReduce() { return this.item(SLOT.ARMOUR)?.reduce ?? 0; }

  /** Total weight carried. Nothing reads this yet; the economy comes next. */
  get weight() {
    let w = 0;
    for (const s of Object.keys(this.equip)) w += this.item(s)?.weight ?? 0;
    return w;
  }

  /**
   * The skills you can actually use right now, in button order.
   *
   * Derived every time rather than cached, because the one thing that must
   * never happen is the button bar and the rules disagreeing about what you are
   * holding.
   */
  activeSkills() {
    const out = [];
    for (const k of skillsFrom(this.item(SLOT.MAIN), SLOT.MAIN)) out.push(k);
    for (const k of skillsFrom(this.item(SLOT.OFF), SLOT.OFF)) out.push(k);
    if (this.shield) out.push('block');
    for (const s of SKILLS) if (s.always && !out.includes(s.key)) out.push(s.key);
    return out;
  }

  /**
   * What is prepared, and how many uses are left.
   *
   * Two slots, one for an item and one for a spell, because they cost a button
   * each and there are only nine. Changing what is in them costs a turn like
   * any other swap - which is what turns a pack full of options into a decision
   * made before the fight rather than a menu opened during it.
   */
  prepared(kind) {
    const key = this.prep[kind];
    return key ? CONSUMABLE_BY_KEY[key] ?? null : null;
  }

  chargesOf(key) { return this.charges[key] ?? 0; }

  /** Bonfires refill charges. Picking things up does not. */
  refillCharges() {
    for (const kind of ['item', 'magic']) {
      const key = this.prep[kind];
      if (key && CONSUMABLE_BY_KEY[key]) this.charges[key] = CONSUMABLE_BY_KEY[key].charges;
    }
  }

  prepare(kind, key) {
    if (key && !CONSUMABLE_BY_KEY[key]) return { ok: false, why: 'that is not something you can ready' };
    if (key && CONSUMABLE_BY_KEY[key].kind !== kind) return { ok: false, why: 'that does not go in that slot' };
    const was = this.prep[kind];
    this.prep[kind] = key ?? null;
    // A newly prepared thing arrives full; one you have already been drinking
    // from keeps what is left of it.
    if (key && this.charges[key] === undefined) this.charges[key] = CONSUMABLE_BY_KEY[key].charges;
    return { ok: true, displaced: was ? [was] : [] };
  }

  /**
   * Turns left standing there after a heavy swing.
   *
   * The player learns "recovery is the punish window" from the wrong end of it
   * all game; this applies the same rule to them. While it is running you do not
   * act at all - **not even roll** - and stamina does not come back, which is
   * the same rule enemies live under (they only regenerate in READY or
   * RESTING). Closing the escape hatch is exactly what gives it weight.
   *
   * Three limits, from the design conversation:
   *   - only *secondary* skills ever have it, so it is always a choice you made
   *   - it replaces most of the cooldown rather than stacking on top of it;
   *     stamina AND cooldown AND recovery is three taxes and would just make
   *     heavy weapons bad
   *   - it is short. Two turns of standing still while surrounded is already
   *     four to ten damage against a twelve to eighteen point pool.
   */
  get recovering() { return this.recover > 0; }

  /** The shield in your off hand, if that is what is in it. */
  get shield() {
    const it = this.item(SLOT.OFF);
    return it?.kind === 'shield' ? it : null;
  }

  hasSkill(key) { return this.activeSkills().includes(key); }

  /**
   * Put something on. Returns whatever came off, so the caller can decide where
   * it goes; this method deliberately does not touch the backpack.
   *
   * A two-handed weapon empties the off hand, and anything in the off hand is
   * refused while one is held - the rule is in one place so the UI cannot
   * present a state the rules would reject.
   */
  equipItem(slot, key) {
    const it = key ? ITEM_BY_KEY[key] : null;
    if (key && !it) return { ok: false, why: `no such item: ${key}` };
    if (it && !slotsFor(it).includes(slot)) return { ok: false, why: `${it.name} does not go there` };

    const displaced = [];
    if (slot === SLOT.MAIN && it?.hands === 2 && this.equip.off) {
      displaced.push(this.equip.off);
      this.equip.off = null;
    }
    if (slot === SLOT.OFF && this.item(SLOT.MAIN)?.hands === 2) {
      return { ok: false, why: 'both hands are on that weapon' };
    }
    if (this.equip[slot]) displaced.push(this.equip[slot]);
    this.equip[slot] = key ?? null;

    // Losing a weapon can leave a cooldown ticking on a skill you no longer
    // have. That is correct and deliberate - see the comment on `skills`.
    if (isArmour(it)) this.hp = Math.min(this.hp, this.hpMax);
    return { ok: true, displaced };
  }

  /** Health comes from the armour you are wearing. */
  get hpMax() { return this.item(SLOT.ARMOUR)?.hp ?? PLAYER.hpMax; }

  /**
   * What weight costs you.
   *
   * The design conversation landed here after two dead ends, and both are worth
   * remembering because both sound reasonable.
   *
   * "Movement costs stamina above a weight threshold" taxes *exploration* -
   * most turns in this game are walking across an empty floor, so you would
   * arrive at every fight on half a bar. That is precisely the failure the bot
   * exhibited before it learned to walk back to a bonfire, and it punishes the
   * wrong activity. It also creates a locked state: heavy, empty bar, a hound
   * next to you, and no legal move at all. So **walking is always free.**
   *
   * Weight instead makes you *recover* slower and *dodge* dearer, which is a
   * continuous pressure rather than a cliff, and leaves you always able to move.
   */
  // The first few points are free: a light kit should cost you nothing extra to
  // dodge in, or "light" is just "slightly less punished". Everything above
  // that adds a point per four.
  get rollExtra() { return Math.floor(Math.max(0, this.weight - 4) / 4); }

  rollCost() {
    return SKILL_BY_KEY.roll.stamina + this.rollExtra;
  }

  /**
   * Everyone rolls two tiles.
   *
   * Heavy armour used to roll one, and that number was doing something nobody
   * intended. Against the attack shapes that arrived later - a five-tile arc, a
   * six-tile lane, the boss's solid 5x5 - **two tiles is the minimum that
   * escapes anything**, so a one-tile roll was not "dodging less well", it was
   * not dodging at all. Heavy survived by tanking with its damage reduction,
   * which is the opposite of what the vow was supposed to feel like.
   *
   * Distance is a cliff; stamina is a slope. So the weight is expressed in the
   * stamina economy, where it can be tuned, and everyone gets a roll that works.
   */
  rollDistance() { return SKILL_BY_KEY.roll.dash; }

  /**
   * Carrying a shield makes every action cost more, whether or not you block.
   *
   * This is the answer to the problem that killed the parry: enemies telegraph,
   * so a defensive reaction is always correctly timed, so charging for the
   * *use* of a block cannot make it a real decision. Charging for *having the
   * option* can. You pay this whether or not the shield ever comes up.
   *
   * It scales with the shield's weight rather than being flat, because a flat
   * point made the buckler a straight loss: you gave up the off-hand weapon's
   * skill AND paid the tax, for one direction of cover. A buckler now costs you
   * only its weight, which is the promise its description makes - you can still
   * roll. The tower shield keeps the tax.
   */
  get actionSurcharge() { return Math.floor((this.shield?.weight ?? 0) / 6); }

  /** What a skill actually costs, with everything you are carrying. */
  costOf(key) {
    if (typeof key === 'string' && key.startsWith('prep:')) {
      return this.prepared(key.slice(5))?.stamina ?? 0;
    }
    if (key === 'roll') return this.rollCost();
    const def = SKILL_BY_KEY[key];
    if (!def) return 0;
    return def.stamina + this.actionSurcharge;
  }

  /**
   * Stamina comes back slowly under load, and only while nothing has seen you.
   *
   * The second half is the important one. Out of a fight the bar refills fast,
   * so exploration is not a tax and you do not arrive at a fight already spent.
   * The moment something notices you, it becomes the scarce thing it is meant to
   * be. `inCombat` is decided by the game, not here, because it depends on the
   * level.
   */
  regenRate(inCombat) {
    const armour = this.item(SLOT.ARMOUR)?.regen ?? 0;
    const base = Math.max(1, PLAYER.staminaRegen + armour
                             - Math.floor(Math.max(0, this.weight - 5) / 6));
    return inCombat ? base : base * 4;
  }

  canAfford(cost) { return this.stamina >= cost; }

  spend(cost) { this.stamina = Math.max(0, this.stamina - cost); }

  /** Called once per turn, after everything has acted. */
  tick(inCombat = true) {
    // No stamina while you are still recovering - the same rule the enemies
    // live under, and the reason a heavy swing is a commitment rather than a
    // price.
    if (this.recover > 0) this.recover--;
    else this.stamina = Math.min(this.staminaMax, this.stamina + this.regenRate(inCombat));
    for (const s of this.skills) if (s.cd > 0) s.cd--;
  }

  /** A kill refunds one turn of every cooldown. This is the combo engine. */
  onKill() {
    this.kills++;
    for (const s of this.skills) if (s.cd > 0) s.cd--;
  }

  face(dx, dy) {
    if (dx || dy) this.facing = { dx: Math.sign(dx), dy: Math.sign(dy) };
  }
}

export class Enemy {
  constructor(key, rng) {
    const spec = ENEMY_BY_KEY[key];
    if (!spec) throw new Error(`no such enemy: ${key}`);
    this.uid = uid++;
    this.key = key;
    this.spec = spec;
    this.name = spec.name;
    this.glyph = spec.glyph;
    this.colour = spec.colour;
    this.sprite = spec.sprite;

    this.x = 0; this.y = 0;
    this.facing = { dx: 0, dy: 1 };
    this.hpMax = spec.hp;
    this.hp = spec.hp;
    this.staminaMax = spec.stamina;
    this.stamina = spec.stamina;
    this.speed = spec.speed;
    this.energy = rng ? rng.rn2(NORMAL_SPEED) : 0;
    this.alive = true;

    this.poise = spec.poise;
    this.poiseLeft = spec.poise;

    this.state = STATE.READY;
    this.timer = 0;                 // turns left in the current state
    this.attack = null;             // the attack being wound up
    this.attackTiles = null;        // resolved at wind-up start, shown to the player
    this.attackDir = null;
    this.aware = false;
    this.lost = 0;              // turns since it last had eyes on you
    this.lastKnown = null;
  }

  get isPlayer() { return false; }

  gainEnergy() { this.energy += this.speed; }
  canAct() {
    if (this.energy >= NORMAL_SPEED) { this.energy -= NORMAL_SPEED; return true; }
    return false;
  }

  face(dx, dy) {
    if (dx || dy) this.facing = { dx: Math.sign(dx), dy: Math.sign(dy) };
  }

  /**
   * Stamina comes back only while the enemy is idle - **recovery is not rest.**
   *
   * This looked like a detail and was not. With regeneration also running
   * during recovery, every enemy's long recovery window paid for its own next
   * attack and the stamina bar never bound on anything: an enemy could swing
   * forever and the "winded" state was unreachable. Excluding recovery makes
   * sustained aggression genuinely exhausting, so pressing an enemy that keeps
   * swinging eventually buys you a free window - and backing off gives that
   * window back to it.
   */
  regen() {
    if (this.state !== STATE.READY && this.state !== STATE.RESTING) return;
    this.stamina = Math.min(this.staminaMax, this.stamina + this.spec.staminaRegen);
  }

  /**
   * Being hit during a wind-up can push the blow back a turn - but only if the
   * hit is heavy enough.
   *
   * The interrupt on its own was a mistake. It gave every telegraph a second
   * answer, which was the point, but it made the *cheapest* answer universal:
   * a 4-stamina jab could postpone a 7-stamina overhead indefinitely, so 1v1
   * was solved by standing still and swinging. Poise is the price the interrupt
   * always needed. A brute at poise 8 cannot be interrupted by anything the
   * player owns inside a three-turn wind-up, so against a brute you have to
   * move - which is the whole game.
   *
   * Poise refills when the wind-up ends, so it is per-attack rather than a
   * second health bar to grind down.
   */
  stagger(impact = 1) {
    if (this.state !== STATE.WINDUP) return false;
    this.poiseLeft -= impact;
    if (this.poiseLeft > 0) return false;
    this.poiseLeft = this.poise;
    this.timer++;
    return true;
  }

  displayName() { return this.name; }
}
