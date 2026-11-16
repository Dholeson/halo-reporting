import { esc, fmt, icon, cssVar, accountColor } from "../util.js";
import { agg, groupBy, rolling } from "../stats.js";
import { lineChart, columns, barList } from "../charts.js";
import { noGames, emptyState } from "./common.js";

const TIERS = [
  { from: 0, to: 300, label: "Bronze" }, { from: 300, to: 600, label: "Silver" }, { from: 600, to: 900, label: "Gold" },
  { from: 900, to: 1200, label: "Platinum" }, { from: 1200, to: 1500, label: "Diamond" }, { from: 1500, to: 3000, label: "Onyx" },
];

export function render(ctx) {
  const { rows, el, params } = ctx;
  if (!rows.length) { el.innerHTML = noGames(ctx); return; }
  const ranked = rows.filter((r) => r.ranked);
  const csrRows = ranked.filter((r) => r.csrPost != null);
  const head = `<div class="page-head"><div><h1>Ranked</h1><p>Your CSR journey, where you gain and lose it, and how you perform against Halo's own expectations for your rank.</p></div></div>`;
  if (!ranked.length) { el.innerHTML = head + emptyState("No ranked games in view", "Switch the queue filter to All or widen the time range.", "ranked"); return; }

  // CSR belongs to an account: summarize each playlist per account.
  const acctOf = (r) => r.player;
  const color = (player) => { const i = ctx.db.me.findIndex((m) => m.xuid === player.xuid); return i >= 0 ? accountColor(i) : cssVar("--s1"); };
  const byPl = [...groupBy(csrRows, "plName").entries()].map(([name, rs]) => {
    const accts = [...groupBy(rs, (r) => r.p).values()].map((ars) => ({
      player: acctOf(ars[0]), rows: ars, last: ars[ars.length - 1], peak: ars.reduce((x, y) => (y.csrPost > x.csrPost ? y : x)), a: agg(ars),
    })).sort((x, y) => y.last.csrPost - x.last.csrPost);
    return { name, rows: rs, a: agg(rs), accts };
  }).sort((x, y) => y.rows.length - x.rows.length);
  const pl = byPl.find((p) => p.name === params.rpl) || byPl[0];

  if (!csrRows.length) {
    const a = agg(ranked);
    el.innerHTML = head + `<div class="callout">${icon("clock")} <b>Ranked detail is still syncing.</b> CSR, team MMR and expected kills/deaths come from a separate Halo endpoint. The ingest backfills it about 600 games per run, newest first, so this page fills in over the next few scheduled runs. You can also run <i>Ingest &amp; report</i> by hand to speed it up.</div>
      <section class="grid g4 mt">
        <div class="card kpi"><div class="label">Ranked games</div><div class="value num">${fmt.int(a.n)}</div></div>
        <div class="card kpi"><div class="label">Ranked win rate</div><div class="value num">${fmt.pct(a.wr)}</div></div>
        <div class="card kpi"><div class="label">Ranked K/D</div><div class="value num">${fmt.n2(a.kd)}</div></div>
        <div class="card kpi"><div class="label">Damage ratio</div><div class="value num">${fmt.n2(a.dmgRatio)}</div></div>
      </section>
      <section class="card mt"><div class="card-head"><div><h2>Ranked playlists</h2></div></div><div id="pl-bars"></div></section>`;
    const pls = [...groupBy(ranked, "plName").entries()].map(([name, rs]) => ({ name, a: agg(rs) })).filter((p) => p.a.n >= 5).sort((x, y) => y.a.n - x.a.n);
    barList(el.querySelector("#pl-bars"), pls.map((p) => ({ label: p.name, value: p.a.wr, display: fmt.pct(p.a.wr), note: `${p.a.n} g`, color: cssVar("--s1") })), { max: 1, head: ["Playlist", "", "Win rate"] });
    return;
  }

  const a = agg(csrRows);
  const sessions = [...groupBy(csrRows, "session").entries()].slice(-24);
  el.innerHTML = head + `
  <section class="grid g3">${byPl.slice(0, 3).map((p) => p.accts.length === 1 ? `
    <div class="card kpi">
      <div class="label"><span>${esc(p.name)}</span><span>${p.rows.length} games</span></div>
      <div class="value num">${fmt.int(p.accts[0].last.csrPost)} <small>CSR</small></div>
      <div class="text-2" style="font-weight:650">${esc(p.accts[0].last.tierName || "")}</div>
      <div class="note">Peak ${fmt.int(p.accts[0].peak.csrPost)} (${esc(fmt.date(p.accts[0].peak.t))}) · net ${esc(fmt.signed(p.a.csrNet, fmt.int))} in view</div>
    </div>` : `
    <div class="card kpi">
      <div class="label"><span>${esc(p.name)}</span><span>${p.rows.length} games</span></div>
      <dl class="kv" style="margin-top:4px">${p.accts.map((x) => `<dt style="display:flex;align-items:center;gap:6px"><span class="swatch-box" style="width:10px;height:10px;border-radius:3px;background:${color(x.player)}"></span>${esc(x.player.gamertag)}</dt><dd>${fmt.int(x.last.csrPost)} <span class="muted" style="font-weight:500">${esc(x.last.tierName || "")}</span></dd>`).join("")}</dl>
      <div class="note">Current CSR per account · best peak ${fmt.int(Math.max(...p.accts.map((x) => x.peak.csrPost)))}</div>
    </div>`).join("")}</section>

  <section class="card mt">
    <div class="card-head"><div><h2>CSR journey</h2><div class="sub">${esc(pl.name)}: CSR after each game, with tier bands${pl.accts.length > 1 ? ". One line per account (CSR is tracked per account)" : ""}</div></div>
      <div class="right">${byPl.length > 1 ? `<select class="select" id="pl-pick" aria-label="Playlist">${byPl.map((p) => `<option ${p === pl ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>` : ""}</div></div>
    <div class="chart" id="journey"></div>
  </section>

  <div class="grid g2 mt">
    <section class="card"><div class="card-head"><div><h2>Where you farm and bleed CSR</h2><div class="sub">Net CSR by map (3+ ranked games). Tap a map to brief it.</div></div></div><div id="csr-maps"></div></section>
    <section class="card"><div class="card-head"><div><h2>Net CSR by mode</h2></div></div><div id="csr-modes"></div>
      <div class="card-head" style="margin-top:18px"><div><h2>Net CSR per session</h2><div class="sub">Last ${sessions.length} ranked sessions</div></div></div><div class="chart" id="csr-sessions"></div></section>
  </div>

  <div class="grid g2 mt">
    <section class="card"><div class="card-head"><div><h2>You vs expectation</h2><div class="sub">Rolling 20-game average of kills and deaths minus what Halo expects at your rank. Above 0 on kills is good; below 0 on deaths is good.</div></div></div><div class="chart" id="expect"></div></section>
    <section class="card"><div class="card-head"><div><h2>Lobby difficulty</h2><div class="sub">Win rate by your team's MMR minus the opponents'</div></div></div><div class="chart" id="lobbies"></div><p class="note" id="lobby-note" style="margin-top:8px"></p></section>
  </div>`;

  el.querySelector("#pl-pick")?.addEventListener("change", (e) => ctx.go("ranked", { ...params, rpl: e.target.value }));

  const prs = pl.rows;
  const lo = Math.min(...prs.map((r) => Math.min(r.csrPre ?? r.csrPost, r.csrPost))), hi = Math.max(...prs.map((r) => r.csrPost));
  const domain = [Math.max(0, Math.floor((lo - 60) / 50) * 50), Math.ceil((hi + 60) / 50) * 50];
  // Time on x so accounts line up; the busiest account first so the crosshair snaps to it.
  const series = [...pl.accts].sort((x, y) => y.rows.length - x.rows.length).map((x) => ({ name: x.player.gamertag, color: color(x.player), data: x.rows.map((r) => ({ x: r.t, y: r.csrPost, row: r })) }));
  const asOf = (s, t) => { let best = null; for (const d of s.data) { if (d.x <= t) best = d; else break; } return best; };
  lineChart(el.querySelector("#journey"), {
    height: 280, yFormat: fmt.int, yDomain: domain, yTicks: 5, endLabels: true, yWidth: 44, gapBreak: 30 * 86400, // no lines through month-long breaks
    bands: TIERS.map((t, i) => ({ ...t, color: i % 2 ? "var(--text)" : "transparent" })),
    series,
    xTicks: (mn, mx) => (innerWidth < 600 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((q) => mn + (mx - mn) * q).map((x) => ({ x, label: fmt.month(x) })),
    tooltip: (p) => series.length === 1
      ? { title: `${fmt.dateTime(p.row.t)}`, rows: [{ label: "CSR", value: `${fmt.int(p.y)} (${p.row.tierName || ""})`, color: series[0].color }, { label: "Change", value: fmt.signed(p.row.csrDelta, fmt.int) }, { label: "Result", value: `${p.row.out} · ${p.row.k}/${p.row.d}/${p.row.a}` }, { label: "Map", value: `${p.row.mapName} · ${p.row.modeShort}` }] }
      : { title: fmt.date(p.x), rows: series.map((s) => { const d = asOf(s, p.x); return { label: s.name, value: d ? `${fmt.int(d.y)}${p.x - d.x > 7 * 86400 ? ` (as of ${fmt.dateShort(d.x)})` : ""}` : "not yet ranked", color: s.color }; }), note: "CSR after each account's latest game at this date" },
  });

  const netBars = (host, key, minN, click) => {
    const list = [...groupBy(csrRows, key).entries()].map(([name, rs]) => ({ name, a: agg(rs) })).filter((x) => x.a.csrN >= minN).sort((x, y) => y.a.csrNet - x.a.csrNet);
    const max = Math.max(1, ...list.map((x) => Math.abs(x.a.csrNet)));
    barList(host, list.map((x) => ({ label: x.name, value: x.a.csrNet, display: fmt.signed(x.a.csrNet, fmt.int), note: `${x.a.csrN} g`, color: x.a.csrNet >= 0 ? cssVar("--div-pos") : cssVar("--div-neg"), name: x.name, tip: () => ({ title: x.name, rows: [{ label: "Net CSR", value: fmt.signed(x.a.csrNet, fmt.int) }, { label: "Per game", value: fmt.signed(x.a.csrPerGame, fmt.n1) }, { label: "Record", value: `${x.a.w}–${x.a.decided - x.a.w}` }] }) })), { diverging: true, max, onClick: click, emptyText: "Not enough ranked games per map yet." });
  };
  netBars(el.querySelector("#csr-maps"), "mapName", 3, (it) => ctx.go("briefing", { bmap: it.name, bfam: "" }));
  netBars(el.querySelector("#csr-modes"), "famName", 3);

  columns(el.querySelector("#csr-sessions"), sessions.map(([, rs]) => {
    const s = agg(rs);
    return { label: fmt.dateShort(rs[0].t), value: s.csrNet, color: s.csrNet >= 0 ? cssVar("--div-pos") : cssVar("--div-neg"), tip: () => ({ title: `Session ${fmt.date(rs[0].t)}`, rows: [{ label: "Net CSR", value: fmt.signed(s.csrNet, fmt.int) }, { label: "Record", value: `${s.w}–${s.decided - s.w}` }, { label: "Games", value: fmt.int(s.n) }, { label: "K/D", value: fmt.n2(s.kd) }] }) };
  }), { height: 160, yFormat: (v) => fmt.signed(v, fmt.int), labelEvery: Math.ceil(sessions.length / 6) });

  const xs = csrRows.filter((r) => r.xk != null);
  if (xs.length >= 20) {
    const kRoll = rolling(xs, 20, (q) => q.xkpg), dRoll = rolling(xs, 20, (q) => q.xdpg);
    lineChart(el.querySelector("#expect"), {
      height: 200, yFormat: (v) => fmt.signed(v, fmt.n1), refs: [{ y: 0, label: "expected" }],
      series: [
        { name: "Kills vs expected", color: cssVar("--s1"), data: kRoll.map((p, i) => ({ x: i, y: p.v, row: p.row })) },
        { name: "Deaths vs expected", color: cssVar("--s2"), data: dRoll.map((p, i) => ({ x: i, y: p.v, row: p.row })) },
      ],
      endLabels: true, xTicks: () => [],
      tooltip: (p) => {
        const i = p.x;
        return { title: fmt.date(p.row.t), rows: [{ label: "Kills vs expected", value: fmt.signed(kRoll[i]?.v, fmt.n1), color: cssVar("--s1") }, { label: "Deaths vs expected", value: fmt.signed(dRoll[i]?.v, fmt.n1), color: cssVar("--s2") }], note: "20-game rolling average" };
      },
    });
  } else el.querySelector("#expect").innerHTML = '<p class="note">Needs 20+ ranked games with skill data.</p>';

  const mm = csrRows.filter((r) => r.mmrDiff != null);
  if (mm.length >= 20) {
    const B = [
      { label: "Big underdog", test: (d) => d < -100 }, { label: "Underdog", test: (d) => d >= -100 && d < -30 }, { label: "Even", test: (d) => d >= -30 && d <= 30 },
      { label: "Favored", test: (d) => d > 30 && d <= 100 }, { label: "Big favorite", test: (d) => d > 100 },
    ].map((b) => ({ ...b, a: agg(mm.filter((r) => b.test(r.mmrDiff))) }));
    columns(el.querySelector("#lobbies"), B.map((b) => ({ label: b.label, value: b.a.decided >= 5 ? b.a.wr : null, color: cssVar("--s1"), tip: () => ({ title: b.label, rows: [{ label: "Win rate", value: fmt.pct(b.a.wr) }, { label: "Games", value: fmt.int(b.a.decided) }, { label: "CSR / game", value: fmt.signed(b.a.csrPerGame, fmt.n1) }] }) })), { height: 170, yFormat: fmt.pct, yDomain: [0, 1], refs: [{ y: 0.5, label: "50%" }] });
    const avgDiff = mm.reduce((s, r) => s + r.mmrDiff, 0) / mm.length;
    el.querySelector("#lobby-note").textContent = `On average your team is rated ${Math.abs(Math.round(avgDiff))} MMR ${avgDiff < 0 ? "below" : "above"} the opponents. Halo's matchmaking aims for even games; persistent underdog lobbies usually mean a party skill gap or a rising rank.`;
  } else el.querySelector("#lobbies").innerHTML = '<p class="note">Needs 20+ ranked games with MMR data.</p>';
}
