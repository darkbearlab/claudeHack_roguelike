// The game: state, the turn loop, and every command the player can give.
//
// Turn model
// ----------
// A turn advances when the player does something that is not a roll. Rolling
// costs stamina and gives the world nothing, which is the single decision that
// defines this game: the clock is stamina, not turns. A player with a full bar
// can weave two tiles left, attack, and weave back before anything else moves;
// a player who spent it attacking is standing exactly where the brute is about
// to swing.
//
// Order within a world turn matters and is not arbitrary:
//   1. the player's own regeneration and cooldowns
//   2. projectiles already in the air move
//   3. enemies act (and may launch new projectiles, which do NOT move yet)
//   4. the dead are cleared, field of view is recomputed
//
// Step 2 before step 3 is what guarantees you always get a full turn to see an
// arrow before it travels. If enemies fired and their arrows moved in the same
// beat, a ranged attack would be an ambush rather than a telegraph, and the
// whole read-and-react contract would be broken.

import { RNG, makeSeedPhrase } from '../../../engine/rng.js';
import { DIRS, DIR_BY_KEY, dist, capitalise } from '../../../engine/util.js';
import { computeFOV, hasLOS } from '../../../engine/fov.js';
import { astar } from '../../../engine/path.js';
import { generateLevel, DUNGEON_DEPTH } from '../map/mapgen.js';
import { T, isBonfire, tileName, isWalkable, isChest, isCorpse } from '../map/tiles.js';
import { Player, Enemy, STATE, NORMAL_SPEED, resetUids } from './actors.js';
import { SKILL_BY_KEY, SKILLS } from '../data/skills.js';
import { STARTING_KIT, SLOT, ITEM_BY_KEY, slotsFor,
         CONSUMABLE_BY_KEY, isConsumable } from '../data/items.js';
import { attackTiles, snapDir, blocksDirection } from './patterns.js';
import { enemyTurn, tickEnemyState } from './ai.js';
import { makeProjectile, stepProjectiles, resetProjectileIds } from './projectile.js';
import { populate, spawnBoss } from './populate.js';
import { saveGame, clearSave } from './save.js';

export const VERSION = '0.1.0';

export class Game {
  constructor(ui) {
    this.ui = ui;
    this.running = false;
    this.busy = false;
  }

  // =========================================================================
  // lifecycle
  // =========================================================================

  newGame({ seed, name, vow }) {
    resetUids(1);
    resetProjectileIds(1);
    this.seed = seed || makeSeedPhrase(new RNG(Date.now()));
    this.rng = new RNG(this.seed);
    this.player = new Player(name);
    this.vow = vow ?? 'light';

    // The vow is now just the kit you start in. Everything it used to set
    // directly - health, damage reduction, how expensive a roll is - is a
    // property of the armour, so it is something you can change later rather
    // than a decision welded on at the character screen.
    const kit = STARTING_KIT[this.vow] ?? STARTING_KIT.light;
    this.player.equipItem(SLOT.ARMOUR, kit.armour);
    this.player.equipItem(SLOT.MAIN, kit.main);
    this.player.equipItem(SLOT.OFF, kit.off);
    this.player.pack = [...kit.pack];
    this.player.prepare('item', kit.item ?? null);
    this.player.prepare('magic', kit.magic ?? null);
    this.player.hp = this.player.hpMax;
    // Ranger rather than rogue for the light kit: the rogue sprite is a dark
    // hooded figure and effectively disappears against dark stone at phone tile
    // sizes.
    this.player.sprite = this.player.heavyArmour ? 'hero_fighter' : 'hero_ranger';

    this.turn = 0;
    this.startedAt = Date.now();
    this.levels = new Map();
    this.messages = [];
    this.stats = { kills: 0, deaths: 0, deepest: 1, rests: 0 };
    this.opened = new Set();            // chest ids taken this run
    this.corpse = null;                 // where the last death left things
    this.running = true;
    this.gameOver = null;
    this.aiming = null;                 // {skillKey} while a skill is selected

    this.gotoLevel(1);
    // Starting bonfire: you always begin a run rested and with a place to
    // return to, so the very first death is a setback and not a restart.
    const b = this.level.bonfires[0];
    if (b) {
      this.player.x = b.x; this.player.y = b.y;
      this.player.bonfire = { depth: 1, id: b.id, x: b.x, y: b.y };
    }
    this.afterMove();

    this.msg(`You wake at the bonfire. ${DUNGEON_DEPTH} floors down, something is still burning.`, 'magic');
    this.msg('You cannot take a hit. Read the wind-up, and be somewhere else.');
    return this;
  }

