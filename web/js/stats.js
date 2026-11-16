// Aggregation and the small amount of statistics the coaching relies on.
// Ratios are computed from sums (K/D = ΣK/ΣD), never averaged per game.

export function agg(rows) {
  const a = {
    n: rows.length, w: 0, l: 0, t: 0, dnf: 0, k: 0, d: 0, as: 0, hs: 0, sf: 0, sh: 0, dd: 0, dt: 0, min: 0,
    life: 0, ps: 0, call: 0, mel: 0, gren: 0, pw: 0, spree: 0, objt: 0, obja: 0, objk: 0, objN: 0,
    dmgRankSum: 0, lobbyRankN: 0, mvp: 0, xk: 0, xd: 0, xN: 0, csr: 0, csrN: 0, kShare: 0, kShareN: 0, dmgShare: 0, impact: 0,
  };
  for (const r of rows) {
    if (r.out === "W") a.w++;
    else if (r.out === "L") a.l++;
    else if (r.out === "T") a.t++;
    else if (r.out === "D") a.dnf++;
    a.k += r.k; a.d += r.d; a.as += r.a; a.hs += r.hs; a.sf += r.sf; a.sh += r.sh; a.dd += r.dd; a.dt += r.dt;
    a.min += r.min; a.life += r.life; a.ps += r.ps; a.call += r.call; a.mel += r.mel; a.gren += r.gren; a.pw += r.pw;
    a.spree = Math.max(a.spree, r.spree);
    if (r.objMode) { a.objt += r.objt; a.obja += r.obja; a.objk += r.objk; a.objN++; }
    if (r.lobby > 1) { a.dmgRankSum += (r.dmgRank - 1) / (r.lobby - 1); a.lobbyRankN++; }
    if (r.mvp) a.mvp++;
    if (r.xk != null) { a.xk += r.k - r.xk; a.xd += r.d - r.xd; a.xN++; }
    if (r.csrDelta != null) { a.csr += r.csrDelta; a.csrN++; }
    if (r.kShare != null) { a.kShare += r.kShare; a.kShareN++; }
    a.dmgShare += r.dmgShare;
    a.impact += r.impact ?? 50;
  }
  const decided = a.w + a.l + a.t + a.dnf;
  return {
    ...a,
    decided,
    wr: decided ? a.w / decided : null,
    kd: a.n ? a.k / Math.max(a.d, 1) : null,
    kda: a.n ? (a.k + a.as / 3 - a.d) / a.n : null,
    kpg: a.n ? a.k / a.n : null,
    dpg: a.n ? a.d / a.n : null,
    apg: a.n ? a.as / a.n : null,
    k10: a.min ? (a.k / a.min) * 10 : null,
    d10: a.min ? (a.d / a.min) * 10 : null,
    a10: a.min ? (a.as / a.min) * 10 : null,
    acc: a.sf ? (a.sh / a.sf) * 100 : null,
    hsPct: a.k ? a.hs / a.k : null,
    dmgRatio: a.n ? a.dd / Math.max(a.dt, 1) : null,
    ddpg: a.n ? a.dd / a.n : null,
    dd10: a.min ? (a.dd / a.min) * 10 : null,
    lifeAvg: a.n ? a.life / a.n : null,
    objtpg: a.objN ? a.objt / a.objN : null,
    objapg: a.objN ? a.obja / a.objN : null,
    lobbyPct: a.lobbyRankN ? 1 - a.dmgRankSum / a.lobbyRankN : null, // 1 = always top damage
    kSharePct: a.kShareN ? a.kShare / a.kShareN : null,
    dmgSharePct: a.n ? a.dmgShare / a.n : null,
    xkpg: a.xN ? a.xk / a.xN : null,
    xdpg: a.xN ? a.xd / a.xN : null,
    csrNet: a.csrN ? a.csr : null,
    csrPerGame: a.csrN ? a.csr / a.csrN : null,
    impactAvg: a.n ? a.impact / a.n : null,
    hours: a.min / 60,
  };
}

