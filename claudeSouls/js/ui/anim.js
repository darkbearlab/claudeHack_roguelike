// Turning "what happened" into "what you see happen".
//
// The rules resolve a whole turn at once, so everything in a turn is
// simultaneous in fact. What the eye needs is not the truth but the causal
// order: things moved, then things swung, then things were hit, then things
// died. So the show is staged by **kind of event**, not by actor - all the
// movement, then all the attacks, then all the hits, then all the deaths -
// and inside each stage everything plays at the same time.
//
// Two properties this had to have, both measured before it was written:
//
// **Constant cost.** Playing 10 events one after another at 120ms is 1.2
// seconds, and 10 is the *median* number of events in a turn here (5040 turns
// sampled), not the worst. Staging by kind means a turn costs the same whether
// one enemy acted or fourteen.
//
// **Empty stages cost nothing.** This game is mostly walking. If every stage
// took its slot, stepping down an empty corridor would take most of a second.
// A stage with no events in it takes zero time, so exploring stays instant and
// only fighting is paid for.
//
// The stages are offsets on one clock rather than a queue. A hit lands at the
// moment the lunge reaches full extension, not after the lunge has finished
// playing - same ordering guarantee, a third of the wall time.

const MOVE_MS = 130;
const ATTACK_MS = 150;
const HIT_MS = 190;
const DIE_MS = 340;
const LEVEL_MS = 260;      // the curtain over a floor change

/** How far into its own animation each stage begins, once it has content. */
const AFTER_MOVE = 105;    // the slide is nearly home before a swing starts
const TO_EXTENT = 65;      // a lunge's furthest point, where the blow lands
const AFTER_HIT = 90;

/** Nothing may leave its own tile far enough to be misread as another one. */
const LUNGE = 0.34;
const SHAKE = 0.13;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * Lay the events of one round on the clock.
 *
 * Returns the time the round finishes *gating* - deaths are excluded, because
 * particles are decoration and must never hold up the next thing you do.
 */
export function planRound(events, t0) {
  const has = (...kinds) => events.some((e) => kinds.includes(e.kind));
  const at = {};
  let t = t0;

  if (has('move')) { at.move = t; t += AFTER_MOVE; }
  if (has('attack')) { at.attack = t; t += TO_EXTENT; }
  if (has('hit', 'knock')) { at.hit = t; t += AFTER_HIT; }
  // Deaths hang off the hit that caused them, or off t0 if nothing hit.
  if (has('die')) at.die = at.hit ?? at.attack ?? t0;
  // A floor change plays at once and gates nothing: it is covering a cut that
  // has already happened, not delaying one.
  if (has('level')) at.level = t0;

  for (const e of events) {
    e.at = at[e.kind === 'knock' ? 'hit' : e.kind] ?? t0;
  }
  return t;
}

/**
 * Lay a whole cycle out and say how long it runs.
 *
 * Separated from the Animator so the two properties that matter can be tested
 * without a DOM: that the cost does not grow with the number of actors, and
 * that a round of theirs never starts before a round of yours has finished.
 */
export function planCycle(events) {
  const evs = events.map((e) => ({ ...e }));
  const r0 = evs.filter((e) => e.round === 0);
  const r1 = evs.filter((e) => e.round !== 0);
  const end0 = planRound(r0, 0);
  const end1 = planRound(r1, end0);
  const dur = (e) => ({ move: MOVE_MS, knock: MOVE_MS, attack: ATTACK_MS,
                        hit: HIT_MS, die: DIE_MS, level: LEVEL_MS }[e.kind] ?? 0);
  const span = evs.length ? Math.max(end1, ...evs.map((e) => e.at + dur(e))) : 0;
  return { events: evs, span, gateEnd: end1, roundBoundary: end0 };
}