  // =========================================================================
  // levels
  // =========================================================================

  /** Levels are derived from the run seed, so a floor is always the same floor. */
  buildLevel(depth) {
    const lvl = generateLevel(depth, new RNG(`${this.seed}#${depth}`));
    populate(this, lvl, new RNG(`${this.seed}#${depth}#mob`));
    if (depth === DUNGEON_DEPTH) spawnBoss(this, lvl);
    return lvl;
  }

  levelAt(depth) {
    if (!this.levels.has(depth)) this.levels.set(depth, this.buildLevel(depth));
    return this.levels.get(depth);
  }

  /**
   * Rebuild a floor from its seed, keeping only what the player *learned*.
   *
   * Enemies come back, doors close, projectiles vanish - that is the bonfire
   * contract. Map memory does not come back, because knowing the shape of the
   * floor is the one thing a death is not supposed to take from you.
   */
  respawnLevel(depth) {
    const old = this.levels.get(depth);
    const fresh = this.buildLevel(depth);
    if (old) fresh.seen.set(old.seen);
    this.levels.set(depth, fresh);
    if (this.player.depth === depth) this.level = fresh;
    // The floor comes back from the seed, so anything that is not in the seed
    // has to be painted on again - any chest you already emptied, and then your
    // remains. Order matters: the chest cleanup writes a tile, so doing it
    // second erased a corpse lying on the square where the chest had been.
    if (fresh.store && this.opened.has(`${depth}:${fresh.store.x},${fresh.store.y}`)) {
      fresh.set(fresh.store.x, fresh.store.y, T.FLOOR);
    }
    this.restoreCorpse(depth);
    return fresh;
  }

  gotoLevel(depth, arriveAt = 'up') {
    const p = this.player;
    depth = Math.max(1, Math.min(DUNGEON_DEPTH, depth));
    this.level = this.levelAt(depth);
    p.depth = depth;
    p.maxDepth = Math.max(p.maxDepth, depth);
    this.stats.deepest = Math.max(this.stats.deepest, depth);

    let spot = arriveAt === 'up' ? this.level.upStair : this.level.downStair;
    spot = spot || this.level.upStair || this.level.downStair ||
           this.level.randomFreeSpot(this.rng);
    if (!spot) spot = { x: 1, y: 1 };
    if (this.level.enemyAt(spot.x, spot.y)) {
      const alt = this.level.randomFreeSpot(this.rng);
      if (alt) spot = alt;
    }
    p.x = spot.x; p.y = spot.y;
    this.afterMove();
  }

  // =========================================================================
  // messages
  // =========================================================================

  msg(text, cls = '') {
    if (!text) return;
    this.messages.push({ text, cls, turn: this.turn });
    if (this.messages.length > 300) this.messages.shift();
    this.ui?.pushMessage(text, cls);
  }

  animateTrail(cells, glyph, colour) { this.ui?.animateTrail?.(cells, glyph, colour); }

  // =========================================================================
  // the turn loop
  // =========================================================================

  async command(key) {
    if (!this.running || this.busy) return;
    this.busy = true;
    try {
      // Recovery burns the turn whatever you pressed. The world still has to be
      // rendered between those turns, or two turns of being hit look like a
      // freeze rather than the consequence of the swing you chose.
      if (this.player.recovering) {
        this.msg(`You are still recovering. (${this.player.recover})`, 'warn');
        this.worldTurn();
        return;
      }
      const spent = await this.doCommand(key);
      if (spent && this.running) this.worldTurn();
    } catch (err) {
      console.error(err);
      this.msg(`(internal error: ${err.message})`, 'bad');
    } finally {
      this.busy = false;
      this.ui?.render();
    }
  }

  worldTurn() {
    this.turn++;
    this.player.turns++;
    this.player.tick(this.inCombat());

    stepProjectiles(this);
    if (!this.running) return;

    for (const e of [...this.level.enemies]) {
      if (!e.alive) continue;
      // State first, once per turn; then however many actions its speed buys.
      // Keeping these apart is what stops a fast enemy from out-running its
      // own telegraph.
      //
      // Energy is gained ONLY when the enemy is free to use it. Banking it
      // through a wind-up or a recovery let a fast enemy save up its whole
      // idle time and then spend it at once: a hound coming out of a bite had
      // enough stored to cross three tiles a turn, so disengaging from one was
      // impossible and its chip damage was unavoidable by construction. That
      // single line accounted for a quarter of all recorded deaths, and it
      // read as the bestiary being over-tuned rather than as a scheduler bug.
      const busy = tickEnemyState(this, e);
      if (busy) continue;
      e.gainEnergy();
      let guard = 0;
      while (e.canAct() && guard++ < 3) {
        if (!e.alive || !this.running) break;
        if (e.state !== STATE.READY) break;
        enemyTurn(this, e);
      }
    }

    // The shield comes down at the end of the turn it was raised. tick() runs at
    // the *top* of worldTurn, before anything swings, so it is the wrong place
    // to clear this - the block would be gone before the blow it was raised
    // against ever landed.
    this.player.blocking = null;

    this.level.removeDead();
    this.afterMove();
  }

