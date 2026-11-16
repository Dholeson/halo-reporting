import { esc, fmt, scales, cssVar } from "../util.js";
import { agg, groupBy, shrink } from "../stats.js";
import { heatGrid, scaleLegend, spark } from "../charts.js";
import { noGames } from "./common.js";
import { mapArt, artLayer, artVar } from "../art.js";

const MODES = {
  wr: { label: "Win rate", cell: (a) => Math.round(a.wr * 100), color: (a, base) => (shrink(a.w, a.decided, base.wr, 6) - base.wr) / 0.15, fmt: (a) => fmt.pct(a.wr) },
  kd: { label: "K/D", cell: (a) => a.kd.toFixed(2), color: (a, base) => Math.log(a.kd / base.kd) / Math.log(1.4), fmt: (a) => fmt.n2(a.kd) },
  dmg: { label: "Damage ratio", cell: (a) => a.dmgRatio.toFixed(2), color: (a, base) => Math.log(a.dmgRatio / base.dmgRatio) / Math.log(1.35), fmt: (a) => fmt.n2(a.dmgRatio) },
  n: { label: "Games", cell: (a) => a.n, seq: true, fmt: (a) => fmt.int(a.n) },
};

export function render(ctx) {
  const { rows, el, params } = ctx;
  if (!rows.length) { el.innerHTML = noGames(ctx); return; }
  const metric = MODES[params.metric] ? params.metric : "wr";
  const minN = +params.min || 3;
  const base = agg(rows);
  const sc = scales();
  const byMap = [...groupBy(rows, "mapName").entries()].map(([name, rs]) => ({ name, rows: rs, a: agg(rs) })).filter((m) => m.a.n >= minN).sort((x, y) => y.a.n - x.a.n);
  const fams = [...groupBy(rows, "famName").entries()].map(([name, rs]) => ({ name, rows: rs, a: agg(rs) })).filter((m) => m.a.n >= minN).sort((x, y) => y.a.n - x.a.n);
  const showMaps = byMap.slice(0, params.allmaps === "1" ? 200 : 18);
  const cols = fams.slice(0, 8);
  const cellRows = new Map();
  for (const r of rows) {
    const k = `${r.mapName}|${r.famName}`;
    if (!cellRows.has(k)) cellRows.set(k, []);
    cellRows.get(k).push(r);
  }

  el.innerHTML = `
  <div class="page-head"><div><h1>Maps &amp; modes</h1><p>Every map and mode you've played, against your own average (${fmt.pct(base.wr)} win rate, ${fmt.n2(base.kd)} K/D in this view). Tap any cell or row for a pre-game briefing.</p></div>
    <div class="fgroup">
      <div class="seg" role="group" aria-label="Metric">${Object.entries(MODES).map(([k, v]) => `<button type="button" data-metric="${k}" aria-pressed="${k === metric}">${v.label}</button>`).join("")}</div>
      <select class="select" id="min-n" aria-label="Minimum games">${[1, 3, 5, 10, 20].map((n) => `<option value="${n}" ${n === minN ? "selected" : ""}>${n}+ games</option>`).join("")}</select>
    </div>
  </div>
  <section class="card">
    <div class="card-head"><div><h2>Your most-played maps</h2><div class="sub">Tap a map for its briefing</div></div></div>
    <div class="tiles lg">${byMap.slice(0, 8).map((m) => {
      const art = mapArt(m.name, "thumb");
      const tone = (m.a.wr ?? 0) - base.wr;
      return `<button class="tile${art ? " with-art" : ""}" type="button" data-gallery="${esc(m.name)}">${artLayer(art, "scrim-bottom")}<span class="t-body"><span class="t-name">${esc(m.name)}</span><span class="t-meta"><span class="dotwr" style="background:${sc.diverging(Math.max(-1, Math.min(1, tone / 0.12)))}"></span>${fmt.pct(m.a.wr)} wins · ${fmt.n2(m.a.kd)} K/D · ${m.a.n} g</span></span></button>`;
    }).join("")}</div>
  </section>
  <section class="card mt">
    <div class="card-head"><div><h2>Map × mode</h2><div class="sub">${esc(MODES[metric].label)} per combination. Cells need ${minN}+ games.</div></div></div>
    <div id="matrix" style="overflow-x:auto"></div>
    ${MODES[metric].seq ? scaleLegend("seq", "fewer", "more games") : scaleLegend("div", "worse than your average", "better", "hatched = under 8 games; small samples are pulled toward average")}
    ${byMap.length > 18 ? `<p style="margin-top:10px"><button class="link-btn" type="button" id="allmaps">${params.allmaps === "1" ? "Show top 18 maps" : `Show all ${byMap.length} maps`}</button></p>` : ""}
  </section>
  <section class="card mt">
    <div class="card-head"><div><h2>Maps</h2><div class="sub">Sortable. The trend line is win rate across your games on that map.</div></div></div>
    <div class="table-wrap" id="map-table"></div>
  </section>
  <section class="card mt">
    <div class="card-head"><div><h2>Modes</h2></div></div>
    <div class="table-wrap" id="mode-table"></div>
  </section>`;

  el.querySelectorAll("[data-metric]").forEach((b) => b.addEventListener("click", () => ctx.go("maps", { ...params, metric: b.dataset.metric }, { keepFilters: true })));
  el.querySelector("#min-n").addEventListener("change", (e) => ctx.go("maps", { ...params, min: e.target.value }, { keepFilters: true }));
  el.querySelector("#allmaps")?.addEventListener("click", () => ctx.go("maps", { ...params, allmaps: params.allmaps === "1" ? "" : "1" }, { keepFilters: true }));

  el.querySelectorAll("[data-gallery]").forEach((b) => b.addEventListener("click", () => ctx.go("briefing", { bmap: b.dataset.gallery, bfam: "" })));
  const M = MODES[metric];
  const maxN = Math.max(...[...cellRows.values()].map((v) => v.length));
  heatGrid(el.querySelector("#matrix"), {
    rows: showMaps.map((m) => m.name), cols: cols.map((c) => c.name), rowWidth: "minmax(96px, 150px)", colMin: "56px",
    cell: (ri, ci) => {
      const rs = cellRows.get(`${showMaps[ri].name}|${cols[ci].name}`) || [];
      if (rs.length < minN) return null;
      const a = agg(rs);
      const fill = M.seq ? sc.sequential(0.15 + 0.85 * Math.sqrt(a.n / maxN)) : sc.diverging(Math.max(-1, Math.min(1, M.color(a, base))));
      return {
        fill, text: M.cell(a), thin: !M.seq && a.decided < 8,
        aria: `${showMaps[ri].name}, ${cols[ci].name}: ${M.fmt(a)} over ${a.n} games`,
        tip: () => ({ title: `${showMaps[ri].name} · ${cols[ci].name}`, rows: [{ label: "Record", value: `${a.w}–${a.decided - a.w}` }, { label: "Win rate", value: fmt.pct(a.wr) }, { label: "K/D", value: fmt.n2(a.kd) }, { label: "Damage ratio", value: fmt.n2(a.dmgRatio) }, a.csrN ? { label: "CSR", value: fmt.signed(a.csrNet, fmt.int) } : null], note: "Tap for the briefing" }),
        onClick: () => ctx.go("briefing", { bmap: showMaps[ri].name, bfam: cols[ci].name }),
      };
    },
  });

  table(el.querySelector("#map-table"), byMap, ctx, "map", base);
  table(el.querySelector("#mode-table"), fams, ctx, "mode", base);
}

