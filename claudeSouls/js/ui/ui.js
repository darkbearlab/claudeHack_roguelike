// Input, HUD and prompts.
//
// The interesting part is the aiming gesture, which is the whole reason this
// game has its own UI layer instead of borrowing claudeHack's.
//
//   press a skill -> drag out from your character -> release to commit
//
// Both halves of that work as one continuous gesture *or* as two taps, because
// on a phone people do both without thinking about it. Pointer Events give
// touch, mouse and pen from one code path; `setPointerCapture` keeps the
// gesture alive when the finger leaves the button it started on; and
// `touch-action: none` on the canvas stops the browser stealing the drag for
// scrolling.
//
// Three things here exist only because a real thumb on a real phone hits them:
//
//   * **Releasing over the control bar cancels.** "Release commits" otherwise
//     leaves no way out of a gesture you have changed your mind about, and the
//     bar is where the finger came from - big, low, and impossible to miss.
//   * **`pointercancel` is handled.** An incoming call or a system edge-swipe
//     takes the pointer away; without this the game stays stuck in aim mode and
//     looks broken.
//   * **The aim readout is text, not just tiles.** A finger covers the tiles it
//     is pointing at, so the direction and cost are also written in the message
//     line where nothing is on top of them.

import { Renderer } from './render.js';
import { Animator } from './anim.js';
import { DIRS, DIR_BY_KEY, capitalise, fmtDuration } from '../../../engine/util.js';
import { SKILLS, SKILL_BY_KEY } from '../data/skills.js';
import { attackTiles, snapDir } from '../game/patterns.js';
import { DUNGEON_DEPTH } from '../map/mapgen.js';
import { T, isBonfire, isChest, isCorpse } from '../map/tiles.js';
import { SLOT, ITEM_BY_KEY, slotsFor, isConsumable, CONSUMABLE_BY_KEY } from '../data/items.js';
import { TRACKS, priceOf } from '../data/souls.js';
import { affixesOn, AFFIX_BY_KEY } from '../data/affixes.js';
import { TEXTURES } from '../data/textures.js';
import { saveSettings, loadSettings } from '../game/save.js';
import { HELP_HTML } from './help.js';

const AIM_DEADZONE = 18;     // CSS px before a drag counts as a direction

export class UI {
  constructor(game) {
    this.game = game;
    game.ui = this;

    this.el = {
      canvas:   document.getElementById('map'),
      overlay:  document.getElementById('overlay'),
      msg:      document.getElementById('msglines'),
      hpbar:    document.getElementById('hpbar'),
      stbar:    document.getElementById('stbar'),
      status:   document.getElementById('statusline'),
      skills:   document.getElementById('skillbar'),
      pad:      document.getElementById('pad'),
      action:   null,     // built with the skill bar
      controls: document.getElementById('controls'),
      splash:   document.getElementById('splash'),
      flash:    document.getElementById('flash'),
    };

    this.renderer = new Renderer(this.el.canvas, game);

    // The show. It only ever redraws - it cannot change the game, which has
    // already finished resolving by the time it starts.
    this.anim = new Animator(() => this.renderer.draw());
    this.renderer.anim = this.anim;
    game.fx.enabled = true;          // the bot and the tests leave this off
    this.settings = loadSettings();
    this.renderer.mode = this.settings.mode ?? 'tiles';
    this.renderer.zoom = this.settings.zoom ?? 1;
    this.applyTexture(this.settings.texture ?? 'grain');

    this.pending = null;
    this.recent = [];
    this.aimSkill = null;     // armed skill key
    this.aimDir = null;
    this.gesture = null;

    this.buildSkillBar();
    this.bindKeys();
    this.bindPointer();
    this.bindButtons();
    window.addEventListener('resize', () => { this.renderer.resize(); this.render(); });
    if (window.visualViewport) {
      visualViewport.addEventListener('resize', () => { this.renderer.resize(); this.render(); });
    }
  }

  // =========================================================================
  // keyboard
  // =========================================================================

  bindKeys() {
    window.addEventListener('keydown', (ev) => {
      if (!this.el.splash.hidden) return;
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
      const key = normaliseKey(ev);
      if (key === null) return;
      if (ev.metaKey || (ev.ctrlKey && key !== 'C-p')) return;
      ev.preventDefault();
      this.feed(key);
    }, { passive: false });
  }

  feed(key) {
    if (this.pending) { this.pending.onKey(key); return; }
    if (!this.game.running) return;
    // Any input snaps the previous turn's show to its end and is served
    // immediately. The animation must never cost you a turn of reaction time -
    // people hold a direction down in this game, and 300ms of swallowed input
    // per step would be worse than having no animation at all.
    this.anim.skip();
    this.game.command(key).then(() => this.afterTurn());
  }

  /**
   * Hand the turn's events to the animator.
   *
   * Called after the rules have completely finished. `take()` empties the log,
   * so nothing can be played twice and nothing accumulates.
   */
  afterTurn() {
    const events = this.game.fx.take();
    this.render();
    if (events.length) this.anim.play(events);
  }

  // =========================================================================
  // the aiming gesture
  // =========================================================================

  /**
   * The nine buttons, in a fixed 3x3.
   *
   * Fixed is the point. Which skills you have changes every time you swap a
   * weapon, and a grid that reflows under your thumb every time you draw a
   * different sword is worse than one with a greyed-out hole in it. So the
   * layout is positional and empty slots stay where they are:
   *
   *     main-primary   main-secondary   off-primary
   *     magic          item             block
   *     roll           interact         pack
   *
   * Roll sits bottom-left, nearest the thumb coming across from the d-pad,
   * because it is the button you press when something has gone wrong.
   */
  buttonLayout() {
    const p = this.game.player;
    const main = p?.item(SLOT.MAIN) ?? null;
    const off = p?.item(SLOT.OFF) ?? null;
    const offIsWeapon = off && off.kind === 'weapon';
    // A hero's three verbs sit in the three combat slots. The positions are
    // fixed either way - which is the point of the grid - so the bar reads the
    // same whether the skills came from a person or from what is in your hands.
    const own = p?.hero?.skills ?? null;
    return [
      { kind: 'skill', key: own ? own[0] : (main ? main.primary : null), label: 'Main' },
      { kind: 'skill', key: own ? own[1] : (main ? main.secondary : null), label: 'Main 2' },
      { kind: 'skill', key: own ? own[2] : (offIsWeapon ? off.primary : null), label: 'Off' },
      { kind: 'prep', slot: 'magic', label: 'Magic' },
      { kind: 'prep', slot: 'item', label: 'Item' },
      { kind: 'skill', key: p?.shield ? 'block' : null, label: 'Block' },
      { kind: 'skill', key: 'roll', label: 'Roll' },
      { kind: 'action' },
      { kind: 'pack' },
    ];
  }