  afterMove() {
    const p = this.player;
    // Lighting is simple here on purpose: rooms are always lit, because a
    // wind-up you cannot see is not a telegraph.
    computeFOV(this.level, p.x, p.y, 11, false);
    this.ui?.render();
  }

  // =========================================================================
  // damage
  // =========================================================================

  /**
   * `opts.from` is the direction the blow arrives FROM, as seen by the player -
   * so a blow you would face to block points that way. Whoever raises the blow
   * works that out, because the honest answer differs by case:
   *
   *   melee       the reverse of the attacker's facing, NOT the direction to
   *               its body. The horned one charges six tiles and ends up past
   *               you; it still hit you from the side it came from.
   *   radial      the direction to the attacker, since a ring has no facing and
   *               the attacker is its centre.
   *   projectile  the reverse of its own velocity - the archer may be dead by
   *               the time the arrow lands, and you are blocking the arrow.
   */
  hurtPlayer(amount, source, opts = {}) {
    const p = this.player;
    let dmg = amount;

    if (p.warded > 0) {
      p.warded--;
      this.msg('The ward takes it.', 'good');
      return;
    }

    const shield = p.shield;
    if (shield && p.blocking && opts.from && !opts.unblockable &&
        blocksDirection(p.blocking, opts.from, shield.block.arc)) {
      dmg = Math.max(0, dmg - shield.block.reduce);
      this.msg(dmg > 0
        ? `You catch it on the ${shield.name}, but not all of it.`
        : `You catch it square on the ${shield.name}.`, 'good');
    }

    if (p.armourReduce) dmg = Math.max(dmg > 0 ? 1 : 0, dmg - p.armourReduce);
    p.hp -= dmg;
    if (p.hp <= 0) this.die(source);
  }

  hurtEnemy(e, amount, byPlayer, impact = 0) {
    if (!e.alive) return;
    let dmg = amount;
    if (byPlayer && this.player.edge) { dmg += this.player.edge; this.player.edge = 0; }
    e.hp -= dmg;
    if (byPlayer && impact > 0) e.stagger(impact);
    if (e.hp <= 0) {
      e.alive = false;
      this.level.markEnemiesDirty();
      this.stats.kills++;
      this.msg(`The ${e.name} falls.`, 'good');
      if (byPlayer) this.player.onKill();
      if (e.spec.boss) this.win();
    }
  }

  // =========================================================================
  // commands
  // =========================================================================

  async doCommand(key) {
    // Aiming a skill swallows direction keys.
    if (this.aiming) {
      if (key === 'Escape') { this.aiming = null; this.msg('Never mind.'); return false; }
      const d = this.dirFromKey(key);
      if (d) { const s = this.aiming; this.aiming = null; return this.useSkill(s, d); }
      { const k = /^[1-9]$/.test(key) ? skillForDigit(this, +key) : null;
        if (k) { this.selectSkill(k); return false; } }
      this.msg('Pick a direction, or Escape.');
      return false;
    }

    const dir = this.dirFromKey(key);
    if (dir) return this.step(dir.dx, dir.dy);

    const roll = this.rollDirFromKey(key);
    if (roll) return this.useSkill('roll', roll);

    { const k = /^[1-9]$/.test(key) ? skillForDigit(this, +key) : null;
      if (k) { this.selectSkill(k); return false; } }

    switch (key) {
      case '.': case ' ': return this.wait();
      case '>': return this.descend();
      case '<': return this.ascend();
      case 'e': case 'E': return this.rest();
      case 'g': case ',': return this.openChest() || this.reclaim();
      case ':': return this.lookHere();
      case 'S': saveGame(this); this.ui?.showSaved?.(); return false;
      case '?': await this.ui?.showHelp?.(); return false;
      case 'C-p': await this.ui?.showText?.('Messages',
        this.messages.slice(-100).map((m) => `${String(m.turn).padStart(5)}  ${m.text}`)); return false;
      default:
        if (key.length === 1) this.msg(`Unknown key '${key}'.  Press ? for help.`);
        return false;
    }
  }

