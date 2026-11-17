// Radar-2: the value model behind the token radar.
//
// A snapshot of the protocol universe goes in; a ranked board comes out. The
// board always covers the snapshot's whole watchlist, then adds the early
// radar: every other rankable pre-token protocol below the watchlist floor.
// A protocol counts as pre-token when its record carries no token at all —
// no market cap, no CoinGecko id, no symbol. Live-token protocols are kept
// out of the ranking and shown beside it with the market's own numbers.
//
// Implied value is computed only from the snapshot's own figures for the
// protocol: its TVL, its seven-day change, and how long it has run without
// a token (days since first listing):
//
//   base      = tvl_usd * 0.25
//   growth    = change_7d clamped to [-60, 120]
//   growthMul = 1 + growth / 100 * 0.5
//   maturity  = 0.6 + min(age, 1095) / 1095 * 0.4   (age unknown: 365)
//   implied   = max(1, round(base * growthMul * maturity))
//
// A token is usually worth a fraction of the value its protocol secures, so
// the base multiple is a quarter. Growth is capped so a single hot week
// cannot triple a protocol, and maturity is capped at three years so age
// alone cannot double one. Nothing here names a protocol: the same function
// scores every row, and the constants are the ones the dashboard prints and
// its sandbox lets a reader move.

/** One protocol as the sealed snapshot records it: its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The snapshot document as a whole. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard prints them and the sandbox moves them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 1 / 4,
  growth_weight: 1 / 2,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 3 / 5,
  maturity_range: 2 / 5,
  maturity_days: 3 * 365,
  unknown_age_days: 365,
};

/** The model's version label, shown by the dashboard. */
export const MODEL_VERSION = 'radar-2';

/** How many early rows the radar carries, by TVL. Past the count of rankable
    protocols below the floor (186 in this snapshot), so the early radar is
    every one of them rather than a cut of the biggest. */
export const EARLY_ROWS = 1000;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One farm step: what to do, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row trimmed for data.js; the page builds the farm plan itself. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it trades already, so the board shows the market's
    value for it, never a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs to render: board, live set, model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The headline counts for a board. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** What scoring one protocol yields. */
export interface Implied {
  implied: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
}

/** Thrown when a snapshot is not the shape this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

/** Clamp n into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** A finite number, or `fallback` when the value is not one. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, never below zero; null when a date
    is missing or unparseable. */
export function daysSince(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(asOf + 'T00:00:00Z');
  const start = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

/** The multipliers and implied value one protocol gets under `model`. */
export function impliedValue(entry: SnapshotProtocol, asOf: string, model: ModelConstants): Implied {
  const age = daysSince(asOf, entry.listed_at);
  const growthPct = clamp(numOr(entry.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageUsed = age === null ? model.unknown_age_days : age;
  const maturityMult =
    model.maturity_floor +
    (clamp(ageUsed, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(entry.tvl_usd * model.base_multiple * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

/** A name ending in a release marker is a versioned pool of another protocol. */
const VERSIONED = /\s(v\d+(\.\d+)?|\d+\.\d+)$/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether the board may rank a protocol: pre-token, not an exchange, not a
    versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** Round to four decimals, for the multipliers the board carries. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The snapshot's protocols keyed by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/** Compare two protocols by slug, for stable tie-breaks. */
function bySlug(a: SnapshotProtocol, b: SnapshotProtocol): number {
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** The protocols the board ranks, strongest first, ranked 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug in it, even one the snapshot no
  // longer carries (it cannot, but coverage is the gate's row and is never
  // gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) chosen.set(slug, found);
  }
  // The early radar: rankable pre-token protocols below the floor, biggest
  // TVL first, capped. A chosen protocol stays chosen; this never replaces
  // a watchlist row.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || bySlug(a, b))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model);
    return { p, v };
  });
  scored.sort((a, b) => b.v.implied - a.v.implied || bySlug(a.p, b.p));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.v.growthPct,
      growth_multiplier: round4(s.v.growthMult),
      maturity_multiplier: round4(s.v.maturityMult),
      age_days: s.v.age,
    },
    farm_steps: farmSteps(s.p, s.v.age).map(stepText),
  }));
}

/** One step as a single string: action, then cost and time, inside the
    gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  if (s.length > 600) s = s.slice(0, 596) + '...';
  if (s.length < 20) s = s + ' Hold the position and check the protocol\'s own page.';
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer
    qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** One category family's two actions: the main deposit and a second touch, so
    the farm is never a single deposit. Each rule matches when the lowercased
    category contains one of its keys; the first matching rule wins. */
interface ActionRule {
  keys: string[];
  main: (name: string, capital: number, chain: string) => string;
  again: (name: string, chain: string) => string;
}

