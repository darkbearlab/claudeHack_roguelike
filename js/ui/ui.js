// The UI layer: input, prompts, menus, and the status line.
//
// Everything the game needs from the outside world arrives through this object,
// and every prompt is a promise. That is the whole design. `await ui.pickItem`
// suspends the command mid-flight and resumes it when a key is pressed or a
// menu row is tapped, which means a command reads as a straight line even when
// it asks three questions.
//
// Touch is not a fallback here. Every command reachable from the keyboard is
// reachable from the command palette, every prompt renders its own tappable
// controls, and the map itself accepts taps (travel), swipes (step) and long
// presses (examine). A phone is a supported input device, not a degraded one.

import { Renderer } from './render.js';
import { DIRS, DIR_BY_KEY, capitalise, signed, fmtDuration } from '../core/util.js';
import { HUNGER, VERSION, groupInventory } from '../game/game.js';
import { objName } from '../game/obj.js';
import { T, TILE, tileName } from '../map/tiles.js';
import { saveSettings, loadSettings } from '../game/save.js';

// How many message lines the bar shows. A phone gets two; the third would cost
// a row of map for a line that is usually blank.
const msgLines = () => (window.innerWidth <= 560 || window.innerHeight <= 560 ? 2 : 3);

export class UI {
  constructor(game) {
    this.game = game;
    game.ui = this;

    this.el = {
      app:      document.getElementById('app'),
      canvas:   document.getElementById('map'),
      overlay:  document.getElementById('overlay'),
      msg:      document.getElementById('msglines'),
      status1:  document.getElementById('status1'),
      status2:  document.getElementById('status2'),
      topinfo:  document.getElementById('topinfo'),
      touchpad: document.getElementById('touchpad'),
      tooltip:  document.getElementById('tooltip'),
      splash:   document.getElementById('splash'),
    };

    this.renderer = new Renderer(this.el.canvas, game);
    this.pending = null;             // active prompt resolver
    this.recent = [];                // last few messages, for the top bar
    this.settings = loadSettings();
    this.renderer.mode = this.settings.mode ?? 'tiles';
    this.renderer.zoom = this.settings.zoom ?? 1;

    // The d-pad is essential on a phone and mostly stolen screen space on a
    // desktop, so it defaults to the device and stays toggleable either way.
    this.isTouch = matchMedia('(hover: none)').matches || 'ontouchstart' in window ||
                   navigator.maxTouchPoints > 0;
    this.el.touchpad.hidden = this.settings.pad !== undefined ? !this.settings.pad : !this.isTouch;

    this.bindKeys();
    this.bindTouch();
    this.bindButtons();
    window.addEventListener('resize', () => { this.renderer.resize(); this.render(); });
    if (window.visualViewport) {
      visualViewport.addEventListener('resize', () => { this.renderer.resize(); this.render(); });
    }
  }

  // =========================================================================
  // input
  // =========================================================================

  bindKeys() {
    window.addEventListener('keydown', (ev) => {
      if (!this.el.splash.hidden) return;
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;

      const key = normaliseKey(ev);
      if (key === null) return;
      // Let the browser keep its own shortcuts.
      if (ev.metaKey || (ev.ctrlKey && !['C-f', 'C-x', 'C-p', 'C-s'].includes(key))) return;
      ev.preventDefault();
      this.feed(key);
    }, { passive: false });
  }

  feed(key) {
    if (this.pending) { this.pending.onKey(key); return; }
    if (!this.game.running) return;
    this.game.command(key);
  }