export class Animator {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.events = [];
    this.particles = [];
    this.start = 0;
    this.span = 0;
    this.raf = 0;
    this.flash = 0;              // full-screen wash, for your own death
    this.curtain = 0;            // black over the map, for a floor change
  }

  get running() { return this.raf !== 0; }

  /** Time since playback began, in ms. */
  now() { return performance.now() - this.start; }

  /**
   * Play a cycle. Round 0 (what you did) is laid down first, and round 1
   * (what they did back) begins where round 0 stopped gating - so a kill you
   * scored finishes before the survivors answer, and a corpse is never seen
   * to swing.
   */
  play(events) {
    if (!events?.length) return false;
    this.stop();
    this.events = events.map((e) => ({ ...e }));
    this.particles = [];
    this.flash = 0;

    const plan = planCycle(this.events);
    this.events = plan.events;
    this.span = plan.span;
    this.start = performance.now();
    for (const e of this.events) e.spawned = false;
    this.tick();
    return true;
  }

  durationOf(e) {
    switch (e.kind) {
      case 'move': case 'knock': return MOVE_MS;
      case 'attack': return ATTACK_MS;
      case 'hit': return HIT_MS;
      case 'die': return DIE_MS;
      case 'level': return LEVEL_MS;
      default: return 0;
    }
  }

  tick = () => {
    const t = this.now();
    this.curtain = 0;
    for (const e of this.events) {
      if (e.kind !== 'level') continue;
      const p = clamp01((t - e.at) / LEVEL_MS);
      if (p < 1) this.curtain = Math.max(this.curtain, 1 - p);
    }
    this.spawnDue(t);
    this.stepParticles();
    this.onFrame();
    if (t >= this.span && !this.particles.length) { this.raf = 0; return; }
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Deaths become particles at their moment, not when the event was made. */
  spawnDue(t) {
    for (const e of this.events) {
      if (e.kind !== 'die' || e.spawned || t < e.at) continue;
      e.spawned = true;
      if (e.final) { this.flash = 1; continue; }   // your own death: see play()
      for (let i = 0; i < 16; i++) {
        const a = (Math.PI * 2 * i) / 16 + Math.random() * 0.4;
        const sp = 0.5 + Math.random() * 1.4;
        this.particles.push({
          x: e.x + 0.5, y: e.y + 0.5,
          vx: Math.cos(a) * sp * 0.030, vy: Math.sin(a) * sp * 0.030,
          life: 1,
          decay: 1 / (DIE_MS / 16.7) * (0.7 + Math.random() * 0.6),
        });
      }
    }
  }

  stepParticles() {
    for (const p of this.particles) {
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.90; p.vy *= 0.90;
      p.life -= p.decay;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - 0.04);
  }

  /**
   * The part of an actor's offset that the CAMERA is allowed to follow.
   *
   * Movement only. When you walk, the camera has to travel with the sprite or
   * it arrives at the new tile a frame after you press the key and the little
   * figure is left visibly running to catch up with its own viewport - the
   * world jumps, then you slide into it.
   *
   * A lunge and a flinch are the opposite case: they are the sprite leaving
   * its tile on purpose, and a camera that chased them would swing the whole
   * world every time anything swung at you. So the split is not "player vs
   * enemy", it is **displacement that means you went somewhere** versus
   * **displacement that means something happened to you**.
   */
  moveOffsetFor(uid) {
    if (!this.raf) return null;
    const t = this.now();
    let dx = 0, dy = 0;
    for (const e of this.events) {
      if (e.uid !== uid || (e.kind !== 'move' && e.kind !== 'knock')) continue;
      const p = clamp01((t - e.at) / this.durationOf(e));
      if (p <= 0 || p >= 1) continue;
      const ease = 1 - (1 - p) * (1 - p);
      dx += lerp(e.from.x - e.to.x, 0, ease);
      dy += lerp(e.from.y - e.to.y, 0, ease);
    }
    return (dx || dy) ? { dx, dy } : null;
  }

  /**
   * Where to draw an actor right now, relative to its own tile, in tiles.
   *
   * Sprite-local on purpose. The camera is locked to the player's tile centre,
   * and if a lunge offset reached the camera the whole world would lurch every
   * time you swung - which is precisely the jitter that locking it fixed.
   */
  offsetFor(uid) {
    if (!this.raf) return null;
    const t = this.now();
    let dx = 0, dy = 0, flash = 0;

    for (const e of this.events) {
      if (e.uid !== uid) continue;
      const p = clamp01((t - e.at) / this.durationOf(e));
      if (p <= 0 || p >= 1) continue;

      if (e.kind === 'move' || e.kind === 'knock') {
        // Start displaced back where it came from and slide home, so the
        // sprite arrives at the tile the rules already put it on.
        const ease = 1 - (1 - p) * (1 - p);
        dx += lerp(e.from.x - e.to.x, 0, ease);
        dy += lerp(e.from.y - e.to.y, 0, ease);
      } else if (e.kind === 'attack') {
        const out = Math.sin(p * Math.PI);          // out and back in one arc
        dx += (e.dx ?? 0) * out * LUNGE;
        dy += (e.dy ?? 0) * out * LUNGE;
      } else if (e.kind === 'hit') {
        dx += Math.sin(p * Math.PI * 7) * SHAKE * (1 - p);
        flash = Math.max(flash, 1 - p);
      }
    }
    return (dx || dy || flash) ? { dx, dy, flash } : null;
  }

  /** Snap everything to its final state. Any input does this. */
  skip() {
    if (!this.raf) return;
    this.stop();
    this.particles = [];
    this.flash = 0;
    this.curtain = 0;
    this.onFrame();
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