  dirFromKey(key) {
    if (DIR_BY_KEY[key]) return DIR_BY_KEY[key];
    const arrows = { ArrowLeft: 'h', ArrowRight: 'l', ArrowUp: 'k', ArrowDown: 'j' };
    if (arrows[key]) return DIR_BY_KEY[arrows[key]];
    const numpad = { numpad1: 'b', numpad2: 'j', numpad3: 'n', numpad4: 'h',
                     numpad6: 'l', numpad7: 'y', numpad8: 'k', numpad9: 'u' };
    if (numpad[key]) return DIR_BY_KEY[numpad[key]];
    return null;
  }

  rollDirFromKey(key) {
    const map = { H: 'h', J: 'j', K: 'k', L: 'l', Y: 'y', U: 'u', B: 'b', N: 'n' };
    return map[key] ? DIR_BY_KEY[map[key]] : null;
  }

  selectSkill(key) {
    const def = SKILL_BY_KEY[key];
    const s = this.player.skill(key);
    if (!def || !s) return;
    if (s.cd > 0) { this.msg(`${def.name} is not ready (${s.cd}).`, 'warn'); return; }
    const cost = this.player.costOf(key);
    if (!this.player.canAfford(cost)) { this.msg(`Not enough stamina for ${def.name}.`, 'warn'); return; }
    this.aiming = key;
    this.msg(`${def.name}: pick a direction.`);
  }

  // ------------------------------------------------------------- movement

  step(dx, dy) {
    const p = this.player;
    const lvl = this.level;
    const nx = p.x + dx, ny = p.y + dy;
    p.face(dx, dy);

    const e = lvl.enemyAt(nx, ny);
    if (e && e.alive) return this.useSkill('strike', { dx, dy });

    if (!lvl.inBounds(nx, ny)) { this.msg('You cannot go that way.'); return false; }
    if (!lvl.diagonalOk(p.x, p.y, nx, ny)) {
      this.msg('Not diagonally through a doorway.');
      return false;
    }
    const t = lvl.at(nx, ny);
    if (t === T.DOOR_CLOSED) { lvl.set(nx, ny, T.DOOR_OPEN); this.msg('You open the door.'); return true; }
    if (!lvl.passable(nx, ny)) { this.msg(`${capitalise(tileName(t))} blocks the way.`); return false; }

    p.x = nx; p.y = ny;
    this.afterMove();
    this.onEnterTile();
    return true;
  }

  onEnterTile() {
    const t = this.level.at(this.player.x, this.player.y);
    if (isBonfire(t)) this.msg('A bonfire. Press e to rest.', 'magic');
    else if (t === T.STAIRS_DOWN) this.msg('Stairs down. Press > to descend.');
    else if (t === T.STAIRS_UP) this.msg('Stairs up.');
  }

  wait() { return true; }

  /**
   * Is anything currently hunting you?
   *
   * "Out of combat" has to mean something recoverable, or the fast refill never
   * fires and the weight rule becomes an exploration tax after all. Awareness
   * decays (see ai.js), so this is a live question rather than a floor-wide
   * latch: once you have broken away and nothing has seen you for a while, the
   * bar comes back.
   */
  inCombat() {
    const lvl = this.level;
    if (!lvl) return false;
    for (const e of lvl.enemies) if (e.alive && e.aware) return true;
    return lvl.projectiles.some((p) => !p.fromPlayer);
  }

  // ------------------------------------------------------------- picking up

  /**
   * Open the chest you are standing on.
   *
   * Taken-ness is tracked on the *run*, not on the level, because the level is
   * rebuilt from the seed every time you die - a chest stored as empty terrain
   * would refill itself the first time you were killed. Keyed by depth and
   * position, which is stable for exactly the same reason the floor is.
   */
  openChest() {
    const p = this.player;
    const lvl = this.level;
    if (!isChest(lvl.at(p.x, p.y))) return false;
    const id = `${p.depth}:${p.x},${p.y}`;
    if (this.opened.has(id) || !lvl.store) {
      this.msg('The chest is empty.');
      lvl.set(p.x, p.y, T.FLOOR);
      return false;
    }
    this.opened.add(id);
    lvl.set(p.x, p.y, T.FLOOR);
    this.gain(lvl.store.loot, 'You lever the chest open');
    return true;
  }

