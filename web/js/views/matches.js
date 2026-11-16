import { esc, fmt, debounce } from "../util.js";
import { agg, groupBy } from "../stats.js";
import { resultStrip } from "../charts.js";
import { noGames, badges, wireMatchLinks } from "./common.js";
import { mapArt, artVar } from "../art.js";

const SORTS = {
  new: { label: "Newest first", fn: (a, b) => b.t - a.t },
  impact: { label: "Best games", fn: (a, b) => b.impact - a.impact || b.k - a.k },
  worst: { label: "Toughest games", fn: (a, b) => a.impact - b.impact },
  kills: { label: "Most kills", fn: (a, b) => b.k - a.k },
  csr: { label: "Biggest CSR swing", fn: (a, b) => Math.abs(b.csrDelta ?? 0) - Math.abs(a.csrDelta ?? 0) },
};

export function render(ctx) {
  const { rows, el, params } = ctx;
  if (!rows.length) { el.innerHTML = noGames(ctx); return; }
  const sort = SORTS[params.sort] ? params.sort : "new";
  const res = params.res || "all";
  const q = params.q || "";

  el.innerHTML = `
  <div class="page-head"><div><h1>Matches</h1><p>${fmt.int(rows.length)} games in view, grouped into sessions. Tap any game for the full lobby scoreboard.</p></div></div>
  <div class="fgroup" style="flex-wrap:wrap;margin-bottom:6px">
    <input class="search" id="q" type="search" placeholder="Filter by map, mode, playlist…" value="${esc(q)}" aria-label="Filter matches">
    <div class="seg" role="group" aria-label="Result">${[["all", "All"], ["W", "Wins"], ["L", "Losses"]].map(([k, l]) => `<button type="button" data-res="${k}" aria-pressed="${k === res}">${l}</button>`).join("")}</div>
    <select class="select" id="sort" aria-label="Sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}" ${k === sort ? "selected" : ""}>${v.label}</option>`).join("")}</select>
  </div>
  <div id="list"></div>`;

  const list = el.querySelector("#list");
  let limit = sort === "new" ? 15 : 60;
  const draw = () => {
    const qq = el.querySelector("#q").value.trim().toLowerCase();
    let rs = rows.filter((r) => (res === "all" || (res === "W" ? r.win : r.loss)) && (!qq || `${r.mapName} ${r.mapVariant} ${r.modeName} ${r.plName} ${r.famName}`.toLowerCase().includes(qq)));
    if (!rs.length) { list.innerHTML = '<div class="card empty"><h3>No matches</h3><p>Nothing matches that search.</p></div>'; return; }
    if (sort === "new") {
      const sessions = [...groupBy(rs, "session").entries()].sort((a, b) => b[0] - a[0]);
      list.innerHTML = sessions.slice(0, limit).map(([, ss]) => sessionBlock(ss)).join("") + more(sessions.length > limit, `${sessions.length - limit} more sessions`);
    } else {
      rs = [...rs].sort(SORTS[sort].fn);
      list.innerHTML = `<section class="card" style="padding:6px">${rs.slice(0, limit).map(row).join("")}</section>` + more(rs.length > limit, `${rs.length - limit} more games`);
    }
    wireMatchLinks(list, ctx);
    list.querySelector("#more")?.addEventListener("click", () => { limit += sort === "new" ? 15 : 60; draw(); });
  };
  draw();
  el.querySelector("#q").addEventListener("input", debounce(() => { ctx.setParam("q", el.querySelector("#q").value.trim()); limit = sort === "new" ? 15 : 60; draw(); }, 200));
  el.querySelectorAll("[data-res]").forEach((b) => b.addEventListener("click", () => ctx.go("matches", { ...params, res: b.dataset.res })));
  el.querySelector("#sort").addEventListener("change", (e) => ctx.go("matches", { ...params, sort: e.target.value }));
}

const more = (show, label) => (show ? `<p style="text-align:center;margin-top:16px"><button class="btn" type="button" id="more">Show ${esc(label)}</button></p>` : "");

function sessionBlock(ss) {
  const a = agg(ss);
  const first = ss[0], last = ss[ss.length - 1];
  const sameDay = new Date(first.t * 1000).toDateString() === new Date(last.t * 1000).toDateString();
  return `<section class="session">
    <div class="session-head">
      <h3>${esc(new Date(first.t * 1000).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" }))}</h3>
      <div class="meta">
        <span>${esc(fmt.time(first.t))}–${esc(sameDay ? fmt.time(last.t + last.dur) : fmt.dateTime(last.t + last.dur))}</span>
        <span><b class="${a.w > a.decided - a.w ? "good-text" : a.w < a.decided - a.w ? "bad-text" : ""}">${a.w}–${a.decided - a.w}</b></span>
        <span>${fmt.n2(a.kd)} K/D</span>
        ${a.csrN ? `<span class="${a.csrNet >= 0 ? "good-text" : "bad-text"}"><b>${fmt.signed(a.csrNet, fmt.int)}</b> CSR</span>` : ""}
        ${resultStrip(ss, { max: 20 })}
      </div>
    </div>
    <div class="card" style="padding:6px">${[...ss].reverse().map(row).join("")}</div>
  </section>`;
}

function row(r) {
  const t = mapArt(r.mapName, "thumb");
  return `<button class="mrow${t ? " with-thumb" : ""}" type="button" data-idx="${r.idx}">
    <span class="res ${r.out}" aria-label="${r.win ? "Win" : r.loss ? "Loss" : "Tie"}">${r.out === "D" ? "Q" : r.out}</span>${t ? `<span class="thumb" style="${artVar(t)}" aria-hidden="true"></span>` : ""}
    <span class="what"><b>${esc(r.mapName)} · ${esc(r.modeShort)}</b><small>${esc(r.plName)} · ${esc(fmt.dateTime(r.t))}${r.teamScore != null && r.enemyScore != null ? ` · ${r.teamScore}–${r.enemyScore}` : ""}</small></span>
    <span class="badges badges-col">${badges(r)}</span>
    <span class="kda num">${r.k} / ${r.d} / ${r.a}<small>${fmt.k(r.dd)} dmg · ${fmt.acc(r.acc)}</small></span>
    <span class="impact" title="Impact: how this game ranks among all your games (0–100)"><span>Impact ${r.impact}</span><span class="ibar"><i style="width:${r.impact}%"></i></span></span>
    <span class="csr">${r.csrDelta != null ? `<span class="${r.csrDelta >= 0 ? "good-text" : "bad-text"}">${fmt.signed(r.csrDelta, fmt.int)}</span>` : '<span class="muted" aria-hidden="true">›</span>'}</span>
  </button>`;
}
