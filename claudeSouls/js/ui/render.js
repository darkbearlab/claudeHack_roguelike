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

import { T, TILE, isDoor, isBonfire, isChasm } from '../map/tiles.js';
import { hash2 } from '../../../engine/util.js';
import { spriteRotation } from '../game/patterns.js';
import { STATE } from '../game/actors.js';
import { NPC_BY_KEY } from '../data/npcs.js';
import { MARK_BY_KEY } from '../data/marks.js';

const SPRITE_DIR = '../assets/';

export class Renderer {
  constructor(canvas, game) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.game = game;
    this.mode = 'tiles';
    this.zoom = 1;
    this.sprites = new Map();
    // One silhouette per sprite per colour, made once. See `tinted`.
    this.tints = new Map();
    this.spriteState = new Map();
    this.overlayTrail = null;
    this.aim = null;              // {tiles:[{x,y}], dir}
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.resize();
  }

  /**
   * A solid silhouette of a sprite, in one colour.
   *
   * The old comment here said tinting was rejected because it "means an
   * offscreen canvas per sprite per frame, and this has to run on a phone at
   * fourteen enemies". The premise was right and the conclusion was not: it is
   * a canvas per sprite per COLOUR, made once and kept. Two colours across
   * about thirty sprites is sixty small canvases for the life of the page, and
   * nothing is drawn twice.
   *
   * `source-in` keeps the alpha and replaces every colour, so what comes back
   * is the shape of the figure and nothing else - which is what a hit flash is.
   */
  tinted(name, colour) {
    const key = `${name}|${colour}`;
    if (this.tints.has(key)) return this.tints.get(key);
    const img = this.sprite(name);
    if (!img) return null;                 // still loading; try again next frame
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = colour;
    g.fillRect(0, 0, c.width, c.height);
    this.tints.set(key, c);
    return c;
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
    // Two extra of each: the sub-tile centring offset shifts the grid by up to
    // a tile, so the row and column at each edge would otherwise be missing.
    return { cell, cols: Math.ceil(W / cell) + 2, rows: Math.ceil(H / cell) + 2, W, H };
  }

  /**
   * The camera. It is locked to the player and never anything else.
   *
   * It used to clamp to the edges of the level so you never saw past them,
   * which meant the player's position on screen depended on how close to a wall
   * they were - and that made the view move for reasons that had nothing to do
   * with the player moving. Off the edge of the map is just black, which costs
   * nothing; a camera that shifts under your thumb mid-gesture costs a lot.
   *
   * `off` is the sub-tile correction. Tiles are a whole number of pixels and the
   * canvas is not a whole number of tiles, so snapping the grid to pixel zero
   * left the player up to most of a tile away from the middle. Everything drawn
   * on the map adds this offset, so the player's tile centre is the canvas
   * centre exactly.
   */
  viewport(animated = false) {
    const p = this.game.player;
    const { cell, cols, rows, W, H } = this.metrics();
    const ox = p.x - Math.floor(cols / 2);
    const oy = p.y - Math.floor(rows / 2);
    let offX = Math.round(W / 2 - ((p.x - ox) * cell + cell / 2));
    let offY = Math.round(H / 2 - ((p.y - oy) * cell + cell / 2));

    // Travel with the sprite while it is walking. The player's own move offset
    // is subtracted from the origin, which shifts the whole map by exactly the
    // amount the sprite is displaced - so the two cancel, the figure stays
    // pinned to the centre of the screen, and it is the world that slides.
    // Only movement: see Animator.moveOffsetFor.
    if (animated) {
      const m = this.anim?.moveOffsetFor(0);
      if (m) { offX -= Math.round(m.dx * cell); offY -= Math.round(m.dy * cell); }
    }
    return { cell, cols, rows, ox, oy, offX, offY, W, H };
  }

  cellAt(cssX, cssY) {
    const v = this.viewport();
    return {
      x: Math.floor((cssX * this.dpr - v.offX) / v.cell) + v.ox,
      y: Math.floor((cssY * this.dpr - v.offY) / v.cell) + v.oy,
    };
  }

  /** Centre of a map cell, in CSS pixels - the aim overlay needs this. */
  cellCentre(x, y) {
    const v = this.viewport();
    return {
      x: ((x - v.ox) * v.cell + v.cell / 2 + v.offX) / this.dpr,
      y: ((y - v.oy) * v.cell + v.cell / 2 + v.offY) / this.dpr,
    };
  }

  // ------------------------------------------------------------------ draw

  draw() {
    if (!this.game.level) return;
    this.resize();
    const ctx = this.ctx;
    const lvl = this.game.level;
    const p = this.game.player;
    // Drawing uses the travelling camera; hit-testing (cellAt / cellCentre)
    // deliberately does not, so which tile a tap lands on never depends on
    // how far through a walk animation the screen happens to be.
    const v = this.viewport(true);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, v.W, v.H);

    // --- terrain
    for (let ry = 0; ry < v.rows; ry++) {
      for (let rx = 0; rx < v.cols; rx++) {
        const x = v.ox + rx, y = v.oy + ry;
        if (!lvl.inBounds(x, y)) continue;
        const i = lvl.idx(x, y);
        if (!lvl.seen[i] && !lvl.visible[i]) continue;
        // Static hides the ground itself. Drawn instead of the terrain, not
        // over it, so nothing shows through.
        if (lvl.snow[i]) { this.drawSnow(ctx, x, y, rx * v.cell + v.offX, ry * v.cell + v.offY, v.cell); continue; }
        this.drawTerrain(ctx, lvl, x, y, rx * v.cell + v.offX, ry * v.cell + v.offY, v.cell, !!lvl.visible[i]);
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
      // Visible if ANY part of it is. Something four squares across should
      // not vanish because the corner it is anchored at happens to be behind
      // the door frame you are looking through.
      if (!e.bodyTiles().some((t) => lvl.isVisible(t.x, t.y))) continue;
      // Under the static you cannot see it. Its wind-up still draws - that is
      // the line, and it is drawn below the actors on purpose.
      if (e.bodyTiles().every((t) => lvl.snowAt(t.x, t.y))) continue;
      const off = this.anim?.offsetFor(e.uid);
      this.drawEnemy(ctx, e,
        rx * v.cell + v.offX + (off?.dx ?? 0) * v.cell,
        ry * v.cell + v.offY + (off?.dy ?? 0) * v.cell, v.cell, off?.flash ?? 0, e.size);
    }

    // --- people, under the enemies and the player. They never move and they
    // cannot be hit, so nothing they could overlap is ever urgent.
    for (const n of lvl.npcs) {
      const rx = n.x - v.ox, ry = n.y - v.oy;
      if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
      if (!lvl.isVisible(n.x, n.y)) continue;
      if (lvl.snowAt(n.x, n.y)) continue;
      this.drawNpc(ctx, n, rx * v.cell + v.offX, ry * v.cell + v.offY, v.cell);
    }

    // --- projectiles, above actors: they are the most urgent thing on screen
    for (const pr of lvl.projectiles) {
      const rx = pr.x - v.ox, ry = pr.y - v.oy;
      if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
      if (!lvl.isVisible(pr.x, pr.y)) continue;
      if (lvl.snowAt(pr.x, pr.y)) continue;
      this.drawProjectile(ctx, pr, rx * v.cell + v.offX, ry * v.cell + v.offY, v.cell);
    }

    // --- the player. The offset is added HERE, to the sprite, and never to
    // the view origin - the camera is locked to the player's tile centre, and
    // an offset that reached it would lurch the whole world on every swing.
    const poff = this.anim?.offsetFor(0);
    this.drawPlayer(ctx, p,
      (p.x - v.ox) * v.cell + v.offX + (poff?.dx ?? 0) * v.cell,
      (p.y - v.oy) * v.cell + v.offY + (poff?.dy ?? 0) * v.cell, v.cell, poff?.flash ?? 0);

    // --- threats the bigger tiles pushed off the edge
    this.drawOffscreenThreats(ctx, v);

    if (this.overlayTrail) this.drawTrail(ctx, v);

    // --- death, above everything: it is the one thing you must not miss
    this.drawParticles(ctx, v);

    // --- the curtain over a floor change, above even that
    const curtain = this.anim?.curtain ?? 0;
    if (curtain > 0) {
      ctx.save();
      ctx.fillStyle = `rgba(0,0,0,${curtain})`;
      ctx.fillRect(0, 0, v.W, v.H);
      ctx.restore();
    }
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
      case T.CHASM: {
        // Drawn as absence, not as an object. No floor underneath, no outline
        // of its own - the only edge you see is the lit lip of whatever solid
        // ground it borders, which is what makes a stretch of it read as one
        // opening rather than as a row of holes.
        ctx.fillStyle = '#04050a';
        ctx.fillRect(px, py, cell, cell);
        const lipN = !isChasm(lvl.at(x, y - 1)) && lvl.at(x, y - 1) !== T.STONE;
        if (lipN) {
          ctx.fillStyle = rgb(60, 56, 50, dim);
          ctx.fillRect(px, py, cell, Math.max(1, cell * 0.16));
        }
        break;
      }
      case T.BRIDGE: {
        // A made thing: planks across, and a rail on whichever sides face the
        // drop. It has to be obvious at a glance that this is the way over.
        ctx.fillStyle = rgb(96, 74, 48, dim);
        ctx.fillRect(px, py, cell, cell);
        ctx.fillStyle = rgb(70, 52, 32, dim);
        for (let k = 1; k < 4; k++) {
          ctx.fillRect(px, py + (cell * k) / 4, cell, Math.max(1, cell * 0.05));
        }
        ctx.fillStyle = rgb(150, 120, 82, dim);
        for (const [dx, dy] of [[0, -1], [0, 1]]) {
          if (!isChasm(lvl.at(x + dx, y + dy))) continue;
          ctx.fillRect(px, dy < 0 ? py : py + cell - Math.max(1, cell * 0.12),
                       cell, Math.max(1, cell * 0.12));
        }
        break;
      }
      case T.PILLAR: {
        // Drawn as a column standing ON the floor rather than as a chunk of
        // wall: it is inside a room, and reading it as wall would make the
        // room look broken instead of built.
        this.floor(ctx, px, py, cell, n, dim, false);
        const j = (n % 10) - 5;
        const w = cell * 0.62, o = (cell - w) / 2;
        ctx.fillStyle = rgb(20, 19, 22, dim * 0.55);          // its shadow
        ctx.fillRect(px + o + cell * 0.08, py + o + cell * 0.12, w, w);
        ctx.fillStyle = rgb(126 + j, 120 + j, 110 + j, dim);
        ctx.fillRect(px + o, py + o, w, w);
        ctx.fillStyle = rgb(160, 154, 142, dim);              // lit top edge
        ctx.fillRect(px + o, py + o, w, Math.max(1, cell * 0.1));
        ctx.fillStyle = rgb(70, 66, 60, dim);                 // shaded base
        ctx.fillRect(px + o, py + o + w - Math.max(1, cell * 0.12), w, Math.max(1, cell * 0.12));
        break;
      }
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

    if (isDoor(t)) this.drawDoor(ctx, t, px, py, cell, dim, x, y);
    else if (t === T.STAIRS_DOWN) this.feature(ctx, 'feat_stairs_down', '>', '#e8e2d0', px, py, cell, dim);
    else if (t === T.STAIRS_UP) this.feature(ctx, 'feat_stairs_up', '<', '#e8e2d0', px, py, cell, dim);
    else if (isBonfire(t)) this.drawBonfire(ctx, px, py, cell, dim);
    else if (t === T.CHEST) this.feature(ctx, 'feat_chest', '(', '#c08a3c', px, py, cell, dim);
    else if (t === T.CORPSE) this.feature(ctx, 'item_bones', '%', '#d8d0c0', px, py, cell, dim);
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

  drawDoor(ctx, t, px, py, cell, dim, x, y) {
    // Two leaves are one door. A closed door with a closed door beside it
    // is one leaf of a double door, and the pair is drawn as one piece: the
    // single-leaf art once, and once mirrored, so the hinges sit on the
    // outside and the handles meet in the middle. It is the door art that
    // was already in the game - a wide one squashed into the generator's
    // portrait frame read worse than the mirror does.
    const lvl = this.game.level;
    const closed = (tx, ty) => lvl?.at(tx, ty) === T.DOOR_CLOSED;
    const open = (tx, ty) => lvl?.at(tx, ty) === T.DOOR_OPEN;
    if (t === T.DOOR_CLOSED) {
      const img = this.sprite('feat_door');
      if (!img) {
        ctx.fillStyle = rgb(140, 96, 48, dim);
        ctx.fillRect(px + cell * 0.08, py + cell * 0.08, cell * 0.84, cell * 0.84);
        return;
      }
      let flipX = false, flipY = false, angle = 0;
      if (closed(x + 1, y) || closed(x - 1, y)) flipX = closed(x - 1, y);          // horizontal pair
      else if (closed(x, y + 1) || closed(x, y - 1)) { angle = Math.PI / 2; flipY = closed(x, y - 1); }
      const r = Math.min(cell / img.width, cell / img.height);
      const w = img.width * r, h = img.height * r;
      ctx.save();
      ctx.globalAlpha = dim;
      ctx.imageSmoothingEnabled = cell > 44;
      ctx.translate(px + cell / 2, py + cell / 2);
      if (angle) ctx.rotate(angle);
      ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    } else {
      // Open: the frame's posts. On a pair only the outer post of each leaf,
      // so the opening reads as one wide gap.
      ctx.fillStyle = rgb(116, 82, 42, dim);
      if (open(x + 1, y) || open(x - 1, y)) {
        if (!open(x - 1, y)) ctx.fillRect(px, py, cell * 0.16, cell);
        if (!open(x + 1, y)) ctx.fillRect(px + cell * 0.84, py, cell * 0.16, cell);
      } else if (open(x, y + 1) || open(x, y - 1)) {
        if (!open(x, y - 1)) ctx.fillRect(px, py, cell, cell * 0.16);
        if (!open(x, y + 1)) ctx.fillRect(px, py + cell * 0.84, cell, cell * 0.16);
      } else {
        ctx.fillRect(px, py, cell * 0.16, cell);
        ctx.fillRect(px + cell * 0.84, py, cell * 0.16, cell);
      }
    }
  }

  /**
   * Television snow.
   *
   * Animated off the turn counter rather than the clock, so it crawls when the
   * game moves and holds still when the game does - a still frame of this is a
   * still frame of the world, which is what the anomaly is meant to feel like.
   */
  drawSnow(ctx, x, y, px, py, cell) {
    const t = this.game.turn ?? 0;
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(px, py, cell, cell);
    const grain = Math.max(1, Math.round(cell / 8));
    const n = Math.max(6, Math.round((cell / grain) * (cell / grain) * 0.34));
    for (let k = 0; k < n; k++) {
      const h = hash2(x * 131 + k * 17 + t * 7, y * 89 + k * 29 - t * 5);
      const gx = px + (h % Math.max(1, cell - grain + 1));
      const gy = py + ((h >> 9) % Math.max(1, cell - grain + 1));
      const v = 70 + ((h >> 3) % 150);
      ctx.fillStyle = `rgb(${v},${v},${v + 6})`;
      ctx.fillRect(gx, gy, grain, grain);
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

    // Your own declared blow, drawn in the same language as theirs but cool
    // rather than hot. It has to be on screen for the same reason every enemy
    // wind-up is: an attack that resolves next turn and cannot be seen is not
    // a commitment, it is a surprise you inflicted on yourself.
    const c = this.game.player.charging;
    if (c?.tiles) {
      for (const t of c.tiles) {
        const rx = t.x - v.ox, ry = t.y - v.oy;
        if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
        ctx.fillStyle = 'rgba(120,180,235,.26)';
        ctx.fillRect(rx * v.cell + v.offX, ry * v.cell + v.offY, v.cell, v.cell);
        ctx.strokeStyle = 'rgba(160,210,255,.7)';
        ctx.lineWidth = Math.max(1, v.cell * 0.05);
        ctx.strokeRect(rx * v.cell + v.offX + 1, ry * v.cell + v.offY + 1, v.cell - 2, v.cell - 2);
      }
    }
    for (const e of lvl.enemies) {
      if (!e.alive || e.state !== STATE.WINDUP || !e.attackTiles) continue;
      if (!lvl.isVisible(e.x, e.y)) continue;
      // Brighter the closer the blow is. One turn out is unmistakable.
      const heat = 1 - Math.min(1, (e.timer - 1) / 3);
      for (const t of e.attackTiles) {
        const rx = t.x - v.ox, ry = t.y - v.oy;
        if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
        // Static hides the telegraph too - but the player always stands in a
        // cleared 3x3, so the part of a blow that can reach them is always
        // drawn. You always know whether you are in it; what the static takes
        // is how far it goes, which is the difference between reacting and
        // knowing where to run. See Level.castSnow.
        if (lvl.snowAt(t.x, t.y)) continue;
        const a = 0.18 + heat * 0.4;
        ctx.fillStyle = `rgba(220,60,50,${a})`;
        ctx.fillRect(rx * v.cell + v.offX, ry * v.cell + v.offY, v.cell, v.cell);
        ctx.strokeStyle = `rgba(255,110,90,${0.35 + heat * 0.5})`;
        ctx.lineWidth = Math.max(1, v.cell * 0.05);
        ctx.strokeRect(rx * v.cell + v.offX + 1, ry * v.cell + v.offY + 1, v.cell - 2, v.cell - 2);
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
    const px = (p.x - v.ox) * v.cell + v.cell / 2 + v.offX;
    const py = (p.y - v.oy) * v.cell + v.cell / 2 + v.offY;

    // Capped, not proportional: at 83 device pixels a tile an arrow scaled to
    // the grid is as big as the thing it is pointing at, and it lands on top of
    // the very telegraph squares it is meant to complement.
    const r = Math.min(v.cell * 0.3, 20 * this.dpr);
    // "Off screen" is measured in pixels, not in grid columns. The grid is two
    // tiles wider than the canvas so the sub-tile centring offset has something
    // to draw at the edges, so a tile can be inside `cols` and still be off the
    // side of the canvas - and that tile is exactly the one that needs a marker.
    const onScreen = (x, y) => {
      const sx = (x - v.ox) * v.cell + v.offX, sy = (y - v.oy) * v.cell + v.offY;
      return sx + v.cell > 0 && sy + v.cell > 0 && sx < v.W && sy < v.H;
    };

    const marks = [];
    for (const e of lvl.enemies) {
      if (!e.alive || e.state !== STATE.WINDUP) continue;
      if (!lvl.isVisible(e.x, e.y)) continue;
      if (onScreen(e.x, e.y)) continue;
      marks.push({ x: e.x, y: e.y, heat: 1 - Math.min(1, (e.timer - 1) / 3) });
    }
    for (const pr of lvl.projectiles) {
      if (pr.fromPlayer) continue;
      if (onScreen(pr.x, pr.y)) continue;
      if (!lvl.isVisible(pr.x, pr.y)) continue;
      marks.push({ x: pr.x, y: pr.y, heat: 0.75 });
    }
    if (!marks.length) return;

    for (const m of marks) {
      const tx = (m.x - v.ox) * v.cell + v.cell / 2 + v.offX;
      const ty = (m.y - v.oy) * v.cell + v.cell / 2 + v.offY;
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
      ctx.fillRect(rx * v.cell + v.offX, ry * v.cell + v.offY, v.cell, v.cell);
      ctx.strokeStyle = 'rgba(150,220,255,.85)';
      ctx.lineWidth = Math.max(1, v.cell * 0.06);
      ctx.strokeRect(rx * v.cell + v.offX + 1, ry * v.cell + v.offY + 1, v.cell - 2, v.cell - 2);
    }
  }

  // --------------------------------------------------------------- actors

  drawEnemy(ctx, e, px, py, cell, hurt = 0) {
    // Everything below is measured in the creature's own footprint rather
    // than in tiles, so a 2x2 gets a sprite, a hit flash, a halo and a
    // wind-up badge that are all twice the size - one creature, drawn once,
    // at the size it actually is.
    const span = cell * (e.size ?? 1);
    const winding = e.state === STATE.WINDUP;
    const spent = e.state === STATE.RECOVER || e.state === STATE.RESTING;

    if (this.mode === 'ascii') {
      this.glyph(ctx, e.glyph, winding ? '#ff8a70' : e.colour, px, py, span, spent ? 0.55 : 1);
      this.facingPip(ctx, e.facing, px, py, span, e.colour);
    } else {
      const img = this.sprite(e.sprite);
      if (img) this.blit(ctx, img, px, py, span, spent ? 0.62 : 1, 1, spriteRotation(e.facing.dx, e.facing.dy, e.sprite));
      else this.glyph(ctx, e.glyph, e.colour, px, py, span, spent ? 0.6 : 1);
    }

    // An elite is a normal species with more of it, so it needs to be readable
    // as one at a glance - the sprite is the same and the name only shows in
    // the log.
    if (hurt > 0) {
      this.hurtFlash(ctx, this.mode === 'ascii' ? null : e.sprite, px, py, span, hurt,
                     '#ffffff', spriteRotation(e.facing.dx, e.facing.dy, e.sprite));
    }

    if (e.elite) this.glow(ctx, px, py, span, 232, 150, 60);

    // The clock, above the head. Replaces the `!` and its tick marks: the
    // exclamation said THAT something was coming and the ticks said when, in
    // two different alphabets, and neither of them was the alphabet the
    // player's own skill buttons already use.
    this.drawClock(ctx, px, py, span, e.clock, e.clockPassed);
    // Out of stamina is not a commitment - it has no length, so it gets no
    // dots. It stays its own mark rather than borrowing the clock's.
    if (e.state === STATE.RESTING) {
      this.glyph(ctx, '~', '#8fd48f', px + span * 0.3, py - span * 0.24, span * 0.7, 1);
    }

    if (e.hp < e.hpMax && span >= 16) {
      const w = span * 0.72, h = Math.max(2, span * 0.075);
      const bx = px + span * 0.14, by = py + span - h - 1;
      ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(bx, by, w, h);
      const frac = e.hp / e.hpMax;
      ctx.fillStyle = frac > 0.5 ? '#56d364' : frac > 0.25 ? '#e3b341' : '#f85149';
      ctx.fillRect(bx, by, w * frac, h);
    }

    this.drawMarks(ctx, e, px, py, span);
  }

  /**
   * The whole committed action, as a row you read left to right.
   *
   *     ○ ○ ● ○        two turns of wind-up, the blow, one turn of recovery
   *     ▪ ○ ● ○        one turn in: the first pip has gone grey
   *
   *   hollow red     a turn where nothing happens yet
   *   SOLID red      the turn the blow actually lands
   *   hollow green   a turn they cannot act
   *   grey           already spent
   *
   * The first version of this drew only what REMAINED, and the row shrank as
   * it went. That could not say the one thing the player most needs, which is
   * *when* - it drew "two turns of wind-up" and left them to work out that the
   * blow falls on the third. A fixed row that greys as it runs says both, and
   * says it in the same glance.
   *
   * Colour says what, not who: red is a wind-up wherever it appears, green is
   * a recovery wherever it appears. An enemy wearing green is your opening; you
   * wearing green are its opening. Colouring by side would read more easily and
   * say nothing - the player already knows which one is theirs.
   *
   * More than one solid pip means the commitment owes more than one blow. A
   * charge still ANNOUNCES one stride at a time on purpose (see beginWindup) -
   * this does not reveal where the next one lands, only that it is owed.
   *
   * The floor keeps the shape and this keeps the time. They never overlap.
   */
  drawClock(ctx, px, py, span, clock, passed = 0) {
    if (!clock || span < 14) return;
    const { windup = 0, strikes = 1, recovery = 0 } = clock;
    const n = Math.min(8, windup + strikes + recovery);
    if (n <= 0) return;

    // The row has to stay over its own creature. Eight pips at a comfortable
    // size are wider than a 35-pixel tile, and in a game whose entire skill is
    // knowing which tile you are standing on, a clock you read off the wrong
    // body is worse than no clock. The pips shrink to fit; the row never grows.
    const wide = span * 1.05;
    const r = Math.max(1.5, Math.min(span * 0.085, wide / (n * 2.7)));
    const gap = r * 2.7;
    const y = py - r * 1.5;
    let x = px + span / 2 - (gap * (n - 1)) / 2;

    for (let i = 0; i < n; i++) {
      // Read left to right, it is the whole commitment: the turns before
      // anything happens, the turn it lands, the turns they cannot answer.
      const strike = i >= windup && i < windup + strikes;
      const solid = strike;
      const done = i < passed;
      const colour = done ? '#5a5a66' : strike ? '#ff5a44' : i < windup ? '#ff5a44' : '#56d364';

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      // A dark disc behind every pip, so the row reads against pale stone and
      // against the static.
      ctx.fillStyle = 'rgba(0,0,0,.72)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, r * 0.55);
      ctx.strokeStyle = colour;
      ctx.stroke();
      if (solid) {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.fill();
      }
      x += gap;
    }
  }

  /**
   * The farwayer's marks, along the top of whatever is carrying them.
   *
   * Drawn as coloured pips rather than glyphs: at a 35-pixel tile there is
   * room for five of something small and none of something legible, and what
   * the player needs from across the board is HOW MANY and WHICH - the exact
   * question the multiplier asks. The names are in the log.
   *
   * The count is the whole readout. Four pips means the next repeat is worth
   * five times, and that is a decision, so it has to be on the creature and
   * not in a panel.
   */
  drawMarks(ctx, e, px, py, span) {
    const n = e.marks?.size ?? 0;
    if (!n || span < 12) return;
    const r = Math.max(1.5, span * 0.06);
    const gap = r * 2.6;
    let x = px + span / 2 - (gap * (n - 1)) / 2;
    // Along the bottom, above the health bar. The clock owns the top of the
    // creature now, and two rows of coloured dots on one head is a smear.
    const y = py + span - r * 3.2;
    for (const key of e.marks.keys()) {
      const m = MARK_BY_KEY[key];
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = m?.colour ?? '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.stroke();
      x += gap;
    }
  }

  drawPlayer(ctx, p, px, py, cell, hurt = 0) {
    // A warm pool of light under the player, drawn first.
    //
    // Not decoration: the generated hero sprites are dark-clothed figures on a
    // dark stone floor, and at 35 pixels a tile the player character was the
    // hardest thing on screen to find. In a game where the whole skill is
    // knowing which tile you are standing on relative to a red one, that is a
    // defect rather than a mood.
    this.glow(ctx, px, py, cell, 255, 205, 135);

    if (this.mode === 'ascii') {
      this.glyph(ctx, '@', '#ffffff', px, py, cell, 1);
      this.facingPip(ctx, p.facing, px, py, cell, '#ffd75f');
    } else {
      const img = this.sprite(p.sprite);
      if (img) this.blit(ctx, img, px, py, cell, 1, 1, spriteRotation(p.facing.dx, p.facing.dy, p.sprite));
      else this.glyph(ctx, '@', '#fff', px, py, cell, 1);
    }
    if (hurt > 0) {
      this.hurtFlash(ctx, this.mode === 'ascii' ? null : p.sprite, px, py, cell, hurt,
                     '#e22e28', spriteRotation(p.facing.dx, p.facing.dy, p.sprite));
    }

    // The same clock the enemies wear. A declared blow of your own is one
    // hollow dot - it lands next turn and can still be taken from you - and a
    // recovery is that many solid ones. The buttons say what an action WILL
    // cost; this says what you are already paying, which is the half you can
    // no longer choose.
    this.drawClock(ctx, px, py, cell, p.clock, p.clockPassed);
  }

  /**
   * The red that says "that one landed".
   *
   * Inset rather than filling the cell: a full tile of red reads as something
   * happening to the *floor*, and this is the one moment the player needs to
   * attribute to a creature. Kept as a wash rather than a tint of the sprite
   * because tinting means an offscreen canvas per sprite per frame, and this
   * has to run on a phone at fourteen enemies.
   */
  /**
   * The flash that says "that one landed".
   *
   * The whole figure, not a box around it: at 35 pixels a tile an inset
   * rectangle reads as something happening to the FLOOR, and this is the one
   * moment the player has to attribute to a creature.
   *
   * White for them, red for you. Colour is the only thing separating the two,
   * so it carries the whole message - a flash you cannot place is worse than
   * none, because the screen has just told you that something happened
   * somewhere.
   *
   * Falls back to the old wash when there is no sprite to silhouette (ASCII
   * mode, or art that has not loaded yet).
   */
  hurtFlash(ctx, name, px, py, cell, a, colour, angle = 0) {
    const tint = name ? this.tinted(name, colour) : null;
    if (!tint) { this.hurtWash(ctx, px, py, cell, a); return; }
    this.blit(ctx, tint, px, py, cell, Math.min(1, a), 1, angle);
  }

  hurtWash(ctx, px, py, cell, a) {
    const pad = cell * 0.11;
    ctx.save();
    ctx.fillStyle = `rgba(226,46,40,${0.62 * a})`;
    ctx.fillRect(px + pad, py + pad, cell - pad * 2, cell - pad * 2);
    ctx.strokeStyle = `rgba(255,150,130,${0.8 * a})`;
    ctx.lineWidth = Math.max(1, cell * 0.04);
    ctx.strokeRect(px + pad, py + pad, cell - pad * 2, cell - pad * 2);
    ctx.restore();
  }

  drawParticles(ctx, v) {
    const ps = this.anim?.particles;
    if (!ps?.length) return;
    ctx.save();
    for (const q of ps) {
      const rx = q.x - v.ox, ry = q.y - v.oy;
      if (rx < 0 || ry < 0 || rx >= v.cols || ry >= v.rows) continue;
      const s = Math.max(1.5, v.cell * 0.11) * (0.4 + q.life * 0.6);
      ctx.globalAlpha = Math.max(0, Math.min(1, q.life));
      ctx.fillStyle = q.life > 0.55 ? '#ff5a4a' : '#8e1f1c';
      ctx.fillRect(rx * v.cell + v.offX - s / 2, ry * v.cell + v.offY - s / 2, s, s);
    }
    ctx.restore();
  }

  /**
   * A pool of light under something, to say "this one matters".
   *
   * A ring was tried twice - once under the player, once under an elite - and
   * removed both times: at tile size it reads as a UI decoration sitting on the
   * floor rather than as part of the creature. A glow reads as the thing
   * itself, and the colour is free to carry meaning, so this is also where
   * enemy tiers would go if they arrive.
   */
  glow(ctx, px, py, cell, r, g, b, strength = 0.42) {
    const grad = ctx.createRadialGradient(
      px + cell / 2, py + cell * 0.6, cell * 0.05,
      px + cell / 2, py + cell * 0.6, cell * 0.62);
    grad.addColorStop(0, `rgba(${r},${g},${b},${strength})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(px - cell * 0.15, py - cell * 0.15, cell * 1.3, cell * 1.3);
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

  /**
   * Someone sitting by the fire.
   *
   * Never rotated. The art is a seated figure with her head bowed, and turning
   * that to face you would read as her spinning on the spot - the rotation
   * trick works for the roster because every one of them is drawn standing and
   * symmetrical about its own axis. `NPCS[].still` says so per person rather
   * than assuming it of everyone who is ever added here.
   */
  drawNpc(ctx, n, px, py, cell) {
    const spec = NPC_BY_KEY[n.key];
    if (!spec) return;
    if (this.mode === 'ascii') {
      this.glyph(ctx, spec.glyph, spec.colour, px, py, cell, 1);
      return;
    }
    const img = this.sprite(spec.sprite);
    if (img) this.blit(ctx, img, px, py, cell, 1, 1, spec.still ? 0 : 0);
    else this.glyph(ctx, spec.glyph, spec.colour, px, py, cell, 1);
    // A cool halo, so she reads as a fixture rather than a thing to fight -
    // the warm one belongs to the player and the amber one to elites. Fainter
    // than either: hers says "someone is here", not "look at this".
    this.glow(ctx, px, py, cell, 150, 170, 220, 0.22);
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
      ctx.fillRect(rx * v.cell + v.offX, ry * v.cell + v.offY, v.cell, v.cell);
      ctx.globalAlpha = 1;
    }
  }
}

function rgb(r, g, b, dim = 1) {
  const f = (n) => Math.max(0, Math.min(255, Math.round(n * dim)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}
