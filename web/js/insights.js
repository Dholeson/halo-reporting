// Coaching engine. Each insight is computed from your own games, carries its
// evidence and a confidence level, and ends in something you can actually do.
// Thresholds are deliberately conservative: no insight on thin or noisy data.

import { agg, compare, propZ, confidence, groupBy, shrink, rolling, mean, METRICS } from "./stats.js";
import { fmt, cssVar } from "./util.js";
import { pairBars, columns, barList, lineChart } from "./charts.js";

const pct = (v) => fmt.pct(v);
const wrOf = (rows) => {
  const a = agg(rows);
  return { wr: a.wr ?? 0, w: a.w, n: a.decided };
};
const hl = () => cssVar("--s1");
const dim = () => cssVar("--axis");

// Candidate "win condition" stats: per-game values you can influence.
const WIN_STATS = [
  { id: "d10", label: "Deaths / 10 min", v: (r) => r.d10, f: fmt.n1, better: -1 },
  { id: "life", label: "Average life", v: (r) => r.life, f: fmt.secs, better: 1 },
  { id: "k10", label: "Kills / 10 min", v: (r) => r.k10, f: fmt.n1, better: 1 },
  { id: "dmgRatio", label: "Damage ratio", v: (r) => Math.min(r.dmgRatio, 4), f: fmt.n2, better: 1 },
  { id: "acc", label: "Accuracy", v: (r) => r.acc, f: fmt.acc, better: 1 },
  { id: "a10", label: "Assists / 10 min", v: (r) => r.a10, f: fmt.n1, better: 1 },
  { id: "pw", label: "Power weapon kills", v: (r) => r.pw, f: fmt.n1, better: 1 },
  { id: "objt", label: "Objective time", v: (r) => (r.objMode ? r.objt : NaN), f: fmt.secs, better: 1 },
];

const WIN_TIPS = {
  d10: (w, l) => `Treat ${w} deaths per 10 minutes as your ceiling (you're at ${l} in losses). When you get cracked, break line of sight and recharge instead of finishing the duel.`,
  life: (w, l) => `Your wins come from staying alive (${w} per life vs ${l}). Play one angle less aggressively, re-peek from a different spot, and don't push alone.`,
  k10: (w, l) => `You win when you're the one getting kills (${w} per 10 min vs ${l}). Play the lanes you're strongest in early, and push alongside a teammate so you can trade.`,
  dmgRatio: (w, l) => `Pick better fights: damage ratio is ${w} in wins vs ${l} in losses. Shoot first from cover and pull out of losing duels earlier.`,
  acc: (w, l) => `Your aim decides your games (${w} accuracy in wins vs ${l}). Warm up before you queue, and pace your shots rather than spraying.`,
  a10: (w, l) => `You win when you play with the team (${w} assists per 10 min vs ${l}). Shoot what your teammates are shooting and use pings.`,
  pw: (w, l) => `Power weapons swing your games (${w} power-weapon kills in wins vs ${l}). Track spawn timers and set up on them 10–15 s early.`,
  objt: (w, l) => `Play the objective: ${w} on the objective in wins vs ${l} in losses. When your team's ahead on kills, convert it into objective time.`,
};
const WIN_TITLES = {
  d10: "Staying alive wins your games", life: "Staying alive wins your games", k10: "Your fragging decides games",
  dmgRatio: "Winning gunfights decides games", acc: "Your aim decides your games", a10: "Teamplay wins your games",
  pw: "Power weapons swing your games", objt: "Objective time wins your games",
};

export function winConditions(rows, { minEach = 8 } = {}) {
  const wins = rows.filter((r) => r.win), losses = rows.filter((r) => r.loss);
  if (wins.length < minEach || losses.length < minEach) return null;
  const out = [];
  for (const s of WIN_STATS) {
    const c = compare(wins.map(s.v), losses.map(s.v));
    if (c.na < minEach / 2 || c.nb < minEach / 2) continue;
    out.push({ ...s, ...c, good: c.d * s.better });
  }
  out.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  return out;
}

function winCondition(rows) {
  const list = winConditions(rows, { minEach: 10 });
  if (!list?.length) return null;
  const top = list[0];
  const conf = confidence(top.na + top.nb, top.t);
  return {
    id: "win-condition", area: "Fundamentals", icon: "target", tone: "neutral",
    title: WIN_TITLES[top.id],
    verdict: `In wins you average ${top.f(top.ma)} ${top.label.toLowerCase()} vs ${top.f(top.mb)} in losses. That's the biggest gap of any stat across ${fmt.int(top.na + top.nb)} games.`,
    tip: WIN_TIPS[top.id](top.f(top.ma), top.f(top.mb)),
    conf, score: 90 * Math.min(1, Math.abs(top.d)) * (0.5 + conf / 6) + 10,
    chart: (el) => pairBars(el, list.slice(0, 4).map((s) => ({ label: s.label, a: s.ma, b: s.mb, f: s.f, tag: `effect ${Math.abs(s.d).toFixed(2)}` }))),
  };
}