  /**
   * A cheap signature, so the bar is rebuilt only when it actually changed.
   *
   * The shield's arc is in here even though it does not change which buttons
   * exist, because it changes what one of them is *drawn as* - swapping a
   * buckler for a tower shield left the block button still showing a
   * one-direction guard.
   */
  layoutSignature() {
    const arc = this.game.player?.shield?.block?.arc ?? 0;
    const who = this.game.player?.hero?.key ?? '-';
    const prep = ['item', 'magic'].map((k) => this.game.player?.prep?.[k] ?? '-').join(',');
    return this.buttonLayout().map((c) => `${c.kind}:${c.key ?? c.label ?? ''}`).join('|') +
           `#${arc}#${prep}#${who}`;
  }

  buildSkillBar() {
    const bar = this.el.skills;
    const p = this.game.player;
    bar.innerHTML = '';
    this.el.action = null;

    this.buttonLayout().forEach((cell, i) => {
      if (cell.kind === 'skill' && cell.key) {
        const def = SKILL_BY_KEY[cell.key];
        const b = document.createElement('button');
        b.className = 'skill';
        b.dataset.skill = cell.key;
        b.title = def.hint ?? '';
        b.innerHTML = `<span class="num">${i + 1}</span>${skillIcon(def, p?.shield?.block?.arc ?? 1)}` +
                      `<span class="nm">${escapeHtml(def.name)}</span>` +
                      `<span class="cost"></span><span class="cd"></span>` +
                      // Commitment has to be on the button. Nine of the twenty-six
                      // skills now leave you unable to act - including some
                      // *primaries*, which is what you use by walking into
                      // something - and a cost you only discover by paying it is
                      // not a decision, it is a trap.
                      ((def.windup || def.recovery)
                        ? `<span class="rec" title="${def.windup ? `前搖 ${def.windup} 回合(下回合才命中,期間被打中會被打斷) ` : ''}` +
                          `${def.recovery ? `收招 ${def.recovery} 回合` : ''}:期間不能行動、不能翻滾、不回精力">` +
                          // Hollow before the blow, solid after. Same budget,
                          // different gamble - and the hollow half is the one
                          // that can be taken away from you.
                          `${'○'.repeat(def.windup ?? 0)}${'●'.repeat(def.recovery ?? 0)}</span>`
                        : '');
        b.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          this.startGesture(ev, cell.key, b);
        });
        bar.appendChild(b);
        return;
      }

      if (cell.kind === 'prep') {
        const c = p?.prepared(cell.slot) ?? null;
        const b = document.createElement('button');
        b.className = c ? 'skill prep' : 'skill empty';
        b.disabled = !c;
        b.dataset.prep = cell.slot;
        if (c) {
          b.title = c.desc ?? '';
          b.innerHTML = `<span class="num">${i + 1}</span>` +
                        `<span class="nm">${escapeHtml(c.name)}</span>` +
                        `<span class="cost"></span><span class="cd"></span>`;
          if (c.directional) {
            // Directional ones are aimed like any other skill: press, drag out,
            // release. Keeping one gesture for everything is why there is no
            // separate targeting mode to learn.
            b.addEventListener('pointerdown', (ev) => {
              ev.preventDefault();
              this.startGesture(ev, `prep:${cell.slot}`, b);
            });
          } else {
            b.addEventListener('click', (ev) => {
              ev.preventDefault();
              if (this.game.usePrepared(cell.slot, null)) this.feed('.');
            });
          }
        } else {
          b.innerHTML = `<span class="num">${i + 1}</span>` +
                        `<span class="nm">${escapeHtml(cell.label)}</span>`;
        }
        bar.appendChild(b);
        return;
      }

      if (cell.kind === 'action') {
        const act = document.createElement('button');
        act.id = 'btn-action';
        act.className = 'skill action';
        act.innerHTML = '<span class="act-name"></span><span class="act-sub"></span>';
        act.addEventListener('click', (ev) => {
          ev.preventDefault();
          const a = this.contextAction();
          if (!a.cmd) return;
          if (a.cmd === 'FIRE') { this.showBonfire(); return; }
          if (a.kind === 'cancel') {
            this.clearAim();
            this.feed('Escape');
            return;
          }
          this.feed(a.cmd);
        });
        bar.appendChild(act);
        this.el.action = act;
        return;
      }

      if (cell.kind === 'pack') {
        const b = document.createElement('button');
        b.className = 'skill action is-pack';
        b.innerHTML = '<span class="act-name">Pack</span><span class="act-sub"></span>';
        b.addEventListener('click', (ev) => { ev.preventDefault(); this.showPack(); });
        bar.appendChild(b);
        return;
      }

      const b = document.createElement('button');
      b.className = 'skill empty';
      b.disabled = true;
      b.innerHTML = `<span class="num">${i + 1}</span>` +
                    `<span class="nm">${escapeHtml(cell.label ?? '')}</span>`;
      bar.appendChild(b);
    });

    this.builtSignature = this.layoutSignature();
  }

  /**
   * What the one context button does right now.
   *
   * Descending and resting can never both apply - you are standing on a
   * staircase or on a bonfire, never on both - which is what makes one button
   * honest rather than a mode. Cancelling an aim joins them for the same
   * reason: while a skill is armed you are not descending anywhere.
   *
   * New verbs go in this list. The only rule is the one that earns the button:
   * no two entries may be available at the same time.
   */
  contextAction() {
    const g = this.game;
    if (!g.running || !g.level) return { name: '—', cmd: null };
    if (this.aimSkill || g.aiming) {
      return { name: 'Cancel', sub: 'aiming', cmd: 'ESC', kind: 'cancel' };
    }
    const p = g.player;
    const here = g.level.at(p.x, p.y);
    if (isChest(here)) {
      return { name: 'Open', sub: 'chest', cmd: 'g', kind: 'take' };
    }
    if (isCorpse(here)) {
      const n = g.corpse?.items?.length ?? 0;
      return { name: 'Take back', sub: `${n} item${n === 1 ? '' : 's'}`, cmd: 'g', kind: 'take' };
    }
    if (isBonfire(here)) {
      // Say WHY it is unavailable. A button that silently refuses is a bug as
      // far as the player is concerned, and "something is still hunting you" is
      // information they can act on.
      const n = g.hunters();
      if (n > 0) return { name: 'Hunted', sub: `${n} aware`, cmd: null, kind: 'blocked' };
      return { name: 'Bonfire', sub: `${p.souls} souls`, cmd: 'FIRE', kind: 'rest' };
    }
    if (here === T.STAIRS_DOWN) {
      return { name: 'Descend', sub: `to ${p.depth + 1}`, cmd: '>', kind: 'descend' };
    }
    return { name: '—', sub: '', cmd: null };
  }

  renderAction() {
    const el = this.el.action;
    if (!el) return;
    const a = this.contextAction();
    el.querySelector('.act-name').textContent = a.name;
    el.querySelector('.act-sub').textContent = a.sub ?? '';
    el.disabled = !a.cmd;
    el.classList.toggle('idle', !a.cmd);
    for (const k of ['cancel', 'rest', 'descend', 'take', 'blocked'])
      el.classList.toggle(`is-${k}`, a.kind === k);
  }

  /** A skill, or one of the two prepared slots dressed up as one. */
  skillDef(key) {
    if (typeof key === 'string' && key.startsWith('prep:')) {
      return this.game.player?.prepared(key.slice(5)) ?? null;
    }
    return SKILL_BY_KEY[key] ?? null;
  }

  startGesture(ev, skillKey, fromEl) {
    if (!this.game.running || this.game.busy) return;
    if (this.game.player.recovering) {
      this.pushMessage(`Still recovering (${this.game.player.recover}).`, 'warn');
      return;
    }
    const def = this.skillDef(skillKey);
    if (!def) return;
    const slot = this.game.player.skill(skillKey);
    if (slot && slot.cd > 0) { this.pushMessage(`${def.name} is not ready (${slot.cd}).`, 'warn'); return; }
    if (skillKey.startsWith('prep:') && this.game.player.chargesOf(def.key) <= 0) {
      this.pushMessage(`The ${def.name} is spent.`, 'warn'); return;
    }
    const cost = this.game.player.costOf(skillKey);
    if (this.game.player.stamina < cost) {
      this.pushMessage(`Not enough stamina for ${def.name}.`, 'warn');
      return;
    }

    this.aimSkill = skillKey;
    this.aimDir = null;
    this.gesture = {
      id: ev.pointerId, from: fromEl,
      startX: ev.clientX, startY: ev.clientY,
      moved: false, fromSkillBar: !!fromEl,
    };
    try { (fromEl ?? this.el.canvas).setPointerCapture(ev.pointerId); } catch { /* not fatal */ }
    this.updateAim(ev.clientX, ev.clientY);
    this.renderSkillBar();
  }

  bindPointer() {
    const c = this.el.canvas;

    c.addEventListener('pointerdown', (ev) => {
      if (!this.game.running) return;
      ev.preventDefault();
      if (this.aimSkill) {
        // Already armed by a tap on the skill; this press starts the aim drag.
        this.gesture = {
          id: ev.pointerId, from: null,
          startX: ev.clientX, startY: ev.clientY, moved: false, fromSkillBar: false,
        };
        try { c.setPointerCapture(ev.pointerId); } catch { /* not fatal */ }
        this.updateAim(ev.clientX, ev.clientY);
        return;
      }
      this.tapStart = { x: ev.clientX, y: ev.clientY, t: Date.now() };
    });

    const move = (ev) => {
      if (!this.gesture || ev.pointerId !== this.gesture.id) return;
      const d = Math.hypot(ev.clientX - this.gesture.startX, ev.clientY - this.gesture.startY);
      if (d > 6) this.gesture.moved = true;
      this.updateAim(ev.clientX, ev.clientY);
    };
    c.addEventListener('pointermove', move);
    window.addEventListener('pointermove', move);

    const up = (ev) => {
      if (this.gesture && ev.pointerId === this.gesture.id) { this.endGesture(ev); return; }
      if (!this.tapStart) return;
      const dx = ev.clientX - this.tapStart.x, dy = ev.clientY - this.tapStart.y;
      const quick = Date.now() - this.tapStart.t < 700;
      this.tapStart = null;
      if (!quick) return;
      if (Math.hypot(dx, dy) > 26) {
        // A swipe on the map with nothing armed is a step.
        const k = ['h', 'b', 'j', 'n', 'l', 'u', 'k', 'y', 'h'][Math.round((Math.atan2(dy, dx) / Math.PI) * 4) + 4];
        this.feed(k);
        return;
      }
      this.onMapTap(ev);
    };
    c.addEventListener('pointerup', up);
    window.addEventListener('pointerup', up);

    // The pointer can be taken away by the OS mid-gesture. If that is not
    // handled the game sits in aim mode forever and looks broken.
    const cancel = (ev) => {
      if (this.gesture && ev.pointerId === this.gesture.id) this.abortAim('interrupted');
      this.tapStart = null;
    };
    c.addEventListener('pointercancel', cancel);
    window.addEventListener('pointercancel', cancel);
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  /** Direction from the player's tile to the finger, snapped to eight ways. */
  updateAim(clientX, clientY) {
    if (!this.aimSkill) return;
    const rect = this.el.canvas.getBoundingClientRect();
    const p = this.game.player;
    const c = this.renderer.cellCentre(p.x, p.y);
    const dx = (clientX - rect.left) - c.x;
    const dy = (clientY - rect.top) - c.y;

    if (Math.hypot(dx, dy) < AIM_DEADZONE) {
      this.aimDir = null;
      this.renderer.aim = null;
      this.renderMessages(`${this.skillDef(this.aimSkill).name}: drag away from yourself to aim.`);
      this.render();
      return;
    }

    const dir = snapDir(dx, dy);
    const changed = !this.aimDir || this.aimDir.dx !== dir.dx || this.aimDir.dy !== dir.dy;
    this.aimDir = dir;

    // How far you drag chooses how far you roll.
    //
    // A fixed-distance roll can only reach a ring, not a disc - and the game
    // has spent the last few rounds making the exact tile you land on the
    // question: packs draw overlapping telegraphs with a gap somewhere in them,
    // and bodies now block the diagonal you used to slip out through. Being
    // unable to say "one tile, not two" meant half the tiles you might want
    // were simply unreachable. Difficulty should come from the puzzle being
    // hard, not from the controls being too coarse to express the answer.
    const def = this.skillDef(this.aimSkill);
    const far = Math.hypot(dx, dy);
    const cell = this.renderer.viewport().cell / this.renderer.dpr;
    const wanted = def?.move && far < cell * 1.5 ? 1 : 99;
    const changedDist = this.aimDist !== wanted;
    this.aimDist = wanted;
    if ((changed || changedDist) && navigator.vibrate) {
      try { navigator.vibrate(8); } catch { /* ignore */ }
    }

    this.renderer.aim = { dir, tiles: this.previewTiles(this.aimSkill, dir, wanted) };
    const cost = this.game.player.costOf(this.aimSkill);
    const steps = this.renderer.aim.tiles.length;
    // The readout goes in the message line because a finger covers the tiles.
    this.renderMessages(`${def.name} → ${dirName(dir)}` +
      `${def.move ? ` ${steps} tile${steps === 1 ? '' : 's'}` : ''}` +
      `   (${cost} stamina${def.advancesTurn === false ? ', free turn' : ''})   release to commit`);
    this.render();
  }

  previewTiles(key, dir, maxSteps = 99) {
    const def = this.skillDef(key);
    const p = this.game.player;
    const lvl = this.game.level;
    if (!def) return [];

    if (def.ranged || def.projectile) {
      const out = [];
      let x = p.x, y = p.y;
      for (let i = 0; i < def.range; i++) {
        x += dir.dx; y += dir.dy;
        if (!lvl.flyable(x, y)) break;
        out.push({ x, y });
        if (lvl.enemyAt(x, y)) break;
      }
      return out;
    }

    if (def.move) {
      const out = [];
      let x = p.x, y = p.y;
      for (let i = 0; i < Math.min(p.rollDistance(), maxSteps); i++) {
        const nx = x + dir.dx, ny = y + dir.dy;
        if (!lvl.passable(nx, ny) || lvl.enemyAt(nx, ny) || !lvl.diagonalOk(x, y, nx, ny)) break;
        x = nx; y = ny;
        out.push({ x, y });
      }
      return out;
    }

    // A lunge moves first, so the preview has to show where it will hit *from*.
    let ox = p.x, oy = p.y;
    if (def.dash) {
      for (let i = 0; i < def.dash; i++) {
        const nx = ox + dir.dx, ny = oy + dir.dy;
        if (!lvl.passable(nx, ny) || lvl.enemyAt(nx, ny)) break;
        ox = nx; oy = ny;
      }
    }
    return attackTiles(ox, oy, dir.dx, dir.dy, def.pattern);
  }

  endGesture(ev) {
    const g = this.gesture;
    this.gesture = null;
    const skill = this.aimSkill;
    if (!skill) return;

    // Released over the controls? That is the cancel target.
    const overControls = this.el.controls.contains(document.elementFromPoint(ev.clientX, ev.clientY));
    if (overControls && g.moved) { this.abortAim('cancelled'); return; }

    // A quick tap on the skill button arms it and waits for a second gesture.
    if (g.fromSkillBar && !g.moved) {
      this.renderMessages(`${this.skillDef(skill).name}: drag out from yourself, or press a direction key.`);
      this.render();
      return;
    }

    if (!this.aimDir) { this.abortAim('no direction'); return; }
    const dir = this.aimDir;
    this.clearAim();
    this.game.busy = false;
    this.commit(skill, dir);
  }

  commit(skillKey, dir, steps = this.aimDist ?? 99) {
    if (!this.game.running || this.game.busy) return;
    this.anim.skip();
    this.game.busy = true;
    this.game.fx.clear();
    this.game.fx.begin(0, this.game);
    Promise.resolve(this.game.useSkill(skillKey, dir, { steps }))
      .then((spent) => {
        this.game.fx.end(this.game);
        if (spent && this.game.running) this.game.worldTurn();
      })
      .catch((e) => { console.error(e); this.game.msg(`(error: ${e.message})`, 'bad'); })
      .finally(() => { this.game.busy = false; this.afterTurn(); });
  }

  abortAim(why) {
    this.clearAim();
    if (why) this.pushMessage(`(${why})`);
    this.render();
  }

  clearAim() {
    this.aimSkill = null;
    this.aimDir = null;
    this.aimDist = 99;
    this.gesture = null;
    this.renderer.aim = null;
    this.renderSkillBar();
    this.renderMessages();
  }

  onMapTap(ev) {
    if (!this.game.running || this.game.busy) return;
    const rect = this.el.canvas.getBoundingClientRect();
    const cell = this.renderer.cellAt(ev.clientX - rect.left, ev.clientY - rect.top);
    const p = this.game.player;
    const dx = cell.x - p.x, dy = cell.y - p.y;
    if (!dx && !dy) { this.feed('.'); return; }
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
      const d = DIRS.find((q) => q.dx === dx && q.dy === dy);
      if (d) this.feed(d.key);
      return;
    }
    // A distant tap is a look, not a travel: in this game walking somewhere
    // without watching is how you die.
    this.game.msg(this.describe(cell.x, cell.y));
  }

  describe(x, y) {
    const lvl = this.game.level;
    if (!lvl.isSeen(x, y)) return 'You have not seen there.';
    const e = lvl.enemyAt(x, y);
    if (e && e.alive && lvl.isVisible(x, y)) {
      return `${e.name}: ${e.hp}/${e.hpMax} hp, ${e.stamina}/${e.staminaMax} stamina` +
             (e.state === 'windup' ? `, winding up ${e.attack?.name} (${e.timer})` :
              e.state === 'recover' ? ', recovering' :
              e.state === 'resting' ? ', winded' : '');
    }
    return lvl.describeTile(x, y);
  }

  // =========================================================================
  // buttons
  // =========================================================================

  bindButtons() {
    for (const b of this.el.pad.querySelectorAll('button')) {
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        const cmd = b.dataset.cmd;
        if (this.aimSkill && DIR_BY_KEY[cmd]) {
          const d = DIR_BY_KEY[cmd];
          const skill = this.aimSkill;
          this.clearAim();
          // Keyboard and d-pad: a plain direction rolls the full distance,
          // shift rolls one tile. The drag gesture has the finer control; this
          // just needs the choice to exist at all.
          this.commit(skill, { dx: d.dx, dy: d.dy }, ev.shiftKey ? 1 : 99);
          return;
        }
        this.feed(cmd === 'ESC' ? 'Escape' : cmd);
      });
    }
    document.getElementById('btn-mode').addEventListener('click', () => {
      this.renderer.mode = this.renderer.mode === 'tiles' ? 'ascii' : 'tiles';
      document.getElementById('btn-mode').textContent = this.renderer.mode === 'tiles' ? 'Tiles' : 'ASCII';
      this.settings.mode = this.renderer.mode; saveSettings(this.settings);
      this.render();
    });
    document.getElementById('btn-zoom').addEventListener('click', () => {
      const steps = [0.75, 0.9, 1, 1.2, 1.5];
      this.renderer.zoom = steps[(steps.indexOf(this.renderer.zoom) + 1) % steps.length];
      this.settings.zoom = this.renderer.zoom; saveSettings(this.settings);
      this.render();
    });
    document.getElementById('btn-help').addEventListener('click', () => this.showHelp());
    document.getElementById('btn-save').addEventListener('click', () => this.feed('S'));
  }

  // =========================================================================
  // rendering the frame
  // =========================================================================

  pushMessage(text, cls) {
    this.recent.push({ text, cls });
    if (this.recent.length > 40) this.recent.shift();
    this.renderMessages();
  }

  renderMessages(prompt = null) {
    const max = window.innerWidth <= 560 || window.innerHeight <= 560 ? 2 : 3;
    const html = [];
    if (prompt) html.push(`<div class="aim">${escapeHtml(prompt)}</div>`);
    for (const m of this.recent.slice(-(prompt ? max - 1 : max))) {
      html.push(`<div class="${m.cls ? 'm-' + m.cls : ''}">${escapeHtml(m.text)}</div>`);
    }
    this.el.msg.innerHTML = html.join('');
  }

  render() {
    this.renderer.draw();
    this.renderBars();
    this.renderSkillBar();
    this.renderAction();
  }

  /**
   * Health as pips, stamina as a bar.
   *
   * Pips because health is small and countable and "how many hits can I take"
   * must be answerable at a glance; a continuous bar hides exactly that.
   */
  renderBars() {
    const p = this.game.player;
    if (!p) return;
    let hp = '';
    for (let i = 0; i < p.hpMax; i++) hp += `<i class="${i < p.hp ? 'on' : ''}"></i>`;
    this.el.hpbar.innerHTML = hp;

    const frac = p.stamina / p.staminaMax;
    const rollCost = p.rollCost();
    this.el.stbar.innerHTML =
      `<span class="fill${p.stamina < rollCost ? ' low' : ''}" style="width:${frac * 100}%"></span>` +
      `<span class="mark" style="left:${(rollCost / p.staminaMax) * 100}%"></span>`;

    const lvl = this.game.level;
    const alive = lvl ? lvl.livingEnemies().length : 0;

    // The hall is not a floor and has no clock. Showing "Floor 0/10" and a
    // turn counter there says the run has started, which is the one thing the
    // room is for denying.
    if (this.game.inHub) {
      this.el.status.innerHTML =
        `<span class="lo">${escapeHtml(lvl?.name ?? '')}</span>` +
        (this.game.hero
          ? `　<b>${escapeHtml(this.game.hero.name)}</b>`
          : `　<span class="lo">尚未選擇</span>`);
      return;
    }

    this.el.status.innerHTML =
      `<span class="lo">Floor</span> <b>${p.depth}</b>/${DUNGEON_DEPTH}` +
      `　<span class="lo">Souls</span> <b>${p.souls}</b>` +
      `<span class="roomy">　<span class="lo">Foes</span> <b>${alive}</b></span>` +
      // Deaths and turn count are how a run reads afterwards, not how it is
      // played. On a phone the line is one ellipsis away from hiding the floor
      // number, so the retrospective half steps aside.
      `<span class="roomy">　<span class="lo">Deaths</span> <b>${p.deaths}</b>` +
      `　<span class="lo">T</span> ${this.game.turn}</span>`;
  }

  renderSkillBar() {
    const p = this.game.player;
    if (!p) return;
    // Swapping a weapon changes which buttons exist, and the bar is built once.
    if (this.layoutSignature() !== this.builtSignature) this.buildSkillBar();
    const stuck = p.recovering;
    this.el.skills.classList.toggle('recovering', stuck);

    for (const b of this.el.skills.querySelectorAll('.skill[data-prep]')) {
      const c = p.prepared(b.dataset.prep);
      if (!c) continue;
      const left = p.chargesOf(c.key);
      b.querySelector('.cost').textContent = c.stamina ? `${c.stamina}` : '';
      b.querySelector('.cd').textContent = `${left}`;
      b.classList.toggle('cooling', left <= 0);
      b.classList.toggle('poor', !!c.stamina && p.stamina < c.stamina);
      b.classList.toggle('armed', this.aimSkill === `prep:${b.dataset.prep}`);
      b.disabled = left <= 0;
    }

    for (const b of this.el.skills.querySelectorAll('.skill[data-skill]')) {
      const key = b.dataset.skill;
      const def = SKILL_BY_KEY[key];
      const slot = p.skill(key);
      const cost = p.costOf(key);
      b.querySelector('.cost').textContent = `${cost}`;
      b.querySelector('.cd').textContent = slot && slot.cd > 0 ? slot.cd : '';
      b.classList.toggle('cooling', !!slot && slot.cd > 0);
      b.classList.toggle('poor', p.stamina < cost);
      b.classList.toggle('armed', this.aimSkill === key);
    }
  }

  animateTrail(cells, glyph, colour) {
    if (!cells?.length) return;
    this.renderer.overlayTrail = { cells, glyph, colour };
    this.renderer.draw();
    setTimeout(() => { this.renderer.overlayTrail = null; this.renderer.draw(); }, 110);
  }

  /** A red wash on death, so it is unmistakable that the run reset. */
  onDeath() {
    const f = this.el.flash;
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }


  // =========================================================================
  // the pack
  // =========================================================================

  /**
   * Looking is free; changing something costs a turn.
   *
   * That split matters. If opening the pack cost a turn the game would be
   * punishing you for checking what you are carrying, which teaches people to
   * memorise a menu instead of reading it. The turn is charged on the swap,
   * which is the decision worth pricing.
   */
  showPack() {
    if (!this.game.running || this.game.busy) return;
    const p = this.game.player;
    const ov = this.el.overlay;
    ov.hidden = false;

    // Every affix says where it came from. That is the whole design of the three
    // slots - a player reading a weapon should know which part of it is the
    // weapon, which part they put there, and which part is about to run out.
    const SLOT_LABEL = { innate: '天生', granted: '後天', temp: '暫時' };
    const affixLine = (it) => {
      if (!it) return '';
      const on = affixesOn(it, p.affix[it.key]);
      if (!on.length) return '';
      return '<br>' + on.map((a) => {
        const name = escapeHtml(AFFIX_BY_KEY[a.key].name);
        const left = a.hits ? `×${a.hits}` : '';
        return `<span class="af af-${a.slot}">${SLOT_LABEL[a.slot]} ${name}${left}</span>`;
      }).join(' ');
    };

    const worn = (slot, label) => {
      const it = p.item(slot);
      return `<tr><td class="key">${label}</td>` +
             `<td>${it ? escapeHtml(it.name) + affixLine(it) : '<i>空</i>'}</td>` +
             `<td>${it ? `<button class="btn" data-off="${slot}">取下</button>` : ''}</td></tr>`;
    };

    const readied = (kind, label) => {
      const c = p.prepared(kind);
      return `<tr><td class="key">${label}</td>` +
             `<td>${c ? `${escapeHtml(c.name)} <span class="dim">(${p.chargesOf(c.key)})</span>` : '<i>空</i>'}</td>` +
             `<td>${c ? `<button class="btn" data-unprep="${kind}">收起</button>` : ''}</td></tr>`;
    };

    const rows = p.pack.length
      ? p.pack.map((k, i) => {
          if (isConsumable(k)) {
            const c = CONSUMABLE_BY_KEY[k];
            return `<tr><td class="key">${i + 1}</td><td>${escapeHtml(c.name)}<br>` +
                   `<span class="dim">${escapeHtml(c.desc ?? '')}</span></td>` +
                   `<td><button class="btn" data-prepare="${c.kind}" data-item="${escapeHtml(k)}">` +
                   `${c.kind === 'magic' ? '記憶' : '備用'}</button></td></tr>`;
          }
          const it = ITEM_BY_KEY[k];
          if (!it) return '';
          const where = slotsFor(it).map((sl) =>
            `<button class="btn" data-on="${sl}" data-item="${escapeHtml(k)}">` +
            `${sl === SLOT.ARMOUR ? '穿上' : sl === SLOT.MAIN ? '主手' : '副手'}</button>`).join(' ');
          return `<tr><td class="key">${i + 1}</td><td>${escapeHtml(it.name)}${affixLine(it)}<br>` +
                 `<span class="dim">${escapeHtml(it.desc ?? '')}</span></td><td>${where}</td></tr>`;
        }).join('')
      : '<tr><td colspan="3"><i>背包是空的。</i></td></tr>';

    ov.innerHTML = `<h2>背包</h2>
      <p>看是免費的。<b>換裝會推進一個回合</b>——所以帶第二把武器是計畫,不是選單。</p>
      <table>${worn(SLOT.MAIN, '主手')}${worn(SLOT.OFF, '副手')}${worn(SLOT.ARMOUR, '防具')}
      ${readied('magic', '記憶')}${readied('item', '備用')}</table>
      <h2>攜帶</h2>
      <table>${rows}</table>
      <div class="foot"><button class="btn" data-act="close">關閉 (Esc)</button></div>`;

    const close = () => this.closeOverlay();
    const swap = (slot, key) => {
      if (!this.game.equipFromPack(slot, key)) { this.showPack(); return; }
      close();
      this.feed('.');                 // the swap is what spends the turn
    };
    ov.querySelector('[data-act="close"]').addEventListener('click', close);
    for (const b of ov.querySelectorAll('[data-on]')) {
      b.addEventListener('click', () => swap(b.dataset.on, b.dataset.item));
    }
    for (const b of ov.querySelectorAll('[data-off]')) {
      b.addEventListener('click', () => swap(b.dataset.off, null));
    }
    const ready = (kind, key) => {
      if (!this.game.prepareFromPack(kind, key)) { this.showPack(); return; }
      close();
      this.feed('.');
    };
    for (const b of ov.querySelectorAll('[data-prepare]')) {
      b.addEventListener('click', () => ready(b.dataset.prepare, b.dataset.item));
    }
    for (const b of ov.querySelectorAll('[data-unprep]')) {
      b.addEventListener('click', () => ready(b.dataset.unprep, null));
    }
    ov.scrollTop = 0;
    this.pending = { onKey: () => close() };
  }


  /**
   * The fire: rest, and spend what you carried here.
   *
   * Spending lives behind the fire rather than on a button of its own because
   * that is the whole mechanic - souls are worth nothing until you have walked
   * them home, and until then they are what you lose. Putting the shop anywhere
   * else would quietly delete the decision.
   */
  showBonfire() {
    if (!this.game.running || this.game.busy) return;
    const g = this.game;
    const p = g.player;
    const ov = this.el.overlay;
    ov.hidden = false;

    const rows = TRACKS.map((t) => {
      const rank = p.ranks[t.key] ?? 0;
      const price = priceOf(p.ranks, t.key);
      const pips = '●'.repeat(rank) + '○'.repeat(t.max - rank);
      const btn = price === null
        ? '<span class="dim">滿了</span>'
        : `<button class="btn" data-buy="${t.key}"${p.souls < price ? ' disabled' : ''}>${price}</button>`;
      return `<tr><td class="key">${escapeHtml(t.name)}</td>` +
             `<td>${pips}<br><span class="dim">${escapeHtml(t.hint)}</span></td>` +
             `<td>${btn}</td></tr>`;
    }).join('');

    const hunted = g.hunters();
    ov.innerHTML = `<h2>篝火</h2>
      <p>身上的魂:<b>${p.souls}</b>。<b>死了會掉在原地</b>,只有走回火邊才算數。</p>
      <table>${rows}</table>
      <div class="foot">
        ${hunted
          ? `<span class="dim">還有 ${hunted} 個東西在找你,不能休息。</span>`
          : '<button class="btn" data-act="rest">休息(回滿,敵人復活)</button>'}
        <button class="btn" data-act="close">關閉 (Esc)</button>
      </div>`;

    const close = () => this.closeOverlay();
    ov.querySelector('[data-act="close"]').addEventListener('click', close);
    ov.querySelector('[data-act="rest"]')?.addEventListener('click', () => {
      close();
      this.feed('e');
    });
    for (const b of ov.querySelectorAll('[data-buy]')) {
      b.addEventListener('click', () => {
        g.buyRank(b.dataset.buy);
        this.render();          // the button behind the overlay shows the total too
        this.showBonfire();
      });
    }
    ov.scrollTop = 0;
    this.pending = { onKey: () => close() };
  }


  /**
   * Which surface the panels wear.
   *
   * The class goes on <body> and the CSS decides what that means, so the whole
   * set can be swapped while looking at it - which is what having alternatives
   * is for. 'none' is the absence of a class rather than a class of its own, so
   * "off" is exactly what the game looked like before any of this existed.
   */
  applyTexture(name) {
    const body = document.body;
    for (const t of TEXTURES) body.classList.remove(`tex-${t.key}`);
    if (name && name !== 'none') body.classList.add(`tex-${name}`);
    this.settings.texture = name;
    saveSettings(this.settings);
  }

  // =========================================================================
  // overlays
  // =========================================================================

  closeOverlay() {
    this.el.overlay.hidden = true;
    this.el.overlay.innerHTML = '';
    this.pending = null;
    this.renderMessages();
  }

  /**
   * Someone talking to you.
   *
   * Deliberately a different shape from showText: a conversation is a loop of
   * "they say something, you pick a reply", and building it as one screen with
   * a Close button would have meant every future NPC re-implementing the loop.
   * Resolves with the id of the choice taken, so the caller does the looping
   * and this only ever renders one exchange.
   *
   * Choices are wired BY NAME (`data-choice`), never by position - the overlay
   * close button was bound with `querySelector('button')` once and silently
   * stopped working the day a screen grew a second button. See showText.
   */
  showDialogue({ name, sprite, lines, choices }) {
    return new Promise((resolve) => {
      const ov = this.el.overlay;
      ov.hidden = false;
      const said = (Array.isArray(lines) ? lines : [lines])
        .map((l) => `<p class="say">${escapeHtml(l)}</p>`).join('');
      const opts = choices.map((c) =>
        `<button class="btn dlg-choice" data-choice="${escapeHtml(c.id)}">` +
        `${escapeHtml(c.label)}</button>`).join('');
      ov.innerHTML =
        `<div class="dlg">` +
        (sprite ? `<img class="dlg-face" src="../assets/${escapeHtml(sprite)}.png" alt="">` : '') +
        `<div class="dlg-body"><h2>${escapeHtml(name)}</h2>${said}</div></div>` +
        `<div class="dlg-choices">${opts}</div>`;

      const pick = (id) => { this.closeOverlay(); resolve(id); };
      for (const b of ov.querySelectorAll('[data-choice]')) {
        b.addEventListener('click', () => pick(b.dataset.choice));
      }
      ov.scrollTop = 0;
      // Esc always means the last choice, which every caller makes the one
      // that ends the conversation.
      this.pending = { onKey: (k) => {
        if (k === 'Escape') { pick(choices[choices.length - 1].id); return; }
        const n = Number(k);
        if (n >= 1 && n <= choices.length) pick(choices[n - 1].id);
      } };
    });
  }

  /**
   * A whole conversation: exchanges until you take the leave option.
   *
   * The loop lives here rather than in the rules, which only ever say "this
   * person is being spoken to". What she has to say is presentation, and the
   * game should not need to be rebuilt to change a line of dialogue.
   *
   * What she says now is the run's statistics, and that is deliberately a
   * placeholder - see docs/META.md. The point of building her today is the
   * machinery underneath, so the fragments of story that are supposed to live
   * here have somewhere to arrive into.
   */
  async showConversation(spec) {
    let lines = spec.greeting;
    for (;;) {
      const choice = await this.showDialogue({
        name: spec.name,
        sprite: spec.face ?? spec.sprite,
        lines,
        // A person in the hall has nothing to say about how far a run went -
        // there is no run. The keeper keeps the reckoning; the heroes talk
        // about themselves.
        choices: spec.hero
          ? [
              { id: 'who', label: '1  跟我說說你自己' },
              { id: 'leave', label: '2  就這樣吧 (Esc)' },
            ]
          : [
              { id: 'stats', label: '1  這一趟走了多遠?' },
              { id: 'who', label: '2  你是誰?' },
              { id: 'leave', label: '3  離開 (Esc)' },
            ],
      });
      if (choice === 'leave') { this.render(); return; }
      lines = choice === 'stats' ? this.runReport() : spec.about ?? [
        '我看著火。',
        '除此之外的事,我大概已經忘了。',
      ];
    }
  }

  /** The placeholder she reads out. Everything here is already counted. */
  runReport() {
    const g = this.game;
    const p = g.player;
    const elapsed = fmtDuration(Date.now() - (g.startedAt ?? Date.now()));
    return [
      `你下到第 ${p.depth} 層,最深到過第 ${p.maxDepth} 層。`,
      `倒下 ${p.deaths} 次,殺了 ${g.stats.kills} 個東西,坐過 ${g.stats.rests} 次火。`,
      `身上有 ${p.souls} 個魂,走了 ${p.turns} 個回合,${elapsed}。`,
      '',
      '——火還記得這些。其他的它不說。',
    ];
  }

  showText(title, body) {
    return new Promise((resolve) => {
      const ov = this.el.overlay;
      ov.hidden = false;
      const html = Array.isArray(body)
        ? body.map((l) => `<div>${escapeHtml(l) || '&nbsp;'}</div>`).join('')
        : body;
      ov.innerHTML = `<h2>${escapeHtml(title)}</h2>${html}
        <div class="foot"><button class="btn" data-act="close">Close (Esc)</button></div>`;
      const done = () => { this.closeOverlay(); resolve(); };
      // Its OWN close button, by name. `querySelector('button')` meant "the
      // first button in the overlay", which was true only while the body was
      // inert text - the moment the help screen grew a texture picker, Close
      // stopped being wired at all and the first picker button silently became
      // the close button instead.
      ov.querySelector('[data-act="close"]').addEventListener('click', done);
      ov.scrollTop = 0;
      this.pending = { onKey: () => done() };
    });
  }

  /**
   * Help, with the surface picker on the end of it.
   *
   * Alternatives are only worth having if you can compare them, and you cannot
   * compare a background by reading its name - so the buttons change it under
   * you immediately and the screen stays open.
   */
  async showHelp() {
    const rows = TEXTURES.map((t) => {
      const on = (this.settings.texture ?? 'grain') === t.key;
      return `<tr><td class="key">${escapeHtml(t.name)}</td>` +
             `<td><span class="dim">${escapeHtml(t.hint)}</span></td>` +
             `<td><button class="btn${on ? ' on' : ''}" data-tex="${t.key}">` +
             `${on ? '使用中' : '換這個'}</button></td></tr>`;
    }).join('');

    const p = this.showText('claudeSouls', HELP_HTML + `
      <h2>面板紋理</h2>
      <p>刻意做得幾乎看不見。如果你先注意到的是背景,那它就錯了——
         這個畫面的工作是讓你看見兩格外那個紅色格子。</p>
      <table>${rows}</table>`);

    const bind = () => {
      for (const b of this.el.overlay.querySelectorAll('[data-tex]')) {
        b.addEventListener('click', () => {
          this.applyTexture(b.dataset.tex);
          this.closeOverlay();
          this.showHelp();
        });
      }
    };
    bind();
    return p;
  }

  showSaved() {
    this.showText('Saved', [
      'Your run is stored in this browser.',
      'Reload and choose Continue to pick it up.',
      '',
      'The floor you are on comes back exactly as you left it - it is derived',
      'from the run seed, not stored - so nothing is lost by closing the tab.',
    ]);
  }

  showGameOver(r) {
    const ov = this.el.overlay;
    ov.hidden = false;
    const won = r.how === 'won';
    ov.innerHTML = `
      <h2>${won ? 'The flame goes out' : 'Ashes'}</h2>
      <p>${won
        ? 'You reached the bottom and put out the First Flame.'
        : `You fell for good on floor ${r.depth}.`}</p>
      <table>
        <tr><td class="key">Deepest floor</td><td>${r.maxDepth} / ${DUNGEON_DEPTH}</td></tr>
        <tr><td class="key">Deaths</td><td>${r.deaths}</td></tr>
        <tr><td class="key">Kills</td><td>${r.kills}</td></tr>
        <tr><td class="key">Turns</td><td>${r.turns}</td></tr>
        <tr><td class="key">Time</td><td>${fmtDuration(r.elapsed)}</td></tr>
        <tr><td class="key">Seed</td><td>${escapeHtml(String(r.seed))}</td></tr>
      </table>
      <div class="foot">
        <button class="big-btn" id="again">Again</button>
        <button class="btn" id="same">Same seed</button>
      </div>`;
    ov.querySelector('#again').addEventListener('click', () => location.reload());
    ov.querySelector('#same').addEventListener('click', () => {
      const u = new URL(location.href);
      u.searchParams.set('seed', String(r.seed));
      location.href = u.toString();
    });
    this.pending = { onKey: () => {} };
  }
}

