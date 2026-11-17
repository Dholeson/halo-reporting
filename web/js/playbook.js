// One map + mode, read from your own games: the verdict, the game plan and the numbers your wins
// hit. Shared by the Briefing tab and the In-game screen. Also loads the map and mode playbooks
// (web/playbook/*.json): callouts, spawns, objectives and coaching that don't come from your data.

import { fmt } from "./util.js";
import { agg, goodness, shrink, METRICS } from "./stats.js";
import { winConditions, timeBlocks, hourBlock, poolStats } from "./insights.js";
import { OBJECTIVE_FAMILIES } from "./data.js";

export const OBJ_WORD = { "King of the Hill": "on the hill", Strongholds: "in zones", Oddball: "holding the skull", "Total Control": "in zones", "Capture the Flag": "flag plays" };

/** Your games on this map and mode, the baseline they're compared with, and the verdict. */
export function matchup(base, map, fam) {
  const here = base.filter((r) => (!map || r.mapName === map) && (!fam || r.famName === fam));
  const famRows = fam ? base.filter((r) => r.famName === fam) : base;
  const mapRows = map ? base.filter((r) => r.mapName === map) : base;
  const baseline = map && fam ? famRows : base;
  const baseLabel = map && fam ? `your ${fam} average` : "your average";
  const title = [map, fam].filter(Boolean).join(" · ");
  const A = agg(here), B = agg(baseline);
  return { map, fam, here, famRows, mapRows, baseline, baseLabel, title, A, B, verdict: verdictFor(A, B, title, map, fam, baseLabel), conf: A.decided >= 25 ? 3 : A.decided >= 8 ? 2 : 1 };
}

function verdictFor(A, B, title, map, fam, baseLabel) {
  if (!A.n) return { tone: "neutral", label: "Uncharted territory", icon: "briefing", text: `You haven't played ${title} yet. This plan is built from your ${map && fam ? `${fam} games and your games on ${map}` : "other games"}.` };
  const adjWr = shrink(A.w, A.decided, B.wr ?? 0.5, 8);
  const adjKd = (A.k + 8 * (B.kpg ?? 0)) / Math.max(A.d + 8 * (B.dpg ?? 1), 1);
  const score = 0.6 * goodness("wr", adjWr, B.wr) + 0.4 * goodness("kd", adjKd, B.kd);
  const rec = `You're ${A.w}–${A.decided - A.w} here (${fmt.pct(A.wr)}) vs ${fmt.pct(B.wr)} for ${baseLabel}. K/D ${fmt.n2(A.kd)} vs ${fmt.n2(B.kd)}.`;
  const csr = A.csrN ? ` Ranked: ${fmt.signed(A.csrNet, fmt.int)} CSR over ${A.csrN} games here.` : "";
  const v = score >= 0.2 ? { tone: "good", label: "Favorable matchup", icon: "check" } : score <= -0.2 ? { tone: "bad", label: "Danger zone", icon: "alert" } : { tone: "neutral", label: "Even ground", icon: "steady" };
  if (A.decided < 6) v.label += " (early read)";
  return { ...v, text: rec + csr, score };
}

