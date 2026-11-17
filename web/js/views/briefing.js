import { esc, fmt, icon, cssVar, scales, plural } from "../util.js";
import { agg } from "../stats.js";
import { pairBars, barList, resultStrip, confHtml } from "../charts.js";
import { winConditions, poolStats } from "../insights.js";
import { kpiTile, wireMatchLinks, emptyState, resultWord } from "./common.js";
import { applyFilters, OBJECTIVE_FAMILIES } from "../data.js";
import { mapArt, artLayer } from "../art.js";
import { matchup, plan } from "../playbook.js";

export function render(ctx) {
  const { el, params, db } = ctx;
  const base = applyFilters(ctx.all, ctx.f, { ignore: ["range", "fam", "map"] }); // full history, queue respected
  if (!base.length) {
    el.innerHTML = emptyState("No games yet", "Once games are ingested, briefings appear here.", "briefing");
    return;
  }
  const map = params.bmap || "", fam = params.bfam || "";
  const overall = agg(base);

  // ---- picker data ----
  const byMap = poolStats(base, "mapName", 1).sort((a, b) => b.n - a.n);
  const byFam = poolStats(map ? base.filter((r) => r.mapName === map) : base, "famName", 1).sort((a, b) => b.n - a.n);
  const allFams = [...new Set([...byFam.map((f) => f.name), ...poolStats(base, "famName", 1).map((f) => f.name)])];
  const recent = [];
  for (let i = base.length - 1; i >= 0 && recent.length < 8; i--) {
    const r = base[i], key = `${r.mapName}|${r.famName}`;
    if (!recent.find((x) => x.key === key)) recent.push({ key, map: r.mapName, fam: r.famName, t: r.t });
  }
  const sc = scales();
  const dot = (m) => `<span class="dotwr" style="background:${sc.diverging(Math.max(-1, Math.min(1, (m.adj - overall.wr) / 0.15)))}"></span>`;
  const tile = (m) => {
    const art = mapArt(m.name, "thumb");
    return `<button class="tile${art ? " with-art" : ""}" type="button" data-map="${esc(m.name)}" aria-pressed="${m.name === map}">${artLayer(art, "scrim-bottom")}<span class="t-body"><span class="t-name">${esc(m.name)}</span><span class="t-meta">${dot(m)}${fmt.pct(m.wr)} · ${m.n} games</span></span></button>`;
  };
  const showAll = params.ball === "1";
  const mapList = showAll ? byMap : byMap.slice(0, innerWidth < 760 ? 10 : 16);
  if (map && !mapList.find((m) => m.name === map)) { const m = byMap.find((x) => x.name === map); if (m) mapList.push(m); }

  el.innerHTML = `
  <div class="page-head"><div><h1>Pre-game briefing</h1><p>Loading into a match? Pick the map and mode. You'll get your record there, what wins it for you, and a game plan.</p></div>${map && fam ? `<a class="btn primary" href="#/ingame?bmap=${encodeURIComponent(map)}&bfam=${encodeURIComponent(fam)}">${icon("crosshair")}Open in-game screen</a>` : ""}</div>
  <details class="card picker-wrap" ${map && fam ? "" : "open"}>
    <summary><span><span class="eyebrow" style="display:block">Matchup</span><span class="sel">${map || fam ? esc([map, fam].filter(Boolean).join(" · ")) : "Pick a map and mode"}</span></span><span class="btn">${map && fam ? "Change" : "Choose"}</span></summary>
  <div class="picker">
    <div class="picker-row"><div class="eyebrow">Recent matchups</div><div class="chips">
      ${recent.map((x) => `<button class="chip" type="button" data-pick="${esc(x.map)}|${esc(x.fam)}" aria-pressed="${x.map === map && x.fam === fam}">${esc(x.map)} · ${esc(x.fam)}</button>`).join("")}
    </div></div>
    <div class="picker-row"><div class="eyebrow"><span>Map</span><input class="search" id="map-search" type="search" placeholder="Search ${byMap.length} maps" aria-label="Search maps"></div>
      <div class="tiles" id="map-chips">${mapList.map(tile).join("")}</div>
      ${!showAll && byMap.length > mapList.length ? `<div><button class="chip" type="button" id="all-maps">Show all ${byMap.length} maps</button></div>` : ""}
      </div>
    <div class="picker-row"><div class="eyebrow">Mode${map ? ` <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">sorted by games on ${esc(map)}</span>` : ""}</div><div class="chips">
      ${allFams.map((name) => { const m = byFam.find((x) => x.name === name); return `<button class="chip${m ? "" : " zero"}" type="button" data-fam="${esc(name)}" aria-pressed="${name === fam}">${esc(name)}${m ? `<span class="rec">${m.n}</span>` : ""}</button>`; }).join("")}
    </div></div>
  </div></details>
  <div id="brief-out" class="mt"></div>`;

  el.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => { const [m, f] = b.dataset.pick.split("|"); ctx.go("briefing", { bmap: m, bfam: f }); }));
  el.querySelectorAll("[data-map]").forEach((b) => b.addEventListener("click", () => ctx.go("briefing", { bmap: b.dataset.map === map ? "" : b.dataset.map, bfam: fam })));
  el.querySelectorAll("[data-fam]").forEach((b) => b.addEventListener("click", () => ctx.go("briefing", { bmap: map, bfam: b.dataset.fam === fam ? "" : b.dataset.fam })));
  el.querySelector("#all-maps")?.addEventListener("click", () => ctx.go("briefing", { ...params, ball: "1" }));
  const search = el.querySelector("#map-search");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    const box = el.querySelector("#map-chips");
    const list = q ? byMap.filter((m) => m.name.toLowerCase().includes(q)) : mapList;
    box.innerHTML = list.slice(0, 24).map(tile).join("") || '<span class="note">No maps match.</span>';
    box.querySelectorAll("[data-map]").forEach((b) => b.addEventListener("click", () => ctx.go("briefing", { bmap: b.dataset.map, bfam: fam })));
  });

  const out = el.querySelector("#brief-out");
  if (!map && !fam) {
    out.innerHTML = emptyState("Pick a map and mode", "Pick a map and a mode above (or one of each, to see that slice). Tip: bookmark a briefing; the link keeps your selection.", "briefing");
    return;
  }
  brief(out, ctx, base, map, fam);
}

function brief(out, ctx, base, map, fam) {
  const m = matchup(base, map, fam);
  const { here, famRows, mapRows, baseLabel, title, A, B, conf } = m;
  const v = m.verdict;
  const vb = v.tone === "good" ? "var(--good)" : v.tone === "bad" ? "var(--bad)" : "var(--tie)";
  const vbt = v.tone === "good" ? "var(--good-text)" : v.tone === "bad" ? "var(--bad-text)" : "var(--text-2)";

  const objFam = fam && OBJECTIVE_FAMILIES.has(fam);
  const tiles = [
    { m: "wr", v: A.wr, b: B.wr },
    { m: "kd", v: A.kd, b: B.kd },
    { m: "dmgRatio", v: A.dmgRatio, b: B.dmgRatio },
    { m: "acc", v: A.acc, b: B.acc },
    { m: "d10", v: A.d10, b: B.d10 },
    objFam ? { m: "objtpg", v: A.objtpg, b: B.objtpg } : { m: "k10", v: A.k10, b: B.k10 },
  ];

  const items = plan(m, base, ctx.all);
  const recentHere = here.slice(-8).reverse();
  const bestHere = here.length ? here.reduce((x, y) => (y.impact > x.impact ? y : x)) : null;

  const vArt = mapArt(map);
  out.innerHTML = `
  <section class="verdict-banner${vArt ? " has-art" : ""}" style="--vb:${vb};--vb-text:${vbt}">${artLayer(vArt, "fade-right")}
    <div class="vb-icon">${icon(v.icon)}</div>
    <div><div class="eyebrow">${esc(title)}</div><h2>${esc(v.label)}</h2><p>${esc(v.text)}</p></div>
    <div class="vb-rec">${A.n ? `<div class="hero-fig num">${fmt.pct(A.wr)}</div><div class="note">win rate · ${plural(A.decided, "game")}</div><div style="margin-top:6px">${confHtml(conf)}</div>` : ""}</div>
  </section>
  ${A.n ? `<section class="grid g6 mt">${tiles.map((t) => kpiTile({ m: t.m, value: t.v, base: t.b, vs: baseLabel.replace("your ", "") })).join("")}</section>` : ""}
  <div class="grid g2 mt">
    <section class="card">
      <div class="card-head"><div><h2>Game plan</h2><div class="sub">Built from your numbers. Most important first.</div></div></div>
      <ol class="plan">${items.map((it) => `<li><div><b>${esc(it.title)}</b><span>${esc(it.detail)}</span></div></li>`).join("")}</ol>
    </section>
    <section class="card">
      <div class="card-head"><div><h2>How you win ${A.w >= 4 && A.decided - A.w >= 4 ? "here" : fam ? `in ${esc(fam)}` : "overall"}</h2><div class="sub" id="how-sub"></div></div></div>
      <div id="how"></div>
    </section>
  </div>
  <div class="grid g2 mt">
    <section class="card">
      <div class="card-head"><div><h2>Your history here</h2><div class="sub">${A.n ? `Last ${Math.min(30, A.n)} results, oldest to newest` : "No games yet"}</div></div></div>
      ${A.n ? resultStrip(here, { max: 30 }) : ""}
      <div class="stack mt" style="gap:0">${recentHere.map((r) => matchLine(r)).join("")}</div>
      ${bestHere ? `<div class="callout mt"><b>Personal best here:</b> ${bestHere.k}/${bestHere.d}/${bestHere.a}, ${fmt.int(bestHere.dd)} damage, ${esc(resultWord(bestHere).toLowerCase())} on ${esc(fmt.date(bestHere.t))}. <button class="link-btn" type="button" data-idx="${bestHere.idx}">Open match</button></div>` : ""}
    </section>
    <section class="card">
      ${map ? `<div class="card-head"><div><h2>${esc(map)} by mode</h2><div class="sub">Tap a mode to switch the briefing</div></div></div><div id="ctx-map"></div>` : ""}
      ${fam ? `<div class="card-head" ${map ? 'style="margin-top:18px"' : ""}><div><h2>${esc(fam)} by map</h2><div class="sub">Most played first (3+ games) · bar = vs your ${esc(fam)} average · tap to switch</div></div></div><div id="ctx-fam"></div>` : ""}
    </section>
  </div>`;

  // how you win
  const howEl = out.querySelector("#how"), howSub = out.querySelector("#how-sub");
  let wc = A.w >= 4 && A.decided - A.w >= 4 ? winConditions(here, { minEach: 4 }) : null;
  let scope = "on this map and mode";
  if (!wc) { wc = winConditions(famRows, { minEach: 8 }); scope = fam ? `across all your ${fam} games` : "across all your games"; }
  if (wc?.length) {
    howSub.textContent = `Your average in wins vs losses, ${scope}. Biggest gaps first.`;
    pairBars(howEl, wc.slice(0, 4).map((s) => ({ label: s.label, a: s.ma, b: s.mb, f: s.f })));
  } else howEl.innerHTML = '<p class="note">Not enough wins and losses to compare yet.</p>';

  const wr0 = (rows) => agg(rows).wr ?? 0.5;
  if (map) {
    const fams = poolStats(mapRows, "famName", 1).sort((a, b) => b.n - a.n);
    const bw = wr0(mapRows);
    barList(out.querySelector("#ctx-map"), fams.map((m) => ({ label: m.name, value: m.adj - bw, display: fmt.pct(m.wr), note: `${m.n} g`, color: m.adj >= bw ? cssVar("--div-pos") : cssVar("--div-neg"), fam: m.name, tip: () => ({ title: `${map} · ${m.name}`, rows: [{ label: "Record", value: `${m.w}–${m.n - m.w}` }, { label: "K/D", value: fmt.n2(m.kd) }] }) })), { diverging: true, max: Math.max(0.08, ...fams.map((m) => Math.abs(m.adj - bw))), onClick: (it) => ctx.go("briefing", { bmap: map, bfam: it.fam }) });
  }
  if (fam) {
    const maps = poolStats(famRows, "mapName", 3).sort((a, b) => b.n - a.n).slice(0, 14);
    const bw = wr0(famRows);
    barList(out.querySelector("#ctx-fam"), maps.map((m) => ({ label: m.name, value: m.adj - bw, display: fmt.pct(m.wr), note: `${m.n} g`, color: m.adj >= bw ? cssVar("--div-pos") : cssVar("--div-neg"), map: m.name, tip: () => ({ title: `${m.name} · ${fam}`, rows: [{ label: "Record", value: `${m.w}–${m.n - m.w}` }, { label: "K/D", value: fmt.n2(m.kd) }] }) })), { diverging: true, max: Math.max(0.08, ...maps.map((m) => Math.abs(m.adj - bw))), onClick: (it) => ctx.go("briefing", { bmap: it.map, bfam: fam }) });
  }
  wireMatchLinks(out, ctx);
}

function matchLine(r) {
  return `<button class="mrow" type="button" data-idx="${r.idx}" style="grid-template-columns:30px minmax(0,1fr) 90px 60px">
    <span class="res ${r.out}">${r.out === "D" ? "Q" : r.out}</span>
    <span class="what"><b>${esc(fmt.date(r.t))}</b><small>${esc(r.modeShort)} · ${esc(r.plName)}</small></span>
    <span class="kda num">${r.k}/${r.d}/${r.a}<small>${fmt.n2(r.kd)} K/D</small></span>
    <span class="csr num">${r.csrDelta != null ? `<span class="${r.csrDelta >= 0 ? "good-text" : "bad-text"}">${fmt.signed(r.csrDelta, fmt.int)}</span><small class="muted" style="display:block;font-weight:500">CSR</small>` : `<span>${r.impact}</span><small class="muted" style="display:block;font-weight:500">impact</small>`}</span>
  </button>`;
}