function tilt(rows) {
  const ctx = rows.filter((r) => r.prevOut && r.decided);
  const afterW = ctx.filter((r) => r.prevOut === "W"), afterL = ctx.filter((r) => r.prevOut === "L" || r.prevOut === "D");
  const after2 = ctx.filter((r) => r.lossRunBefore >= 2);
  if (afterW.length < 15 || afterL.length < 15) return null;
  const base = wrOf(rows), aw = wrOf(afterW), al = wrOf(afterL), a2 = wrOf(after2);
  const chart = (el) =>
    columns(el, [
      { label: "After win", value: aw.wr, n: aw.n, flag: false },
      { label: "After loss", value: al.wr, n: al.n, flag: al.wr < aw.wr - 0.05 },
      { label: "After 2+ losses", value: a2.n >= 8 ? a2.wr : null, n: a2.n, flag: a2.n >= 8 && a2.wr < base.wr - 0.06 },
    ].map((d, _, arr) => ({ ...d, color: arr.some((x) => x.flag) ? (d.flag ? hl() : dim()) : hl() })).map((d) => ({ ...d, tip: () => ({ title: d.label, rows: [{ label: "Win rate", value: fmt.pct(d.value) }, { label: "Games", value: fmt.int(d.n) }] }) })), { height: 150, yFormat: fmt.pct, refs: [{ y: base.wr, label: `overall ${pct(base.wr)}` }], yDomain: [0, Math.max(0.8, aw.wr, al.wr)] });
  if (a2.n >= 12 && a2.wr <= base.wr - 0.07) {
    const z = propZ(a2.w, a2.n, base.w, base.n);
    const conf = confidence(a2.n, z);
    return {
      id: "tilt", area: "Mindset", icon: "brain", tone: "bad", title: "Two losses is your stop sign",
      verdict: `After two straight losses you win ${pct(a2.wr)} of games (${a2.n} games), against ${pct(base.wr)} overall.`,
      tip: `When you drop two in a row, take 10 minutes or switch to a social playlist. Re-queueing straight away costs you about ${Math.round((base.wr - a2.wr) * 100)} points of win rate.`,
      conf, score: 75 * (0.5 + conf / 6) + (base.wr - a2.wr) * 100, chart,
    };
  }
  if (al.wr <= aw.wr - 0.07) {
    const z = propZ(aw.w, aw.n, al.w, al.n);
    const conf = confidence(Math.min(aw.n, al.n), z);
    return {
      id: "tilt", area: "Mindset", icon: "brain", tone: "bad", title: "Losses carry into your next game",
      verdict: `You win ${pct(al.wr)} right after a loss vs ${pct(aw.wr)} right after a win.`,
      tip: "Reset between games: stand up, drink some water, and replay one thing you'd do differently before you queue again.",
      conf, score: 55 * (0.5 + conf / 6), chart,
    };
  }
  return {
    id: "tilt", area: "Mindset", icon: "brain", tone: "good", title: "You don't tilt",
    verdict: `Your win rate after a loss (${pct(al.wr)}) holds up against after a win (${pct(aw.wr)}). Losses aren't snowballing.`,
    tip: "Keep the routine. Your mental game isn't what's costing you.",
    conf: confidence(Math.min(aw.n, al.n), 2), score: 30, chart,
  };
}

const SESSION_BUCKETS = [
  { label: "Game 1", test: (n) => n === 1 }, { label: "2–3", test: (n) => n >= 2 && n <= 3 }, { label: "4–6", test: (n) => n >= 4 && n <= 6 },
  { label: "7–9", test: (n) => n >= 7 && n <= 9 }, { label: "10+", test: (n) => n >= 10 },
];
export function sessionCurve(rows) {
  return SESSION_BUCKETS.map((b) => {
    const rs = rows.filter((r) => b.test(r.gameNo));
    const a = agg(rs);
    return { ...b, rows: rs, wr: a.wr, kd: a.kd, n: a.decided };
  });
}