  /**
   * Take something into the pack, and remember that it is not safe yet.
   *
   * `unbanked` is the whole death penalty: everything you have picked up since
   * you last sat at a fire is dropped where you die. Wearing something protects
   * it - you never lose the sword in your hand, only the one you have not had
   * time to carry home.
   */
  gain(key, how = 'You take') {
    const it = ITEM_BY_KEY[key] ?? CONSUMABLE_BY_KEY[key];
    if (!it) return false;
    this.player.pack.push(key);
    this.player.unbanked.push(key);
    this.msg(`${how}: ${it.name}.`, 'good');
    return true;
  }

  /**
   * Pick your own remains back up.
   *
   * One corpse at a time, and dying again before you reach it loses what was on
   * it. That is the Souls loop with items instead of a currency, which is worth
   * doing this way round: the drop system had to exist anyway, and it means the
   * thing you are walking back for is the specific sword you wanted, not a
   * number.
   */
  /** Paint the corpse back on after a floor is rebuilt from its seed. */
  restoreCorpse(depth) {
    const c = this.corpse;
    if (!c || c.depth !== depth) return;
    const lvl = this.levels.get(depth);
    if (!lvl) return;
    // Do not re-read `under` from a corpse we already painted, or the tile
    // underneath would become CORPSE and survive being picked up.
    const here = lvl.at(c.x, c.y);
    if (!isCorpse(here)) c.under = here;
    lvl.set(c.x, c.y, T.CORPSE);
  }

  reclaim() {
    const p = this.player;
    const c = this.corpse;
    if (!c || c.depth !== p.depth || c.x !== p.x || c.y !== p.y) return false;
    for (const key of c.items) this.gain(key, 'You take back');
    this.level.set(p.x, p.y, c.under ?? T.FLOOR);
    this.corpse = null;
    return true;
  }

  /** Everything you are carrying is safe now. Called when you sit down. */
  bank() {
    if (this.player.unbanked.length) this.msg('What you found is safe now.');
    this.player.unbanked = [];
  }

  /**
   * Leave a corpse holding whatever had not been banked.
   *
   * Worn equipment is never touched. Only one corpse exists at a time, so dying
   * on the way back to the first one is how you actually lose things.
   */
  dropUnbanked() {
    const p = this.player;
    const items = p.unbanked.filter((k) => p.pack.includes(k));
    p.unbanked = [];
    if (!items.length) return;

    for (const k of items) {
      const i = p.pack.indexOf(k);
      if (i >= 0) p.pack.splice(i, 1);
    }
    // The old one is gone. This is the only way to permanently lose anything.
    if (this.corpse) this.msg('What you left behind is gone.', 'bad');

    const lvl = this.levelAt(p.depth);
    const under = lvl.at(p.x, p.y);
    lvl.set(p.x, p.y, T.CORPSE);
    this.corpse = { depth: p.depth, x: p.x, y: p.y, items, under };
    this.msg(`You drop what you were carrying. (${items.length})`, 'bad');
  }

  // ------------------------------------------------------------- equipment

  /**
   * Put something on, or take it off. **This advances the turn.**
   *
   * That is the rule the whole loadout system rests on. If swapping were free
   * the eight buttons would really be "every skill on every weapon you own",
   * because you would simply switch to whichever shape suited the tile you were
   * standing on. Costing a turn makes carrying a second weapon a plan rather
   * than a menu.
   *
   * Looking in the pack is free; only changing something costs you.
   */
  equipFromPack(slot, key) {
    const p = this.player;
    if (key !== null && !p.pack.includes(key)) { this.msg('You are not carrying that.', 'warn'); return false; }
    if (key !== null && !slotsFor(ITEM_BY_KEY[key]).includes(slot)) {
      this.msg(`That does not go in your ${slot === SLOT.ARMOUR ? 'armour slot' : slot + ' hand'}.`, 'warn');
      return false;
    }
    if (key !== null && p.equip[slot] === key) return false;

    const res = p.equipItem(slot, key);
    if (!res.ok) { this.msg(res.why, 'warn'); return false; }

    if (key !== null) p.pack = p.pack.filter((k) => k !== key);
    for (const k of res.displaced) p.pack.push(k);
    p.hp = Math.min(p.hp, p.hpMax);

    const it = key ? ITEM_BY_KEY[key] : null;
    this.msg(it ? `You ready the ${it.name}.` : `You put it away.`);
    return true;               // <- advances the turn
  }