const WEAK = {
  d10: (a, b, s) => ({ title: "Slow down: you die more here", detail: `${fmt.n1(a.d10)} deaths per 10 min vs ${fmt.n1(b.d10)} for ${s}. Hold your power positions, recharge after trades, and don't chase into their side of the map.` }),
  lifeAvg: (a, b, s) => ({ title: "Stay alive longer", detail: `Average life ${fmt.secs(a.lifeAvg)} here vs ${fmt.secs(b.lifeAvg)} for ${s}. Move between cover, and back off when you're cracked.` }),
  acc: (a, b, s) => ({ title: "Your aim drops here", detail: `${fmt.acc(a.acc)} accuracy vs ${fmt.acc(b.acc)} for ${s}. Take fights at ranges that suit your weapon, and avoid the long cross-map duels.` }),
  dmgRatio: (a, b, s) => ({ title: "Pick your fights", detail: `Damage ratio ${fmt.n2(a.dmgRatio)} here vs ${fmt.n2(b.dmgRatio)} for ${s}. Shoot first from cover and team-shoot; don't take even 1v1s in the open.` }),
  k10: (a, b, s) => ({ title: "Get into the action earlier", detail: `${fmt.n1(a.k10)} kills per 10 min vs ${fmt.n1(b.k10)} for ${s}. Rotate toward the fights instead of holding quiet angles.` }),
  objtpg: (a, b, s) => ({ title: "More time on the objective", detail: `${fmt.secs(a.objtpg)} on the objective per game here vs ${fmt.secs(b.objtpg)} for ${s}.` }),
  a10: (a, b, s) => ({ title: "Play closer to your team", detail: `${fmt.n1(a.a10)} assists per 10 min vs ${fmt.n1(b.a10)} for ${s}. Shoot what your teammates are shooting.` }),
};
const STRONG = {
  d10: "you stay alive", lifeAvg: "you live longer", acc: "your aim is sharper", dmgRatio: "you win more gunfights", k10: "you get more kills", objtpg: "you play the objective more", a10: "you get more assists",
};

/**
 * The game plan: what stands out in your numbers here, most important first. `all` = every game in
 * scope; `sessionRows` = every game you played (any queue), to tell whether you're mid-session.
 */
