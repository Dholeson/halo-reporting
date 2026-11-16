import { esc, fmt, icon, cssVar, scales, plural } from "../util.js";
import { agg, goodness, shrink, METRICS, groupBy } from "../stats.js";
import { pairBars, barList, resultStrip, confHtml } from "../charts.js";
import { winConditions, timeBlocks, hourBlock, poolStats } from "../insights.js";
import { kpiTile, wireMatchLinks, emptyState, resultWord, badges } from "./common.js";
import { applyFilters, OBJECTIVE_FAMILIES } from "../data.js";
import { mapArt, artLayer } from "../art.js";

const OBJ_WORD = { "King of the Hill": "on the hill", Strongholds: "in zones", Oddball: "holding the skull", "Total Control": "in zones", "Capture the Flag": "flag plays" };

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
  <div class="page-head"><div><h1>Pre-game briefing</h1><p>Loading into a match? Pick the map and mode. You'll get your record there, what wins it for you, and a game plan.</p></div></div>
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
  const here = base.filter((r) => (!map || r.mapName === map) && (!fam || r.famName === fam));
  const famRows = fam ? base.filter((r) => r.famName === fam) : base;
  const mapRows = map ? base.filter((r) => r.mapName === map) : base;
  const baseline = map && fam ? famRows : base;
  const baseLabel = map && fam ? `your ${fam} average` : "your average";
  const title = [map, fam].filter(Boolean).join(" · ");
  const A = agg(here), B = agg(baseline);

  // ---- verdict ----
  let v;
  if (!A.n) {
    v = { tone: "neutral", label: "Uncharted territory", icon: "briefing", text: `You haven't played ${title} yet. This plan is built from your ${map && fam ? `${fam} games and your games on ${map}` : "other games"}.` };
  } else {
    const adjWr = shrink(A.w, A.decided, B.wr ?? 0.5, 8);
    const adjKd = (A.k + 8 * (B.kpg ?? 0)) / Math.max(A.d + 8 * (B.dpg ?? 1), 1);
    const score = 0.6 * goodness("wr", adjWr, B.wr) + 0.4 * goodness("kd", adjKd, B.kd);
    const rec = `You're ${A.w}–${A.decided - A.w} here (${fmt.pct(A.wr)}) vs ${fmt.pct(B.wr)} for ${baseLabel}. K/D ${fmt.n2(A.kd)} vs ${fmt.n2(B.kd)}.`;
    const csr = A.csrN ? ` Ranked: ${fmt.signed(A.csrNet, fmt.int)} CSR over ${A.csrN} games here.` : "";
    if (score >= 0.2) v = { tone: "good", label: "Favorable matchup", icon: "check", text: rec + csr };
    else if (score <= -0.2) v = { tone: "bad", label: "Danger zone", icon: "alert", text: rec + csr };
    else v = { tone: "neutral", label: "Even ground", icon: "steady", text: rec + csr };
    if (A.decided < 6) v.label += " (early read)";
  }
  const vb = v.tone === "good" ? "var(--good)" : v.tone === "bad" ? "var(--bad)" : "var(--tie)";
  const vbt = v.tone === "good" ? "var(--good-text)" : v.tone === "bad" ? "var(--bad-text)" : "var(--text-2)";
  const conf = A.decided >= 25 ? 3 : A.decided >= 8 ? 2 : 1;

  const objFam = fam && OBJECTIVE_FAMILIES.has(fam);
  const tiles = [
    { m: "wr", v: A.wr, b: B.wr },
    { m: "kd", v: A.kd, b: B.kd },
    { m: "dmgRatio", v: A.dmgRatio, b: B.dmgRatio },
    { m: "acc", v: A.acc, b: B.acc },
    { m: "d10", v: A.d10, b: B.d10 },
    objFam ? { m: "objtpg", v: A.objtpg, b: B.objtpg } : { m: "k10", v: A.k10, b: B.k10 },
  ];

  const items = plan(ctx, here, baseline, base, famRows, A, B, map, fam, baseLabel);
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