  /**
   * Use whatever is in a prepared slot. Always spends the turn.
   *
   * Drinking is not free and neither is casting: standing still to heal while
   * something winds up is the decision, and it is only interesting because it
   * costs you the turn you could have spent leaving.
   */
  usePrepared(kind, dir) {
    const p = this.player;
    if (p.recovering) { this.msg('You are still recovering.', 'warn'); return false; }
    const c = p.prepared(kind);
    if (!c) { this.msg(`You have no ${kind} readied.`, 'warn'); return false; }
    if (p.chargesOf(c.key) <= 0) { this.msg(`The ${c.name} is spent.`, 'warn'); return false; }
    if (c.stamina && !p.canAfford(c.stamina)) { this.msg('Not enough stamina.', 'warn'); return false; }
    if (c.directional && !dir) { this.msg(`${c.name}: pick a direction.`, 'warn'); return false; }

    p.charges[c.key] = p.chargesOf(c.key) - 1;
    if (c.stamina) p.spend(c.stamina);
    if (dir) p.face(dir.dx, dir.dy);

    if (c.shield) {
      // Direction-blind on purpose: this is the answer to the things a shield
      // cannot help with - a charge that runs you over, or being surrounded.
      p.warded = c.shield;
      this.msg('A ward closes around you.', 'good');
      return true;
    }

    if (c.teleport) {
      const before = { x: p.x, y: p.y };
      let x = p.x, y = p.y;
      for (let i = 0; i < c.teleport; i++) {
        const nx = x + dir.dx, ny = y + dir.dy;
        // Through bodies, but not through rock - that is the whole point of it
        // over a roll.
        if (!this.level.inBounds(nx, ny) || !isWalkable(this.level.at(nx, ny))) break;
        x = nx; y = ny;
      }
      if (this.level.enemyAt(x, y)) { this.msg('There is something in the way.', 'warn'); return false; }
      p.x = x; p.y = y;
      this.msg(`You step through. (${Math.max(Math.abs(x - before.x), Math.abs(y - before.y))})`);
      this.afterMove();
      return true;
    }

    if (c.heal) {
      const before = p.hp;
      p.hp = Math.min(p.hpMax, p.hp + c.heal);
      this.msg(`You drink. (+${p.hp - before})`, 'good');
      return true;
    }

    if (c.projectile) {
      this.level.projectiles.push(makeProjectile({
        x: p.x, y: p.y, dx: dir.dx, dy: dir.dy,
        speed: c.projectile.speed, damage: c.damage, impact: c.impact,
        glyph: c.projectile.glyph, colour: c.projectile.colour,
        fromPlayer: true, life: c.range + 2,
      }));
      this.msg(`You cast ${c.name}.`);
      return true;
    }

    if (c.pattern) {
      const tiles = attackTiles(p.x, p.y, dir.dx, dir.dy, c.pattern);
      let hit = 0;
      for (const t of tiles) {
        const e = this.level.enemyAt(t.x, t.y);
        if (e && e.alive) {
          this.hurtEnemy(e, c.damage, true, c.impact);
          if (c.knock && e.alive) this.knockBack(e, dir, c.knock);
          hit++;
        }
      }
      this.ui?.animateTrail?.(tiles, '*', '#ff9a3c');
      this.msg(hit ? `${capitalise(c.name)} tears through ${hit}.` : `${capitalise(c.name)} hits nothing.`);
      return true;
    }

    // A buff with no shape of its own: the whetstone.
    if (c.damage) {
      p.edge = c.damage;
      this.msg(`You sharpen your weapon. (+${c.damage} next hit)`, 'good');
      return true;
    }

    return true;
  }

  /**
   * Push something away from you.
   *
   * Position is this game's language, so moving an enemy is a real effect
   * rather than a garnish: shove something out of the lane you want to stand
   * in, or into the lane the horned one is about to charge down. It stops at
   * whatever it would have been pushed into, which is the interesting case.
   */
  knockBack(e, dir, tiles) {
    let moved = 0;
    for (let i = 0; i < tiles; i++) {
      const nx = e.x + dir.dx, ny = e.y + dir.dy;
      if (!this.level.passable(nx, ny, e)) break;
      if (this.level.enemyAt(nx, ny)) break;
      if (nx === this.player.x && ny === this.player.y) break;
      if (!this.level.diagonalOk(e.x, e.y, nx, ny)) break;
      this.level.moveEnemy(e, nx, ny);
      moved++;
    }
    return moved;
  }

  /** Ready a consumable from the pack. Costs a turn, like any other swap. */
  prepareFromPack(kind, key) {
    const p = this.player;
    if (key !== null && !p.pack.includes(key)) { this.msg('You are not carrying that.', 'warn'); return false; }
    if (key !== null && !isConsumable(key)) { this.msg('That is not something you ready.', 'warn'); return false; }
    if (key !== null && p.prep[kind] === key) return false;

    const res = p.prepare(kind, key);
    if (!res.ok) { this.msg(res.why, 'warn'); return false; }
    if (key !== null) p.pack = p.pack.filter((k) => k !== key);
    for (const k of res.displaced) p.pack.push(k);
    const c = key ? CONSUMABLE_BY_KEY[key] : null;
    this.msg(c ? `You ready the ${c.name}.` : 'You put it away.');
    return true;
  }

