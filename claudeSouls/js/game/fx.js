// What just happened, for the part of the program that draws it.
//
// `worldTurn()` is completely synchronous: it resolves projectiles, every
// enemy, every hit and every death, and only then does anyone get to render.
// So by the time a show could start, the things it needs to show are gone -
// the dead are off the enemy list, the knocked-back are already at their new
// tile, and an enemy that moved, swung and died leaves only the last of those
// three visible in the final state.
//
// The animation therefore cannot read the state; it has to be told. This is
// the telling. The rules stay synchronous and stay ignorant - they push a
// line into a list - and the UI turns that list into a timeline. Same shape as
// the renderer deriving everything else from game state, one step removed.
//
// Off unless a real UI switched it on. The bot runs sixty thousand steps and
// must not pay for a log nobody reads.

/** The player is uid 0; enemy uids start at 1. */
export const PLAYER_UID = 0;

export const uidOf = (actor) => (actor?.isPlayer ? PLAYER_UID : actor?.uid ?? -1);

export class FxLog {
  constructor() {
    this.enabled = false;
    this.events = [];
    this.round = 0;
    this.before = new Map();
  }

  /** Start a round: 0 is what you did, 1 is what they did back. */
  begin(round, game) {
    if (!this.enabled) return;
    this.round = round;
    this.depth = game.player.depth;
    this.before.clear();
    const p = game.player;
    this.before.set(PLAYER_UID, { x: p.x, y: p.y });
    for (const e of game.level?.enemies ?? []) {
      if (e.alive) this.before.set(e.uid, { x: e.x, y: e.y });
    }
  }

  add(ev) {
    if (!this.enabled) return;
    ev.round = this.round;
    this.events.push(ev);
  }

  /**
   * Close a round, turning position changes into movement events.
   *
   * Movement is diffed rather than reported by the code that moves things.
   * There are a lot of ways to change tile in this game - walking, rolling,
   * a dash attack, knockback, a charge - and instrumenting each of them would
   * have meant finding all of them, which historically this project does not
   * manage in one go. A diff cannot miss one.
   *
   * The classification matters though: a shove is movement *caused by a hit*,
   * so playing it in the movement phase would show the target flying backwards
   * before the blow that pushed it. Anything that moved AND was hit this round
   * is knockback, and belongs with the hit.
   */
  end(game) {
    if (!this.enabled) return;

    // Changing floor is not travelling across one.
    //
    // The diff below cannot tell "walked one tile" from "was relocated", and a
    // staircase moves you about thirty tiles - measured, seed 'stairs' goes
    // 7,3 -> 36,5 - onto a map where the old coordinates mean nothing at all.
    // Played as movement the camera slides that whole distance, which is the
    // lurch you see on every descent. Same family as your own death, which
    // rebuilds every floor and is already excluded for the same reason.
    //
    // A curtain instead: the cut is honest, and the fade covers the tiles and
    // the fog arriving underneath it.
    if (game.player.depth !== this.depth) {
      this.before.clear();
      this.add({ kind: 'level' });
      return;
    }
    const hit = new Set(this.events.filter((e) => e.round === this.round && e.kind === 'hit')
                                   .map((e) => e.uid));
    const now = (uid) => (uid === PLAYER_UID
      ? { x: game.player.x, y: game.player.y }
      : game.level?.enemies.find((e) => e.uid === uid));

    for (const [uid, from] of this.before) {
      const to = now(uid);
      if (!to || (to.x === from.x && to.y === from.y)) continue;
      this.add({
        kind: hit.has(uid) ? 'knock' : 'move',
        uid, from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y },
      });
    }
    this.before.clear();
  }

  /** Hand the whole cycle to the UI and forget it. */
  take() {
    const out = this.events;
    this.events = [];
    return out;
  }

  clear() { this.events = []; this.before.clear(); }
}