// ---------------------------------------------------------------- helpers

function dirName(d) {
  const names = { '0,-1': 'north', '1,-1': 'north-east', '1,0': 'east', '1,1': 'south-east',
                  '0,1': 'south', '-1,1': 'south-west', '-1,0': 'west', '-1,-1': 'north-west' };
  return names[`${d.dx},${d.dy}`] ?? '';
}

function normaliseKey(ev) {
  const k = ev.key;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(k)) return null;
  // Ctrl + a direction is the short roll. Shift + a direction was already the
  // roll itself, so the second modifier is where "one tile, not two" had to go.
  if (ev.ctrlKey) {
    const low = k.toLowerCase();
    if (low === 'p') return 'C-p';
    return 'hjklyubn'.includes(low) && low.length === 1 ? `C-${low}` : null;
  }
  if (k.startsWith('Arrow')) return k;
  if (k === 'Escape' || k === 'Enter') return k;
  if (k === ' ') return ' ';
  if (ev.code?.startsWith('Numpad') && /^[0-9]$/.test(k)) return 'numpad' + k;
  if (k.length === 1) return k;
  return null;
}

/**
 * A little map of what a skill actually does, drawn on the button.
 *
 * The complaint that prompted this was exact: the skills give no visual
 * feedback about what they correspond to. "Sweep" and "Strike" are words, and
 * a word does not tell you that one covers three tiles and the other covers
 * one - so the only way to learn the difference was to spend the stamina and
 * read the log afterwards. On a phone, where the buttons are the entire
 * interface, that is the difference between a game you can read and a game you
 * have to memorise.
 *
 * The shapes are derived from the same pattern table the attacks resolve
 * against, not drawn by hand, so an icon cannot quietly start lying about what
 * its skill does.
 */