  // -------------------------------------------------------------- skills

  useSkill(key, dir) {
    // The two prepared slots ride the same path as a skill so that the button,
    // the drag gesture, the keyboard and the bot all have one way in.
    if (this.player.recovering) { this.msg('You are still recovering.', 'warn'); return false; }
    if (typeof key === 'string' && key.startsWith('prep:')) return this.usePrepared(key.slice(5), dir);
    const p = this.player;
    const def = SKILL_BY_KEY[key];
    const slot = p.skill(key);
    if (!def || !slot) return false;
    // You can only use what you are holding. Checked here rather than only in
    // the UI, because the keyboard, the bot and a stale save all reach this
    // function without going past a button.
    if (!p.hasSkill(key)) { this.msg(`You are not holding anything that does that.`, 'warn'); return false; }
    if (slot.cd > 0) { this.msg(`${def.name} is not ready.`, 'warn'); return false; }

    const cost = p.costOf(key);
    if (!p.canAfford(cost)) { this.msg(`Not enough stamina.`, 'warn'); return false; }

    if (def.defend) {
      const shield = p.shield;
      if (!shield) { this.msg('You have no shield.', 'warn'); return false; }
      p.spend(cost);
      p.face(dir.dx, dir.dy);
      p.blocking = { dx: dir.dx, dy: dir.dy };
      this.msg(`You raise the ${shield.name}.`);
      return true;
    }

    p.face(dir.dx, dir.dy);

    // ---- roll: the one action that does not advance the turn --------------
    if (def.move) {
      const moved = this.dash(p.rollDistance(), dir);
      if (!moved) { this.msg('No room to roll.'); return false; }
      p.spend(cost);
      this.msg(`You roll ${moved} ${moved === 1 ? 'tile' : 'tiles'}.`);
      this.afterMove();
      return false;                    // <- does not advance the turn
    }

    p.spend(cost);
    if (def.cooldown) slot.cd = def.cooldown;
    // Recovery is set AFTER the blow lands, and counts down in tick() - so the
    // turn you swung is yours and the turns after it are not.
    if (def.recovery) p.recover = def.recovery;

    if (def.ranged) {
      this.level.projectiles.push(makeProjectile({
        x: p.x, y: p.y, dx: dir.dx, dy: dir.dy,
        speed: def.projectile.speed, damage: def.damage, impact: def.impact ?? 0,
        glyph: def.projectile.glyph, colour: def.projectile.colour,
        fromPlayer: true, life: def.range + 2,
      }));
      this.msg('You hurl a knife.');
      return true;
    }

    if (def.dash) this.dash(def.dash, dir);

    const tiles = attackTiles(p.x, p.y, dir.dx, dir.dy, def.pattern);
    let hit = 0;
    for (const t of tiles) {
      const e = this.level.enemyAt(t.x, t.y);
      if (e && e.alive) {
        const wasWindup = e.state === STATE.WINDUP;
        const poiseBefore = e.poiseLeft;
        this.hurtEnemy(e, def.damage, true, def.impact ?? 0);
        if (def.knock && e.alive) this.knockBack(e, dir, def.knock);
        hit++;
        if (wasWindup && e.alive) {
          if (e.poiseLeft === e.poise && poiseBefore !== e.poise) {
            this.msg(`You stagger the ${e.name}; its attack is delayed.`, 'good');
          } else {
            this.msg(`The ${e.name} shrugs it off and keeps winding up.`, 'warn');
          }
        }
      }
    }
    this.animateTrail(tiles, '/', '#ffd75f');
    if (!hit) this.msg(`${def.name} hits nothing.`);
    return true;
  }

