// What survives a run.
//
// The dungeon has two kinds of money and the difference between them is the
// whole design:
//
//   embers (`player.souls`)  scraped off what you kill. Still warm, still
//                            yours only while you are alive - death spends
//                            them all, and there is no corpse to walk back to.
//
//   ash    (this file)       what an ember leaves when it goes out. Cold,
//                            permanent, kept in the Hall of Ashes, and the
//                            only thing a dead run leaves behind.
//
// You turn embers into ash at a hearth. That exchange is the decision the game
// is built around now: bank what you have, or carry it one floor deeper for a
// better rate and risk carrying it into a grave.
//
// Why buying rather than depositing: a deposit is safekeeping and has no
// number in it. A purchase has a RATE, and a rate is a dial - a deeper hearth
// can pay better, so "one more floor" is arithmetic rather than a mood.
//
// ---------------------------------------------------------------------------
//
// It also has to stop a farm. Enemies come back when you use a hearth, so
// anything permanent that could be earned from a renewable kill invites
// sitting on floor one forever. Two things prevent it, and both are load
// bearing:
//
//   1. embers die with you, so a farm has to walk back alive every time
//   2. the rate rises with depth, so the shallow farm is the worst rate in
//      the game
//
// Neither works alone. See docs/CURRENCY.md.

const KEY = 'claudesouls.meta.v1';

/** A fresh, empty hall. */
export function emptyMeta() {
  return { ash: 0, ranks: {}, runs: 0, clears: 0 };
}

export function loadMeta() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyMeta();
    const d = JSON.parse(raw);
    return {
      ash: Number(d.ash) || 0,
      ranks: d.ranks && typeof d.ranks === 'object' ? d.ranks : {},
      runs: Number(d.runs) || 0,
      clears: Number(d.clears) || 0,
    };
  } catch { return emptyMeta(); }
}

export function saveMeta(m) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

/**
 * What one ember is worth as ash, at this depth.
 *
 * Rising with depth is the second half of the anti-farm rule. Floor one pays a
 * tenth; the bottom pays a whole one. A player who never leaves the first
 * hearth is earning at the worst rate in the game, and no amount of patience
 * fixes that - the fix is to walk down, which is the thing the game wants.
 *
 * Deliberately not a cliff. A rate that jumped would make one particular floor
 * the only correct place to bank; a slope makes every hearth a slightly better
 * offer than the last, which is the question worth asking at each one.
 */
export function rateAt(depth) {
  return 0.1 + 0.09 * Math.max(0, depth - 1);
}

/** Embers in, ash out. Rounded down, so tiny sums are worth carrying deeper. */
export function ashFor(embers, depth) {
  return Math.floor(embers * rateAt(depth));
}
