import { esc, fmt, accountColor, cssVar, ago, icon } from "../util.js";
import { agg, groupBy } from "../stats.js";
import { columns, barList } from "../charts.js";
import { squadStats, personName } from "../insights.js";
import { noGames, avatar } from "./common.js";
import { applyFilters, rowsFor } from "../data.js";

export function render(ctx) {
  const { rows, el, db, f } = ctx;
  if (!rows.length) { el.innerHTML = noGames(ctx); return; }
  const base = agg(rows);
  const own = new Set(db.players.filter((p) => p.me || p.xuid === f.who).map((p) => p.xuid));
  const mates = squadStats(rows, db.people, 5, own);
  const named = mates.filter((m) => m.named).length;
  const rivals = rivalStats(rows, db.people, own);
  const frenemies = frenemyStats(rows, db.people, own);
  const showAccounts = f.who === "me" && db.me.length > 1;

  el.innerHTML = `
  <div class="page-head"><div><h1>Squad</h1><p>Who you play with, who you keep running into, and how your accounts compare.</p></div></div>
  ${showAccounts ? `<section class="card">
    <div class="card-head"><div><h2>Your accounts</h2><div class="sub">Same filters, split by account. Tap an account to view just that one.</div></div></div>
    <div class="table-wrap" id="acct-table"></div>
    <div class="card-head" style="margin-top:18px"><div><h2>Which account, when</h2><div class="sub">Games per month by account</div></div></div>
    <div class="chart" id="acct-months"></div>
  </section>` : ""}
  ${frenemies.length ? `<section class="card mt">
    <div class="card-head"><div><h2>Frenemies</h2><div class="sub">Regular teammates who also turn up on the other side</div></div></div>
    <div class="grid g2" style="gap:10px">${frenemies.slice(0, 4).map((x) => `<div class="story">${icon("people")}<div><b>${esc(x.name)}</b><p>With you: ${x.withA.w}–${x.withA.decided - x.withA.w} (${fmt.pct(x.withA.wr)}) over ${x.withA.n} games. Against you: you're ${x.vsA.w}–${x.vsA.decided - x.vsA.w}${x.vsA.wr <= 0.25 ? ". Keep them on your team." : x.vsA.wr >= 0.6 ? ". You have their number." : "."}</p></div></div>`).join("")}</div>
  </section>` : ""}
  <div class="grid g2 mt">
    <section class="card">
      <div class="card-head"><div><h2>Regular teammates</h2><div class="sub">5+ games together. Your overall win rate here: ${fmt.pct(base.wr)}.</div></div></div>
      ${mates.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Teammate</th><th class="n">Games</th><th class="n">Win %</th><th class="n">vs without</th><th class="n">Your K/D</th><th class="n">Last</th></tr></thead><tbody>
        ${mates.slice(0, 25).map((m) => `<tr><td class="lead">${esc(m.name)}</td><td class="n">${m.n}</td><td class="n">${fmt.pct(m.wr)}</td><td class="n ${m.wr - m.without >= 0.05 ? "good-text" : m.wr - m.without <= -0.05 ? "bad-text" : ""}">${fmt.signed((m.wr - m.without) * 100, (v) => `${Math.round(v)} pts`)}</td><td class="n">${fmt.n2(m.kd)}</td><td class="n">${esc(ago(m.last))}</td></tr>`).join("")}
      </tbody></table></div>` : '<p class="note">No regular teammates in this view.</p>'}
      ${mates.length && named < mates.length ? `<p class="note" style="margin-top:10px">${mates.length - named} teammate${mates.length - named === 1 ? "" : "s"} show as IDs. The ingest resolves gamertags for anyone you've played with 3+ times, so names fill in after the next run.</p>` : ""}
    </section>
    <section class="card">
      <div class="card-head"><div><h2>Rivals</h2><div class="sub">Opponents you keep running into (4+ games), and your record against them</div></div></div>
      <div id="rivals"></div>
    </section>
  </div>
  <section class="card mt">
    <div class="card-head"><div><h2>Solo vs with your regulars</h2><div class="sub">Games with at least one regular teammate (10+ games together) vs without</div></div></div>
    <div id="solo"></div>
  </section>`;

  if (showAccounts) {
    const accts = db.me.map((p, i) => {
      const rs = applyFilters(rowsFor(db, p.xuid), f);
      return { p, i, a: agg(rs), last: rs[rs.length - 1]?.t };
    });
    el.querySelector("#acct-table").innerHTML = `<table class="t"><thead><tr><th>Account</th><th class="n">Games</th><th class="n">Win %</th><th class="n">K/D</th><th class="n">Dmg ratio</th><th class="n">Acc</th><th class="n">Hours</th><th class="n">Last played</th></tr></thead><tbody>
      ${accts.map((x) => `<tr class="clickable" data-who="${esc(x.p.xuid)}"><td class="lead"><span style="display:inline-flex;align-items:center;gap:8px">${avatar(x.p.xuid, db).replace('class="avatar ', 'style="width:22px;height:22px;font-size:10px;border-radius:7px" class="avatar ')}${esc(x.p.gamertag)}</span></td><td class="n">${fmt.int(x.a.n)}</td><td class="n">${fmt.pct(x.a.wr)}</td><td class="n">${fmt.n2(x.a.kd)}</td><td class="n">${fmt.n2(x.a.dmgRatio)}</td><td class="n">${fmt.acc(x.a.acc)}</td><td class="n">${fmt.int(x.a.hours)}</td><td class="n">${x.last ? esc(ago(x.last)) : "–"}</td></tr>`).join("")}
    </tbody></table>`;
    el.querySelectorAll("tr[data-who]").forEach((tr) => tr.addEventListener("click", () => ctx.setFilter({ who: tr.dataset.who })));

    const byMonth = groupBy(rows, (r) => `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, "0")}`);
    const keys = [...byMonth.keys()].sort();
    const colors = db.me.map((_, i) => accountColor(i));
    columns(el.querySelector("#acct-months"), keys.map((k) => {
      const rs = byMonth.get(k);
      const segs = db.me.map((p, i) => ({ v: rs.filter((r) => r.p === p.i).length, color: colors[i], name: p.gamertag }));
      const label = new Date(`${k}-01T00:00`).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
      return { label, segs, tip: () => ({ title: label, rows: segs.map((s) => ({ label: s.name, value: fmt.int(s.v), color: s.color })) }) };
    }), { height: 170, labelEvery: Math.max(1, Math.ceil(keys.length / 8)), legend: db.me.map((p, i) => ({ name: p.gamertag, color: colors[i] })) });
  }

  barList(el.querySelector("#rivals"), rivals.slice(0, 12).map((r) => ({
    label: r.name, value: r.wr - 0.5, display: `${r.w}–${r.n - r.w}`, note: `${r.n} g`,
    color: r.wr >= 0.5 ? cssVar("--div-pos") : cssVar("--div-neg"),
    tip: () => ({ title: r.name, rows: [{ label: "Your record vs them", value: `${r.w}–${r.n - r.w}` }, { label: "Win rate", value: fmt.pct(r.wr) }, { label: "Your K/D in those games", value: fmt.n2(r.kd) }] }),
  })), { diverging: true, max: 0.5, emptyText: "No repeat opponents in this view.", head: ["Opponent", "← they win · you win →", "Record"] });

  const regulars = new Set(squadStats(rows, db.people, 10, own).map((m) => m.pi));
  const withR = rows.filter((r) => r.mates.some((p) => regulars.has(p))), solo = rows.filter((r) => !r.mates.some((p) => regulars.has(p)));
  const A = agg(withR), S = agg(solo);
  barList(el.querySelector("#solo"), [
    { label: "With a regular", value: A.wr ?? 0, display: fmt.pct(A.wr), note: `${A.n} g · ${fmt.n2(A.kd)} K/D`, color: cssVar("--s1") },
    { label: "Without", value: S.wr ?? 0, display: fmt.pct(S.wr), note: `${S.n} g · ${fmt.n2(S.kd)} K/D`, color: cssVar("--axis") },
  ], { max: 1, head: ["", "", "Win rate"] });
}

function rivalStats(rows, people, own) {
  const m = new Map();
  for (const r of rows) for (const p of r.foes || []) {
    if (own.has(people[p]?.xuid)) continue;
    if (!m.has(p)) m.set(p, []);
    m.get(p).push(r);
  }
  return [...m.entries()].filter(([, rs]) => rs.length >= 4).map(([pi, rs]) => {
    const a = agg(rs);
    return { pi, name: personName(people[pi]), n: a.decided, w: a.w, wr: a.wr ?? 0, kd: a.kd };
  }).sort((x, y) => y.n - x.n);
}

function frenemyStats(rows, people, own) {
  const withM = new Map(), vsM = new Map();
  for (const r of rows) {
    for (const p of r.mates || []) { if (!withM.has(p)) withM.set(p, []); withM.get(p).push(r); }
    for (const p of r.foes || []) { if (!vsM.has(p)) vsM.set(p, []); vsM.get(p).push(r); }
  }
  return [...withM.entries()]
    .filter(([p, rs]) => rs.length >= 10 && (vsM.get(p)?.length || 0) >= 5 && !own.has(people[p]?.xuid))
    .map(([p, rs]) => ({ name: personName(people[p], "Teammate"), withA: agg(rs), vsA: agg(vsM.get(p)) }))
    .sort((x, y) => y.vsA.n - x.vsA.n);
}