function sessionLength(rows) {
  const curve = sessionCurve(rows);
  const early = rows.filter((r) => r.gameNo <= 6), late = rows.filter((r) => r.gameNo >= 7);
  if (early.length < 20 || late.length < 20) return null;
  const e = wrOf(early), l = wrOf(late), base = wrOf(rows);
  const z = propZ(e.w, e.n, l.w, l.n);
  const sessions = groupBy(rows, "session");
  const avgLen = mean([...sessions.values()].map((s) => s.length));
  const chart = (el) =>
    columns(el, curve.map((b) => ({
      label: b.label, value: b.n >= 8 ? b.wr : null, color: b.n >= 8 && b.wr < base.wr - 0.05 ? hl() : dim(),
      tip: () => ({ title: `Session ${b.label.toLowerCase()}`, rows: [{ label: "Win rate", value: fmt.pct(b.wr) }, { label: "K/D", value: fmt.n2(b.kd) }, { label: "Games", value: fmt.int(b.n) }] }),
    })), { height: 150, yFormat: fmt.pct, refs: [{ y: base.wr, label: `overall ${pct(base.wr)}` }], yDomain: [0, 0.8] });
  if (l.wr <= e.wr - 0.06) {
    const conf = confidence(Math.min(e.n, l.n), z);
    return {
      id: "session-length", area: "Mindset", icon: "hourglass", tone: "bad", title: "You fade in long sessions",
      verdict: `Games 1–6 of a session: ${pct(e.wr)} win rate. Game 7 onwards: ${pct(l.wr)}. Your sessions average ${avgLen.toFixed(1)} games.`,
      tip: `Cap ranked sessions at about 6 games, or take a proper 10-minute break after game 6 before you queue again.`,
      conf, score: 60 * (0.5 + conf / 6) + (e.wr - l.wr) * 100, chart,
    };
  }
  return {
    id: "session-length", area: "Mindset", icon: "hourglass", tone: l.wr > e.wr + 0.04 ? "good" : "neutral",
    title: l.wr > e.wr + 0.04 ? "You get stronger as sessions go on" : "Session length isn't hurting you",
    verdict: `Games 1–6: ${pct(e.wr)} win rate. Game 7 onwards: ${pct(l.wr)}. Sessions average ${avgLen.toFixed(1)} games.`,
    tip: l.wr > e.wr + 0.04 ? "You need a few games to warm up. Play a social match or two before ranked." : "No need to cut sessions short on performance grounds.",
    conf: confidence(Math.min(e.n, l.n), Math.abs(z)), score: 20, chart,
  };
}

function warmup(rows) {
  const first = rows.filter((r) => r.gameNo === 1), rest = rows.filter((r) => r.gameNo > 1);
  if (first.length < 15 || rest.length < 30) return null;
  const f = agg(first), r = agg(rest);
  const accGap = (f.acc ?? 0) - (r.acc ?? 0), kdRatio = f.kd / Math.max(r.kd, 0.01);
  const cKD = compare(first.map((x) => x.kda), rest.map((x) => x.kda));
  const chart = (el) =>
    pairBars(el, [
      { label: "K/D", a: f.kd, b: r.kd, f: fmt.n2 },
      { label: "Accuracy", a: f.acc, b: r.acc, f: fmt.acc },
      { label: "Win rate", a: f.wr, b: r.wr, f: fmt.pct },
    ], { aLabel: "First game", bLabel: "Rest of session", aColor: cssVar("--s1"), bColor: cssVar("--axis") });
  if (kdRatio < 0.92) {
    const conf = confidence(first.length, cKD.t);
    return {
      id: "warmup", area: "Fundamentals", icon: "clock", tone: "bad", title: "Your first game is your worst",
      verdict: `First game of a session: ${fmt.n2(f.kd)} K/D and ${fmt.acc(f.acc)} accuracy. The rest of the session: ${fmt.n2(r.kd)} and ${fmt.acc(r.acc)}.`,
      tip: "Warm up before your first real match: 5–10 minutes of bot bootcamp or a firing range drill, especially before ranked.",
      conf, score: 45 * (0.5 + conf / 6) + (1 - kdRatio) * 60, chart,
    };
  }
  if (accGap <= -2) {
    return {
      id: "warmup", area: "Fundamentals", icon: "clock", tone: "bad", title: "Your aim needs a warm-up",
      verdict: `Your first game of a session averages ${fmt.acc(f.acc)} accuracy vs ${fmt.acc(r.acc)} afterwards. Your K/D holds up (${fmt.n2(f.kd)} vs ${fmt.n2(r.kd)}), so it's the aim that's cold, not the decisions.`,
      tip: "Five minutes of aim drills (firing range or bot bootcamp) before you queue should close the gap.",
      conf: first.length >= 40 ? 2 : 1, score: 22 + Math.abs(accGap) * 3, chart,
    };
  }
  return {
    id: "warmup", area: "Fundamentals", icon: "clock", tone: "good", title: "You start sessions strong",
    verdict: `First-game K/D ${fmt.n2(f.kd)} vs ${fmt.n2(r.kd)} for the rest of the session. No warm-up penalty.`,
    tip: "Queue ranked from the first game without worrying about it.",
    conf: confidence(first.length, 2), score: 15, chart,
  };
}

const BLOCKS = [
  { label: "Late night", short: "12–4a", from: 0, to: 4 }, { label: "Early morning", short: "4–8a", from: 4, to: 8 },
  { label: "Morning", short: "8–12", from: 8, to: 12 }, { label: "Afternoon", short: "12–4p", from: 12, to: 16 },
  { label: "Evening", short: "4–8p", from: 16, to: 20 }, { label: "Night", short: "8p–12", from: 20, to: 24 },
];
export const hourBlock = (r) => BLOCKS.find((b) => r.date.getHours() >= b.from && r.date.getHours() < b.to);

export function timeBlocks(rows) {
  return BLOCKS.map((b) => {
    const rs = rows.filter((r) => hourBlock(r) === b);
    const a = agg(rs);
    return { ...b, n: a.decided, w: a.w, wr: a.wr, kd: a.kd };
  });
}

