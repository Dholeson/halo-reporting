import { esc, fmt, icon, ago, cssVar, scales, plural } from "../util.js";
import { agg, rolling, streaks, groupBy } from "../stats.js";
import { lineChart, columns, heatGrid, calendar, barList, resultStrip, scaleLegend, dataTable } from "../charts.js";
import { coach, formStory, poolStats, focusAreas } from "../insights.js";
import { kpiTile, avatar, primaryAccount, noGames, wireMatchLinks } from "./common.js";
import { rangeLabel, prevLabel, applyFilters } from "../data.js";
import { mapArt, artLayer, medalIcon } from "../art.js";

const KPIS = [
  { m: "wr", pick: (a) => a.wr },
  { m: "kd", pick: (a) => a.kd },
  { m: "dmgRatio", pick: (a) => a.dmgRatio },
  { m: "acc", pick: (a) => a.acc },
  { m: "k10", pick: (a) => a.k10 },
  { m: "d10", pick: (a) => a.d10 },
];

export function render(ctx) {
  const { rows, prev, f, db, el } = ctx;
  if (!rows.length) {
    el.innerHTML = noGames(ctx);
    return;
  }
  const a = agg(rows);
  const p = prev && prev.length >= 3 ? agg(prev) : null;
  const they = f.who !== "me" && !db.players.find((x) => x.xuid === f.who)?.me;
  const story = formStory(rows, { they });
  const st = streaks(rows);
  const last = rows[rows.length - 1];
  const primary = primaryAccount(db, ctx.all);
  const isMe = f.who === "me";
  const person = isMe ? null : db.players.find((x) => x.xuid === f.who);
  const name = isMe ? primary?.gamertag || "You" : person?.gamertag;
  const accounts = isMe ? db.me.map((x) => x.gamertag) : [];
  const insights = coach(rows, ctx);
  const focus = focusAreas(insights, 3);
  // Smoothing scales with history: 20-game form for a few hundred games, up to 50 for thousands.
  const win = rows.length < 100 ? Math.max(5, Math.floor(rows.length / 5)) : Math.min(50, Math.max(20, Math.round(rows.length / 45)));

  const statusIcon = story ? { hot: "flame", cold: "snow", steady: "steady" }[story.state] : "steady";
  const statusLabel = story ? { hot: "In form", cold: "Cold streak", steady: "Steady" }[story.state] : "Getting started";
  const statusCls = story?.state === "hot" ? "good-text" : story?.state === "cold" ? "bad-text" : "text-2";
  const filtersDesc = [rangeLabel(f.range), f.queue !== "all" ? f.queue : "", f.fam, f.map].filter(Boolean).join(" · ");

  const topMap = [...groupBy(rows, "mapName").entries()].sort((x, y) => y[1].length - x[1].length)[0]?.[0];
  const heroArt = mapArt(topMap);

  el.innerHTML = `
  <section class="hero${heroArt ? " has-art" : ""}">${artLayer(heroArt, "fade-right")}
    <div class="hero-top">
      ${avatar(f.who, db, { size: "lg", primary })}
      <div class="hero-id">
        <div class="eyebrow">${isMe ? "Welcome back" : "Scouting report"}</div>
        <h1>${esc(name)}</h1>
        <div class="meta">
          ${isMe && accounts.length > 1 ? `<span>${esc(accounts.length)} accounts: ${esc(accounts.join(", "))}</span>` : ""}
          <span>${plural(a.n, "game")} · ${esc(fmt.hours(a.min))} played · ${esc(filtersDesc)}</span>
        </div>
      </div>
      <div class="hero-badges">
        <span class="pill ${st.now.type === "W" ? "good" : st.now.type === "L" ? "bad" : ""}">${icon(st.now.type === "W" ? "flame" : "steady")}${st.now.len} ${st.now.type === "W" ? "win" : st.now.type === "L" ? "loss" : "game"} streak</span>
        <span class="pill outline">${icon("clock")}Last played ${esc(ago(last.t))}</span>
        ${currentRank(ctx.all)}
      </div>
    </div>
    <div class="headline">
      <span class="status ${statusCls}">${icon(statusIcon)}${esc(statusLabel)}</span>
      <h2>${esc(story?.headline || `${plural(a.n, "game")} in view. Play a few more for a trend read.`)}</h2>
      ${story ? `<p>${esc(story.sub)}</p>` : ""}
    </div>
    <div class="facts">${facts(rows, a, st).map((x) => `<span class="fact">${x}</span>`).join("")}</div>
  </section>

  <section class="grid g6 mt" aria-label="Key numbers">
    ${KPIS.map((k) => kpiTile({ m: k.m, value: k.pick(a), base: p ? k.pick(p) : null, vs: p ? prevLabel(f.range) : "", sub: f.range === "all" ? "career" : `${a.n} games`, sparkVals: rolling(rows.slice(-80), 10, k.pick).map((x) => x.v) })).join("")}
  </section>

  <div class="grid g3 mt">
    <section class="card span2">
      <div class="card-head"><div><h2>Form</h2><div class="sub">Rolling ${win}-game averages, oldest to newest. Hover for each game.</div></div></div>
      <div class="eyebrow" style="margin-bottom:4px">Win rate</div>
      <div class="chart" id="form-wr"></div>
      <div class="eyebrow" style="margin:10px 0 4px">K/D</div>
      <div class="chart" id="form-kd"></div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>${they ? "Where they're beatable" : "Your coaching plan"}</h2><div class="sub">The highest-payoff changes, from the ${fmt.int(rows.length)} games in view</div></div></div>
      <div class="stack" style="gap:14px">
        ${focus.length ? focus.map((ins, i) => `<div class="focus-card"><div class="focus-rank">${i + 1}</div><div><h3>${esc(ins.title)}</h3><p>${esc(ins.verdict)}</p></div></div>`).join("") : '<p class="note">Not enough games in view for coaching yet.</p>'}
        <a class="btn" href="#/coach${location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?")) : ""}">${icon("coach")}Open the full coaching report</a>
      </div>
    </section>
  </div>

  <section class="card mt">
    <div class="card-head"><div><h2>The story so far</h2><div class="sub" id="tl-sub"></div></div></div>
    <div class="chart" id="timeline"></div>
  </section>

  <div class="grid g2 mt">
    <section class="card">
      <div class="card-head"><div><h2>When ${they ? "they play" : "you play"} best</h2><div class="sub">Win rate by day and time (your local time), against ${they ? "their" : "your"} ${esc(fmt.pct(a.wr))} average</div></div></div>
      <div id="heat"></div>
      ${scaleLegend("div", "worse", "better", "hatched = fewer than 8 games")}
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Activity</h2><div class="sub">Games per day over the last year (ignores the time filter)</div></div></div>
      <div class="chart" id="calendar"></div>
      ${scaleLegend("seq", "fewer", "more games")}
      <div class="facts" id="cal-facts"></div>
    </section>
  </div>

  <div class="section-title"><h2>Highlight reel</h2><span class="note">Tap a card for the full match</span></div>
  <div class="grid g3" id="highlights">${highlights(rows, st)}</div>

  <div class="grid g2 mt">
    <section class="card">
      <div class="card-head"><div><h2>Maps</h2><div class="sub">Most played, vs your average win rate. Tap a map to brief it.</div></div><div class="right"><a class="btn ghost" href="#/maps">All maps</a></div></div>
      <div id="maps-snap"></div>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Modes</h2><div class="sub">Vs your average win rate. Tap to brief.</div></div></div>
      <div id="modes-snap"></div>
    </section>
  </div>

  <div class="grid g2 mt">
    <section class="card">
      <div class="card-head"><div><h2>Signature medals</h2><div class="sub">What you earn most, and the rare ones worth bragging about</div></div></div>
      ${medals(rows, db)}
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Recent results</h2><div class="sub">Last ${Math.min(40, rows.length)} games, oldest to newest. Tap one for details.</div></div></div>
      ${resultStrip(rows, { max: 40 })}
      <dl class="kv mt">
        <dt>Longest win streak</dt><dd>${st.best.len ? `${st.best.len} (${esc(fmt.dateShort(st.best.to.t))})` : "–"}</dd>
        <dt>Longest losing streak</dt><dd>${st.worst.len ? `${st.worst.len} (${esc(fmt.dateShort(st.worst.to.t))})` : "–"}</dd>
        <dt>MVP games (top kills and damage)</dt><dd>${fmt.int(a.mvp)} · ${fmt.pct(a.mvp / a.n)}</dd>
        <dt>Average lobby damage placement</dt><dd>${a.lobbyPct != null ? `Top ${Math.max(1, Math.round((1 - a.lobbyPct) * 100))}%` : "–"}</dd>
      </dl>
    </section>
  </div>`;

  // ---- charts ----
  const wrRoll = rolling(rows, win, (x) => x.wr);
  const kdRoll = rolling(rows, win, (x) => x.kd);
  const gameTip = (label, f2) => (pt) => ({ title: `${fmt.date(pt.row.t)} · game ${pt.x + 1}`, rows: [{ label, value: f2(pt.y), color: cssVar("--s1") }, { label: "This game", value: `${pt.row.out === "W" ? "Win" : "Loss"} · ${pt.row.k}/${pt.row.d}/${pt.row.a}` }, { label: "Map", value: pt.row.mapName }], note: "Click a point's game in Matches for details" });
  const xTicks = (min, max) => {
    const n = innerWidth < 600 ? 2 : 4, out = [];
    for (let i = 0; i <= n; i++) {
      const x = Math.round(min + ((max - min) * i) / n);
      const r = rows[x];
      if (r) out.push({ x, label: fmt.month(r.t) });
    }
    return out;
  };
  lineChart(el.querySelector("#form-wr"), {
    height: 150, yFormat: fmt.pct, yDomain: [0, 1], refs: [{ y: a.wr, label: `avg ${fmt.pct(a.wr)}` }], endLabels: true,
    series: [{ name: "Win rate", color: cssVar("--s1"), area: true, data: wrRoll.map((q) => ({ x: q.i, y: q.v, row: q.row })) }],
    tooltip: gameTip(`Win rate (last ${win})`, fmt.pct), xTicks,
  });
  lineChart(el.querySelector("#form-kd"), {
    height: 150, yFormat: fmt.n2, refs: [{ y: 1, label: "1.00" }], endLabels: true,
    series: [{ name: "K/D", color: cssVar("--s1"), area: true, data: kdRoll.map((q) => ({ x: q.i, y: q.v, row: q.row })) }],
    tooltip: gameTip(`K/D (last ${win})`, fmt.n2), xTicks,
  });

  timeline(el.querySelector("#timeline"), el.querySelector("#tl-sub"), rows);
  heatmap(el.querySelector("#heat"), rows, a.wr);
  const yearRows = applyFilters(ctx.all, f, { ignore: ["range"] });
  activity(el.querySelector("#calendar"), el.querySelector("#cal-facts"), yearRows);

  const maps = poolStats(rows, "mapName", 5).sort((x, y) => y.n - x.n).slice(0, 8);
  const mx = Math.max(0.08, ...maps.map((m) => Math.abs(m.adj - a.wr)));
  barList(el.querySelector("#maps-snap"), maps.map((m) => ({
    label: m.name, value: m.adj - a.wr, display: fmt.pct(m.wr), note: `${m.n} g`, color: m.adj >= a.wr ? cssVar("--div-pos") : cssVar("--div-neg"), map: m.name,
    tip: () => ({ title: m.name, rows: [{ label: "Record", value: `${m.w}–${m.n - m.w}` }, { label: "Win rate", value: fmt.pct(m.wr) }, { label: "K/D", value: fmt.n2(m.kd) }], note: "Bar = adjusted win rate vs your average" }),
  })), { diverging: true, max: mx, onClick: (it) => ctx.go("briefing", { bmap: it.map, bfam: "" }), emptyText: "Play a few more maps to compare." });
  const modes = poolStats(rows.filter((r) => !r.casual), "famName", 5).sort((x, y) => y.n - x.n).slice(0, 8);
  barList(el.querySelector("#modes-snap"), modes.map((m) => ({
    label: m.name, value: m.adj - a.wr, display: fmt.pct(m.wr), note: `${m.n} g`, color: m.adj >= a.wr ? cssVar("--div-pos") : cssVar("--div-neg"), fam: m.name,
    tip: () => ({ title: m.name, rows: [{ label: "Record", value: `${m.w}–${m.n - m.w}` }, { label: "Win rate", value: fmt.pct(m.wr) }, { label: "K/D", value: fmt.n2(m.kd) }] }),
  })), { diverging: true, max: Math.max(0.08, ...modes.map((m) => Math.abs(m.adj - a.wr))), onClick: (it) => ctx.go("briefing", { bmap: "", bfam: it.fam }) });

  el.querySelectorAll("[data-match]").forEach((c) => c.addEventListener("click", () => ctx.openMatch(ctx.all.find((r) => r.idx === +c.dataset.match))));
  el.querySelectorAll("[data-match]").forEach((c) => c.addEventListener("keydown", (e) => { if (e.key === "Enter") c.click(); }));
  wireMatchLinks(el, ctx);
}