  /** Move up to `n` tiles in a direction, stopping at the first obstruction. */
  dash(n, dir) {
    const p = this.player;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const nx = p.x + dir.dx, ny = p.y + dir.dy;
      if (!this.level.passable(nx, ny)) break;
      if (this.level.enemyAt(nx, ny)) break;
      if (!this.level.diagonalOk(p.x, p.y, nx, ny)) break;
      p.x = nx; p.y = ny; moved++;
    }
    return moved;
  }

  // -------------------------------------------------------- bonfire & floors

  rest() {
    const p = this.player;
    if (!isBonfire(this.level.at(p.x, p.y))) { this.msg('There is no bonfire here.'); return false; }
    const b = this.level.bonfireAt(p.x, p.y);
    p.bonfire = { depth: p.depth, id: b?.id ?? 0, x: p.x, y: p.y };
    p.hp = p.hpMax;
    p.stamina = p.staminaMax;
    p.refillCharges();
    this.bank();
    for (const s of p.skills) s.cd = 0;
    this.stats.rests++;

    const fresh = this.respawnLevel(p.depth);
    fresh.projectiles = [];
    this.msg('You rest. Your wounds close, and the dead stand up again.', 'magic');
    this.afterMove();
    saveGame(this);
    return false;
  }

  descend() {
    if (this.level.at(this.player.x, this.player.y) !== T.STAIRS_DOWN) {
      this.msg('No stairs down here.'); return false;
    }
    this.gotoLevel(this.player.depth + 1, 'up');
    this.msg(`Floor ${this.player.depth}.`, 'magic');
    saveGame(this);
    return true;
  }

  ascend() {
    if (this.level.at(this.player.x, this.player.y) !== T.STAIRS_UP) {
      this.msg('No stairs up here.'); return false;
    }
    if (this.player.depth === 1) { this.msg('There is nothing left above.'); return false; }
    this.gotoLevel(this.player.depth - 1, 'down');
    this.msg(`Floor ${this.player.depth}.`);
    return true;
  }

  lookHere() {
    const p = this.player;
    const bits = [tileName(this.level.at(p.x, p.y))];
    const near = this.level.livingEnemies()
      .filter((e) => dist(e.x, e.y, p.x, p.y) <= 6 && this.level.isVisible(e.x, e.y))
      .map((e) => `${e.name} (${e.hp}/${e.hpMax}${e.state === STATE.WINDUP ? ', winding up' :
                    e.state === STATE.RECOVER ? ', recovering' :
                    e.state === STATE.RESTING ? ', winded' : ''})`);
    if (near.length) bits.push('nearby: ' + near.join(', '));
    this.msg(bits.join('; '));
    return false;
  }

  // =========================================================================
  // ending
  // =========================================================================

  /**
   * Death.
   *
   * Not the end of the run - the end of the *attempt*. You wake at the last
   * bonfire, everything is standing again, and the floor is still the floor you
   * had already learned. That is the whole reason the levels come from a seed.
   */
  die(source) {
    const p = this.player;
    p.deaths++;
    this.stats.deaths++;
    this.msg(`You are killed by ${source}.`, 'bad');

    // Before anything else: this is where you died, and this is where what you
    // were carrying stays. Has to happen before the level is rebuilt and before
    // you are moved.
    this.dropUnbanked();

    const b = p.bonfire;
    if (!b) { this.finish('lost', source); return; }

    p.depth = b.depth;
    this.respawnLevel(b.depth);
    this.level = this.levels.get(b.depth);
    for (const d of this.levels.keys()) if (d !== b.depth) this.respawnLevel(d);
    p.x = b.x; p.y = b.y;
    p.hp = p.hpMax;
    p.stamina = p.staminaMax;
    p.refillCharges();
    for (const s of p.skills) s.cd = 0;
    this.level.projectiles = [];
    this.afterMove();
    this.msg('You wake at the bonfire.', 'warn');
    saveGame(this);
    this.ui?.onDeath?.(p.deaths);
  }

  win() { this.finish('won', null); }

  finish(how, killer) {
    this.running = false;
    this.gameOver = {
      how, killer,
      turns: this.turn,
      depth: this.player.depth,
      maxDepth: this.player.maxDepth,
      deaths: this.player.deaths,
      kills: this.stats.kills,
      elapsed: Date.now() - this.startedAt,
      seed: this.seed,
    };
    if (how === 'won') this.msg('The First Flame gutters out. You are done here.', 'good');
    clearSave();
    this.ui?.showGameOver?.(this.gameOver);
  }
}

// Number keys map to *button positions*, not to fixed skills - the loadout
// decides what sits in each slot, and the keyboard has to agree with the grid.
function skillForDigit(game, d) {
  const p = game.player;
  if (!p) return null;
  const main = p.item(SLOT.MAIN), off = p.item(SLOT.OFF);
  const offIsWeapon = off && off.kind === 'weapon';
  const slots = [main?.primary, main?.secondary, offIsWeapon ? off.primary : null,
                 null, null, null, 'roll'];
  return slots[d - 1] ?? null;
}
export { skillForDigit, DUNGEON_DEPTH };