  bindButtons() {
    for (const btn of document.querySelectorAll('#touchpad button')) {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const cmd = btn.dataset.cmd;
        this.feed(cmd === 'ESC' ? 'Escape' : cmd);
      });
    }
    document.getElementById('btn-mode').addEventListener('click', () => this.toggleMode());
    document.getElementById('btn-zoom').addEventListener('click', () => this.cycleZoom());
    document.getElementById('btn-help').addEventListener('click', () => this.showCommandPalette());
    document.getElementById('btn-save').addEventListener('click', () => this.feed('S'));
    document.getElementById('btn-pad').addEventListener('click', () => {
      this.el.touchpad.hidden = !this.el.touchpad.hidden;
      this.settings.pad = !this.el.touchpad.hidden;
      saveSettings(this.settings);
      this.renderer.resize(); this.render();
    });
  }

  toggleMode() {
    this.renderer.mode = this.renderer.mode === 'tiles' ? 'ascii' : 'tiles';
    document.getElementById('btn-mode').textContent = this.renderer.mode === 'tiles' ? 'Tiles' : 'ASCII';
    this.settings.mode = this.renderer.mode;
    saveSettings(this.settings);
    this.render();
  }

  cycleZoom() {
    const steps = [0.7, 0.85, 1, 1.25, 1.6, 2];
    const i = steps.indexOf(this.renderer.zoom);
    this.renderer.zoom = steps[(i + 1) % steps.length];
    this.settings.zoom = this.renderer.zoom;
    saveSettings(this.settings);
    this.render();
  }

  bindTouch() {
    const c = this.el.canvas;
    let start = null, moved = false, longPressTimer = null;

    const pos = (ev) => {
      const t = ev.touches?.[0] ?? ev.changedTouches?.[0] ?? ev;
      const r = c.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top, t: Date.now() };
    };

    c.addEventListener('pointerdown', (ev) => {
      c.setPointerCapture?.(ev.pointerId);
      start = pos(ev); moved = false;
      longPressTimer = setTimeout(() => {
        if (start && !moved) {
          const cell = this.renderer.cellAt(start.x, start.y);
          this.game.describeAt(cell.x, cell.y);
          start = null;
        }
      }, 480);
    });

    c.addEventListener('pointermove', (ev) => {
      if (!start) return;
      const p = pos(ev);
      if (Math.hypot(p.x - start.x, p.y - start.y) > 14) moved = true;
    });

    c.addEventListener('pointerup', (ev) => {
      clearTimeout(longPressTimer);
      if (!start) return;
      const end = pos(ev);
      const dx = end.x - start.x, dy = end.y - start.y;
      const d = Math.hypot(dx, dy);
      const startCell = this.renderer.cellAt(start.x, start.y);
      start = null;

      if (d > 28) {
        // Swipe: one step in the dominant direction, eight-way.
        const ang = Math.atan2(dy, dx);
        const oct = Math.round((ang / Math.PI) * 4);
        const key = ['h', 'b', 'j', 'n', 'l', 'u', 'k', 'y', 'h'][oct + 4];
        this.feed(key);
        return;
      }

      const cell = this.renderer.cellAt(end.x, end.y);
      void startCell;
      this.onMapTap(cell.x, cell.y);
    });

    c.addEventListener('pointercancel', () => { clearTimeout(longPressTimer); start = null; });
    c.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  onMapTap(x, y) {
    if (this.pending?.onPosition) { this.pending.onPosition(x, y); return; }
    if (!this.game.running) return;
    const p = this.game.player;
    if (x === p.x && y === p.y) { this.feed('.'); return; }
    const dx = x - p.x, dy = y - p.y;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) {
      const dir = DIRS.find((d) => d.dx === dx && d.dy === dy);
      if (dir) this.feed(dir.key);
      return;
    }
    // Distant tap: travel there.
    if (this.game.busy) return;
    this.game.busy = true;
    this.game.travelTo(x, y).finally(() => { this.game.busy = false; this.render(); });
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // =========================================================================
  // messages and status
  // =========================================================================

  pushMessage(text, cls) {
    this.recent.push({ text, cls });
    if (this.recent.length > 40) this.recent.shift();
    this.renderMessages();
  }

  renderMessages(prompt = null) {
    const max = msgLines();
    const lines = this.recent.slice(-max);
    const html = [];
    if (prompt) html.push(`<div class="more">${escapeHtml(prompt)}</div>`);
    const n = prompt ? Math.max(1, max - 1) : max;
    for (const m of lines.slice(-n)) {
      html.push(`<div class="${m.cls ? 'm-' + m.cls : ''}">${escapeHtml(m.text)}</div>`);
    }
    this.el.msg.innerHTML = html.join('');
  }

  renderStatus() {
    const g = this.game, p = g.player;
    if (!p) return;
    const hpCls = p.hp < p.hpMax / 3 ? 'bad' : p.hp < p.hpMax * 0.66 ? 'warn' : 'hi';
    const l1 = [
      `<span class="lo">Dlvl</span>:<span class="hi">${p.depth}</span>`,
      `<span class="lo">$</span>:<span class="hi">${p.gold}</span>`,
      `<span class="lo">HP</span>:<span class="${hpCls}">${p.hp}(${p.hpMax})</span>`,
      `<span class="lo">Pw</span>:<span class="hi">${p.pw}(${p.pwMax})</span>`,
      `<span class="lo">AC</span>:<span class="hi">${p.ac}</span>`,
      `<span class="lo">Xp</span>:<span class="hi">${p.xpLevel}/${p.xp}</span>`,
      `<span class="lo">T</span>:<span class="hi">${g.turn}</span>`,
    ];
    this.el.status1.innerHTML = l1.join('  ');

    const st = [];
    const hunger = hungerName(p.nutrition);
    if (hunger.name) st.push(`<span class="${hunger.cls}">${hunger.name}</span>`);
    const enc = ['', 'Burdened', 'Stressed', 'Strained', 'Overtaxed'][p.encumbrance()];
    if (enc) st.push(`<span class="warn">${enc}</span>`);
    for (const [k] of p.statuses) {
      if (['fast', 'invisible', 'see invisible', 'confusing touch'].includes(k)) continue;
      const cls = ['blind', 'stoning', 'sick', 'paralyzed', 'strangled'].includes(k) ? 'bad' : 'warn';
      st.push(`<span class="${cls}">${capitalise(k)}</span>`);
    }
    if (p.has('fast')) st.push('<span class="good">Fast</span>');
    if (p.hasAmulet) st.push('<span class="good">Amulet</span>');

    const attrs = `St:${p.attr.str} Dx:${p.attr.dex} Co:${p.attr.con} In:${p.attr.int} Wi:${p.attr.wis} Ch:${p.attr.cha}`;
    this.el.status2.innerHTML =
      `<span class="lo">${attrs}</span>  ${st.join(' ')}`;

    this.el.topinfo.textContent =
      `${p.name} the ${p.roleName}  ·  seed ${this.game.seed}  ·  ${this.renderer.mode}`;
  }

  render() {
    this.renderer.draw();
    this.renderStatus();
  }

  animateTrail(cells, glyph, colour) {
    if (!cells?.length) return;
    this.renderer.overlayTrail = { cells, glyph, colour };
    this.renderer.draw();
    setTimeout(() => { this.renderer.overlayTrail = null; this.renderer.draw(); }, 110);
  }

  // =========================================================================
  // prompts
  // =========================================================================

  closeOverlay() {
    this.el.overlay.hidden = true;
    this.el.overlay.innerHTML = '';
    this.pending = null;
    this.renderMessages();
  }

  /** Wait for a single key. Resolves with the key string, or 'Escape'. */
  getKey(prompt, accept = null) {
    this.renderMessages(prompt);
    return new Promise((resolve) => {
      this.pending = {
        onKey: (key) => {
          if (accept && key !== 'Escape' && !accept.includes(key)) return;
          this.pending = null;
          this.renderMessages();
          resolve(key);
        },
      };
    });
  }

  yesno(prompt, dflt = 'n') {
    return new Promise((resolve) => {
      const ov = this.el.overlay;
      ov.hidden = false;
      ov.innerHTML = `
        <h2>${escapeHtml(prompt)}</h2>
        <div class="menu-foot">
          <button class="btn" data-a="y">Yes  (y)</button>
          <button class="btn" data-a="n">No  (n)</button>
        </div>`;
      const done = (v) => { this.closeOverlay(); resolve(v); };
      ov.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => done(b.dataset.a === 'y')));
      this.pending = {
        onKey: (key) => {
          if (key === 'y' || key === 'Y') done(true);
          else if (key === 'n' || key === 'N' || key === 'Escape') done(false);
          else if (key === 'Enter') done(dflt === 'y');
        },
      };
    });
  }

  getDirection(prompt) {
    return new Promise((resolve) => {
      const ov = this.el.overlay;
      ov.hidden = false;
      const cellBtn = (key, label) =>
        `<button class="btn" data-k="${key}" style="height:52px;font-size:18px">${label}</button>`;
      ov.innerHTML = `
        <h2>${escapeHtml(prompt)}</h2>
        <div style="display:grid;grid-template-columns:repeat(3,64px);gap:6px;margin:12px 0">
          ${cellBtn('y', '↖')}${cellBtn('k', '↑')}${cellBtn('u', '↗')}
          ${cellBtn('h', '←')}${cellBtn('.', '·')}${cellBtn('l', '→')}
          ${cellBtn('b', '↙')}${cellBtn('j', '↓')}${cellBtn('n', '↘')}
        </div>
        <div class="note">· aims at yourself or the floor. Escape cancels.</div>
        <div class="menu-foot"><button class="btn" data-k="Escape">Cancel</button></div>`;
      const done = (v) => { this.closeOverlay(); resolve(v); };
      const fromKey = (key) => {
        if (key === 'Escape') return done(null);
        if (key === '.' || key === 's') return done({ dx: 0, dy: 0 });
        const d = this.game.dirFromKey(key);
        if (d) done({ dx: d.dx, dy: d.dy });
      };
      ov.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => fromKey(b.dataset.k)));
      this.pending = { onKey: fromKey };
    });
  }

  getText(prompt, dflt = '') {
    return new Promise((resolve) => {
      const ov = this.el.overlay;
      ov.hidden = false;
      ov.innerHTML = `
        <h2>${escapeHtml(prompt)}</h2>
        <div class="splash-row">
          <input type="text" id="prompt-input" value="${escapeHtml(dflt)}" autocomplete="off"
                 autocapitalize="off" autocorrect="off" spellcheck="false">
          <button class="big-btn" id="prompt-ok">OK</button>
          <button class="big-btn secondary" id="prompt-cancel">Cancel</button>
        </div>`;
      const input = ov.querySelector('#prompt-input');
      const done = (v) => { this.closeOverlay(); resolve(v); };
      ov.querySelector('#prompt-ok').addEventListener('click', () => done(input.value));
      ov.querySelector('#prompt-cancel').addEventListener('click', () => done(null));
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') done(input.value);
        if (ev.key === 'Escape') done(null);
      });
      this.pending = { onKey: (k) => { if (k === 'Escape') done(null); } };
      setTimeout(() => input.focus(), 30);
    });
  }

  /** A menu. entries: {header} | {obj, letter, label}. Returns obj | obj[] | null. */
  showMenu(title, entries, opts = {}) {
    return new Promise((resolve) => {
      const ov = this.el.overlay;
      ov.hidden = false;
      const multi = !!opts.multi;
      const selected = new Set();

      const body = entries.map((e, i) => {
        if (e.header) return `<div class="menu-head">${escapeHtml(e.header)}</div>`;
        const letter = e.letter ?? letterFor(i);
        return `<div class="menu-item" data-i="${i}" data-letter="${escapeHtml(letter)}">
                  <span class="let">${escapeHtml(letter)} ${multi ? '-' : '-'}</span>
                  <span class="txt">${escapeHtml(e.label)}</span>
                </div>`;
      }).join('');

      const foot = opts.readonly
        ? `<button class="btn" data-act="close">Close  (Esc)</button>`
        : multi
          ? `<button class="btn" data-act="ok">Confirm</button>
             <button class="btn" data-act="all">Select all</button>
             <button class="btn" data-act="close">Cancel  (Esc)</button>`
          : `<button class="btn" data-act="close">Cancel  (Esc)</button>`;

      ov.innerHTML = `<h2>${escapeHtml(title)}</h2>${body}<div class="menu-foot">${foot}</div>`;

      const done = (v) => { this.closeOverlay(); resolve(v); };
      const rowFor = (letter) => entries.findIndex((e) => !e.header && (e.letter ?? null) === letter);

      const toggle = (i) => {
        const e = entries[i];
        if (!e || e.header) return;
        if (!multi) { done(e.obj); return; }
        if (selected.has(i)) selected.delete(i); else selected.add(i);
        ov.querySelector(`.menu-item[data-i="${i}"]`)?.classList.toggle('sel', selected.has(i));
      };

      ov.querySelectorAll('.menu-item').forEach((row) =>
        row.addEventListener('click', () => toggle(Number(row.dataset.i))));
      ov.querySelectorAll('.menu-foot button').forEach((b) =>
        b.addEventListener('click', () => {
          const act = b.dataset.act;
          if (act === 'close') done(multi ? [] : null);
          else if (act === 'ok') done([...selected].map((i) => entries[i].obj));
          else if (act === 'all') {
            entries.forEach((e, i) => { if (!e.header) selected.add(i); });
            ov.querySelectorAll('.menu-item').forEach((r) => r.classList.add('sel'));
          }
        }));

      this.pending = {
        onKey: (key) => {
          if (key === 'Escape') return done(multi ? [] : null);
          if (key === 'Enter') {
            if (multi) return done([...selected].map((i) => entries[i].obj));
            return done(opts.readonly ? null : null);
          }
          if (key === '*' && multi) {
            entries.forEach((e, i) => { if (!e.header) selected.add(i); });
            ov.querySelectorAll('.menu-item').forEach((r) => r.classList.add('sel'));
            return;
          }
          const i = rowFor(key);
          if (i >= 0) toggle(i);
        },
      };
    });
  }

  async pickItem(prompt, entries) {
    if (!entries.length) return null;
    return await this.showMenu(prompt, entries, {});
  }

  async pickMany(prompt, entries) {
    if (!entries.length) return [];
    return await this.showMenu(prompt, entries, { multi: true });
  }

  /** Move a cursor on the map and confirm. Works with keys or a tap. */
  pickPosition(prompt) {
    return new Promise((resolve) => {
      const p = this.game.player;
      this.renderer.cursor = { x: p.x, y: p.y };
      this.renderMessages(`${prompt}  (move with hjkl / arrows, . to select, Esc to cancel - or just tap)`);
      this.render();
      const done = (v) => {
        this.renderer.cursor = null;
        this.pending = null;
        this.renderMessages();
        this.render();
        resolve(v);
      };
      this.pending = {
        onKey: (key) => {
          if (key === 'Escape') return done(null);
          if (key === '.' || key === ',' || key === 'Enter') return done({ ...this.renderer.cursor });
          const d = this.game.dirFromKey(key);
          if (d) {
            const c = this.renderer.cursor;
            const nx = c.x + d.dx, ny = c.y + d.dy;
            if (this.game.level.inBounds(nx, ny)) { c.x = nx; c.y = ny; this.render(); }
          }
        },
        onPosition: (x, y) => done({ x, y }),
      };
    });
  }

  showText(title, lines) {
    return new Promise((resolve) => {
      const ov = this.el.overlay;
      ov.hidden = false;
      const body = Array.isArray(lines)
        ? lines.map((l) => `<div>${escapeHtml(l) || '&nbsp;'}</div>`).join('')
        : lines;
      ov.innerHTML = `<h2>${escapeHtml(title)}</h2>${body}
        <div class="menu-foot"><button class="btn" data-act="close">Close  (Esc)</button></div>`;
      const done = () => { this.closeOverlay(); resolve(); };
      ov.querySelector('button').addEventListener('click', done);
      this.pending = { onKey: () => done() };
    });
  }

  async showTerrain() {
    const lvl = this.game.level;
    const rows = [];
    for (let y = 0; y < lvl.h; y++) {
      let row = '';
      for (let x = 0; x < lvl.w; x++) {
        const i = lvl.idx(x, y);
        if (x === this.game.player.x && y === this.game.player.y) { row += '@'; continue; }
        row += lvl.seen[i] ? TILE[lvl.tiles[i]].glyph : ' ';
      }
      rows.push(row);
    }
    await this.showText(`Dungeon level ${lvl.depth}`,
      `<pre style="font-size:10px;line-height:1.05;overflow-x:auto">${escapeHtml(rows.join('\n'))}</pre>`);
  }

  // =========================================================================
  // help and palette
  // =========================================================================

  async showHelp() {
    await this.showText('claudeHack - how to play', HELP_HTML);
  }

  async showCommandPalette() {
    const ov = this.el.overlay;
    ov.hidden = false;
    const group = (title, cmds) => `
      <h3>${title}</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:5px">
        ${cmds.map(([k, l]) => `<button class="btn" data-k="${escapeHtml(k)}"
            style="text-align:left;padding:9px 8px">${escapeHtml(l)}<br>
            <span style="color:var(--dim);font-size:10px">${escapeHtml(k)}</span></button>`).join('')}
      </div>`;

    ov.innerHTML = `<h2>Commands</h2>
      ${group('Act', [[',', 'Pick up'], ['i', 'Inventory'], ['.', 'Rest a turn'], ['s', 'Search once'],
                      ['A', 'Rest until healed'], ['C-s', 'Search until found'],
                      ['>', 'Go down'], ['<', 'Go up'], ['o', 'Open door'], ['c', 'Close door']])}
      ${group('Use', [['q', 'Quaff potion'], ['r', 'Read'], ['z', 'Zap wand'], ['Z', 'Cast spell'],
                      ['e', 'Eat'], ['a', 'Apply tool'], ['t', 'Throw'], ['f', 'Fire'], ['Q', 'Ready ammo']])}
      ${group('Equip', [['w', 'Wield weapon'], ['W', 'Wear armor'], ['T', 'Take off armor'],
                        ['P', 'Put on ring'], ['R', 'Remove ring'], ['x', 'Swap weapons'],
                        ['d', 'Drop'], ['D', 'Drop several']])}
      ${group('Look', [[';', 'Examine a spot'], [':', 'Look here'], ['_', 'Travel to...'],
                       ['C-f', 'Explore'], ['\\', 'Discoveries'], ['C-x', 'Attributes'],
                       ['#', 'Extended...'], ['E', 'Engrave']])}
      ${group('Meta', [['?', 'Full help'], ['S', 'Save and quit'], ['p', 'Pay shopkeeper'],
                       ['C-p', 'Message history'], ['v', 'Version']])}
      <div class="menu-foot"><button class="btn" data-act="close">Close</button></div>`;

    const done = () => this.closeOverlay();
    ov.querySelectorAll('button[data-k]').forEach((b) =>
      b.addEventListener('click', () => { done(); this.feed(b.dataset.k); }));
    ov.querySelector('button[data-act=close]').addEventListener('click', done);
    this.pending = { onKey: (k) => { if (k === 'Escape' || k === '?') done(); } };
  }

  showSaved() {
    const ov = this.el.overlay;
    ov.hidden = false;
    ov.innerHTML = `<h2>Saved</h2>
      <div class="note">Your game is stored in this browser. Reload the page and choose
      <b>Continue</b> to pick it up. Clearing site data will delete it.</div>
      <div class="menu-foot"><button class="btn" id="back">Back to the game</button></div>`;
    ov.querySelector('#back').addEventListener('click', () => this.closeOverlay());
    this.pending = { onKey: (k) => { if (k === 'Escape') this.closeOverlay(); } };
  }

  showGameOver(result) {
    const g = this.game, p = g.player;
    const ov = this.el.overlay;
    ov.hidden = false;
    const verdict = result.how === 'ascended'
      ? 'You escaped the dungeon with the Amulet of Yendor.'
      : result.how === 'quit'
        ? 'You gave up.'
        : `You died in the dungeon, killed by ${result.killer}.`;

    const kills = [...p.kills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    ov.innerHTML = `
      <h2>${result.how === 'ascended' ? 'You win' : 'Game over'}</h2>
      <pre style="color:var(--accent);font-size:11px;line-height:1.2">${escapeHtml(tombstone(p, result))}</pre>
      <div style="margin:10px 0">${escapeHtml(verdict)}</div>
      <table>
        <tr><td class="key">Score</td><td>${result.score}</td></tr>
        <tr><td class="key">Turns</td><td>${result.turns}</td></tr>
        <tr><td class="key">Deepest level</td><td>${result.maxDepth}</td></tr>
        <tr><td class="key">Experience</td><td>level ${p.xpLevel}, ${p.xp} points</td></tr>
        <tr><td class="key">Gold</td><td>${p.gold}</td></tr>
        <tr><td class="key">Time played</td><td>${fmtDuration(result.elapsed)}</td></tr>
        <tr><td class="key">Seed</td><td>${escapeHtml(String(g.seed))}</td></tr>
      </table>
      <h3>You killed</h3>
      <div class="cols">${kills.length
        ? kills.map(([n, c]) => `<div>${c} &times; ${escapeHtml(n)}</div>`).join('')
        : '<div>nothing at all</div>'}</div>
      <h3>You were carrying</h3>
      <div class="cols">${p.inventory.length
        ? p.inventory.map((o) => `<div>${escapeHtml(objName(o, g.disc))}</div>`).join('')
        : '<div>nothing</div>'}</div>
      <div class="menu-foot">
        <button class="big-btn" id="again">Play again</button>
        <button class="btn" id="same-seed">Replay this seed</button>
      </div>`;
    ov.querySelector('#again').addEventListener('click', () => location.reload());
    ov.querySelector('#same-seed').addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.set('seed', String(g.seed));
      location.href = url.toString();
    });
    this.pending = { onKey: () => {} };
  }
}