export function plan(m, all, sessionRows = all) {
  const { here, baseline, famRows, A, B, map, fam, baseLabel } = m;
  const items = [];
  const metrics = ["d10", "lifeAvg", "acc", "dmgRatio", "k10", "a10"].concat(fam && OBJECTIVE_FAMILIES.has(fam) ? ["objtpg"] : []);
  if (A.n >= 5) {
    // With a big sample, smaller gaps are real; with a handful of games, demand bigger ones.
    const bar = A.n >= 40 ? 0.07 : A.n >= 15 ? 0.1 : 0.15;
    const scored = metrics.map((k) => ({ k, g: goodness(k, A[k], B[k]) })).filter((x) => Number.isFinite(x.g));
    const weak = scored.filter((x) => x.g < -bar).sort((a, b) => a.g - b.g)[0];
    const strong = scored.filter((x) => x.g > bar).sort((a, b) => b.g - a.g)[0];
    if (weak) items.push({ ...WEAK[weak.k](A, B, baseLabel), kind: "fix" });
    if (strong) items.push({ title: `Lean on it: ${STRONG[strong.k]} here`, detail: `${METRICS[strong.k].label}: ${METRICS[strong.k].f(A[strong.k])} here vs ${METRICS[strong.k].f(B[strong.k])} for ${baseLabel}. Play to that strength.`, kind: "strength" });
  }
  // win condition (here if possible, else the mode)
  let wc = A.w >= 4 && A.decided - A.w >= 4 ? winConditions(here, { minEach: 4 }) : null;
  let scope = "here";
  if (!wc?.length) { wc = winConditions(famRows, { minEach: 8 }); scope = fam ? `in ${fam}` : "overall"; }
  if (wc?.length) {
    const s = wc[0];
    items.push({ title: `Win condition: ${s.label.toLowerCase()}`, detail: `In your wins ${scope} you average ${s.f(s.ma)}; in losses ${s.f(s.mb)}. ${s.better > 0 ? "Get above" : "Stay under"} ${s.f(s.ma)}.`, kind: "win" });
  }
  // objective target
  // objective target: only when your wins really do have more of it than your losses
  if (fam && OBJECTIVE_FAMILIES.has(fam)) {
    const wins = famRows.filter((r) => r.win), losses = famRows.filter((r) => r.loss);
    if (wins.length >= 5 && losses.length >= 5) {
      const ctf = fam === "Capture the Flag";
      const v = (r) => (ctf ? r.obja + r.objk : r.objt);
      const avg = wins.reduce((s, r) => s + v(r), 0) / wins.length, avgL = losses.reduce((s, r) => s + v(r), 0) / losses.length;
      if (avg >= avgL * 1.05) items.push({ title: `Objective target: ${ctf ? fmt.n1(avg) : fmt.secs(avg)} ${OBJ_WORD[fam]}`, detail: `That's what your ${fam} wins average (${ctf ? fmt.n1(avgL) : fmt.secs(avgL)} in losses). ${ctf ? "Grabs, returns and carrier kills all count." : "Be on it when your team has the numbers advantage."}`, kind: "objective" });
    }
  }
  // recent form on this exact matchup
  if (here.length >= 5) {
    const last5 = here.slice(-5), w5 = last5.filter((r) => r.win).length;
    if (w5 >= 4) items.push({ title: `You've won ${w5} of your last 5 here`, detail: `Last played ${fmt.date(last5[4].t)}. Whatever you did then, do it again.`, kind: "form" });
    else if (w5 <= 1) items.push({ title: `You've lost ${5 - w5} of your last 5 here`, detail: `Last played ${fmt.date(last5[4].t)}. Reset your approach: check what separates your wins here.`, kind: "form" });
  }
  // context: how this map ranks for you overall
  if (map && fam) {
    const ranked = poolStats(all, "mapName", 8).sort((a, b) => b.adj - a.adj);
    const pos = ranked.findIndex((x) => x.name === map);
    if (pos >= 0 && ranked.length >= 6) {
      const x = ranked[pos];
      if (pos < ranked.length / 3) items.push({ title: `${map} is one of your better maps`, detail: `${fmt.pct(x.wr)} across ${x.n} games in all modes, #${pos + 1} of the ${ranked.length} maps you've played 8+ times.`, kind: "context" });
      else if (pos >= (ranked.length * 2) / 3) items.push({ title: `${map} is one of your tougher maps`, detail: `${fmt.pct(x.wr)} across ${x.n} games in all modes, #${pos + 1} of ${ranked.length}. Respect its power positions.`, kind: "context" });
    }
  }
  const s = sessionNow(sessionRows, all);
  if (s?.advice) items.unshift({ ...s.advice, kind: "session" });
  // time of day
  const blocks = timeBlocks(all);
  const nowBlock = hourBlock({ date: new Date() });
  const cur = blocks.find((b) => b.label === nowBlock?.label);
  const overallWr = agg(all).wr ?? 0;
  if (cur && cur.n >= 12 && cur.wr <= overallWr - 0.07) items.push({ title: `It's ${cur.label.toLowerCase()}, not your best hours`, detail: `You win ${fmt.pct(cur.wr)} at this time of day vs ${fmt.pct(overallWr)} overall.`, kind: "context" });
  if (!items.length) items.push({ title: "Play your game", detail: "Nothing here stands out against your averages. Trust your fundamentals.", kind: "context" });
  return items.slice(0, 6);
}

/**
 * The session you're in, if your last game ended within 50 minutes: games and record so far, the
 * current streak, and a nudge when your history says this point of a session goes badly.
 */
export function sessionNow(rows, history = rows, now = Date.now() / 1000) {
  const last = rows[rows.length - 1];
  if (!last || now - (last.t + (last.dur || 0)) >= 50 * 60) return null;
  const games = rows.filter((r) => r.session === last.session);
  const w = games.filter((r) => r.win).length, l = games.filter((r) => r.loss).length;
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].session === last.session && rows[i].out === last.out; i--) streak++;
  const all = history;
  const next = last.gameNo + 1;
  let advice = null;
  const early = agg(all.filter((r) => r.gameNo <= 6)), late = agg(all.filter((r) => r.gameNo >= 7));
  const after2 = agg(all.filter((r) => r.lossRunBefore >= 2));
  const lossTrail = last.loss ? streak : 0;
  if (lossTrail >= 2 && after2.decided >= 12 && after2.wr <= (agg(all).wr ?? 0) - 0.07)
    advice = { title: `You've lost ${lossTrail} straight. Consider a break`, detail: `After two losses in a row you win ${fmt.pct(after2.wr)} of the time. A 10-minute reset usually beats queueing tilted.` };
  else if (next >= 7 && late.decided >= 20 && late.wr <= early.wr - 0.06)
    advice = { title: `This is game ${next} of your session`, detail: `From game 7 on, your win rate drops to ${fmt.pct(late.wr)} (vs ${fmt.pct(early.wr)} in games 1–6). Make it count, then call it.` };
  return { games, w, l, last, next, streak, streakOut: last.out, advice };
}