const COLS = [
  { k: "name", label: "", get: (m) => m.name, f: (v) => v, left: true },
  { k: "n", label: "Games", get: (m) => m.a.n, f: fmt.int },
  { k: "rec", label: "W–L", get: (m) => m.a.w - (m.a.decided - m.a.w), f: (_, m) => `${m.a.w}–${m.a.decided - m.a.w}` },
  { k: "wr", label: "Win %", get: (m) => m.a.wr, f: fmt.pct, bar: true },
  { k: "kd", label: "K/D", get: (m) => m.a.kd, f: fmt.n2 },
  { k: "dmg", label: "Dmg ratio", get: (m) => m.a.dmgRatio, f: fmt.n2 },
  { k: "acc", label: "Acc", get: (m) => m.a.acc, f: fmt.acc },
  { k: "life", label: "Avg life", get: (m) => m.a.lifeAvg, f: fmt.secs },
  { k: "csr", label: "CSR", get: (m) => m.a.csrNet, f: (v) => (v == null ? "–" : fmt.signed(v, fmt.int)) },
  { k: "last", label: "Last played", get: (m) => m.rows[m.rows.length - 1].t, f: (v) => fmt.date(v) },
];

function table(host, list, ctx, kind, base) {
  let sortKey = "n", dir = -1;
  const draw = () => {
    const c = COLS.find((x) => x.k === sortKey);
    const sorted = [...list].sort((x, y) => {
      const a = c.get(x), b = c.get(y);
      if (a == null) return 1;
      if (b == null) return -1;
      return (a > b ? 1 : a < b ? -1 : 0) * dir;
    });
    const good = cssVar("--div-pos"), bad = cssVar("--div-neg");
    host.innerHTML = `<table class="t"><thead><tr>${COLS.map((col) => `<th class="sortable ${col.left ? "" : "n"}" data-k="${col.k}" aria-sort="${col.k === sortKey ? (dir > 0 ? "ascending" : "descending") : "none"}">${esc(col.label || (kind === "map" ? "Map" : "Mode"))}${col.k === sortKey ? `<span class="arrow">${dir > 0 ? "↑" : "↓"}</span>` : ""}</th>`).join("")}<th class="n">Trend</th></tr></thead><tbody>
      ${sorted.map((m) => {
        const wrSeries = [];
        let w = 0;
        m.rows.forEach((r, i) => { w += r.win ? 1 : 0; if (i >= 4) wrSeries.push(w / (i + 1)); });
        return `<tr class="clickable" data-name="${esc(m.name)}">${COLS.map((col) => {
          const v = col.get(m);
          const txt = col.f(v, m);
          if (col.bar && v != null) return `<td class="n">${esc(txt)}<span class="mini-bar" style="width:${Math.round(Math.min(1, Math.abs(v - base.wr) / 0.2) * 40)}px;background:${v >= base.wr ? good : bad}"></span></td>`;
          if (col.k === "name" && kind === "map") { const t = mapArt(m.name, "thumb"); return `<td class="lead">${t ? `<span class="tbl-thumb" style="${artVar(t)}"></span>` : ""}${esc(txt)}</td>`; }
          return `<td class="${col.left ? "lead" : "n"}">${esc(txt)}</td>`;
        }).join("")}<td class="n" style="width:90px">${wrSeries.length > 2 ? `<span style="display:inline-block;width:80px;height:22px">${spark(wrSeries.slice(-60), { w: 80, h: 22, ref: base.wr })}</span>` : ""}</td></tr>`;
      }).join("")}</tbody></table>`;
    host.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
      if (sortKey === th.dataset.k) dir = -dir; else { sortKey = th.dataset.k; dir = th.dataset.k === "name" ? 1 : -1; }
      draw();
    }));
    host.querySelectorAll("tr[data-name]").forEach((tr) => tr.addEventListener("click", () => ctx.go("briefing", kind === "map" ? { bmap: tr.dataset.name, bfam: "" } : { bmap: "", bfam: tr.dataset.name })));
  };
  draw();
}