function currentRank(all) {
  const ranked = all.filter((r) => r.csrPost != null);
  if (!ranked.length) return "";
  const last = ranked[ranked.length - 1];
  return `<span class="pill accent">${icon("ranked")}${esc(last.tierName || "Ranked")} · ${fmt.int(last.csrPost)} CSR <span class="muted" style="font-weight:500">${esc(last.plName)}</span></span>`;
}

function facts(rows, a, st) {
  const out = [];
  const maps = [...groupBy(rows, "mapName").entries()].sort((x, y) => y[1].length - x[1].length);
  if (maps[0]) out.push(`Most played <b>${esc(maps[0][0])}</b> ${fmt.int(maps[0][1].length)} games`);
  const fams = [...groupBy(rows, "famName").entries()].sort((x, y) => y[1].length - x[1].length);
  if (fams[0]) out.push(`Favourite mode <b>${esc(fams[0][0])}</b>`);
  out.push(`<b>${fmt.n1(a.kpg)}</b> kills · <b>${fmt.n1(a.dpg)}</b> deaths · <b>${fmt.n1(a.apg)}</b> assists a game`);
  out.push(`Headshots <b>${fmt.pct(a.hsPct)}</b> of kills`);
  if (st.best.len >= 3) out.push(`Best run <b>${st.best.len} straight wins</b>`);
  return out;
}