/** Metric catalog: how to read each number, which direction is good, how to format it. */
import { fmt } from "./util.js";
export const METRICS = {
  wr: { label: "Win rate", short: "Win %", f: fmt.pct, better: 1, scale: 0.15 },
  kd: { label: "K/D", short: "K/D", f: fmt.n2, better: 1, scale: 0.35, ratio: true },
  kda: { label: "KDA", short: "KDA", f: fmt.n1, better: 1, scale: 4 },
  dmgRatio: { label: "Damage ratio", short: "Dmg ratio", f: fmt.n2, better: 1, scale: 0.3, ratio: true },
  acc: { label: "Accuracy", short: "Acc", f: fmt.acc, better: 1, scale: 6 },
  k10: { label: "Kills / 10 min", short: "K/10m", f: fmt.n1, better: 1, scale: 3 },
  d10: { label: "Deaths / 10 min", short: "D/10m", f: fmt.n1, better: -1, scale: 3 },
  a10: { label: "Assists / 10 min", short: "A/10m", f: fmt.n1, better: 1, scale: 2 },
  kpg: { label: "Kills / game", short: "K", f: fmt.n1, better: 1, scale: 4 },
  dpg: { label: "Deaths / game", short: "D", f: fmt.n1, better: -1, scale: 4 },
  apg: { label: "Assists / game", short: "A", f: fmt.n1, better: 1, scale: 3 },
  hsPct: { label: "Headshot kills", short: "HS%", f: fmt.pct, better: 1, scale: 0.12 },
  ddpg: { label: "Damage / game", short: "Dmg", f: fmt.int, better: 1, scale: 1500 },
  dd10: { label: "Damage / 10 min", short: "Dmg/10m", f: fmt.int, better: 1, scale: 1200 },
  lifeAvg: { label: "Avg life", short: "Life", f: fmt.secs, better: 1, scale: 10 },
  objtpg: { label: "Objective time / game", short: "Obj time", f: fmt.secs, better: 1, scale: 30 },
  lobbyPct: { label: "Lobby damage placement", short: "Lobby rank", f: (v) => (v == null ? "–" : `Top ${Math.max(1, Math.round((1 - v) * 100))}%`), better: 1, scale: 0.25 },
  kSharePct: { label: "Share of team kills", short: "Kill share", f: fmt.pct, better: 1, scale: 0.08 },
  dmgSharePct: { label: "Damage vs lobby avg", short: "Dmg vs lobby", f: (v) => (v == null ? "–" : `${v.toFixed(2)}×`), better: 1, scale: 0.3 },
  xkpg: { label: "Kills vs expected", short: "K vs exp", f: (v) => fmt.signed(v, fmt.n1), better: 1, scale: 2 },
  xdpg: { label: "Deaths vs expected", short: "D vs exp", f: (v) => fmt.signed(v, fmt.n1), better: -1, scale: 2 },
  csrPerGame: { label: "CSR per game", short: "CSR/g", f: (v) => fmt.signed(v, fmt.n1), better: 1, scale: 8 },
  impactAvg: { label: "Impact", short: "Impact", f: fmt.int, better: 1, scale: 15 },
};

/** Signed "goodness" of a change from base→cur on metric m, normalized to ~[-1,1]. */
export function goodness(m, cur, base) {
  const M = METRICS[m];
  if (cur == null || base == null || !M) return 0;
  const diff = M.ratio ? Math.log(Math.max(cur, 0.01) / Math.max(base, 0.01)) / Math.log(1 + M.scale) : (cur - base) / M.scale;
  return Math.max(-1, Math.min(1, diff * M.better));
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Welch's t for two samples; also returns Cohen's d. */
export function compare(a, b) {
  a = a.filter(Number.isFinite);
  b = b.filter(Number.isFinite);
  if (a.length < 3 || b.length < 3) return { t: 0, d: 0, ma: mean(a), mb: mean(b), na: a.length, nb: b.length };
  const ma = mean(a), mb = mean(b), va = sd(a) ** 2, vb = sd(b) ** 2;
  const se = Math.sqrt(va / a.length + vb / b.length) || 1e-9;
  const pooled = Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2)) || 1e-9;
  return { t: (ma - mb) / se, d: (ma - mb) / pooled, ma, mb, na: a.length, nb: b.length };
}

/** Two-proportion z-test. */
export function propZ(w1, n1, w2, n2) {
  if (!n1 || !n2) return 0;
  const p = (w1 + w2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)) || 1e-9;
  return (w1 / n1 - w2 / n2) / se;
}

/** Shrink a rate toward a prior so 3-0 on a map doesn't outrank 60-40. */
export const shrink = (w, n, prior, k = 12) => (w + k * prior) / (n + k);

/** Confidence from sample size and test statistic → 1..3 */
export function confidence(n, t = 3) {
  const at = Math.abs(t);
  if (n >= 40 && at >= 2.5) return 3;
  if (n >= 15 && at >= 1.8) return 2;
  return 1;
}

export function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = typeof key === "function" ? key(r) : r[key];
    if (k === undefined || k === null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/** Rolling window aggregate over an ordered row list. */
export function rolling(rows, win, pick) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i + 1 < Math.min(win, rows.length)) continue;
    const slice = rows.slice(Math.max(0, i - win + 1), i + 1);
    out.push({ i, row: rows[i], v: pick(agg(slice)) });
  }
  return out;
}

export function streaks(rows) {
  let best = { len: 0 }, cur = 0, start = 0, worst = { len: 0 }, curL = 0, startL = 0;
  rows.forEach((r, i) => {
    if (r.win) { if (!cur) start = i; cur++; if (cur > best.len) best = { len: cur, from: rows[start], to: r }; } else cur = 0;
    if (r.loss) { if (!curL) startL = i; curL++; if (curL > worst.len) worst = { len: curL, from: rows[startL], to: r }; } else curL = 0;
  });
  // current streak (from the end)
  let now = { type: null, len: 0 };
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = rows[i].win ? "W" : rows[i].loss ? "L" : "T";
    if (!now.type) now = { type: t, len: 1 };
    else if (t === now.type) now.len++;
    else break;
  }
  return { best, worst, now };
}