function skillIcon(def, arc = 1) {
  let hit = [], step = [], guard = [];

  if (def.defend) {
    // Not an attack, so it is not drawn like one: the shield's arc, in the
    // defensive colour, so a buckler and a tower shield are visibly different
    // buttons rather than the same word.
    const ring = [[0, -1], [1, -1], [-1, -1], [1, 0], [-1, 0]];
    for (let i = 0; i < Math.min(arc, ring.length); i++) {
      guard.push({ x: ring[i][0], y: ring[i][1] });
    }
  } else if (def.move) {
    // Roll: pure movement, no tiles struck.
    for (let i = 1; i <= (def.dash ?? 1); i++) step.push({ x: 0, y: -i });
  } else if (def.ranged) {
    // The knife keeps flying after your turn ends, so the lane fades out
    // rather than stopping at a tidy edge.
    for (let i = 1; i <= 3; i++) hit.push({ x: 0, y: -i, fade: i / 3 });
  } else {
    const reach = def.dash ?? 0;
    for (let i = 1; i <= reach; i++) step.push({ x: 0, y: -i });
    for (const t of attackTiles(0, -reach, 0, -1, def.pattern ?? 'front')) hit.push(t);
  }

  // Clamp the drawn grid. A six-tile lane is seven cells tall, which at button
  // height renders about three pixels wide - technically correct and completely
  // unreadable. Anything past the limit is dropped and the last cell kept is
  // faded, so a long shape reads as "and it keeps going".
  const LIMIT = 4;
  const clip = (cells) => cells.filter((c) => Math.abs(c.x) <= LIMIT && Math.abs(c.y) <= LIMIT);
  const truncated = (hit.length + step.length + guard.length) >
                    (clip(hit).length + clip(step).length + clip(guard).length);
  hit = clip(hit); step = clip(step); guard = clip(guard);
  if (truncated) {
    const far = [...hit, ...step].sort((a, b) =>
      (Math.abs(b.x) + Math.abs(b.y)) - (Math.abs(a.x) + Math.abs(a.y)))[0];
    if (far) far.fade = 1;
  }

  const all = [{ x: 0, y: 0 }, ...hit, ...step, ...guard];
  const minX = Math.min(...all.map((c) => c.x)), maxX = Math.max(...all.map((c) => c.x));
  const minY = Math.min(...all.map((c) => c.y)), maxY = Math.max(...all.map((c) => c.y));
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const S = 10, G = 1.8;

  const cell = (c, cls) =>
    `<rect class="${cls}" x="${(c.x - minX) * S + G / 2}" y="${(c.y - minY) * S + G / 2}" ` +
    `width="${S - G}" height="${S - G}" rx="1.7"` +
    (c.fade ? ` opacity="${(1.05 - c.fade * 0.55).toFixed(2)}"` : '') + '/>';

  return `<svg class="ico" viewBox="0 0 ${w * S} ${h * S}" width="${w * S}" height="${h * S}" aria-hidden="true">` +
    guard.map((c) => cell(c, 'ic-guard')).join('') +
    step.map((c) => cell(c, 'ic-step')).join('') +
    hit.map((c) => cell(c, 'ic-hit')).join('') +
    cell({ x: 0, y: 0 }, 'ic-me') +
    '</svg>';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