function timeOfDay(rows) {
  const blocks = timeBlocks(rows).filter((b) => b.n >= 12);
  if (blocks.length < 2) return null;
  const base = wrOf(rows);
  const best = blocks.reduce((a, b) => (b.wr > a.wr ? b : a)), worst = blocks.reduce((a, b) => (b.wr < a.wr ? b : a));
  const z = propZ(best.w, best.n, worst.w, worst.n);
  const gap = best.wr - worst.wr;
  const chart = (el) =>
    columns(el, timeBlocks(rows).map((b) => ({
      label: b.short, value: b.n >= 12 ? b.wr : null, color: b === worst && gap >= 0.08 ? hl() : dim(),
      tip: () => ({ title: `${b.label} (${b.short})`, rows: [{ label: "Win rate", value: fmt.pct(b.wr) }, { label: "K/D", value: fmt.n2(b.kd) }, { label: "Games", value: fmt.int(b.n) }] }),
    })), { height: 150, yFormat: fmt.pct, refs: [{ y: base.wr, label: `overall ${pct(base.wr)}` }], yDomain: [0, 0.8] });
  if (gap < 0.08) return { id: "time-of-day", area: "Mindset", icon: "clock", tone: "neutral", title: "Time of day doesn't matter much", verdict: `Your win rate stays within ${Math.round(gap * 100)} points across the hours you play.`, tip: "Play when it suits you.", conf: 1, score: 8, chart };
  const conf = confidence(Math.min(best.n, worst.n), z);
  return {
    id: "time-of-day", area: "Mindset", icon: "clock", tone: "bad", title: `${worst.label} games cost you`,
    verdict: `${worst.label} (${worst.short}): ${pct(worst.wr)} win rate over ${worst.n} games. ${best.label}: ${pct(best.wr)}.`,
    tip: `Save ranked for ${best.label.toLowerCase()} sessions, and keep ${worst.label.toLowerCase()} games social.`,
    conf, score: 40 * (0.5 + conf / 6) + gap * 80, chart,
  };
}

function finishing(rows) {
  if (rows.length < 20) return null;
  let dd = 0, k = 0, ldd = 0, lk = 0;
  for (const r of rows) { dd += r.dd; k += r.k; ldd += r.lobbyDD; lk += r.lobbyK; }
  const you = dd / Math.max(k, 1), lobby = ldd / Math.max(lk, 1), ratio = you / lobby;
  const a = agg(rows);
  const chart = (el) => barList(el, [
    { label: "You", value: you, display: fmt.int(you), color: cssVar("--s1") },
    { label: "Lobby average", value: lobby, display: fmt.int(lobby), color: cssVar("--axis") },
  ], { head: ["Damage dealt per kill", "", ""] });
  if (ratio >= 1.12)
    return {
      id: "finishing", area: "Gunfights", icon: "crosshair", tone: "bad", title: "You do the damage, others get the kill",
      verdict: `You deal ${fmt.int(you)} damage per kill; your lobbies average ${fmt.int(lobby)}. That's ${Math.round((ratio - 1) * 100)}% more work for each kill, and ${fmt.n1(a.apg)} assists a game.`,
      tip: "Finish fights: melee or a quick follow-up shot the moment shields pop, nade before you push, and call out one-shot targets so a teammate can clean up.",
      conf: rows.length >= 60 ? 3 : 2, score: 50 + (ratio - 1) * 100,
      chart,
    };
  if (ratio <= 0.9)
    return {
      id: "finishing", area: "Gunfights", icon: "crosshair", tone: "good", title: "Efficient finisher",
      verdict: `You need ${fmt.int(you)} damage per kill vs a lobby average of ${fmt.int(lobby)}. You close out fights well.`,
      tip: "Stay near a teammate who strips shields; you're the one who converts.",
      conf: rows.length >= 60 ? 3 : 2, score: 30, chart,
    };
  return null;
}

function survival(rows) {
  if (rows.length < 20) return null;
  const a = agg(rows);
  const lobbyD = mean(rows.map((r) => r.lobbyAvgD));
  const ratio = a.dpg / Math.max(lobbyD, 0.1);
  const chart = (el) => barList(el, [
    { label: "You", value: a.dpg, display: fmt.n1(a.dpg), color: cssVar("--s1") },
    { label: "Lobby average", value: lobbyD, display: fmt.n1(lobbyD), color: cssVar("--axis") },
  ], { head: ["Deaths per game", "", ""] });
  if (ratio >= 1.08)
    return {
      id: "survival", area: "Survival", icon: "shield", tone: "bad", title: "You die more than your lobbies",
      verdict: `You die ${fmt.n1(a.dpg)} times a game; the average player in your lobbies dies ${fmt.n1(lobbyD)} times. Average life: ${fmt.secs(a.lifeAvg)}.`,
      tip: "Play one step more conservatively: back off to recharge after a trade, don't re-peek the angle you just lost on, and cross open ground with a teammate.",
      conf: rows.length >= 60 ? 3 : 2, score: 55 + (ratio - 1) * 120, chart,
    };
  if (ratio <= 0.92)
    return {
      id: "survival", area: "Survival", icon: "shield", tone: "good", title: "You're hard to kill",
      verdict: `${fmt.n1(a.dpg)} deaths a game vs a lobby average of ${fmt.n1(lobbyD)}. Your discipline keeps your team in fights.`,
      tip: "That gives you room to take one more fight per life when your team needs a pick.",
      conf: rows.length >= 60 ? 3 : 2, score: 28, chart,
    };
  return null;
}