const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * Up to three numbers to play to: per-game medians from your wins here, next to your losses. Only
 * stats where your wins are actually better than your losses make the cut (if you spend more time in
 * zones when you lose, zone time isn't a target). Falls back to the whole mode when this map has too
 * few wins and losses.
 */
export function winTargets(m) {
  const { here, famRows, fam } = m;
  const split = (rows, minW, minL) => {
    const w = rows.filter((r) => r.win && !r.dnf), l = rows.filter((r) => r.loss && !r.dnf);
    return w.length >= minW && l.length >= minL ? { w, l } : null;
  };
  let src = split(here, 6, 4), scope = "here";
  if (!src) { src = split(famRows, 10, 6); scope = fam ? `all your ${fam}` : "all your games"; }
  if (!src) return null;
  const obj = fam && OBJECTIVE_FAMILIES.has(fam);
  const objStat = !obj ? null
    : fam === "Capture the Flag" ? { id: "flag", label: "Flag plays", f: (r) => r.obja + r.objk, better: 1, fmt: fmt.int, note: "grabs, caps, returns, carrier kills" }
    : { id: "objt", label: fam === "Oddball" ? "Skull time" : "Time in zones", f: (r) => r.objt, better: 1, fmt: fmt.secs };
  const candidates = [
    { id: "d", label: "Deaths", f: (r) => r.d, better: -1, fmt: fmt.int },
    { id: "k", label: "Kills", f: (r) => r.k, better: 1, fmt: fmt.int },
    objStat,
    { id: "dd", label: "Damage", f: (r) => r.dd, better: 1, fmt: fmt.int },
    { id: "a", label: "Assists", f: (r) => r.a, better: 1, fmt: fmt.int },
  ].filter(Boolean);
  const scored = candidates.map((s) => {
    const win = median(src.w.map(s.f)), loss = median(src.l.map(s.f));
    const gap = win != null && loss != null ? (s.better * (win - loss)) / Math.max(Math.abs(loss), 1) : -1;
    return { ...s, win, loss, gap };
  });
  // a real separation: at least 5% better in wins (or one whole unit for small counts)
  const items = scored.filter((s) => s.gap >= 0.05 && Math.abs(s.win - s.loss) >= (s.id === "objt" ? 5 : 1)).slice(0, 3);
  return { scope, wins: src.w.length, losses: src.l.length, items, flat: !items.length };
}

// ---------- map and mode playbooks ----------
let books = null;
/** web/playbook/maps.json and modes.json, fetched once. Missing files just mean "no notes yet". */
export function loadPlaybooks() {
  if (!books) {
    const get = (p) => fetch(p, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    books = Promise.all([get("playbook/maps.json"), get("playbook/modes.json")]).then(([maps, modes]) => ({ maps: maps?.maps || {}, modes: modes?.modes || {}, general: modes?.general || null }));
  }
  return books;
}
/** The playbook entry for a map name as it appears in your data (case and spacing insensitive). */
export function mapBook(books, name) {
  if (!books || !name) return null;
  const k = String(name).toLowerCase().replace(/\s+/g, " ").trim();
  for (const [key, v] of Object.entries(books.maps)) if (key.toLowerCase() === k || (v.aka || []).some((a) => a.toLowerCase() === k)) return v;
  return null;
}