function timeline(el, subEl, rows) {
  const span = rows[rows.length - 1].t - rows[0].t;
  const weekly = span > 70 * 86400;
  const monthly = span > 2.5 * 365 * 86400;
  const keyOf = (r) => {
    const d = new Date(r.t * 1000);
    if (monthly) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (weekly) { const m = new Date(d); m.setHours(0, 0, 0, 0); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return m.toISOString().slice(0, 10); }
    return d.toLocaleDateString("en-CA");
  };
  const groups = groupBy(rows, keyOf);
  // fill gaps so quiet periods are visible
  const keys = [];
  const start = new Date(rows[0].t * 1000), end = new Date(rows[rows.length - 1].t * 1000);
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  if (monthly) cur.setDate(1);
  else if (weekly) cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
  while (cur <= end) {
    keys.push(monthly ? `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}` : weekly ? cur.toISOString().slice(0, 10) : cur.toLocaleDateString("en-CA"));
    if (monthly) cur.setMonth(cur.getMonth() + 1);
    else cur.setDate(cur.getDate() + (weekly ? 7 : 1));
    if (keys.length > 400) break;
  }
  const good = cssVar("--good"), bad = cssVar("--bad"), tie = cssVar("--tie");
  const data = keys.map((k) => {
    const rs = groups.get(k) || [];
    const a = agg(rs);
    const label = monthly ? new Date(`${k}-01T00:00`).toLocaleDateString(undefined, { month: "short", year: "2-digit" }) : new Date(`${k}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return { key: k, label, n: rs.length, segs: [{ v: a.w, color: good, name: "Wins" }, { v: a.l + a.dnf, color: bad, name: "Losses" }, { v: a.t, color: tie, name: "Ties" }], tip: () => ({ title: `${monthly ? "" : weekly ? "Week of " : ""}${label}`, rows: [{ label: "Games", value: fmt.int(rs.length) }, { label: "Record", value: `${a.w}–${a.l + a.dnf}${a.t ? `–${a.t}` : ""}` }, { label: "Win rate", value: fmt.pct(a.wr) }, { label: "K/D", value: fmt.n2(a.kd) }] }) };
  });
  const busiest = data.reduce((x, y) => (y.n > x.n ? y : x), data[0]);
  const bestPeriod = data.filter((d) => d.n >= 10).reduce((x, y) => (!x || agg(groups.get(y.key)).wr > agg(groups.get(x.key)).wr ? y : x), null);
  subEl.textContent = `Games per ${monthly ? "month" : weekly ? "week" : "day"}, wins and losses stacked. Busiest: ${busiest.label} (${busiest.n} games)${bestPeriod ? `. Best ${monthly ? "month" : weekly ? "week" : "day"} with 10+ games: ${bestPeriod.label} (${fmt.pct(agg(groups.get(bestPeriod.key)).wr)})` : ""}.`;
  columns(el, data, { height: 190, labelEvery: Math.max(1, Math.ceil(data.length / 8)), legend: [{ name: "Wins", color: good }, { name: "Losses", color: bad }, { name: "Ties", color: tie }], focusable: data.length <= 60 });
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SLOTS = ["12a", "3a", "6a", "9a", "12p", "3p", "6p", "9p"];
function heatmap(el, rows, base) {
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => []));
  for (const r of rows) cells[(r.date.getDay() + 6) % 7][Math.floor(r.date.getHours() / 3)].push(r);
  const sc = scales();
  heatGrid(el, {
    rows: DAYS, cols: SLOTS, rowWidth: "38px", colMin: "26px",
    cell: (ri, ci) => {
      const rs = cells[ri][ci];
      const a = agg(rs);
      if (a.decided < 3) return null;
      const diff = (a.wr - base) / 0.25;
      return {
        fill: sc.diverging(Math.max(-1, Math.min(1, diff))), text: a.decided >= 5 ? Math.round(a.wr * 100) : "", thin: a.decided < 8,
        aria: `${DAYS[ri]} ${SLOTS[ci]}: ${fmt.pct(a.wr)} over ${a.decided} games`,
        tip: () => ({ title: `${DAYS[ri]} ${SLOTS[ci]}–${SLOTS[(ci + 1) % 8]}`, rows: [{ label: "Win rate", value: fmt.pct(a.wr) }, { label: "Record", value: `${a.w}–${a.decided - a.w}` }, { label: "K/D", value: fmt.n2(a.kd) }], note: a.decided < 8 ? "Small sample" : null }),
      };
    },
  });
}

function activity(el, factsEl, rows) {
  const days = new Map();
  for (const r of rows) {
    const k = r.date.toLocaleDateString("en-CA");
    const d = days.get(k) || { n: 0, w: 0, l: 0, k: 0, d: 0 };
    d.n++; if (r.win) d.w++; if (r.loss) d.l++; d.k += r.k; d.d += r.d;
    days.set(k, d);
  }
  calendar(el, days);
  const yearAgo = Date.now() / 1000 - 365 * 86400;
  const yr = rows.filter((r) => r.t >= yearAgo);
  const activeDays = new Set(yr.map((r) => r.date.toLocaleDateString("en-CA"))).size;
  const biggest = [...days.entries()].filter(([k]) => new Date(`${k}T00:00`).getTime() / 1000 >= yearAgo).sort((x, y) => y[1].n - x[1].n)[0];
  factsEl.innerHTML = [
    `<span class="fact"><b>${fmt.int(yr.length)}</b> games in the last year</span>`,
    `<span class="fact"><b>${fmt.int(activeDays)}</b> days played</span>`,
    biggest ? `<span class="fact">Biggest day <b>${esc(new Date(`${biggest[0]}T00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }))}</b> ${biggest[1].n} games</span>` : "",
  ].join("");
}

function highlights(rows, st) {
  const by = (fn) => rows.reduce((x, y) => (fn(y) > fn(x) ? y : x), rows[0]);
  const best = by((r) => r.impact * 1000 + r.k);
  const kills = by((r) => r.k);
  const spree = by((r) => r.spree * 100 + r.k);
  const dmg = by((r) => r.dd);
  const csr = rows.filter((r) => r.csrDelta != null);
  const csrBest = csr.length ? csr.reduce((x, y) => (y.csrDelta > x.csrDelta ? y : x)) : null;
  const accRows = rows.filter((r) => r.sf >= 150);
  const accBest = accRows.length ? accRows.reduce((x, y) => (y.acc > x.acc ? y : x)) : null;
  const card = (r, label, ic, value, sub) => {
    const art = mapArt(r.mapName);
    return `<div class="card highlight clickable${art ? " has-art on-art" : ""}" role="button" tabindex="0" data-match="${r.idx}">${artLayer(art, "scrim-bottom")}<div class="h-label">${icon(ic)}${esc(label)}</div><div class="h-value num">${esc(value)}</div><div class="h-sub">${esc(sub)}</div></div>`;
  };
  const where = (r) => `${r.mapName} · ${r.modeShort} · ${fmt.dateShort(r.t)}`;
  return [
    card(best, "Best game", "trophy", `${best.k}/${best.d}/${best.a}`, `Impact ${best.impact} · ${where(best)}`),
    card(kills, "Most kills", "skull", `${kills.k} kills`, where(kills)),
    card(spree, "Longest spree", "flame", `${spree.spree} in a row`, where(spree)),
    card(dmg, "Most damage", "bolt", fmt.int(dmg.dd), where(dmg)),
    st.best.len >= 2
      ? `<div class="card highlight"><div class="h-label">${icon("trophy")}Longest win streak</div><div class="h-value num">${st.best.len} wins</div><div class="h-sub">${esc(fmt.dateShort(st.best.from.t))} – ${esc(fmt.dateShort(st.best.to.t))}</div></div>`
      : "",
    csrBest && csrBest.csrDelta > 0 ? card(csrBest, "Biggest CSR gain", "ranked", `+${csrBest.csrDelta} CSR`, where(csrBest)) : accBest ? card(accBest, "Sharpest aim", "crosshair", fmt.acc(accBest.acc), `${accBest.sh}/${accBest.sf} shots · ${where(accBest)}`) : "",
  ].join("");
}

function medals(rows, db) {
  const tot = new Map();
  for (const r of rows) for (const [i, c] of r.medals || []) tot.set(i, (tot.get(i) || 0) + c);
  if (!tot.size) return '<p class="note">No medals in view.</p>';
  const sorted = [...tot.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 10);
  const rare = sorted.filter(([, c]) => c <= Math.max(2, rows.length / 400)).slice(-6).reverse();
  const chip = ([i, c]) => `<span class="medal">${medalIcon(i, 22) || icon("medal")}${esc(db.medals[i] || "Medal")} <b>×${fmt.int(c)}</b><span class="muted">${(c / rows.length).toFixed(2)}/g</span></span>`;
  return `<div class="eyebrow" style="margin-bottom:6px">Most earned</div><div class="medal-list">${top.map(chip).join("")}</div>
    ${rare.length ? `<div class="eyebrow" style="margin:14px 0 6px">Rare flex</div><div class="medal-list">${rare.map(chip).join("")}</div>` : ""}`;
}

export { dataTable };