function aim(rows) {
  const withAcc = rows.filter((r) => r.acc != null && r.sf >= 20);
  if (withAcc.length < 40) return null;
  const base = agg(withAcc).acc;
  const recent = agg(withAcc.slice(-20)).acc;
  const delta = recent - base;
  const series = rolling(withAcc, 20, (a) => a.acc);
  const chart = (el) =>
    lineChart(el, {
      height: 160, yFormat: (v) => `${v.toFixed(0)}%`, refs: [{ y: base, label: `avg ${base.toFixed(1)}%` }],
      series: [{ name: "Accuracy (20-game avg)", color: cssVar("--s1"), data: series.map((p, i) => ({ x: i, y: p.v, row: p.row })) }],
      xTicks: () => [], legend: false,
      tooltip: (p) => ({ title: fmt.date(p.row.t), rows: [{ label: "20-game accuracy", value: fmt.acc(p.y), color: cssVar("--s1") }] }),
    });
  if (delta <= -1.8)
    return { id: "aim", area: "Gunfights", icon: "crosshair", tone: "bad", title: "Your aim has dipped", verdict: `Last 20 games: ${fmt.acc(recent)} accuracy, down from your ${fmt.acc(base)} average.`, tip: "Do 10 minutes of aim warm-up before each session this week, and check your sensitivity hasn't drifted.", conf: 2, score: 40 + Math.abs(delta) * 6, chart };
  if (delta >= 1.8)
    return { id: "aim", area: "Gunfights", icon: "crosshair", tone: "good", title: "Your aim is trending up", verdict: `Last 20 games: ${fmt.acc(recent)} accuracy vs your ${fmt.acc(base)} average.`, tip: "Whatever you changed, keep doing it.", conf: 2, score: 25, chart };
  return { id: "aim", area: "Gunfights", icon: "crosshair", tone: "neutral", title: "Your aim is steady", verdict: `${fmt.acc(recent)} over your last 20 games, right around your ${fmt.acc(base)} average.`, tip: "Aim isn't the lever right now. Look at positioning and fight selection instead.", conf: 2, score: 6, chart };
}

function expected(rows) {
  const xs = rows.filter((r) => r.xk != null && r.xd != null);
  if (xs.length < 15) return null;
  const dk = mean(xs.map((r) => r.k - r.xk)), dd = mean(xs.map((r) => r.d - r.xd));
  const net = dk - dd;
  const chart = (el) => barList(el, [
    { label: "Kills vs expected", value: dk, display: fmt.signed(dk, fmt.n1), color: dk >= 0 ? cssVar("--div-pos") : cssVar("--div-neg") },
    { label: "Deaths vs expected", value: dd, display: fmt.signed(dd, fmt.n1), color: dd <= 0 ? cssVar("--div-pos") : cssVar("--div-neg") },
  ], { diverging: true, max: Math.max(Math.abs(dk), Math.abs(dd), 1), head: ["Per game, vs Halo's prediction for your rank", "", ""] });
  const conf = xs.length >= 60 ? 3 : xs.length >= 25 ? 2 : 1;
  const base = { id: "expected", area: "Ranked", icon: "ranked", conf, chart };
  const v = `Per game you get ${fmt.signed(dk, fmt.n1)} kills and ${fmt.signed(dd, fmt.n1)} deaths compared with what Halo's skill system expects at your rank (${xs.length} games).`;
  if (dk >= 0.3 && dd <= -0.3) return { ...base, tone: "good", title: "You beat your expected performance", verdict: v, tip: "You're underrated right now; your CSR should keep climbing if this holds.", score: 45 };
  if (dk >= 0.3 && dd >= 0.3) return { ...base, tone: net >= 0 ? "neutral" : "bad", title: "Aggressive trader", verdict: v, tip: "You win the fights you take, but you take too many. Skip the low-percentage pushes and keep the kills.", score: 50 + Math.abs(dd) * 10 };
  if (dk <= -0.3 && dd <= -0.3) return { ...base, tone: "neutral", title: "Playing it too safe", verdict: v, tip: "You survive, but you're not converting. Take the fights you're favored in: first shot, numbers advantage, or a weakened target.", score: 45 };
  if (dk <= -0.3 && dd >= 0.3) return { ...base, tone: "bad", title: "Underperforming at your rank", verdict: v, tip: "Back to fundamentals: slow down, fight from cover, and stay with the team. Expect CSR to settle a bit lower until the numbers turn.", score: 65 };
  return { ...base, tone: "neutral", title: "Right on expectation", verdict: v, tip: "You're playing at your rank. To climb, pick one stat from your win condition and push it.", score: 15 };
}