function plan(ctx, here, baseline, all, famRows, A, B, map, fam, baseLabel) {
  const items = [];
  const metrics = ["d10", "lifeAvg", "acc", "dmgRatio", "k10", "a10"].concat(fam && OBJECTIVE_FAMILIES.has(fam) ? ["objtpg"] : []);
  if (A.n >= 5) {
    // With a big sample, smaller gaps are real; with a handful of games, demand bigger ones.
    const bar = A.n >= 40 ? 0.07 : A.n >= 15 ? 0.1 : 0.15;
    const scored = metrics.map((m) => ({ m, g: goodness(m, A[m], B[m]) })).filter((x) => Number.isFinite(x.g));
    const weak = scored.filter((x) => x.g < -bar).sort((a, b) => a.g - b.g)[0];
    const strong = scored.filter((x) => x.g > bar).sort((a, b) => b.g - a.g)[0];
    if (weak) items.push(WEAK[weak.m](A, B, baseLabel));
    if (strong) items.push({ title: `Lean on it: ${STRONG[strong.m]} here`, detail: `${METRICS[strong.m].label}: ${METRICS[strong.m].f(A[strong.m])} here vs ${METRICS[strong.m].f(B[strong.m])} for ${baseLabel}. Play to that strength.` });
  }
  // win condition (here if possible, else the mode)
  let wc = A.w >= 4 && A.decided - A.w >= 4 ? winConditions(here, { minEach: 4 }) : null;
  let scope = "here";
  if (!wc?.length) { wc = winConditions(famRows, { minEach: 8 }); scope = fam ? `in ${fam}` : "overall"; }
  if (wc?.length) {
    const s = wc[0];
    items.push({ title: `Win condition: ${s.label.toLowerCase()}`, detail: `In your wins ${scope} you average ${s.f(s.ma)}; in losses ${s.f(s.mb)}. ${s.better > 0 ? "Get above" : "Stay under"} ${s.f(s.ma)}.` });
  }
  // objective target
  if (fam && OBJECTIVE_FAMILIES.has(fam)) {
    const wins = famRows.filter((r) => r.win);
    if (wins.length >= 5) {
      const ctf = fam === "Capture the Flag";
      const avg = wins.reduce((s, r) => s + (ctf ? r.obja + r.objk : r.objt), 0) / wins.length;
      items.push({ title: `Objective target: ${ctf ? fmt.n1(avg) : fmt.secs(avg)} ${OBJ_WORD[fam]}`, detail: `That's what your ${fam} wins average. ${ctf ? "Grabs, returns and carrier kills all count." : "Be on it when your team has the numbers advantage."}` });
    }
  }
  // recent form on this exact matchup
  if (here.length >= 5) {
    const last5 = here.slice(-5), w5 = last5.filter((r) => r.win).length;
    if (w5 >= 4) items.push({ title: `You've won ${w5} of your last 5 here`, detail: `Last played ${fmt.date(last5[4].t)}. Whatever you did then, do it again.` });
    else if (w5 <= 1) items.push({ title: `You've lost ${5 - w5} of your last 5 here`, detail: `Last played ${fmt.date(last5[4].t)}. Reset your approach: check "how you win here" for what separates your wins.` });
  }
  // context: how this map / mode ranks for you overall
  if (map && fam) {
    const ranked = poolStats(all, "mapName", 8).sort((a, b) => b.adj - a.adj);
    const pos = ranked.findIndex((m) => m.name === map);
    if (pos >= 0 && ranked.length >= 6) {
      const m = ranked[pos];
      if (pos < ranked.length / 3) items.push({ title: `${map} is one of your better maps`, detail: `${fmt.pct(m.wr)} across ${m.n} games in all modes, #${pos + 1} of the ${ranked.length} maps you've played 8+ times.` });
      else if (pos >= (ranked.length * 2) / 3) items.push({ title: `${map} is one of your tougher maps`, detail: `${fmt.pct(m.wr)} across ${m.n} games in all modes, #${pos + 1} of ${ranked.length}. Respect its power positions.` });
    }
  }
  // live session context: if the last game ended recently, you're mid-session
  const last = ctx.all[ctx.all.length - 1];
  const now = Date.now() / 1000;
  if (last && now - (last.t + last.dur) < 50 * 60) {
    const next = last.gameNo + 1;
    const early = agg(all.filter((r) => r.gameNo <= 6)), late = agg(all.filter((r) => r.gameNo >= 7));
    let trail = 0;
    for (let i = ctx.all.length - 1; i >= 0 && ctx.all[i].session === last.session && ctx.all[i].loss; i--) trail++;
    const after2 = agg(all.filter((r) => r.lossRunBefore >= 2));
    if (trail >= 2 && after2.decided >= 12 && after2.wr <= (agg(all).wr ?? 0) - 0.07)
      items.unshift({ title: `You've lost ${trail} straight. Consider a break`, detail: `After two losses in a row you win ${fmt.pct(after2.wr)} of the time. A 10-minute reset usually beats queueing tilted.` });
    else if (next >= 7 && late.decided >= 20 && late.wr <= early.wr - 0.06)
      items.unshift({ title: `This is game ${next} of your session`, detail: `From game 7 on, your win rate drops to ${fmt.pct(late.wr)} (vs ${fmt.pct(early.wr)} in games 1–6). Make it count, then call it.` });
  }
  // time of day
  const blocks = timeBlocks(all);
  const nowBlock = hourBlock({ date: new Date() });
  const cur = blocks.find((b) => b.label === nowBlock?.label);
  const overallWr = agg(all).wr ?? 0;
  if (cur && cur.n >= 12 && cur.wr <= overallWr - 0.07) items.push({ title: `It's ${cur.label.toLowerCase()}, not your best hours`, detail: `You win ${fmt.pct(cur.wr)} at this time of day vs ${fmt.pct(overallWr)} overall.` });
  if (!items.length) items.push({ title: "Play your game", detail: "Nothing here stands out against your averages. Trust your fundamentals." });
  return items.slice(0, 6);
}