// ===========================================================================

function tombstone(p, result) {
  const lines = [
    '        ----------',
    '       /          \\',
    '      /    REST    \\',
    '     /      IN      \\',
    '    /     PEACE      \\',
    '    |                |',
  ];
  const name = (p.name || 'nobody').slice(0, 16);
  const role = p.roleName.slice(0, 16);
  const how = result.how === 'ascended' ? 'ascended' : `died on Dlvl ${result.depth}`;
  lines.push(`    |${centre(name, 16)}|`);
  lines.push(`    |${centre(role, 16)}|`);
  lines.push(`    |${centre(how, 16)}|`);
  lines.push(`    |${centre(String(result.score) + ' Au', 16)}|`);
  lines.push('   *|     *  *  *    | *');
  lines.push('   _)/\\\\_//(\\/(/\\)/\\//\\/|_)_');
  return lines.join('\n');
}

function centre(s, w) {
  s = s.slice(0, w);
  const left = Math.floor((w - s.length) / 2);
  return ' '.repeat(left) + s + ' '.repeat(w - s.length - left);
}

export function hungerName(n) {
  if (n >= 1000) return { name: 'Satiated', cls: 'warn' };
  if (n >= 150) return { name: '', cls: '' };
  if (n >= 50) return { name: 'Hungry', cls: 'warn' };
  if (n >= 0) return { name: 'Weak', cls: 'bad' };
  return { name: 'Fainting', cls: 'bad' };
}