function lobbyDifficulty(rows) {
  const xs = rows.filter((r) => r.mmrDiff != null && r.decided);
  if (xs.length < 30) return null;
  const buckets = [
    { label: "Underdog", test: (d) => d < -40 }, { label: "Even", test: (d) => d >= -40 && d <= 40 }, { label: "Favored", test: (d) => d > 40 },
  ].map((b) => ({ ...b, ...wrOf(xs.filter((r) => b.test(r.mmrDiff))) }));
  const under = buckets[0], share = under.n / xs.length;
  const chart = (el) => columns(el, buckets.map((b) => ({ label: b.label, value: b.n >= 8 ? b.wr : null, color: dim(), tip: () => ({ title: b.label, rows: [{ label: "Win rate", value: fmt.pct(b.wr) }, { label: "Games", value: fmt.int(b.n) }] }) })), { height: 140, yFormat: fmt.pct, yDomain: [0, 1] });
  return {
    id: "lobbies", area: "Ranked", icon: "people", tone: "neutral",
    title: share > 0.4 ? "You're often the underdog" : "How matchmaking treats you",
    verdict: `${Math.round(share * 100)}% of your games start with your team rated lower than the opponents. Underdog: ${pct(under.wr)}; even: ${pct(buckets[1].wr)}; favored: ${pct(buckets[2].wr)}.`,
    tip: share > 0.4 ? "Matchmaking keeps putting you in stacked lobbies. Queue with a squad to even it out, and judge underdog games by kills vs expected, not by the result." : "Judge underdog games by kills vs expected, not by the result.",
    conf: xs.length >= 80 ? 3 : 2, score: share > 0.4 ? 35 : 12, chart,
  };
}

export function poolStats(rows, key, minN, k = 10) {
  const base = wrOf(rows).wr;
  const g = groupBy(rows, key);
  return [...g.entries()]
    .map(([name, rs]) => {
      const a = agg(rs);
      return { name, rows: rs, n: a.decided, w: a.w, wr: a.wr, kd: a.kd, adj: shrink(a.w, a.decided, base, k), a };
    })
    .filter((m) => m.n >= minN)
    .sort((a, b) => b.adj - a.adj);
}

function mapPool(rows, ctx) {
  const maps = poolStats(rows, "mapName", 10);
  if (maps.length < 4) return null;
  const base = wrOf(rows).wr;
  const best = maps.filter((m) => m.adj >= base + 0.025).slice(0, 3);
  const worst = maps.filter((m) => m.adj <= base - 0.025).slice(-3).reverse();
  const spread = maps[0].adj - maps[maps.length - 1].adj;
  const shown = maps.length > 12 ? [...maps.slice(0, 6), ...maps.slice(-6)] : maps;
  const chart = (el) => barList(el, shown.map((m) => ({
    label: m.name, value: m.adj - base, display: fmt.pct(m.wr), note: `${m.n} g`, color: m.adj >= base ? cssVar("--div-pos") : cssVar("--div-neg"),
    tip: () => ({ title: m.name, rows: [{ label: "Record", value: `${m.w}–${m.n - m.w}` }, { label: "Win rate", value: fmt.pct(m.wr) }, { label: "Adjusted", value: fmt.pct(m.adj) }, { label: "K/D", value: fmt.n2(m.kd) }], note: "Adjusted = pulled toward your average so small samples don't dominate" }),
    map: m.name,
  })), { diverging: true, max: Math.max(...maps.map((m) => Math.abs(m.adj - base)), 0.05), onClick: (it) => ctx?.go?.("briefing", { bmap: it.map, bfam: "" }) });
  const parts = [];
  if (best.length) parts.push(`Strongest: ${best.map((m) => `${m.name} (${pct(m.wr)})`).join(", ")}.`);
  if (worst.length) parts.push(`Weakest: ${worst.map((m) => `${m.name} (${pct(m.wr)})`).join(", ")}.`);
  return {
    id: "map-pool", area: "Map pool", icon: "maps", tone: worst.length ? "bad" : "neutral",
    title: worst.length ? `Fix ${worst[0].name}` : "Your map pool is even",
    verdict: (parts.join(" ") || "No map stands out either way.") + " (10+ games each, small samples pulled toward your average.)",
    tip: worst.length ? `Run a custom game on ${worst[0].name}: walk the power positions, weapon spawns and spawn flips for 10 minutes, then check its briefing before you load in.` : "Nothing to fix map-wise.",
    conf: maps.length >= 6 ? 2 : 1, score: 25 + spread * 100, chart,
  };
}

