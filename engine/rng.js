// Seeded pseudo-random number generation.
//
// Every random decision in claudeHack goes through one of these. That is a
// deliberate constraint, not a stylistic one: a run is reproducible from its
// seed alone, which makes bugs reportable ("seed 41d2, level 7, it crashed")
// and lets a save file store a seed plus a step count instead of a snapshot of
// the whole random stream.
//
// The generator is xoshiro128** - four words of state, passes PractRand well
// past what a roguelike will ever draw, and is trivially serialisable.

export class RNG {
  constructor(seed) {
    this.setSeed(seed);
  }

  /** Accepts a number or any string; strings are hashed. */
  setSeed(seed) {
    let h;
    if (typeof seed === 'number' && Number.isFinite(seed)) {
      h = seed >>> 0;
    } else {
      h = 2166136261 >>> 0;
      const s = String(seed ?? '');
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
    this.seedValue = seed;
    // splitmix32 to spread one word into four.
    this.s = new Uint32Array(4);
    for (let i = 0; i < 4; i++) {
      h = (h + 0x9e3779b9) >>> 0;
      let z = h;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      this.s[i] = (z ^ (z >>> 15)) >>> 0;
    }
    if ((this.s[0] | this.s[1] | this.s[2] | this.s[3]) === 0) this.s[0] = 1;
    this.count = 0;
  }

  /** Raw 32-bit draw. */
  next() {
    const s = this.s;
    const r = (Math.imul(rotl(Math.imul(s[1], 5) >>> 0, 7), 9) >>> 0);
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
    s[3] = rotl(s[3], 11);
    this.count++;
    return r >>> 0;
  }

  /** Float in [0,1). */
  float() { return this.next() / 4294967296; }

  /** Integer in [0,n) - NetHack calls this rn2. */
  rn2(n) { return n <= 0 ? 0 : this.next() % n; }

  /** Integer in [1,n] - NetHack calls this rnd. */
  rnd(n) { return this.rn2(n) + 1; }

  /** Integer in [lo,hi] inclusive. */
  int(lo, hi) { return hi <= lo ? lo : lo + this.rn2(hi - lo + 1); }

  /** n dice of d sides: d(2,6) is 2..12 with a bell. */
  d(n, sides) { let t = 0; for (let i = 0; i < n; i++) t += this.rnd(sides); return t; }

  /** True with probability 1/n. NetHack's !rn2(n). */
  oneIn(n) { return this.rn2(n) === 0; }

  /** True with probability p (0..1). */
  chance(p) { return this.float() < p; }

  pick(arr) { return arr.length ? arr[this.rn2(arr.length)] : undefined; }

  /** Pick by integer weight. Entries are [value, weight] or objects with .freq. */
  pickWeighted(entries, weightOf = (e) => e.freq ?? 1) {
    let total = 0;
    for (const e of entries) total += Math.max(0, weightOf(e));
    if (total <= 0) return this.pick(entries);
    let r = this.rn2(total);
    for (const e of entries) {
      r -= Math.max(0, weightOf(e));
      if (r < 0) return e;
    }
    return entries[entries.length - 1];
  }

  /** In-place Fisher-Yates. Returns the same array. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.rn2(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** NetHack's rne: geometric-ish tail used for enchantment magnitudes. */
  rne(x, luck = 0) {
    const bound = luck > 0 ? 10 : 5;
    let n = 1;
    while (n < bound && this.oneIn(x)) n++;
    return n;
  }

  /** NetHack's rnz: wildly-skewed timer values. */
  rnz(i) {
    let x = i;
    let tmp = 1000;
    tmp += this.rn2(1000);
    tmp *= this.rne(4);
    if (this.rn2(2)) { x *= tmp; x /= 1000; }
    else { x *= 1000; x /= tmp; }
    return Math.max(1, Math.round(x));
  }

  save() { return { s: Array.from(this.s), count: this.count, seedValue: this.seedValue }; }

  static load(data) {
    const r = new RNG(0);
    r.s = Uint32Array.from(data.s);
    r.count = data.count | 0;
    r.seedValue = data.seedValue;
    return r;
  }
}

function rotl(x, k) { return (((x << k) | (x >>> (32 - k))) >>> 0); }

/** A short human-typable seed like "swift-oak-1284". */
export function makeSeedPhrase(rng) {
  const a = ['swift', 'grim', 'hollow', 'ashen', 'quiet', 'brass', 'cruel', 'pale',
             'deep', 'bitter', 'gilded', 'rusted', 'silent', 'blind', 'iron', 'amber'];
  const b = ['oak', 'crypt', 'ember', 'lantern', 'grave', 'moth', 'kettle', 'thorn',
             'raven', 'anvil', 'chapel', 'cinder', 'vault', 'wyrm', 'quill', 'shroud'];
  return `${rng.pick(a)}-${rng.pick(b)}-${1000 + rng.rn2(9000)}`;
}
