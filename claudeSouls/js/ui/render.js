// The renderer.
//
// Copied from claudeHack and then changed where this game needs different
// things, which turned out to be four places. Copying rather than sharing was
// the right call: three of these four would have been `if (game === souls)` in
// a shared renderer.
//
//   1. **Facing.** Sprites rotate to face the way their owner is looking. This
//      is presentation only - no rule depends on it - but it is what makes a
//      wind-up readable at a glance, because you can see which way the brute is
//      turned before you read which tiles are lit. It costs nothing because the
//      art is top-down: rotating a top-down sprite is simply correct, which is
//      the payoff for having picked that camera when the art was generated.
//
//   2. **Telegraphs.** The tiles a winding-up enemy will hit are painted red,
//      brighter as the blow gets closer. This is the single most important
//      thing on screen and it is drawn under everything else so nothing can
//      hide it.
//
//   3. **Projectiles.** Arrows are objects on the board, so they are drawn.
//
//   4. **The aim preview.** While a skill is selected, the tiles it would hit
//      are outlined, so committing is never a guess.

import { T, TILE, isDoor, isBonfire } from '../map/tiles.js';
import { hash2 } from '../../../engine/util.js';
import { spriteRotation } from '../game/patterns.js';
import { STATE } from '../game/actors.js';

const SPRITE_DIR = '../assets/';