function modeStrengths(rows, ctx) {
  const modes = poolStats(rows, "famName", 15, 25);
  if (modes.length < 2) return null;
  const base = wrOf(rows).wr;
  const solid = modes.filter((m) => m.n >= 30);
  if (!solid.length) return null;
  const best = solid[0], worst = solid[solid.length - 1];
  const chart = (el) => barList(el, modes.map((m) => ({
    label: m.name, value: m.adj - base, display: fmt.pct(m.wr), note: `${m.n} g`, color: m.adj >= base ? cssVar("--div-pos") : cssVar("--div-neg"),
    tip: () => ({ title: m.name, rows: [{ label: "Record", value: `${m.w}–${m.n - m.w}` }, { label: "Win rate", value: fmt.pct(m.wr) }, { label: "K/D", value: fmt.n2(m.kd) }] }), fam: m.name,
  })), { diverging: true, max: Math.max(...modes.map((m) => Math.abs(m.adj - base)), 0.05), onClick: (it) => ctx?.go?.("briefing", { bmap: "", bfam: it.fam }) });
  return {
    id: "modes", area: "Map pool", icon: "flag", tone: "neutral", title: `${best.name} is your mode`,
    verdict: `${best.name}: ${pct(best.wr)} over ${best.n} games. ${worst.name}: ${pct(worst.wr)} over ${worst.n}.`,
    tip: best.adj - worst.adj > 0.06 ? `When you're grinding CSR, the ${worst.name} games are where it leaks. Check its briefing before you load in.` : "You're consistent across modes.",
    conf: 2, score: 18 + (best.adj - worst.adj) * 80, chart,
  };
}

function objective(rows) {
  const obj = rows.filter((r) => r.objMode);
  const fams = [...groupBy(obj, "famName").entries()]
    .map(([fam, rs]) => {
      const w = rs.filter((r) => r.win), l = rs.filter((r) => r.loss);
      const metric = fam === "Capture the Flag" ? (r) => r.obja + r.objk : (r) => r.objt;
      const c = compare(w.map(metric), l.map(metric));
      return { fam, ...c, f: fam === "Capture the Flag" ? fmt.n1 : fmt.secs, unit: fam === "Capture the Flag" ? "flag plays" : "on objective" };
    })
    .filter((x) => x.na >= 8 && x.nb >= 8);
  if (!fams.length) return null;
  fams.sort((a, b) => b.d - a.d);
  const top = fams[0];
  return {
    id: "objective", area: "Teamplay", icon: "flag", tone: top.d > 0.3 ? "neutral" : "good",
    title: top.d > 0.3 ? `Objective play wins your ${top.fam} games` : "Your objective play is consistent",
    verdict: fams.map((x) => `${x.fam}: ${x.f(x.ma)} ${x.unit} in wins vs ${x.f(x.mb)} in losses.`).join(" "),
    tip: top.d > 0.3 ? `In ${top.fam}, commit to the objective when your team has numbers. Your wins average ${top.f(top.ma)} ${top.unit}.` : "You play the objective the same way in wins and losses, so the difference is coming from gunfights.",
    conf: confidence(top.na + top.nb, top.t), score: 20 + Math.max(0, top.d) * 40,
    chart: (el) => pairBars(el, fams.map((x) => ({ label: x.fam, a: x.ma, b: x.mb, f: x.f, tag: x.unit }))),
  };
}

export const personName = (person, kind = "Player") => person?.gt || `${kind} ··${person?.xuid.slice(-6) ?? "?"}`;

export function squadStats(rows, people, minGames = 8, exclude = new Set()) {
  const counts = new Map();
  for (const r of rows) for (const p of r.mates || []) if (!exclude.has(people[p]?.xuid)) counts.set(p, (counts.get(p) || 0) + 1);
  const base = wrOf(rows);
  return [...counts.entries()]
    .filter(([, n]) => n >= minGames)
    .map(([pi, n]) => {
      const withRows = rows.filter((r) => r.mates.includes(pi));
      const a = agg(withRows), wo = wrOf(rows.filter((r) => !r.mates.includes(pi)));
      const person = people[pi];
      return { pi, person, name: personName(person, "Teammate"), named: !!person?.gt, n, wr: a.wr, w: a.w, kd: a.kd, without: wo.wr, adj: shrink(a.w, a.decided, base.wr, 10), last: withRows[withRows.length - 1]?.t, a };
    })
    .sort((a, b) => b.n - a.n);
}