function letterFor(i) {
  const L = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return L[i % L.length];
}

function normaliseKey(ev) {
  const k = ev.key;
  if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta') return null;
  if (ev.ctrlKey) {
    if (k.toLowerCase() === 'f') return 'C-f';
    if (k.toLowerCase() === 'x') return 'C-x';
    if (k.toLowerCase() === 'p') return 'C-p';
    return null;
  }
  if (k.startsWith('Arrow')) return k;
  if (k === 'Escape' || k === 'Enter' || k === ' ') return k === ' ' ? ' ' : k;
  if (ev.code?.startsWith('Numpad') && /^[0-9]$/.test(k)) return 'numpad' + k;
  if (k.length === 1) return k;
  return null;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const HELP_HTML = `
<h3>The goal</h3>
<div>Descend 26 levels, take the Amulet of Yendor from the Sanctum at the bottom,
and carry it back up to the surface. Death is permanent; there is one save and it
is deleted when the run ends.</div>

<h3>Moving</h3>
<table>
<tr><td class="key">h j k l</td><td>west, south, north, east</td></tr>
<tr><td class="key">y u b n</td><td>the four diagonals</td></tr>
<tr><td class="key">arrows / numpad</td><td>the same, if you prefer</td></tr>
<tr><td class="key">Shift + direction</td><td>run until something happens</td></tr>
<tr><td class="key">.</td><td>wait one turn</td></tr>
<tr><td class="key">&gt; &lt;</td><td>take stairs down / up</td></tr>
<tr><td class="key">_</td><td>travel to a chosen spot</td></tr>
<tr><td class="key">Ctrl-F</td><td>explore automatically until something interesting</td></tr>
</table>
<div class="note">On a touch screen: <b>tap a nearby square</b> to step or attack,
<b>tap a distant one</b> to travel there, <b>swipe</b> to step, <b>press and hold</b>
to examine. The d-pad and the <b>?</b> button do everything a keyboard can.</div>

<h3>Fighting</h3>
<div>Walk into a monster to attack it. There is no separate attack key. Your chance
to hit depends on your level, Strength, Dexterity and your weapon; the monster's
armour class works against you. Ranged attacks use <span class="key">f</span> (fire
what is in your quiver) or <span class="key">t</span> (throw anything).</div>

<h3>Things</h3>
<table>
<tr><td class="key">, i d D</td><td>pick up, inventory, drop, drop several</td></tr>
<tr><td class="key">w W T P R</td><td>wield, wear, take off, put on, remove</td></tr>
<tr><td class="key">q r z Z e a</td><td>quaff, read, zap, cast, eat, apply</td></tr>
<tr><td class="key">p</td><td>pay a shopkeeper</td></tr>
</table>

<h3>Identification</h3>
<div>Potions, scrolls, wands, rings and amulets start unknown, and which appearance
means what is <b>shuffled every game</b>. You learn by using, by reading a scroll of
identify, or by price. Use <span class="key">\\</span> to see what you have worked
out, and <span class="key">#name</span> to label a type with a guess.</div>

<h3>Staying alive</h3>
<ul>
<li>Hunger kills. Carry food; eat before you are Weak.</li>
<li>Cursed gear cannot be removed. Test unknown items when you are safe, not when you are not.</li>
<li>Do not attack a floating eye in melee.</li>
<li>Fight in a doorway or a corridor so only one thing reaches you at a time.</li>
<li>Writing <b>Elbereth</b> with <span class="key">E</span> makes most monsters keep away.</li>
<li>Stairs are an escape. Monsters next to them follow you.</li>
</ul>

<h3>Display</h3>
<div>The <b>Tiles / ASCII</b> button switches between generated sprite art and the
classic glyph display. Both show exactly the same information.</div>
`;
