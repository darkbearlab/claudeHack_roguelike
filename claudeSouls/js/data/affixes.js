// Affixes: three slots, and one entry per source.
//
// The constraint is the design, not the taxonomy. Every affix on a weapon can
// be traced to where it came from - this one it was forged with, this one you
// put on it, this one wears off - and a player reading a weapon knows which is
// which without being told. That is legibility, and it is also what stops
// affixes from turning into the stat soup they become everywhere else.
//
//   innate   what the weapon was made with. A weapon may have TWO, and if it
//            does it can never be worked on: the strong found weapon and the
//            customisable one are different weapons.
//   granted  what you put on it, permanently, with a stone.
//   temp     an oil or a ward, measured in **hits remaining** rather than turns.
//            Hits is the honest unit: it is the same currency the consumables
//            already count in, and "five more swings" is something you can plan
//            around in a way that "thirty turns" is not.
//
// What an affix may change is deliberately narrow: weight, and the numbers on a
// skill. **Not the pattern.** A pattern-changing affix would make the shape
// icon on the button lie about what the skill does, and those icons are
// generated from the pattern table precisely so that they cannot.

const affix = (key, o) => ({
  key,
  name: o.name,
  hint: o.hint,
  on: o.on ?? 'primary',        // 'primary' | 'secondary' | 'both'
  weight: o.weight ?? 0,
  damage: o.damage ?? 0,
  impact: o.impact ?? 0,
  knock: o.knock ?? 0,
  stamina: o.stamina ?? 0,
  cooldown: o.cooldown ?? 0,
  // Not a number. The affix rules are otherwise strictly numeric deltas, and
  // this is the documented exception rather than the start of a drift: it
  // changes WHEN cooldowns tick, not what any skill's shape or numbers are.
  kills: o.kills ?? false,
});

export const AFFIXES = [
  affix('keen', {
    name: '銳利', hint: '主要技能命中後把目標推開一格',
    knock: 1,
  }),
  affix('light', {
    name: '輕量', hint: '重量 −3:翻滾更便宜,回復更快',
    weight: -3,
  }),
  affix('tempered', {
    name: '淬火', hint: '主要技能傷害 +1,精力 +1',
    damage: 1, stamina: 1,
  }),
  // A behaviour rather than a delta, and the only one. It was the default
  // until it was measured against when it actually pays: the turn something
  // dies is the turn you are least under pressure, so refunding then rewarded
  // the exchange you had already won. As an affix it is a real choice, and the
  // paired blades were always built around it.
  affix('reaping', {
    name: '收割', hint: '每擊殺一個敵人,所有技能 CD −1',
    on: 'both', kills: true,
  }),
  affix('quick', {
    name: '迅捷', hint: '次要技能 CD −1',
    on: 'secondary', cooldown: -1,
  }),
  // Temporary ones. Nothing stops these being innate, but they are priced as
  // something that runs out.
  affix('ember', {
    name: '燃', hint: '傷害 +2',
    on: 'both', damage: 2,
  }),
  affix('frost', {
    name: '霜', hint: '衝擊 +2:打得斷本來打不斷的東西',
    on: 'both', impact: 2,
  }),
];

export const AFFIX_BY_KEY = Object.fromEntries(AFFIXES.map((a) => [a.key, a]));

/** How many hits a temporary affix lasts. */
export const TEMP_HITS = 5;

/**
 * Every affix currently on an item, tagged with where it came from.
 *
 * `state` is the player's per-item record: { granted, temp: {key, hits} }.
 * Innate ones come from the item itself and are always first.
 */
export function affixesOn(item, state) {
  const out = [];
  for (const key of item?.affixes ?? []) {
    if (AFFIX_BY_KEY[key]) out.push({ slot: 'innate', key });
  }
  if (state?.granted && AFFIX_BY_KEY[state.granted]) {
    out.push({ slot: 'granted', key: state.granted });
  }
  if (state?.temp?.hits > 0 && AFFIX_BY_KEY[state.temp.key]) {
    out.push({ slot: 'temp', key: state.temp.key, hits: state.temp.hits });
  }
  return out;
}

/** Whether a stone can still be used on this item. */
export function canGrant(item, state) {
  if (!item) return false;
  const innate = (item.affixes ?? []).filter((k) => AFFIX_BY_KEY[k]).length;
  if (innate >= 2) return false;              // forged full; nothing more fits
  return !state?.granted;
}

/**
 * The combined numeric change an item's affixes make to one of its skills.
 *
 * Returns deltas rather than a rewritten skill definition. That keeps every
 * existing reader of SKILL_BY_KEY honest - a modified copy would have meant
 * every call site either knowing about affixes or silently using the wrong
 * numbers, and there are a lot of them.
 */
export function modsFor(item, state, skillKey, forcedRole = null) {
  const mods = { damage: 0, impact: 0, knock: 0, stamina: 0, cooldown: 0 };
  if (!item) return mods;
  // A hero's verbs are not on the weapon, so their role cannot be worked out
  // from its primary/secondary and is passed in instead. Without this the
  // lookup below returned null for every hero skill and every affix in the
  // game silently did nothing to them.
  const role = forcedRole
             ?? (item.primary === skillKey ? 'primary'
               : item.secondary === skillKey ? 'secondary' : null);
  if (!role) return mods;

  for (const { key } of affixesOn(item, state)) {
    const a = AFFIX_BY_KEY[key];
    if (a.on !== 'both' && a.on !== role) continue;
    for (const f of ['damage', 'impact', 'knock', 'stamina', 'cooldown']) mods[f] += a[f];
  }
  return mods;
}

/** Total weight change from an item's affixes. */
export function weightMod(item, state) {
  let w = 0;
  for (const { key } of affixesOn(item, state)) w += AFFIX_BY_KEY[key].weight;
  return w;
}
