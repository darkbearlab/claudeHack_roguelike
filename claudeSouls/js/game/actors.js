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
import { ITEM_BY_KEY, SLOT, skillsFrom, slotsFor, isArmour } from '../data/items.js';

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
    this.pack = [];

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
    for (const s of SKILLS) if (s.always && !out.includes(s.key)) out.push(s.key);
    return out;
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

  rollCost() {
    const s = SKILL_BY_KEY.roll;
    return this.heavyArmour ? s.staminaHeavy : s.stamina;
  }

  /**
   * How far a roll carries you.
   *
   * Heavy armour rolls one tile, not two, and that number is doing real work.
   * With both vows rolling the same distance, heavy was strictly better: flat
   * -1 damage against 2-to-5 damage hits is enormous, and paying more stamina
   * per roll cost nothing because walking out of a telegraph is free. A perfect
   * player took zero damage all run in heavy and died repeatedly in light,
   * which means it was not a choice.
   *
   * Halving the distance makes the trade real: heavy cannot reposition, so it
   * has to read earlier and hold ground, spending health where light spends
   * movement.
   */
  rollDistance() {
    const s = SKILL_BY_KEY.roll;
    return this.heavyArmour ? s.dashHeavy : s.dash;
  }

  canAfford(cost) { return this.stamina >= cost; }

  spend(cost) { this.stamina = Math.max(0, this.stamina - cost); }

  /** Called once per turn, after everything has acted. */
  tick() {
    this.stamina = Math.min(this.staminaMax, this.stamina + this.staminaRegen);
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
