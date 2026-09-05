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
import { soulsFor, TRACKS, TRACK_BY_KEY, priceOf } from '../data/souls.js';
import { AFFIX_BY_KEY, canGrant, affixesOn, TEMP_HITS } from '../data/affixes.js';
import { attackTiles, snapDir, blocksDirection } from './patterns.js';
import { enemyTurn, tickEnemyState } from './ai.js';
import { makeProjectile, stepProjectiles, resetProjectileIds } from './projectile.js';
import { populate, spawnBoss } from './populate.js';
import { FxLog } from './fx.js';
import { buildHub } from '../map/hub.js';
import { HERO_BY_KEY } from '../data/heroes.js';
import { NPC_BY_KEY } from '../data/npcs.js';
import { saveGame, clearSave } from './save.js';

export const VERSION = '0.1.0';

export class Game {
  constructor(ui) {
    this.ui = ui;
    this.running = false;
    this.busy = false;
    this.fx = new FxLog();
  }

  // =========================================================================
  // lifecycle
  // =========================================================================

  newGame({ seed, name, vow, hero }) {
    resetUids(1);
    resetProjectileIds(1);
    this.seed = seed || makeSeedPhrase(new RNG(Date.now()));
    this.rng = new RNG(this.seed);
    this.player = new Player(name);
    this.inHub = false;
    // A hero brings their own skills and their own stamina economy; the vow is
    // what the game had before people existed, and still drives the bot and
    // the tests.
    this.player.hero = HERO_BY_KEY[hero] ?? null;
    this.hero = this.player.hero;
    this.vow = vow ?? 'light';

    // The vow is now just the kit you start in. Everything it used to set
    // directly - health, damage reduction, how expensive a roll is - is a
    // property of the armour, so it is something you can change later rather
    // than a decision welded on at the character screen.
    const kit = this.player.hero
      // A hero starts holding their own weapon. They used to start with empty
      // hands, and that quietly broke the loot loop: the weapon is where
      // affixes live, so with nothing in the slot every weapon the dungeon
      // dropped was pure carried weight and picking up a better one made you
      // worse.
      ? { off: null, pack: [], ...this.player.hero.kit }
      : (STARTING_KIT[this.vow] ?? STARTING_KIT.light);
    this.player.equipItem(SLOT.ARMOUR, kit.armour);
    this.player.equipItem(SLOT.MAIN, kit.main);
    this.player.equipItem(SLOT.OFF, kit.off);
    this.player.pack = [...kit.pack];
    this.player.prepare('item', kit.item ?? null);
    this.player.prepare('magic', kit.magic ?? null);
    this.player.hp = this.player.hpMax;

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
      // A declared blow lands on your next turn whatever you tried to do with
      // it. Walking away from your own swing would make the wind-up free.
      if (this.player.charging) {
        this.resolveCharge();
        this.worldTurn();
        return;
      }
      if (this.player.forced) {
        this.resolveForced();
        this.worldTurn();
        return;
      }
      this.fx.clear();
      this.fx.begin(0, this);
      const spent = await this.doCommand(key);
      this.fx.end(this);
      if (spent && this.running) this.worldTurn();
    } catch (err) {
      console.error(err);
      this.msg(`(internal error: ${err.message})`, 'bad');
    } finally {
      this.busy = false;
      this.ui?.render();
    }
  }

  /**
   * The hall you leave from.
   *
   * A real level with real people on it rather than a menu screen, so it
   * reuses movement, rendering, conversation and the bonfire - and so there is
   * somewhere to put the rest of docs/META.md later. Nothing acts here: it is
   * the one place in the game with no turn pressure.
   */
  enterHub() {
    const { level, start } = buildHub();
    this.running = true;
    this.inHub = true;
    this.hero = null;
    this.player = new Player(this.player?.name ?? 'Ashen');
    this.level = level;
    this.levels = new Map();
    this.player.x = start.x; this.player.y = start.y;
    this.player.depth = 0;
    this.turn = 0;
    this.messages = [];
    this.msg('灰燼之廳。火還亮著。', 'good');
    this.msg('走向一個人來選擇他。準備好了就走下階梯。');
    this.afterMove();
  }

  /** Take up one of them. Nothing else in the hall changes. */
  chooseHero(key) {
    const h = HERO_BY_KEY[key];
    if (!h) return false;
    this.hero = h;
    // Put it on the player too, not just the game. In the hall that is what
    // makes the choice legible: the buttons fill with their verbs and the bar
    // shrinks or grows to their pool, so you can see who you would be before
    // you take the stair rather than finding out on floor one.
    this.player.hero = h;
    this.player.equipItem(SLOT.ARMOUR, h.kit.armour);
    // Their weapon too, not just their coat. The hall exists to show you who
    // you would be, and a hero previewed empty-handed shows the wrong damage
    // and the wrong stamina - the weapon is where power and affixes live.
    this.player.equipItem(SLOT.MAIN, h.kit.main ?? null);
    this.player.stamina = this.player.staminaMax;
    this.player.hp = this.player.hpMax;
    this.msg(`你成為了${h.name}。`, 'good');
    this.ui?.render?.();
    return true;
  }

  worldTurn() {
    // The hall has no clock. Standing in it costs nothing, which is the
    // difference between a place to decide and a place to hurry.
    if (this.inHub) return;
    this.fx.begin(1, this);
    this.turn++;
    this.player.turns++;
    this.player.tick(this.inCombat());

    stepProjectiles(this);
    if (!this.running) { this.fx.end(this); return; }

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
    this.fx.end(this);

  }

  afterMove() {
    const p = this.player;
    computeFOV(this.level, p.x, p.y, 11, false);

    // Anything mid-swing is visible, whatever is between you and it.
    //
    // Rooms used to be revealed wholesale, which made this impossible to need:
    // you saw everything in the room you stood in. Pillars changed that on
    // purpose - an ambush is worth having, and a colonnade you can see through
    // is just decoration - so now something CAN be hidden from you.
    //
    // Being surprised by a creature's presence is fine. Being surprised by a
    // blow is not: "every blow in the game is announced" is the rule the whole
    // combat system rests on, and a telegraph behind a pillar is not a
    // telegraph. Measured before adding this, it never actually happened
    // (0 of 2097 wind-ups were hidden) because anything close enough to reach
    // you is close enough to see - but an observation is not a guarantee, and
    // this one is too important to leave to geometry.
    for (const e of this.level.enemies) {
      if (!e.alive || e.state !== STATE.WINDUP) continue;
      for (const t of e.bodyTiles()) this.level.markSeen(t.x, t.y);
      for (const t of e.attackTiles ?? []) this.level.markSeen(t.x, t.y);
    }
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
  /**
   * Land the blow declared last turn.
   *
   * Deliberately re-enters useSkill rather than duplicating the resolution:
   * every shape, affix, knockback and kill-refund rule lives in there once,
   * and a second copy of it would be wrong within a fortnight.
   */
  resolveCharge() {
    const p = this.player;
    const c = p.charging;
    if (!c) return false;
    p.charging = null;
    return this.useSkill(c.key, { dx: c.dx, dy: c.dy }, { resolving: true });
  }

  /**
   * Say something to whoever is standing there.
   *
   * The game only opens the conversation; what is in it belongs to the UI, so
   * the rules never need to know what anybody says. Async because a
   * conversation is a loop of exchanges and the UI owns the waiting.
   */
  talkTo(npc) {
    const spec = NPC_BY_KEY[npc.key];
    if (!spec) return;
    if (spec.hero) { this.chooseHero(spec.hero); this.ui?.showConversation?.(spec); return; }
    this.ui?.showConversation?.(spec);
  }

  hurtPlayer(amount, source, opts = {}) {
    const p = this.player;
    let dmg = amount;
    this.fx.add({ kind: 'hit', uid: 0, x: p.x, y: p.y });

    // A declared blow is lost if something lands on you first. No poise check:
    // the player is one person, not a troll, and a wind-up you can carry
    // through a hit would make the long attacks strictly better than the short
    // ones instead of a gamble against them. The stamina stays spent.
    if (p.charging && dmg > 0) {
      const name = SKILL_BY_KEY[p.charging.key]?.name ?? 'your swing';
      p.charging = null;
      this.msg(`${name} is knocked out of you.`, 'warn');
    }

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

    // A fraction, rounded, never below one. Flat reduction was worth half a
    // two-damage bite and a sixth of a six-damage pyre, which is backwards:
    // armour should answer the blow you could not avoid, not the chip you
    // were always going to take.
    if (p.armourReduce && dmg > 0) {
      dmg = Math.max(1, Math.round(dmg * (1 - p.armourReduce)));
    }
    p.hp -= dmg;
    if (p.hp <= 0) this.die(source);
  }

  /**
   * The distinct creatures standing in a set of tiles.
   *
   * The whole reason this exists: a body can cover more than one square, and
   * every attack in the game is a list of squares. Iterating the squares and
   * asking what is on each one hits a big creature once per square it happens
   * to occupy.
   */
  bodiesIn(tiles) {
    const out = [];
    for (const t of tiles) {
      const e = this.level.enemyAt(t.x, t.y);
      if (e && e.alive && !out.includes(e)) out.push(e);
    }
    return out;
  }

  hurtEnemy(e, amount, byPlayer, impact = 0) {
    if (!e.alive) return;
    let dmg = amount;
    if (byPlayer && this.player.edge) { dmg += this.player.edge; this.player.edge = 0; }
    e.hp -= dmg;
    this.fx.add({ kind: 'hit', uid: e.uid, x: e.x, y: e.y });
    if (byPlayer && impact > 0) e.stagger(impact);
    if (e.hp <= 0) {
      // Recorded here, while it still has a position. A moment later it is off
      // the enemy list and there is nothing left to draw a death for.
      this.fx.add({ kind: 'die', uid: e.uid, x: e.x, y: e.y });
      e.alive = false;
      this.level.markEnemiesDirty();
      this.stats.kills++;
      this.msg(`The ${e.name} falls.`, 'good');
      if (byPlayer) {
        const worth = soulsFor(e.spec, this.player.depth);
        this.player.souls += worth;
        this.player.onKill();
        // Its prize is a property of the floor seed, not of the kill - so
        // resting brings the elite back but not what it was carrying.
        if (e.elite && e.drop) {
          const id = `elite:${this.player.depth}`;
          if (!this.opened.has(id)) { this.opened.add(id); this.gain(e.drop, 'It was carrying'); }
        }
      }
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
    if (roll) return this.useSkill('roll', roll.dir, { steps: roll.steps });

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

  /** Shift + a direction rolls the full distance; Ctrl + one rolls a single tile. */
  rollDirFromKey(key) {
    const map = { H: 'h', J: 'j', K: 'k', L: 'l', Y: 'y', U: 'u', B: 'b', N: 'n' };
    if (map[key]) return { dir: DIR_BY_KEY[map[key]], steps: 99 };
    const m = /^C-([hjklyubn])$/.exec(key ?? '');
    if (m) return { dir: DIR_BY_KEY[m[1]], steps: 1 };
    return null;
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
    if (e && e.alive) {
      const swing = p.meleeSkill();
      if (!swing) { this.msg('You have nothing to hit it with.', 'warn'); return false; }
      return this.useSkill(swing, { dx, dy });
    }

    // Walking into a person talks to them. Checked after the enemy test and
    // before anything else, so there is no arrangement of tiles in which the
    // swing meant for a body lands on someone who is not one.
    //
    // It does not spend the turn: she stands beside a bonfire, which is a room
    // nothing spawns in, and charging a turn for a conversation held somewhere
    // safe only teaches people not to have it.
    const npc = lvl.npcAt(nx, ny);
    if (npc) { this.talkTo(npc); return false; }

    if (!lvl.inBounds(nx, ny)) { this.msg('You cannot go that way.'); return false; }
    if (!lvl.diagonalOk(p.x, p.y, nx, ny, true)) {
      // Bodies count here, and the message has to say which it was or being
      // pinched reads as the game refusing at random.
      const pinched = lvl.diagonalOk(p.x, p.y, nx, ny);
      this.msg(pinched ? 'They have you boxed in - roll.' : 'Not diagonally through a doorway.',
               pinched ? 'warn' : undefined);
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

  /**
   * Buy a rank. Only at a fire, which is the entire point.
   *
   * Spending being tied to the fire is what turns "I am carrying twelve hundred"
   * into a decision rather than a number: the souls are only worth something
   * once you have walked them home, and until then they are what you lose.
   */
  buyRank(key) {
    const p = this.player;
    if (!isBonfire(this.level.at(p.x, p.y))) { this.msg('Not here.', 'warn'); return false; }
    const t = TRACK_BY_KEY[key];
    if (!t) return false;
    const price = priceOf(p.ranks, key);
    if (price === null) { this.msg(`${t.name} is as far as it goes.`, 'warn'); return false; }
    if (p.souls < price) { this.msg(`You need ${price - p.souls} more.`, 'warn'); return false; }

    p.souls -= price;
    p.ranks[key] = (p.ranks[key] ?? 0) + 1;
    for (const track of TRACKS) track.apply(p, p.ranks[track.key] ?? 0);
    p.stamina = Math.min(p.stamina, p.staminaMax);
    this.msg(`${t.name} ${p.ranks[key]}. ${t.hint}`, 'magic');
    return false;                       // spending does not advance the turn
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
    if (c.souls) { p.souls += c.souls; this.msg(`You take back ${c.souls} souls.`, 'good'); }
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
    const souls = p.souls;
    p.unbanked = [];
    p.souls = 0;
    if (!items.length && !souls) return;

    for (const k of items) {
      const i = p.pack.indexOf(k);
      if (i >= 0) p.pack.splice(i, 1);
    }
    // The old one is gone. This is the only way to permanently lose anything.
    if (this.corpse) this.msg('What you left behind is gone.', 'bad');

    const lvl = this.levelAt(p.depth);
    const under = lvl.at(p.x, p.y);
    lvl.set(p.x, p.y, T.CORPSE);
    this.corpse = { depth: p.depth, x: p.x, y: p.y, items, souls, under };
    this.msg(`You drop what you were carrying.` +
             `${items.length ? ` (${items.length})` : ''}${souls ? ` and ${souls} souls` : ''}`,
             'bad');
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
    if (c.restore) {
      const before = p.stamina;
      p.stamina = Math.min(p.staminaMax, p.stamina + c.restore);
      this.msg(`You lift the banner. (+${p.stamina - before})`, 'good');
    }
    if (c.stamina) p.spend(c.stamina);
    if (dir) p.face(dir.dx, dir.dy);

    if (c.grants || c.tempAffix) {
      const it = p.item(SLOT.MAIN);
      if (!it) { this.msg('You have nothing in your main hand.', 'warn'); return false; }
      const st = (p.affix[it.key] ??= {});
      const a = AFFIX_BY_KEY[c.grants ?? c.tempAffix];

      if (c.grants) {
        if (!canGrant(it, st)) {
          this.msg(`The ${it.name} will not take any more work.`, 'warn');
          return false;
        }
        st.granted = c.grants;
        this.msg(`The ${it.name} is now ${a.name}. ${a.hint}`, 'magic');
      } else {
        st.temp = { key: c.tempAffix, hits: TEMP_HITS };
        this.msg(`${a.name}: the next ${TEMP_HITS} hits. ${a.hint}`, 'magic');
      }
      return true;
    }

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
      // Once per BODY, not once per tile. A shape that overlaps three squares
      // of a 2x2 would otherwise deal its damage and its knockback three times
      // to one creature - and that arrives looking like "big enemies are too
      // weak", which is a resolution bug wearing a balance problem's clothes.
      for (const e of this.bodiesIn(tiles)) {
        this.hurtEnemy(e, c.damage, true, c.impact);
        if (c.knock && e.alive) this.knockBack(e, dir, c.knock);
        hit++;
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
    // Big things are not shoved about. Without this a Shove walks a dragon
    // across the room for three stamina.
    if (e.immovable) return 0;
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
    // The telegraph travels with the body.
    //
    // `attackTiles` is resolved once, in absolute coordinates, when the
    // wind-up starts - so shoving something mid-swing left its marked squares
    // behind, and a long wind-up then landed a blow from a place its owner was
    // no longer standing in. Read as: the red tiles are somewhere over there,
    // and the thing hitting you is here.
    //
    // This does not break the rule at the top of ai.js. The shape and its
    // geometry relative to the attacker are untouched; only the attacker
    // moved, and the tiles follow it the way its own body did. It also makes
    // shoving a winding-up enemy do the obvious thing - the swing goes where
    // the swinger went, so pushing it off your square works.
    if (moved && e.attackTiles) {
      const ddx = dir.dx * moved, ddy = dir.dy * moved;
      e.attackTiles = e.attackTiles.map((t) => ({ x: t.x + ddx, y: t.y + ddy }));
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

  useSkill(key, dir, opts = {}) {
    // The two prepared slots ride the same path as a skill so that the button,
    // the drag gesture, the keyboard and the bot all have one way in.
    // Recovery burns the turn whatever you pressed, exactly as it does on the
    // movement path. Returning false here meant the skill buttons were simply
    // dead during a recovery - no turn passed, nothing happened - so the only
    // way to spend the turns you had already committed to was to discover that
    // the direction keys still worked. The bot found it as an infinite loop;
    // a player would have found it as an interface that had stopped
    // responding, which is worse.
    if (this.player.recovering) {
      this.msg(`You are still recovering. (${this.player.recover})`, 'warn');
      return true;
    }
    // Whatever you pressed, the swing you already committed to is what happens.
    // You cannot cancel it any more than a brute can cancel its overhead.
    if (this.player.charging && !opts.resolving) return this.resolveCharge();
    // And a charge already under way carries you whether or not this is where
    // you wanted to go.
    if (this.player.forced && !opts.forced) return this.resolveForced();
    if (typeof key === 'string' && key.startsWith('prep:')) return this.usePrepared(key.slice(5), dir);
    const p = this.player;
    const def = SKILL_BY_KEY[key];
    const slot = p.skill(key);
    if (!def || !slot) return false;
    // You can only use what you are holding. Checked here rather than only in
    // the UI, because the keyboard, the bot and a stale save all reach this
    // function without going past a button.
    if (!p.hasSkill(key)) { this.msg(`You are not holding anything that does that.`, 'warn'); return false; }
    if (slot.cd > 0 && !opts.resolving) { this.msg(`${def.name} is not ready.`, 'warn'); return false; }

    // Paid on the turn it was declared, so it is not re-priced on the turn it
    // lands. Charging this twice would refuse the blow *because* you had
    // already bought it, and the bar is usually below the price by then.
    const cost = p.costOf(key);
    // Some skills may be paid for in health. The soulbinder's big ones are the
    // reason it exists: her recovery is one a turn, so without a way to spend
    // something else she would simply stand still for ten turns to afford a
    // lance. Health is the only other pool she has, which is why armour is a
    // stamina reserve for her and for nobody else.
    let bleed = 0;
    if (!opts.resolving && !opts.forced && !p.canAfford(cost)) {
      if (!def.bleed) { this.msg(`Not enough stamina.`, 'warn'); return false; }
      bleed = cost - p.stamina;
      if (p.hp <= bleed) { this.msg('That would kill you.', 'warn'); return false; }
    }

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
      // Roll one tile or two, as asked. The exact landing tile is the whole
      // question now that packs draw overlapping telegraphs and bodies block
      // the diagonals - a fixed distance can only reach a ring, not a disc.
      const moved = this.dash(Math.min(p.rollDistance(), opts.steps ?? 99), dir);
      if (!moved) { this.msg('No room to roll.'); return false; }
      p.spend(cost);
      this.msg(`You roll ${moved} ${moved === 1 ? 'tile' : 'tiles'}.`);
      this.afterMove();
      return false;                    // <- does not advance the turn
    }

    // ---- wind-up: declare now, land next turn ----------------------------
    // The player has read every enemy's wind-up all game; this is the same
    // contract pointed the other way. Note what it costs that a recovery does
    // not: the blow has not happened yet, so it can be taken away from you -
    // by a hit, or simply by the target walking out of the lane.
    if (def.windup && !opts.resolving) {
      p.spend(cost);
      p.charging = {
        key, dx: dir.dx, dy: dir.dy,
        tiles: def.pattern ? attackTiles(p.x, p.y, dir.dx, dir.dy, def.pattern) : null,
      };
      this.msg(`You draw back for ${def.name}.`, 'warn');
      return true;                     // the declaration costs you the turn
    }

    if (!def.move && !def.defend) {
      this.fx.add({ kind: 'attack', uid: 0, x: p.x, y: p.y, dx: dir.dx, dy: dir.dy });
    }

    const m = p.mods(key);
    if (!opts.resolving && !opts.forced) {
      p.spend(cost);
      if (bleed > 0) {
        p.hp -= bleed;
        this.msg(`You spend ${bleed} of yourself.`, 'bad');
      }
    }

    // ---- a charge: goes out at once, and carries you again next turn ------
    if (def.rush) {
      this.playerRush(def, dir, m);
      if (def.forced && !opts.forced) {
        p.forced = { key, dx: dir.dx, dy: dir.dy, left: def.forced.times };
      }
      return true;
    }
    if (def.cooldown) slot.cd = Math.max(0, def.cooldown + m.cooldown);
    // Recovery is set AFTER the blow lands, and counts down in tick() - so the
    // turn you swung is yours and the turns after it are not.
    if (def.recovery) p.recover = def.recovery;

    if (def.ranged) {
      this.level.projectiles.push(makeProjectile({
        x: p.x, y: p.y, dx: dir.dx, dy: dir.dy,
        speed: def.projectile.speed, damage: def.damage + m.damage,
        impact: (def.impact ?? 0) + m.impact,
        glyph: def.projectile.glyph, colour: def.projectile.colour,
        fromPlayer: true, life: def.range + 2,
      }));
      this.msg('You hurl a knife.');
      return true;
    }

    if (def.dash) this.dash(def.dash, dir);

    const tiles = attackTiles(p.x, p.y, dir.dx, dir.dy, def.pattern);
    let hit = 0;
    let undone = 0;
    for (const e of this.bodiesIn(tiles)) {
      {
        const wasWindup = e.state === STATE.WINDUP;
        const poiseBefore = e.poiseLeft;
        this.hurtEnemy(e, def.damage + m.damage, true, (def.impact ?? 0) + m.impact);
        const push = (def.knock ?? 0) + m.knock;
        if (push && e.alive) this.knockBack(e, dir, push);
        hit++;
        if (def.disrupt && e.alive) undone += this.disrupt(e, def.disrupt, dir) ? 1 : 0;
        else if (wasWindup && e.alive) {
          if (e.poiseLeft === e.poise && poiseBefore !== e.poise) {
            this.msg(`You stagger the ${e.name}; its attack is delayed.`, 'good');
          } else {
            this.msg(`The ${e.name} shrugs it off and keeps winding up.`, 'warn');
          }
        }
      }
    }
    // A temporary affix is measured in hits that land, not turns that pass -
    // the same currency the consumables already count in, and a unit you can
    // plan around.
    if (hit) {
      const spent = p.wearAffix(key);
      if (spent) this.msg(`The ${AFFIX_BY_KEY[spent].name} wears off.`, 'warn');
      // Landing it feeds you. The soulbinder has almost no passive recovery,
      // so this is her whole engine: standing off and dodging is starving.
      if (def.refund) {
        const before = p.stamina;
        p.stamina = Math.min(p.staminaMax, p.stamina + def.refund);
        if (p.stamina > before) this.msg(`You draw ${p.stamina - before} back.`, 'good');
      }
    }
    this.animateTrail(tiles, '/', '#ffd75f');
    if (!hit) this.msg(`${def.name} hits nothing.`);
    return true;
  }

  /**
   * The player's charge: hit the ground ahead, move into it.
   *
   * Same idea as the horned one's, and deliberately not the same code path -
   * the bull telegraphs its whole route and resolves every stride at once,
   * while this goes out immediately and is spread across turns by `forced`.
   * Stopping at a wall is stopping, not damage: the blow still lands on
   * whatever was in the way.
   */
  playerRush(def, dir, m) {
    const p = this.player;
    const { advance } = def.rush;
    const nx = p.x + dir.dx * advance, ny = p.y + dir.dy * advance;
    const tiles = [];
    for (let i = 1; i <= advance; i++) tiles.push({ x: p.x + dir.dx * i, y: p.y + dir.dy * i });

    let hit = 0;
    for (const e of this.bodiesIn(tiles)) {
      this.hurtEnemy(e, def.damage + m.damage, true, (def.impact ?? 0) + m.impact);
      hit++;
    }
    this.animateTrail(tiles, '/', '#ffd75f');

    // Move as far along as the ground allows.
    let moved = 0;
    for (let i = 0; i < advance; i++) {
      const tx = p.x + dir.dx, ty = p.y + dir.dy;
      if (!this.level.passable(tx, ty)) break;
      if (this.level.enemyAt(tx, ty)) break;
      if (!this.level.diagonalOk(p.x, p.y, tx, ty)) break;
      p.x = tx; p.y = ty; moved++;
    }
    p.face(dir.dx, dir.dy);
    if (moved) this.afterMove();
    if (!moved) this.msg('You slam to a halt.', 'warn');
    else if (!hit) this.msg(`${def.name}!`);
    return hit;
  }

  /** Spend the turn on the charge you cannot stop. */
  resolveForced() {
    const p = this.player;
    const f = p.forced;
    if (!f) return false;
    f.left -= 1;
    const dir = { dx: f.dx, dy: f.dy };
    if (f.left <= 0) p.forced = null;
    this.useSkill(f.key, dir, { forced: true });
    return true;
  }

  /**
   * Take an attack away from something that was about to make it.
   *
   * The verb two of the heroes share, with different grammar. The knight's
   * version has to MOVE what it interrupts - turning a blade aside is the same
   * motion as shoving its owner off their line - so against anything that
   * cannot be pushed there is nothing to turn, and it fails. That makes his
   * signature useless against the largest things in the game, which is his
   * shape. The soulbinder simply unmakes the attack, so hers reaches what his
   * cannot.
   */
  disrupt(e, rule, dir) {
    if (e.state !== STATE.WINDUP) {
      this.msg(`The ${e.name} was not winding up.`);
      return false;
    }
    if (rule.needsPush) {
      if (e.immovable) {
        this.msg(`The ${e.name} does not move for you.`, 'warn');
        return false;
      }
      // Sideways, either way. The randomness is the price of the counter, and
      // it means the tile it ends on is not yours to choose.
      const side = this.rng.oneIn(2) ? 1 : -1;
      const away = { dx: -dir.dy * side, dy: dir.dx * side };
      const from = { x: e.x, y: e.y };
      if (!this.knockBack(e, away, rule.shove ?? 1)) {
        // Nothing to turn it into. A blade you cannot displace is a blade you
        // cannot turn aside - so the attack stands.
        this.msg(`The ${e.name} has nowhere to go; the blow comes anyway.`, 'warn');
        return false;
      }
      e.cancelAttack();
      this.msg(`You turn the ${e.name} aside.`, 'good');
      if (rule.advance) {
        const p = this.player;
        if (!this.level.occupant(from.x, from.y)) { p.x = from.x; p.y = from.y; this.afterMove(); }
      }
      return true;
    }
    e.cancelAttack();
    if (rule.stun) e.stun(rule.stun);
    this.msg(`The ${e.name}'s attack comes apart.`, 'good');
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
      // No `bodies` flag: a roll tumbles past them. It still respects terrain.
      if (!this.level.diagonalOk(p.x, p.y, nx, ny)) break;
      p.x = nx; p.y = ny; moved++;
    }
    return moved;
  }

  // -------------------------------------------------------- bonfire & floors

  /** How many things currently know where you are. */
  hunters() {
    return this.level ? this.level.livingEnemies().filter((e) => e.aware).length : 0;
  }

  rest() {
    const p = this.player;
    if (!isBonfire(this.level.at(p.x, p.y))) { this.msg('There is no bonfire here.'); return false; }
    // You cannot sit down while something is hunting you.
    //
    // Resting heals, refills stamina, refills charges AND puts every enemy on
    // the floor back on its spawn - so without this it is a reset button you
    // can press in the middle of a fight, and the obvious use is to un-stick a
    // bad position rather than to recover from one. Awareness decays once you
    // have been out of sight for a while, so breaking away is the way out, and
    // that makes disengaging a skill rather than a formality.
    const n = this.hunters();
    if (n > 0) {
      this.msg(`Something is still hunting you. (${n})`, 'warn');
      return false;
    }
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
    // The stair out of the hall is where a run begins. Choosing a hero is
    // therefore something you do by walking up to one, not by ticking a box -
    // and refusing here rather than defaulting means nobody starts a run as
    // somebody they did not pick.
    if (this.inHub) {
      if (!this.hero) { this.msg('先去跟他們其中一個說話。', 'warn'); return false; }
      this.inHub = false;
      this.newGame({ seed: this.pendingSeed, name: this.player.name, hero: this.hero.key });
      this.onRunStart?.(this);
      return true;
    }
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
    // Recorded before anything else, because everything else destroys the
    // scene: dropUnbanked, then respawnLevel rebuilds every floor, then the
    // player is teleported to a bonfire that may be on a different depth.
    // Particles drawn from the post-state would land on the wrong map at
    // coordinates that no longer mean anything - so this event carries a
    // `final` flag and the animator plays it as a screen effect rather than
    // as something happening on a tile.
    this.fx.add({ kind: 'die', uid: 0, x: p.x, y: p.y, final: true });
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