function squad(rows, ctx) {
  const mates = squadStats(rows, ctx.db.people, 10, new Set(ctx.db.players.map((p) => p.xuid)));
  if (!mates.length) return null;
  const base = wrOf(rows).wr;
  const best = [...mates].sort((a, b) => b.adj - a.adj)[0];
  const top = mates.slice(0, 6);
  const chart = (el) => barList(el, top.map((m) => ({
    label: m.name, value: m.wr, display: fmt.pct(m.wr), note: `${m.n} g`, color: cssVar("--s1"),
    tip: () => ({ title: m.name, rows: [{ label: "Games together", value: fmt.int(m.n) }, { label: "Win rate together", value: fmt.pct(m.wr) }, { label: "Your K/D with them", value: fmt.n2(m.kd) }] }),
  })), { max: 1, head: ["Most frequent teammates", "", "Win rate"] });
  const lift = best.wr - base;
  return {
    id: "squad", area: "Teamplay", icon: "people", tone: lift >= 0.06 ? "good" : "neutral",
    title: lift >= 0.06 ? `You win more with ${best.name}` : "Your squad",
    verdict: `${mates.length} regular teammate${mates.length === 1 ? "" : "s"}. With ${best.name} you win ${pct(best.wr)} (${best.n} games) vs ${pct(base)} overall.`,
    tip: lift >= 0.06 ? `Queue ranked with ${best.name} when you can.` : "No teammate swings your results much, so pick squads for fun.",
    conf: best.n >= 30 ? 2 : 1, score: 15 + Math.max(0, lift) * 100, chart,
  };
}

function quitting(rows) {
  const left = rows.filter((r) => !r.done || r.out === "D");
  const rate = left.length / Math.max(rows.length, 1);
  if (left.length < 4 || rate < 0.025) return null;
  return {
    id: "quitting", area: "Mindset", icon: "alert", tone: "bad", title: "Early exits are costing you",
    verdict: `You left ${left.length} games early (${(rate * 100).toFixed(1)}% of matches). Each one is an automatic loss.`,
    tip: "If you need to stop, stop between matches. Leaving mid-game costs CSR and can trigger matchmaking bans.",
    conf: 3, score: 30 + rate * 300,
  };
}

/** Run every analysis, best first. ctx: {db, go} */
export function coach(allRows, ctx) {
  const rows = allRows.filter((r) => !r.casual && !r.ffa);
  const fns = [winCondition, survival, finishing, tilt, sessionLength, warmup, timeOfDay, aim, expected, lobbyDifficulty, mapPool, modeStrengths, objective, squad, quitting];
  const out = [];
  for (const fn of fns) {
    try {
      const x = fn(rows, ctx);
      if (x) out.push(x);
    } catch (e) {
      console.warn(`insight ${fn.name} failed`, e);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The top items to work on: "bad" findings first, then neutral ones, by score. */
export function focusAreas(list, n = 3) {
  const lead = list.filter((i) => i.id === "win-condition");
  const bad = list.filter((i) => i.tone === "bad");
  const neutral = list.filter((i) => i.tone === "neutral" && i.id !== "win-condition");
  return [...lead, ...bad, ...neutral].slice(0, n);
}

// ---------- Overview narrative ----------
export function formStory(rows, { they = false } = {}) {
  const your = they ? "their" : "your", you = they ? "they" : "you", youre = they ? "they're" : "you're";
  if (rows.length < 30) return null;
  const roll = rolling(rows, 20, (a) => a.kd);
  const cur = roll[roll.length - 1].v;
  const history = roll.slice(0, -1).map((p) => p.v);
  const pctile = history.filter((v) => v <= cur).length / Math.max(history.length, 1);
  const recent = agg(rows.slice(-20)), before = agg(rows.slice(0, -20));
  let since = null;
  for (let i = roll.length - 21; i >= 0; i--) if (roll[i].v >= cur) { since = roll[i].row; break; }
  const state = pctile >= 0.8 ? "hot" : pctile <= 0.2 ? "cold" : "steady";
  const kdTxt = `${fmt.n2(recent.kd)} K/D and ${fmt.pct(recent.wr)} wins over ${your} last 20`;
  let headline, sub;
  if (state === "hot") {
    headline = since ? `Heating up: ${your} best 20-game stretch since ${fmt.month(since.t)}.` : `Heating up: this is ${your} best 20-game stretch on record.`;
    sub = `${kdTxt}, up from ${fmt.n2(before.kd)} and ${fmt.pct(before.wr)} before that.${they ? "" : " Ride it: this is the time to grind ranked."}`;
  } else if (state === "cold") {
    headline = `Cold streak: ${fmt.n2(recent.kd)} K/D over ${your} last 20 games.`;
    sub = `That's down from ${fmt.n2(before.kd)} before.${they ? "" : " It happens. The Coach tab has the specific things to fix."}`;
  } else if (recent.wr <= before.wr - 0.1) {
    headline = `${they ? "Their" : "Your"} K/D is steady, but the wins aren't coming.`;
    sub = `${kdTxt}, compared with ${fmt.n2(before.kd)} and ${fmt.pct(before.wr)} before.${they ? "" : " You're holding your own in fights. Check objective play and who you're queueing with."}`;
  } else if (recent.wr >= before.wr + 0.1) {
    headline = `Steady fragging, and ${youre} winning more.`;
    sub = `${kdTxt}, compared with ${fmt.n2(before.kd)} and ${fmt.pct(before.wr)} before.`;
  } else {
    headline = `Steady form: ${youre} playing right at ${your} level.`;
    sub = `${kdTxt}, compared with ${fmt.n2(before.kd)} and ${fmt.pct(before.wr)} before.`;
  }
  return { state, headline, sub, pctile, recent, before };
}

export { BLOCKS, METRICS };