export class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.game = game;
    this.mode = 'tiles';
    this.zoom = 1;
    this.sprites = new Map();
    this.spriteState = new Map();
    this.overlayTrail = null;
    this.aim = null;              // {tiles:[{x,y}], dir}
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.resize();
  }

  sprite(name) {
    if (!name) return null;
    if (this.sprites.has(name)) return this.sprites.get(name);
    const st = this.spriteState.get(name);
    if (st === 'loading' || st === 'fail') return null;
    this.spriteState.set(name, 'loading');
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => { this.sprites.set(name, img); this.spriteState.set(name, 'ok'); this.draw(); };
    img.onerror = () => this.spriteState.set(name, 'fail');
    img.src = `${SPRITE_DIR}${name}.png`;
    return null;
  }

  preload(names) { for (const n of names) this.sprite(n); }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * this.dpr));
    const h = Math.max(1, Math.floor(rect.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  /**
   * Tiles are bigger here than in claudeHack, and that is a design requirement
   * rather than taste: the whole interface is "press a skill, drag out from
   * your character, release", and you cannot drag accurately onto a 20-pixel
   * tile with a thumb.
   */
  metrics() {
    const lvl = this.game.level;
    const W = this.canvas.width, H = this.canvas.height;
    let base;
    if (this.mode === 'ascii') {
      base = Math.max(Math.min(W / lvl.w, H / lvl.h), 9 * this.dpr);
    } else {
      // 9x6 rather than 13x8. On a 375px phone that is ~41 CSS pixels a tile
      // instead of ~29, which is the difference between recognising a brute by
      // its sprite and having to read the message log to find out what hit you.
      // Only binds on small screens: on a desktop the 92px cap below wins.
      // One number for both axes: the canvas is square (see #viewport in the
      // CSS), so guaranteeing nine columns and six rows would have promised an
      // asymmetric view on a square surface.
      const MIN_TILES = 9;
      base = Math.min(W, H) / MIN_TILES;
      base = Math.max(18 * this.dpr, Math.min(base, 92 * this.dpr));
    }
    const cell = Math.max(6, Math.floor(base * this.zoom));
    return { cell, cols: Math.ceil(W / cell), rows: Math.ceil(H / cell), W, H };
  }

  viewport() {
    const lvl = this.game.level;
    const p = this.game.player;
    const { cell, cols, rows, W, H } = this.metrics();
    let ox = cols >= lvl.w ? -Math.floor((cols - lvl.w) / 2)
                           : Math.max(0, Math.min(lvl.w - cols, p.x - Math.floor(cols / 2)));
    let oy = rows >= lvl.h ? -Math.floor((rows - lvl.h) / 2)
                           : Math.max(0, Math.min(lvl.h - rows, p.y - Math.floor(rows / 2)));
    return { cell, cols, rows, ox, oy, W, H };
  }

  cellAt(cssX, cssY) {
    const v = this.viewport();
    return {
      x: Math.floor((cssX * this.dpr) / v.cell) + v.ox,
      y: Math.floor((cssY * this.dpr) / v.cell) + v.oy,
    };
  }

  /** Centre of a map cell, in CSS pixels - the aim overlay needs this. */
  cellCentre(x, y) {
    const v = this.viewport();
    return {
      x: ((x - v.ox) * v.cell + v.cell / 2) / this.dpr,
      y: ((y - v.oy) * v.cell + v.cell / 2) / this.dpr,
    };
  }

  // ------------------------------------------------------------------ draw

  draw() {
    if (!this.game.level) return;
    this.resize();
    const ctx = this.ctx;
    const lvl = this.game.level;
    const p = this.game.player;
    const v = this.viewport();

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, v.W, v.H);

    // --- terrain
    for (let ry = 0; ry < v.rows; ry++) {
      for (let rx = 0; rx < v.cols; rx++) {
        const x = v.ox + rx, y = v.oy + ry;
        if (!lvl.inBounds(x, y)) continue;
        const i = lvl.idx(x, y);
        if (!lvl.seen[i] && !lvl.visible[i]) continue;
        this.drawTerrain(ctx, lvl, x, y, rx * v.cell, ry * v.cell, v.cell, !!lvl.visible[i]);
      }
    }

    // --- telegraphs, under the actors so nothing can obscure them
    this.drawTelegraphs(ctx, v);

    // --- the aim preview
    if (this.aim) this.drawAim(ctx, v);

    // --- enemies
    for (const e of lvl.enemies) {
      if (!e.alive) continue;
      const rx = e.x - v.ox, ry = e.y - v.oy;
      if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
      if (!lvl.isVisible(e.x, e.y)) continue;
      this.drawEnemy(ctx, e, rx * v.cell, ry * v.cell, v.cell);
    }

    // --- projectiles, above actors: they are the most urgent thing on screen
    for (const pr of lvl.projectiles) {
      const rx = pr.x - v.ox, ry = pr.y - v.oy;
      if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
      if (!lvl.isVisible(pr.x, pr.y)) continue;
      this.drawProjectile(ctx, pr, rx * v.cell, ry * v.cell, v.cell);
    }

    // --- the player
    this.drawPlayer(ctx, p, (p.x - v.ox) * v.cell, (p.y - v.oy) * v.cell, v.cell);

    // --- threats the bigger tiles pushed off the edge
    this.drawOffscreenThreats(ctx, v);

    if (this.overlayTrail) this.drawTrail(ctx, v);
  }

  // --------------------------------------------------------------- terrain

  drawTerrain(ctx, lvl, x, y, px, py, cell, visible) {
    const t = lvl.at(x, y);
    const dim = visible ? 1 : 0.38;

    if (this.mode === 'ascii') {
      ctx.fillStyle = '#07080a';
      ctx.fillRect(px, py, cell, cell);
      if (t === T.STONE) return;
      this.glyph(ctx, TILE[t].glyph, TILE[t].colour, px, py, cell, dim);
      return;
    }

    const n = lvl.noise[lvl.idx(x, y)];
    switch (t) {
      case T.STONE:
        ctx.fillStyle = '#05060a'; ctx.fillRect(px, py, cell, cell); break;
      case T.WALL: {
        const j = (n % 14) - 7;
        ctx.fillStyle = rgb(66 + j, 62 + j, 56 + j, dim);
        ctx.fillRect(px, py, cell, cell);
        ctx.fillStyle = rgb(98, 94, 86, dim);
        ctx.fillRect(px, py, cell, Math.max(1, cell * 0.13));
        ctx.fillStyle = rgb(10, 10, 14, dim);
        ctx.fillRect(px, py + cell - Math.max(1, cell * 0.1), cell, Math.max(1, cell * 0.1));
        break;
      }
      case T.PIT:
        this.floor(ctx, px, py, cell, n, dim, false);
        ctx.fillStyle = rgb(8, 8, 12, dim);
        ctx.beginPath();
        ctx.ellipse(px + cell / 2, py + cell / 2, cell * 0.38, cell * 0.34, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      case T.RUBBLE:
        this.floor(ctx, px, py, cell, n, dim, false);
        ctx.fillStyle = rgb(120, 114, 104, dim);
        for (let k = 0; k < 3; k++) {
          const h = hash2(x * 7 + k, y * 13 + k);
          const s = cell * (0.16 + (h % 10) / 60);
          ctx.fillRect(px + (h % Math.max(1, cell - s)), py + ((h >> 8) % Math.max(1, cell - s)), s, s);
        }
        break;
      default:
        this.floor(ctx, px, py, cell, n, dim, t === T.CORRIDOR);
        break;
    }

    if (isDoor(t)) this.drawDoor(ctx, t, px, py, cell, dim);
    else if (t === T.STAIRS_DOWN) this.feature(ctx, 'feat_stairs_down', '>', '#e8e2d0', px, py, cell, dim);
    else if (t === T.STAIRS_UP) this.feature(ctx, 'feat_stairs_up', '<', '#e8e2d0', px, py, cell, dim);
    else if (isBonfire(t)) this.drawBonfire(ctx, px, py, cell, dim);
  }

  floor(ctx, px, py, cell, n, dim, corridor) {
    const base = corridor ? 30 : 42;
    const j = (n % 11) - 5;
    ctx.fillStyle = rgb(base + j, base - 2 + j, base - 8 + j, dim);
    ctx.fillRect(px, py, cell, cell);
    if (cell >= 16 && (n & 7) === 0) {
      ctx.fillStyle = rgb(base + 20, base + 18, base + 12, dim);
      ctx.fillRect(px + ((n >> 3) % Math.max(1, cell - 3)),
                   py + ((n >> 5) % Math.max(1, cell - 3)),
                   Math.max(1, cell * 0.07), Math.max(1, cell * 0.07));
    }
  }

  drawDoor(ctx, t, px, py, cell, dim) {
    if (t === T.DOOR_CLOSED) {
      const img = this.sprite('feat_door');
      if (img) this.blit(ctx, img, px, py, cell, dim, 1, 0);
      else {
        ctx.fillStyle = rgb(140, 96, 48, dim);
        ctx.fillRect(px + cell * 0.08, py + cell * 0.08, cell * 0.84, cell * 0.84);
      }
    } else {
      ctx.fillStyle = rgb(116, 82, 42, dim);
      ctx.fillRect(px, py, cell * 0.16, cell);
      ctx.fillRect(px + cell * 0.84, py, cell * 0.16, cell);
    }
  }

  /** The one warm thing in the game; it should read from across the room. */
  drawBonfire(ctx, px, py, cell, dim) {
    const cx = px + cell / 2, cy = py + cell * 0.62;
    ctx.fillStyle = rgb(70, 56, 40, dim);
    ctx.fillRect(px + cell * 0.2, py + cell * 0.66, cell * 0.6, cell * 0.14);
    const t = (this.game.turn ?? 0) % 3;
    for (let k = 2; k >= 0; k--) {
      const r = cell * (0.13 + k * 0.075) + (k === t ? cell * 0.02 : 0);
      ctx.fillStyle = ['rgba(255,240,180,', 'rgba(255,160,60,', 'rgba(200,70,20,'][k] + (dim * 0.9) + ')';
      ctx.beginPath();
      ctx.ellipse(cx, cy - cell * 0.12, r * 0.7, r, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  feature(ctx, name, glyph, colour, px, py, cell, dim) {
    const img = this.sprite(name);
    if (img) this.blit(ctx, img, px, py, cell, dim, 1, 0);
    else this.glyph(ctx, glyph, colour, px, py, cell, dim);
  }

  // ------------------------------------------------------------ telegraphs

  drawTelegraphs(ctx, v) {
    const lvl = this.game.level;
    for (const e of lvl.enemies) {
      if (!e.alive || e.state !== STATE.WINDUP || !e.attackTiles) continue;
      if (!lvl.isVisible(e.x, e.y)) continue;
      // Brighter the closer the blow is. One turn out is unmistakable.
      const heat = 1 - Math.min(1, (e.timer - 1) / 3);
      for (const t of e.attackTiles) {
        const rx = t.x - v.ox, ry = t.y - v.oy;
        if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
        const a = 0.18 + heat * 0.4;
        ctx.fillStyle = `rgba(220,60,50,${a})`;
        ctx.fillRect(rx * v.cell, ry * v.cell, v.cell, v.cell);
        ctx.strokeStyle = `rgba(255,110,90,${0.35 + heat * 0.5})`;
        ctx.lineWidth = Math.max(1, v.cell * 0.05);
        ctx.strokeRect(rx * v.cell + 1, ry * v.cell + 1, v.cell - 2, v.cell - 2);
      }
    }
  }

  /**
   * Threats that are winding up outside the viewport.
   *
   * This is the bill for making the tiles bigger. The camera now shows nine
   * columns, the player's field of view is eleven tiles, and the horned one
   * telegraphs a six-tile charge lane - so it is entirely possible for
   * something to announce an attack that will reach you from off screen. A
   * telegraph you cannot see is not a telegraph, and the whole game is built on
   * the promise that every blow is announced, so the announcement has to
   * survive leaving the frame.
   *
   * Drawn as a marker pinned to the edge in the threat's direction, using the
   * same red and the same urgency ramp as the tiles themselves, so it reads as
   * the same language rather than as a new symbol to learn.
   */
  drawOffscreenThreats(ctx, v) {
    const lvl = this.game.level;
    const p = this.game.player;
    const px = (p.x - v.ox) * v.cell + v.cell / 2;
    const py = (p.y - v.oy) * v.cell + v.cell / 2;

    // Capped, not proportional: at 83 device pixels a tile an arrow scaled to
    // the grid is as big as the thing it is pointing at, and it lands on top of
    // the very telegraph squares it is meant to complement.
    const r = Math.min(v.cell * 0.3, 20 * this.dpr);
    const marks = [];
    for (const e of lvl.enemies) {
      if (!e.alive || e.state !== STATE.WINDUP) continue;
      if (!lvl.isVisible(e.x, e.y)) continue;
      const rx = e.x - v.ox, ry = e.y - v.oy;
      if (rx >= 0 && ry >= 0 && rx < v.cols && ry < v.rows) continue;
      marks.push({ x: e.x, y: e.y, heat: 1 - Math.min(1, (e.timer - 1) / 3) });
    }
    for (const pr of lvl.projectiles) {
      if (pr.fromPlayer) continue;
      const rx = pr.x - v.ox, ry = pr.y - v.oy;
      if (rx >= 0 && ry >= 0 && rx < v.cols && ry < v.rows) continue;
      if (!lvl.isVisible(pr.x, pr.y)) continue;
      marks.push({ x: pr.x, y: pr.y, heat: 0.75 });
    }
    if (!marks.length) return;

    for (const m of marks) {
      const tx = (m.x - v.ox) * v.cell + v.cell / 2;
      const ty = (m.y - v.oy) * v.cell + v.cell / 2;
      const cx = Math.max(r, Math.min(v.W - r, tx));
      const cy = Math.max(r, Math.min(v.H - r, ty));
      const ang = Math.atan2(ty - py, tx - px);
      const a = 0.55 + m.heat * 0.45;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      // A dark disc first, so the arrow is legible whether it lands on stone,
      // on floor, or on top of another telegraph.
      ctx.fillStyle = 'rgba(8,6,6,.72)';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(240,80,64,${a})`;
      ctx.strokeStyle = `rgba(255,190,170,${a})`;
      ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(r * 0.72, 0);
      ctx.lineTo(-r * 0.34, -r * 0.6);
      ctx.lineTo(-r * 0.1, 0);
      ctx.lineTo(-r * 0.34, r * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  drawAim(ctx, v) {
    for (const t of this.aim.tiles) {
      const rx = t.x - v.ox, ry = t.y - v.oy;
      if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
      ctx.fillStyle = 'rgba(120,200,255,.22)';
      ctx.fillRect(rx * v.cell, ry * v.cell, v.cell, v.cell);
      ctx.strokeStyle = 'rgba(150,220,255,.85)';
      ctx.lineWidth = Math.max(1, v.cell * 0.06);
      ctx.strokeRect(rx * v.cell + 1, ry * v.cell + 1, v.cell - 2, v.cell - 2);
    }
  }

  // --------------------------------------------------------------- actors

  drawEnemy(ctx, e, px, py, cell) {
    const winding = e.state === STATE.WINDUP;
    const spent = e.state === STATE.RECOVER || e.state === STATE.RESTING;

    if (this.mode === 'ascii') {
      this.glyph(ctx, e.glyph, winding ? '#ff8a70' : e.colour, px, py, cell, spent ? 0.55 : 1);
      this.facingPip(ctx, e.facing, px, py, cell, e.colour);
    } else {
      const img = this.sprite(e.sprite);
      if (img) this.blit(ctx, img, px, py, cell, spent ? 0.62 : 1, 1, spriteRotation(e.facing.dx, e.facing.dy, e.sprite));
      else this.glyph(ctx, e.glyph, e.colour, px, py, cell, spent ? 0.6 : 1);
    }

    // State badge. The player should never have to click to learn this.
    if (winding) {
      ctx.fillStyle = '#ff5a44';
      ctx.font = `bold ${Math.floor(cell * 0.5)}px ui-monospace, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('!', px + cell / 2, py + cell * 0.16);
      // Ticks for turns remaining, so "two away" and "one away" are distinct.
      for (let i = 0; i < e.timer; i++) {
        ctx.fillRect(px + cell * (0.62 + i * 0.12), py + cell * 0.08, cell * 0.08, cell * 0.14);
      }
    } else if (e.state === STATE.RECOVER) {
      this.glyph(ctx, '·', '#8fd48f', px + cell * 0.3, py - cell * 0.24, cell * 0.7, 1);
    } else if (e.state === STATE.RESTING) {
      this.glyph(ctx, '~', '#8fd48f', px + cell * 0.3, py - cell * 0.24, cell * 0.7, 1);
    }

    if (e.hp < e.hpMax && cell >= 16) {
      const w = cell * 0.72, h = Math.max(2, cell * 0.075);
      const bx = px + cell * 0.14, by = py + cell - h - 1;
      ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(bx, by, w, h);
      const frac = e.hp / e.hpMax;
      ctx.fillStyle = frac > 0.5 ? '#56d364' : frac > 0.25 ? '#e3b341' : '#f85149';
      ctx.fillRect(bx, by, w * frac, h);
    }
  }

  drawPlayer(ctx, p, px, py, cell) {
    // A warm pool of light under the player, drawn first.
    //
    // Not decoration: the generated hero sprites are dark-clothed figures on a
    // dark stone floor, and at 35 pixels a tile the player character was the
    // hardest thing on screen to find. In a game where the whole skill is
    // knowing which tile you are standing on relative to a red one, that is a
    // defect rather than a mood.
    const g = ctx.createRadialGradient(
      px + cell / 2, py + cell * 0.6, cell * 0.05,
      px + cell / 2, py + cell * 0.6, cell * 0.62);
    g.addColorStop(0, 'rgba(255,210,140,.42)');
    g.addColorStop(1, 'rgba(255,190,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - cell * 0.15, py - cell * 0.15, cell * 1.3, cell * 1.3);

    if (this.mode === 'ascii') {
      this.glyph(ctx, '@', '#ffffff', px, py, cell, 1);
      this.facingPip(ctx, p.facing, px, py, cell, '#ffd75f');
    } else {
      const img = this.sprite(p.sprite);
      if (img) this.blit(ctx, img, px, py, cell, 1, 1, spriteRotation(p.facing.dx, p.facing.dy, p.sprite));
      else this.glyph(ctx, '@', '#fff', px, py, cell, 1);
    }
  }

  drawProjectile(ctx, pr, px, py, cell) {
    ctx.save();
    ctx.translate(px + cell / 2, py + cell / 2);
    ctx.rotate(Math.atan2(pr.dy, pr.dx));
    ctx.fillStyle = pr.colour;
    ctx.fillRect(-cell * 0.3, -cell * 0.06, cell * 0.6, cell * 0.12);
    ctx.beginPath();
    ctx.moveTo(cell * 0.34, 0);
    ctx.lineTo(cell * 0.16, -cell * 0.15);
    ctx.lineTo(cell * 0.16, cell * 0.15);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** ASCII cannot rotate, so facing gets a pip on the relevant edge. */
  facingPip(ctx, f, px, py, cell, colour) {
    if (!f || (!f.dx && !f.dy)) return;
    const s = Math.max(2, cell * 0.12);
    const cx = px + cell / 2 + f.dx * cell * 0.38 - s / 2;
    const cy = py + cell / 2 + f.dy * cell * 0.38 - s / 2;
    ctx.fillStyle = colour;
    ctx.fillRect(cx, cy, s, s);
  }

  // ----------------------------------------------------------- primitives

  blit(ctx, img, px, py, cell, alpha = 1, scale = 1, angle = 0) {
    const pad = cell * (1 - scale) * 0.5;
    const r = Math.min((cell - pad * 2) / img.width, (cell - pad * 2) / img.height);
    const w = img.width * r, h = img.height * r;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = cell > 44;
    if (angle) {
      // Rotation is free and correct here because the art is drawn top-down.
      ctx.translate(px + cell / 2, py + cell / 2);
      ctx.rotate(angle);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      ctx.drawImage(img, px + (cell - w) / 2, py + (cell - h), w, h);
    }
    ctx.restore();
  }

  glyph(ctx, ch, colour, px, py, cell, alpha = 1) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    ctx.font = `${Math.floor(cell * 0.84)}px ui-monospace, "DejaVu Sans Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ch, px + cell / 2, py + cell * 0.54);
    ctx.globalAlpha = 1;
  }

  drawTrail(ctx, v) {
    const { colour, cells } = this.overlayTrail;
    for (const c of cells) {
      const rx = c.x - v.ox, ry = c.y - v.oy;
      if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
      ctx.fillStyle = colour;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(rx * v.cell, ry * v.cell, v.cell, v.cell);
      ctx.globalAlpha = 1;
    }
  }
}

function rgb(r, g, b, dim = 1) {
  const f = (n) => Math.max(0, Math.min(255, Math.round(n * dim)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