const ACTION_RULES: ActionRule[] = [
  {
    keys: ['lend', 'cdp', 'collateral'],
    main: (name, capital, chain) =>
      'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and borrow $25 against it, then repay the borrow within the week.',
    again: (name, chain) =>
      'Borrow a further $25 of USDC from ' + name + ' on ' + chain + ', hold it a day, then repay it in full.',
  },
  {
    keys: ['dex', 'yield', 'leveraged farm'],
    main: (name, capital, chain) =>
      'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.',
    again: (name, chain) =>
      'Swap $25 through ' + name + "'s main pool on " + chain + ' once, using the router it publishes.',
  },
  {
    keys: ['bridge'],
    main: (name, capital, chain) =>
      'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.',
    again: (name, chain) =>
      'Bridge $25 back through ' + name + ' to ' + chain + ' so the round trip is on record.',
  },
  {
    keys: ['staking', 'restak'],
    main: (name, capital, chain) =>
      'Stake $' + capital + " of the chain's staking asset through " + name + ' and keep the receipt.',
    again: (name, chain) =>
      'Compound the staking receipt once through ' + name + ' on ' + chain + ' instead of letting it sit.',
  },
  {
    keys: ['perpetual', 'derivative'],
    main: (name, capital, chain) =>
      'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.',
    again: (name, chain) =>
      'Close the hedge on ' + name + ' and open a fresh one half its size on ' + chain + '.',
  },
  {
    keys: ['prediction'],
    main: (name, capital, chain) =>
      'Fund $' + capital + ' and place one market position on ' + name + '.',
    again: (name, chain) =>
      'Settle the first market position on ' + name + ' and open a second one with $25.',
  },
  {
    keys: ['curator', 'allocator', 'risk'],
    main: (name, capital, chain) =>
      'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.',
    again: (name, chain) =>
      'Deposit $25 into a second ' + name + ' vault on ' + chain + ' so two vaults hold funds.',
  },
  {
    keys: ['stable'],
    main: (name, capital, chain) =>
      'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.',
    again: (name, chain) =>
      'Redeem $25 of the stable asset through ' + name + ' on ' + chain + ' and re-mint it the same day.',
  },
  {
    keys: ['rwa'],
    main: (name, capital, chain) =>
      'Mint $' + capital + " of the protocol's yield asset on " + chain + ' and hold it.',
    again: (name, chain) =>
      'Claim the yield distribution ' + name + ' pays on ' + chain + ' instead of leaving it unclaimed.',
  },
  {
    keys: ['insurance'],
    main: (name, capital, chain) =>
      'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.',
    again: (name, chain) =>
      'Review the ' + name + ' policy on ' + chain + ' and add a second $25 cover for a different risk.',
  },
];

/** The category's rule, or null when no rule matches it. */
function ruleFor(category: string | null): ActionRule | null {
  const c = (category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.keys.some((k) => c.includes(k))) return rule;
  }
  return null;
}

/** The cross-chain step: a second chain when the protocol runs on one, else a
    second use of its app. */
function crossChainStep(p: SnapshotProtocol, chain: string): string {
  const second = p.chains.length > 1 ? p.chains[1]! : null;
  if (second !== null) return 'Repeat the main action with $25 on ' + second + ' so the activity spans two chains, not one.';
  return "Use " + p.name + "'s app on " + chain + ' a second way -- its swap, vote or rewards tab -- once a week.';
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdFor(age);
  const rule = ruleFor(p.category);
  const mainAction = rule !== null
    ? rule.main(p.name, capital, chain)
    : 'Deposit $' + capital + ' of USDC into ' + p.name + ' on ' + chain + ' and keep the position open.';
  const secondAction = rule !== null
    ? rule.again(p.name, chain)
    : "Use " + p.name + "'s second feature on " + chain + ' -- its swap, vote or rewards tab -- once.';
  const gas = capital >= 150 ? 8 : 4;
  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: mainAction,
      cost: '$' + capital + ' of capital and about $' + gas + ' of gas',
      time: '15 minutes to set up',
    },
    {
      text: secondAction,
      cost: '$25 of capital and about $2 of gas',
      time: '10 minutes',
    },
    {
      text: crossChainStep(p, chain),
      cost: '$25 of capital and about $3 of gas',
      time: '15 minutes',
    },
    {
      text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, and keep a weekly streak.',
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.',
      cost: 'the $' + capital + ' stays in the position',
      time: hold + ' days',
    },
    {
      text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Write the wallet, the dates and every transaction in a farm log, and unwind in two steps: withdraw half, then the rest a day later.',
      cost: 'about $4 of gas to unwind',
      time: '15 minutes to unwind',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const watch = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watch.has(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist: snapshot.watchlist,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError('snapshot.json protocol ' + i + ' is not an object');
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError('snapshot.json protocol ' + i + ' lacks a slug, a name or a TVL');
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks,
    order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return 'the board misses ' + missing.length + ' watchlist slug' + (missing.length === 1 ? '' : 's') + ': ' + missing.slice(0, 5).join(', ');
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return 'rank ' + (i + 1) + ' is ' + ranks[i];
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return 'row ' + (i + 1) + ' outranks row ' + i + ' on implied value';
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'all ' + board.length + ' rows share the same implied value $' + board[0]!.implied_value_usd + ': a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return r.slug + ' has ' + steps.length + ' farm steps';
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) return r.slug + ' has a farm step of ' + s.length + ' characters';
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return r.slug + ' has implied value ' + r.implied_value_usd;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch
    and no network. */
export function dataScript(radar: RadarData): string {
  return 'window.RADAR=' + JSON.stringify(radar) + ';\n';
}
