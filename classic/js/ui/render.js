// The renderer.
//
// One canvas, two modes. Tile mode draws the generated sprites; ASCII mode
// draws the same world as glyphs. They are not two renderers - they share the
// viewport maths, the lighting model and the draw order, and differ only in
// what gets painted per cell. Keeping them that way is what stops the two from
// disagreeing about what the hero can see, which is a real bug class: an ASCII
// mode that shows a monster the tile mode hides is a cheat.
//
// Terrain is drawn procedurally rather than from sprites, and that is a
// measured decision, not laziness. The asset pipeline available here produces
// background-removed *objects*; it has no tiling path, so a floor built from
// them shows seams and a wall built from them has gaps at the joins. Procedural
// floors and walls tile perfectly, cost nothing to load, and take their
// variation from a per-cell hash so they are stable between frames.

import { T, TILE, isDoor, isStairs } from '../map/tiles.js';
import { hash2, dist } from '../../../engine/util.js';
import { objBase } from '../game/obj.js';

// The sprite library is shared between the games in this repository, so it
// sits at the repository root rather than inside classic/.
const SPRITE_DIR = '../assets/';

export class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.game = game;
    this.mode = 'tiles';           // 'tiles' | 'ascii'
    this.zoom = 1;
    this.sprites = new Map();
    this.spriteState = new Map();  // name -> 'loading' | 'ok' | 'fail'
    this.overlayTrail = null;
    this.cursor = null;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.resize();
  }

  // ------------------------------------------------------------- sprites

  sprite(name) {
    if (!name) return null;
    if (this.sprites.has(name)) return this.sprites.get(name);
    if (this.spriteState.get(name) === 'loading' || this.spriteState.get(name) === 'fail') return null;
    this.spriteState.set(name, 'loading');
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { this.sprites.set(name, img); this.spriteState.set(name, 'ok'); this.draw(); };
    img.onerror = () => { this.spriteState.set(name, 'fail'); };
    img.src = `${SPRITE_DIR}${name}.png`;
    return null;
  }

  /** Warm the cache for everything currently on the level, so tiles do not pop. */
  preload(names) { for (const n of names) this.sprite(n); }

  // -------------------------------------------------------------- layout

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * this.dpr));
    const h = Math.max(1, Math.floor(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.cssW = rect.width; this.cssH = rect.height;
  }

  /** Pixels per map cell, and how many cells fit. */
  metrics() {
    const lvl = this.game.level;
    const W = this.canvas.width, H = this.canvas.height;
    let base;
    if (this.mode === 'ascii') {
      // Prefer showing the whole 80-column map; shrink only as far as legible.
      base = Math.min(W / lvl.w, H / lvl.h);
      base = Math.max(base, 9 * this.dpr);
    } else {
      // Tile mode guarantees a minimum window on the world rather than a fixed
      // cell size: at least MIN_COLS by MIN_ROWS cells are always on screen, so
      // a phone in portrait and a desktop in landscape both show enough of the
      // level to fight in, and neither ends up with 8-pixel monsters.
      const MIN_COLS = 15, MIN_ROWS = 9;
      base = Math.min(W / MIN_COLS, H / MIN_ROWS);
      base = Math.max(14 * this.dpr, Math.min(base, 88 * this.dpr));
    }
    const cell = Math.max(6, Math.floor(base * this.zoom));
    const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
    return { cell, cols, rows, W, H };
  }

  viewport() {
    const lvl = this.game.level;
    const p = this.game.player;
    const { cell, cols, rows, W, H } = this.metrics();
    let ox, oy;
    if (cols >= lvl.w) ox = -Math.floor((cols - lvl.w) / 2);
    else ox = Math.max(0, Math.min(lvl.w - cols, p.x - Math.floor(cols / 2)));
    if (rows >= lvl.h) oy = -Math.floor((rows - lvl.h) / 2);
    else oy = Math.max(0, Math.min(lvl.h - rows, p.y - Math.floor(rows / 2)));
    return { cell, cols, rows, ox, oy, W, H };
  }

  /** Map cell under a canvas-space (CSS pixel) point. */
  cellAt(cssX, cssY) {
    const v = this.viewport();
    const x = Math.floor((cssX * this.dpr) / v.cell) + v.ox;
    const y = Math.floor((cssY * this.dpr) / v.cell) + v.oy;
    return { x, y };
  }

  // ---------------------------------------------------------------- draw

  draw() {
    if (!this.game.level) return;
    this.resize();
    const ctx = this.ctx;
    const lvl = this.game.level;
    const p = this.game.player;
    const v = this.viewport();

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, v.W, v.H);

    const halluc = p.hasStatus('hallucinating');

    for (let ry = 0; ry < v.rows; ry++) {
      for (let rx = 0; rx < v.cols; rx++) {
        const x = v.ox + rx, y = v.oy + ry;
        if (!lvl.inBounds(x, y)) continue;
        const px = rx * v.cell, py = ry * v.cell;
        const i = lvl.idx(x, y);
        const visible = !!lvl.visible[i];
        const seen = !!lvl.seen[i];
        if (!seen && !visible) continue;

        this.drawTerrain(ctx, lvl, x, y, px, py, v.cell, visible);

        // Traps the hero knows about sit above terrain.
        const trap = lvl.traps.get(i);
        if (trap && trap.seen) this.drawGlyph(ctx, '^', '#e3b341', px, py, v.cell, visible ? 1 : 0.45);

        // Objects: live ones if visible, remembered ones otherwise.
        if (visible) {
          const o = lvl.topItemAt(x, y);
          if (o) this.drawObject(ctx, o, px, py, v.cell, 1, halluc);
        } else if (lvl.memObj[i]) {
          const m = lvl.memObj[i];
          this.drawRemembered(ctx, m, px, py, v.cell);
        }
      }
    }

    // Monsters.
    for (const m of lvl.monsters) {
      if (!m.alive) continue;
      const rx = m.x - v.ox, ry = m.y - v.oy;
      if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
      const visible = lvl.isVisible(m.x, m.y) && this.canSeeMonster(m);
      const detected = this.game.detectedMonsters?.has(m.uid);
      const telepathy = p.has('telepathy') && !m.spec.mindless && p.hasStatus('blind');
      if (!visible && !detected && !telepathy) continue;
      this.drawMonster(ctx, m, rx * v.cell, ry * v.cell, v.cell, visible ? 1 : 0.55, halluc);
    }

    // The hero, last, so nothing hides them.
    {
      const rx = p.x - v.ox, ry = p.y - v.oy;
      this.drawHero(ctx, p, rx * v.cell, ry * v.cell, v.cell);
    }

    if (this.overlayTrail) this.drawTrail(ctx, v);
    if (this.cursor) this.drawCursor(ctx, v);
  }

  canSeeMonster(m) {
    const p = this.game.player;
    if (p.hasStatus('blind')) return false;
    if (m.invisible && !p.has('seeInvis')) return false;
    return true;
  }

  // ------------------------------------------------------------- terrain

  drawTerrain(ctx, lvl, x, y, px, py, cell, visible) {
    const t = lvl.at(x, y);
    const dim = visible ? 1 : 0.42;

    if (this.mode === 'ascii') {
      ctx.fillStyle = visible && lvl.lit[lvl.idx(x, y)] ? '#0d0f13' : '#07080a';
      ctx.fillRect(px, py, cell, cell);
      const def = TILE[t];
      if (t === T.STONE) return;
      this.drawGlyph(ctx, def.glyph, def.colour, px, py, cell, dim);
      return;
    }

    // ---- tile mode
    const n = lvl.noise[lvl.idx(x, y)];
    switch (t) {
      case T.STONE:
        ctx.fillStyle = '#05060a';
        ctx.fillRect(px, py, cell, cell);
        break;
      case T.WALL: case T.TREE: {
        const base = t === T.TREE ? [40, 70, 36] : [72, 68, 60];
        const j = (n % 14) - 7;
        ctx.fillStyle = rgb(base[0] + j, base[1] + j, base[2] + j, dim);
        ctx.fillRect(px, py, cell, cell);
        // A light top edge and dark bottom edge reads as a solid block.
        ctx.fillStyle = rgb(base[0] + 34, base[1] + 32, base[2] + 28, dim);
        ctx.fillRect(px, py, cell, Math.max(1, cell * 0.13));
        ctx.fillStyle = rgb(10, 10, 14, dim);
        ctx.fillRect(px, py + cell - Math.max(1, cell * 0.1), cell, Math.max(1, cell * 0.1));
        break;
      }
      case T.WATER: {
        const j = (n % 20) - 10;
        ctx.fillStyle = rgb(30 + j, 80 + j, 150 + j, dim);
        ctx.fillRect(px, py, cell, cell);
        break;
      }
      case T.LAVA: {
        const j = (n % 30) - 15;
        ctx.fillStyle = rgb(190 + j, 70 + j / 2, 20, dim);
        ctx.fillRect(px, py, cell, cell);
        break;
      }
      case T.BARS:
        this.floor(ctx, px, py, cell, n, dim, true);
        ctx.fillStyle = rgb(130, 140, 150, dim);
        for (let k = 1; k < 4; k++) ctx.fillRect(px + (cell * k) / 4, py, Math.max(1, cell * 0.06), cell);
        break;
      default:
        this.floor(ctx, px, py, cell, n, dim, t === T.CORRIDOR);
        break;
    }

    // Features drawn on top of their floor.
    if (isDoor(t) && t !== T.SDOOR) this.drawDoor(ctx, t, px, py, cell, dim);
    else if (t === T.STAIRS_DOWN || t === T.LADDER_DOWN) this.drawFeature(ctx, 'feat_stairs_down', '>', '#e8e2d0', px, py, cell, dim);
    else if (t === T.STAIRS_UP || t === T.LADDER_UP) this.drawFeature(ctx, 'feat_stairs_up', '<', '#e8e2d0', px, py, cell, dim);
    else if (t === T.ALTAR) this.drawFeature(ctx, 'feat_altar', '_', '#d8d4c8', px, py, cell, dim);
    else if (t === T.FOUNTAIN) this.drawFeature(ctx, 'feat_fountain', '{', '#59a5d8', px, py, cell, dim);
    else if (t === T.GRAVE) this.drawFeature(ctx, 'item_bones', '|', '#9aa0a6', px, py, cell, dim);
    else if (t === T.THRONE) this.drawFeature(ctx, 'feat_chest', '\\', '#e0b64a', px, py, cell, dim);
    else if (t === T.SINK) this.drawGlyph(ctx, '{', '#9aa0a6', px, py, cell, dim);
  }

  floor(ctx, px, py, cell, n, dim, corridor) {
    const base = corridor ? 30 : 44;
    const j = (n % 11) - 5;
    ctx.fillStyle = rgb(base + j, base - 2 + j, base - 8 + j, dim);
    ctx.fillRect(px, py, cell, cell);
    // A faint speck per cell, deterministic, so the floor is not a flat wash.
    if (cell >= 14 && (n & 7) === 0) {
      ctx.fillStyle = rgb(base + 22, base + 20, base + 12, dim);
      const sx = px + ((n >> 3) % Math.max(1, cell - 3));
      const sy = py + ((n >> 5) % Math.max(1, cell - 3));
      ctx.fillRect(sx, sy, Math.max(1, cell * 0.07), Math.max(1, cell * 0.07));
    }
  }

  drawDoor(ctx, t, px, py, cell, dim) {
    const open = t === T.DOOR_OPEN || t === T.DOOR_BROKEN;
    const img = this.sprite('feat_door');
    if (!open) {
      if (img) { this.blit(ctx, img, px, py, cell, dim); }
      else {
        ctx.fillStyle = rgb(140, 96, 48, dim);
        ctx.fillRect(px + cell * 0.08, py + cell * 0.08, cell * 0.84, cell * 0.84);
        ctx.fillStyle = rgb(90, 60, 30, dim);
        ctx.fillRect(px + cell * 0.45, py + cell * 0.08, cell * 0.1, cell * 0.84);
      }
      if (t === T.DOOR_LOCKED) {
        ctx.fillStyle = rgb(230, 200, 80, dim);
        ctx.fillRect(px + cell * 0.42, py + cell * 0.42, cell * 0.16, cell * 0.16);
      }
    } else {
      ctx.fillStyle = rgb(120, 84, 42, dim);
      ctx.fillRect(px, py, cell * 0.16, cell);
      ctx.fillRect(px + cell * 0.84, py, cell * 0.16, cell);
    }
  }

  drawFeature(ctx, spriteName, glyph, colour, px, py, cell, dim) {
    const img = this.sprite(spriteName);
    if (img) this.blit(ctx, img, px, py, cell, dim);
    else this.drawGlyph(ctx, glyph, colour, px, py, cell, dim);
  }

  // ------------------------------------------------------------- entities

  drawObject(ctx, o, px, py, cell, dim, halluc) {
    const base = objBase(o);
    if (!base) return;
    if (this.mode === 'ascii' || halluc) {
      const g = halluc ? randomGlyph(o.oid, this.game.turn) : base.glyph;
      const c = halluc ? randomColour(o.oid, this.game.turn) : base.colour;
      this.drawGlyph(ctx, g, c, px, py, cell, dim);
      return;
    }
    const img = this.sprite(base.sprite);
    if (img) this.blit(ctx, img, px, py, cell, dim, 0.78);
    else this.drawGlyph(ctx, base.glyph, base.colour, px, py, cell, dim);
  }

  drawRemembered(ctx, m, px, py, cell) {
    if (this.mode === 'tiles') {
      const img = this.sprite(m.sprite);
      if (img) { this.blit(ctx, img, px, py, cell, 0.34, 0.7); return; }
    }
    this.drawGlyph(ctx, m.glyph, m.colour, px, py, cell, 0.38);
  }

  drawMonster(ctx, m, px, py, cell, dim, halluc) {
    if (this.mode === 'ascii' || halluc) {
      const g = halluc ? randomGlyph(m.uid, this.game.turn) : m.glyph;
      const c = halluc ? randomColour(m.uid, this.game.turn) : m.colour;
      this.drawGlyph(ctx, g, c, px, py, cell, dim);
    } else {
      const img = this.sprite(m.sprite);
      if (img) this.blit(ctx, img, px, py, cell, dim);
      else this.drawGlyph(ctx, m.glyph, m.colour, px, py, cell, dim);
    }
    // Health pip, so a wounded monster is legible without a look command.
    if (m.hp < m.hpMax && cell >= 16) {
      const w = cell * 0.7, h = Math.max(2, cell * 0.07);
      const bx = px + cell * 0.15, by = py + cell - h - 1;
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      ctx.fillRect(bx, by, w, h);
      ctx.fillStyle = m.hp / m.hpMax > 0.5 ? '#56d364' : m.hp / m.hpMax > 0.25 ? '#e3b341' : '#f85149';
      ctx.fillRect(bx, by, (w * m.hp) / m.hpMax, h);
    }
    if (m.peaceful && cell >= 16) {
      ctx.fillStyle = 'rgba(90,180,255,.9)';
      ctx.fillRect(px + cell * 0.06, py + cell * 0.06, Math.max(2, cell * 0.1), Math.max(2, cell * 0.1));
    }
    if (m.asleep && cell >= 16) {
      this.drawGlyph(ctx, 'z', 'rgba(200,220,255,.85)', px + cell * 0.3, py - cell * 0.28, cell * 0.7, 1);
    }
  }

  drawHero(ctx, p, px, py, cell) {
    if (this.mode === 'ascii') {
      this.drawGlyph(ctx, '@', p.hasStatus('invisible') ? '#8899aa' : '#ffffff', px, py, cell, 1);
    } else {
      const img = this.sprite(p.sprite);
      if (img) this.blit(ctx, img, px, py, cell, p.hasStatus('invisible') ? 0.5 : 1);
      else this.drawGlyph(ctx, '@', '#ffffff', px, py, cell, 1);
    }
    // A ring under the hero: on a busy tile map the eye needs an anchor.
    ctx.strokeStyle = 'rgba(255,215,95,.75)';
    ctx.lineWidth = Math.max(1, cell * 0.05);
    ctx.beginPath();
    ctx.arc(px + cell / 2, py + cell * 0.86, cell * 0.3, 0, Math.PI * 2);
    ctx.stroke();
  }

  // ------------------------------------------------------------ primitives

  blit(ctx, img, px, py, cell, alpha = 1, scale = 1) {
    const pad = cell * (1 - scale) * 0.5;
    const availW = cell - pad * 2, availH = cell - pad * 2;
    const r = Math.min(availW / img.width, availH / img.height);
    const w = img.width * r, h = img.height * r;
    const dx = px + (cell - w) / 2;
    const dy = py + (cell - h) - pad * 0.5;   // stand on the floor, not float
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = cell > 40;
    ctx.drawImage(img, dx, dy, w, h);
    ctx.globalAlpha = 1;
  }

  drawGlyph(ctx, ch, colour, px, py, cell, alpha = 1) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.font = `${Math.floor(cell * 0.86)}px ui-monospace, "DejaVu Sans Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, px + cell / 2, py + cell * 0.54);
    ctx.globalAlpha = 1;
  }

  drawTrail(ctx, v) {
    const { glyph, colour, cells } = this.overlayTrail;
    for (const c of cells) {
      const rx = c.x - v.ox, ry = c.y - v.oy;
      if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = colour;
      ctx.fillRect(rx * v.cell + v.cell * 0.3, ry * v.cell + v.cell * 0.3, v.cell * 0.4, v.cell * 0.4);
      ctx.globalAlpha = 1;
      this.drawGlyph(ctx, glyph, '#fff', rx * v.cell, ry * v.cell, v.cell, 1);
    }
  }

  drawCursor(ctx, v) {
    const rx = this.cursor.x - v.ox, ry = this.cursor.y - v.oy;
    ctx.strokeStyle = '#ffd75f';
    ctx.lineWidth = Math.max(2, v.cell * 0.08);
    ctx.strokeRect(rx * v.cell + 1, ry * v.cell + 1, v.cell - 2, v.cell - 2);
  }
}

function rgb(r, g, b, dim = 1) {
  const f = (n) => Math.max(0, Math.min(255, Math.round(n * dim)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

const HALLUC_GLYPHS = '@abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ&;:!?/*$%[](){}';
const HALLUC_COLOURS = ['#f85149', '#56d364', '#e3b341', '#bc8cff', '#79c0ff', '#ff8ac0', '#ffffff'];

function randomGlyph(id, turn) {
  return HALLUC_GLYPHS[hash2(id, turn) % HALLUC_GLYPHS.length];
}
function randomColour(id, turn) {
  return HALLUC_COLOURS[hash2(id + 7, turn) % HALLUC_COLOURS.length];
}
