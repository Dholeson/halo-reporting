// Chart primitives. Hand-built SVG/HTML so the marks follow one spec:
// 2px lines, ≤24px bars with 4px rounded data-ends, hairline solid grid,
// 2px surface gaps/rings, hover + focus tooltips on every mark.

import { esc, cssVar, scales, fmt } from "./util.js";

const NS = "http://www.w3.org/2000/svg";
function S(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

// ---------- tooltip ----------
const tipEl = () => document.getElementById("tooltip");
export function tipNode({ title, rows = [], note }) {
  const frag = document.createDocumentFragment();
  if (title) {
    const t = document.createElement("div");
    t.className = "tt-title";
    t.textContent = title;
    frag.append(t);
  }
  for (const r of rows) {
    if (!r) continue;
    const row = document.createElement("div");
    row.className = "tt-row";
    const k = document.createElement("span");
    k.className = "k";
    if (r.color) {
      const i = document.createElement("i");
      i.style.background = r.color;
      k.append(i);
    }
    k.append(document.createTextNode(r.label));
    const v = document.createElement("span");
    v.className = "v";
    v.textContent = r.value;
    row.append(k, v);
    frag.append(row);
  }
  if (note) {
    const n = document.createElement("div");
    n.className = "tt-note";
    n.textContent = note;
    frag.append(n);
  }
  return frag;
}
export function showTip(content, x, y) {
  const el = tipEl();
  el.replaceChildren(content instanceof Node ? content : tipNode(content));
  el.hidden = false;
  const pad = 14, w = el.offsetWidth, h = el.offsetHeight;
  let left = x + pad, top = y + pad;
  if (left + w > innerWidth - 8) left = x - w - pad;
  if (top + h > innerHeight - 8) top = y - h - pad;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}
export function hideTip() {
  const el = tipEl();
  if (el) el.hidden = true;
}
/** Hover, touch and keyboard focus all reach the same tooltip. */
export function bindTip(el, content) {
  const show = (e) => showTip(content(e), e.clientX, e.clientY);
  el.addEventListener("pointermove", show);
  el.addEventListener("pointerdown", show);
  el.addEventListener("pointerleave", hideTip);
  el.addEventListener("focus", () => {
    const r = el.getBoundingClientRect();
    showTip(content(), r.left + r.width / 2, r.top);
  });
  el.addEventListener("blur", hideTip);
}
addEventListener("scroll", hideTip, { passive: true });

// ---------- ticks ----------
function niceStep(range, count) {
  const raw = range / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}
export function niceTicks(min, max, count = 4) {
  if (!(max > min)) { min -= 1; max += 1; }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

const empty = (el, msg = "Not enough games for this chart yet.") => {
  el.innerHTML = `<p class="note" style="padding:24px 0;text-align:center">${esc(msg)}</p>`;
};

// ---------- line chart ----------
/**
 * series: [{name, color, data:[{x, y, ...}], raw?:[{x,y}], area?:bool}]
 * opts: height, yFormat, xFormat(x)→label, yDomain, refs:[{y,label}], bands:[{from,to,label,color}],
 *       tooltip(x)→{title, rows, note}, endLabels, xTicks(min,max)→[{x,label}]
 */
export function lineChart(el, opts) {
  const series = opts.series.filter((s) => s.data.length);
  if (!series.length) return empty(el, opts.emptyText);
  const W = Math.max(el.clientWidth || 600, 260), H = opts.height || 200;
  const yF = opts.yFormat || fmt.n1;
  const m = { t: 12, r: opts.endLabels ? 52 : 12, b: 26, l: opts.yWidth ?? 40 };
  const pts = series.flatMap((s) => [...s.data, ...(s.raw || [])]);
  const xmin = Math.min(...pts.map((p) => p.x)), xmax = Math.max(...pts.map((p) => p.x));
  let [ymin, ymax] = opts.yDomain || [Math.min(...series.flatMap((s) => s.data.map((p) => p.y))), Math.max(...series.flatMap((s) => s.data.map((p) => p.y)))];
  for (const r of opts.refs || []) { ymin = Math.min(ymin, r.y); ymax = Math.max(ymax, r.y); }
  if (!opts.yDomain) { const pad = (ymax - ymin) * 0.08 || 0.5; ymin -= pad; ymax += pad; }
  const ticks = opts.yDomain ? niceTicks(ymin, ymax, opts.yTicks || 4).filter((v) => v >= ymin - 1e-9 && v <= ymax + 1e-9) : niceTicks(ymin, ymax, opts.yTicks || 4);
  if (!opts.yDomain) { ymin = ticks[0]; ymax = ticks[ticks.length - 1]; }
  const X = (x) => m.l + ((x - xmin) / Math.max(xmax - xmin, 1e-9)) * (W - m.l - m.r);
  const Y = (y) => m.t + (1 - (y - ymin) / Math.max(ymax - ymin, 1e-9)) * (H - m.t - m.b);

  const svg = S("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opts.label || "Line chart" });
  for (const b of opts.bands || []) {
    const y1 = Y(Math.min(b.to, ymax)), y2 = Y(Math.max(b.from, ymin));
    if (y2 <= y1) continue;
    S("rect", { x: m.l, y: y1, width: W - m.l - m.r, height: y2 - y1, class: "band", fill: b.color || "var(--text)" }, svg);
    if (y2 - y1 > 14) S("text", { x: W - m.r - 4, y: y1 + 12, "text-anchor": "end", class: "band-label" }, svg).textContent = b.label;
  }
  for (const v of ticks) {
    S("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: v === ticks[0] ? "baseline" : "gridline" }, svg);
    S("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", class: "tick" }, svg).textContent = yF(v);
  }
  for (const r of opts.refs || []) S("line", { x1: m.l, x2: W - m.r, y1: Y(r.y), y2: Y(r.y), class: "ref" }, svg);
  const xt = opts.xTicks ? opts.xTicks(xmin, xmax) : niceTicks(xmin, xmax, Math.max(2, Math.floor(W / 120))).filter((v) => v >= xmin && v <= xmax).map((x) => ({ x, label: (opts.xFormat || fmt.int)(x) }));
  for (const t of xt) S("text", { x: X(t.x), y: H - 6, "text-anchor": "middle", class: "tick" }, svg).textContent = t.label;

  for (const s of series) {
    if (s.raw) for (const p of s.raw) S("circle", { cx: X(p.x), cy: Y(Math.max(ymin, Math.min(ymax, p.y))), r: 2, fill: s.color, class: "raw" }, svg);
    const d = s.data.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
    if (s.area) S("path", { d: `${d}L${X(s.data[s.data.length - 1].x)},${Y(ymin)}L${X(s.data[0].x)},${Y(ymin)}Z`, fill: s.color, class: "area" }, svg);
    S("path", { d, stroke: s.color, class: "series" }, svg);
    const last = s.data[s.data.length - 1];
    S("circle", { cx: X(last.x), cy: Y(last.y), r: 4, fill: s.color, class: "dot" }, svg);
    if (opts.endLabels) S("text", { x: X(last.x) + 8, y: Y(last.y) + 4, class: "end-label" }, svg).textContent = yF(last.y);
  }

  // reference labels sit above the data, with a surface halo so they stay legible
  for (const r of opts.refs || []) if (r.label) S("text", { x: m.l + 6, y: Y(r.y) - 5, class: "ref-label" }, svg).textContent = r.label;

  // crosshair layer
  const cross = S("line", { y1: m.t, y2: H - m.b, class: "crosshair", visibility: "hidden" }, svg);
  const markers = series.map((s) => S("circle", { r: 4, fill: s.color, class: "dot", visibility: "hidden" }, svg));
  const hit = S("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, class: "hit", tabindex: 0 }, svg);
  const base = series[0].data;
  const nearest = (px) => {
    const x = xmin + ((px - m.l) / (W - m.l - m.r)) * (xmax - xmin);
    let lo = 0, hi = base.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (base[mid].x < x) lo = mid; else hi = mid; }
    return Math.abs(base[lo].x - x) <= Math.abs(base[hi].x - x) ? base[lo] : base[hi];
  };
  const move = (clientX, clientY) => {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    const p = nearest(px);
    cross.setAttribute("x1", X(p.x)); cross.setAttribute("x2", X(p.x)); cross.setAttribute("visibility", "visible");
    series.forEach((s, i) => {
      const q = s.data.find((d) => d.x === p.x) || s.data.reduce((a, b) => (Math.abs(b.x - p.x) < Math.abs(a.x - p.x) ? b : a));
      markers[i].setAttribute("cx", X(q.x)); markers[i].setAttribute("cy", Y(q.y)); markers[i].setAttribute("visibility", "visible");
    });
    const content = opts.tooltip ? opts.tooltip(p) : { title: (opts.xFormat || fmt.int)(p.x), rows: series.map((s) => ({ label: s.name, value: yF((s.data.find((d) => d.x === p.x) || {}).y), color: s.color })) };
    showTip(content, clientX, clientY);
  };
  const leave = () => { cross.setAttribute("visibility", "hidden"); markers.forEach((mk) => mk.setAttribute("visibility", "hidden")); hideTip(); };
  hit.addEventListener("pointermove", (e) => move(e.clientX, e.clientY));
  hit.addEventListener("pointerdown", (e) => move(e.clientX, e.clientY));
  hit.addEventListener("pointerleave", leave);
  let kIdx = base.length - 1;
  hit.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    kIdx = Math.max(0, Math.min(base.length - 1, kIdx + (e.key === "ArrowRight" ? 1 : -1)));
    const rect = svg.getBoundingClientRect();
    move(rect.left + (X(base[kIdx].x) / W) * rect.width, rect.top + (Y(base[kIdx].y) / H) * rect.height);
  });
  hit.addEventListener("blur", leave);

  el.replaceChildren();
  if (opts.legend !== false && series.length > 1) el.insertAdjacentHTML("afterbegin", legendHtml(series.map((s) => ({ name: s.name, color: s.color, line: true }))));
  el.appendChild(svg);
}

export function legendHtml(items) {
  return `<div class="legend">${items.map((i) => `<span class="key">${i.line ? `<span class="swatch-line" style="color:${i.color}"></span>` : `<span class="swatch-box" style="background:${i.color}"></span>`}${esc(i.name)}</span>`).join("")}</div>`;
}

// ---------- column chart (optionally stacked) ----------
/**
 * data: [{label, value?, segs?:[{v, color, name}], color?, tip?:()=>content}]
 * opts: height, yFormat, refs, labelEvery, onClick(d)
 */
export function columns(el, data, opts = {}) {
  if (!data.length) return empty(el, opts.emptyText);
  const W = Math.max(el.clientWidth || 600, 260), H = opts.height || 180;
  const m = { t: 10, r: 8, b: opts.noXLabels ? 8 : 26, l: opts.yWidth ?? 36 };
  const totals = data.map((d) => (d.segs ? d.segs.reduce((a, s) => a + s.v, 0) : d.value ?? 0));
  let ymax = Math.max(...totals, ...(opts.refs || []).map((r) => r.y), opts.yMin ?? 0);
  let ymin = Math.min(0, ...totals);
  if (opts.yDomain) [ymin, ymax] = opts.yDomain;
  const ticks = niceTicks(ymin, ymax, opts.yTicks || 3);
  if (!opts.yDomain) { ymin = ticks[0]; ymax = ticks[ticks.length - 1]; }
  const Y = (y) => m.t + (1 - (y - ymin) / Math.max(ymax - ymin, 1e-9)) * (H - m.t - m.b);
  const slot = (W - m.l - m.r) / data.length;
  const bw = Math.max(1, Math.min(24, slot - 2, slot * 0.72));
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opts.label || "Column chart" });
  const yF = opts.yFormat || fmt.int;
  for (const v of ticks) {
    if (v < ymin - 1e-9 || v > ymax + 1e-9) continue;
    S("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: v === 0 || v === ymin ? "baseline" : "gridline" }, svg);
    S("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", class: "tick" }, svg).textContent = yF(v);
  }
  const r = Math.min(4, bw / 2);
  const roundTop = (x, y0, y1, w) => {
    // y0 = baseline (bottom), y1 = top; rounded data-end at the top only
    const h = y0 - y1;
    if (h <= 0) return "";
    const rr = Math.min(r, h);
    return `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`;
  };
  const surface = cssVar("--surface");
  data.forEach((d, i) => {
    const cx = m.l + slot * i + slot / 2, x = cx - bw / 2;
    const g = S("g", {}, svg);
    if (d.segs) {
      let acc = 0;
      const nonzero = d.segs.filter((s) => s.v > 0);
      nonzero.forEach((s, j) => {
        const y0 = Y(acc), y1 = Y(acc + s.v);
        acc += s.v;
        const top = j === nonzero.length - 1;
        if (top) S("path", { d: roundTop(x, y0, y1, bw), fill: s.color }, g);
        else S("rect", { x, y: y1, width: bw, height: Math.max(0, y0 - y1), fill: s.color }, g);
        if (!top && bw >= 4) S("line", { x1: x, x2: x + bw, y1: y1, y2: y1, stroke: surface, "stroke-width": 2 }, g);
      });
    } else if (d.value != null) {
      const v = d.value;
      if (v >= 0) S("path", { d: roundTop(x, Y(Math.max(0, ymin)), Y(v), bw), fill: d.color || cssVar("--s1") }, g);
      else S("rect", { x, y: Y(0), width: bw, height: Y(v) - Y(0), fill: d.color || cssVar("--s1"), rx: 2 }, g);
    }
    if (!opts.noXLabels && (!opts.labelEvery || i % opts.labelEvery === 0 || i === data.length - 1))
      S("text", { x: cx, y: H - 8, "text-anchor": "middle", class: "tick" }, svg).textContent = d.label;
    const hit = S("rect", { x: cx - slot / 2, y: m.t, width: slot, height: H - m.t - m.b, class: "hit", tabindex: opts.focusable === false ? null : 0 }, g);
    if (d.tip) bindTip(hit, d.tip);
    if (opts.onClick) { hit.style.cursor = "pointer"; hit.addEventListener("click", () => opts.onClick(d)); }
  });
  for (const rf of opts.refs || []) {
    S("line", { x1: m.l, x2: W - m.r, y1: Y(rf.y), y2: Y(rf.y), class: "ref" }, svg);
    if (rf.label) S("text", { x: W - m.r - 2, y: Y(rf.y) - 4, "text-anchor": "end", class: "ref-label" }, svg).textContent = rf.label;
  }
  el.replaceChildren(svg);
  if (opts.legend) el.insertAdjacentHTML("afterbegin", legendHtml(opts.legend));
}

// ---------- horizontal bar list (HTML) ----------
/**
 * items: [{label, sub, value, display, note, color, key, tip:()=>content}]
 * opts: diverging (value in [-1,1]), max, onClick(item), head:[l,m,r]
 */
export function barList(el, items, opts = {}) {
  if (!items.length) return empty(el, opts.emptyText);
  const max = opts.max ?? Math.max(...items.map((i) => Math.abs(i.value)), 1e-9);
  const head = opts.head ? `<div class="bars-head"><span>${esc(opts.head[0])}</span><span>${esc(opts.head[1] || "")}</span><span>${esc(opts.head[2] || "")}</span></div>` : "";
  el.innerHTML = head + `<div class="bars">${items
    .map((it, i) => {
      const pct = Math.min(1, Math.abs(it.value) / max) * (opts.diverging ? 50 : 100);
      const fill = opts.diverging
        ? `<div class="track div"><span class="mid"></span><span class="fill ${it.value >= 0 ? "pos" : "neg"}" style="width:${pct}%;background:${it.color}"></span></div>`
        : `<div class="track"><span class="fill" style="width:${pct}%;background:${it.color || "var(--s1)"}"></span></div>`;
      const tag = opts.onClick ? "button" : "div";
      return `<${tag} class="bar-row${opts.onClick ? " clickable" : ""}" data-i="${i}" ${tag === "div" ? 'tabindex="0"' : 'type="button"'}>
        <span class="lbl" title="${esc(it.label)}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</span>
        ${fill}
        <span class="val">${esc(it.display ?? fmt.n1(it.value))}${it.note ? `<small>${esc(it.note)}</small>` : ""}</span>
      </${tag}>`;
    })
    .join("")}</div>`;
  el.querySelectorAll(".bar-row").forEach((row) => {
    const it = items[+row.dataset.i];
    if (it.tip) bindTip(row, it.tip);
    if (opts.onClick) row.addEventListener("click", () => opts.onClick(it));
  });
}

// ---------- paired bars: wins vs losses (or any A/B) ----------
export function pairBars(el, items, { aLabel = "In wins", bLabel = "In losses", aColor = cssVar("--good"), bColor = cssVar("--bad") } = {}) {
  if (!items.length) return empty(el);
  const longest = Math.max(aLabel.replace(/^In /, "").length, bLabel.replace(/^In /, "").length);
  el.style.setProperty("--pl", `${Math.min(120, Math.max(44, longest * 7 + 6))}px`);
  el.innerHTML =
    legendHtml([{ name: aLabel, color: aColor }, { name: bLabel, color: bColor }]) +
    `<div class="pairs">${items
      .map((it) => {
        const max = Math.max(Math.abs(it.a), Math.abs(it.b), 1e-9) * 1.05;
        return `<div class="pair"><div class="pair-top"><b>${esc(it.label)}</b><span class="tag">${esc(it.tag || "")}</span></div>
          <div class="pair-line"><span>${esc(aLabel.replace(/^In /, ""))}</span><div class="track"><span class="fill" style="width:${(Math.abs(it.a) / max) * 100}%;background:${aColor}"></span></div><span class="v">${esc(it.f(it.a))}</span></div>
          <div class="pair-line"><span>${esc(bLabel.replace(/^In /, ""))}</span><div class="track"><span class="fill" style="width:${(Math.abs(it.b) / max) * 100}%;background:${bColor}"></span></div><span class="v">${esc(it.f(it.b))}</span></div></div>`;
      })
      .join("")}</div>`;
}

// ---------- heat grid (HTML, CSS grid) ----------
/** rows/cols: labels; cell(ri, ci) → {fill, text, thin, tip, onClick} | null */
export function heatGrid(el, { rows, cols, cell, rowWidth = "minmax(80px, 140px)", colMin = "28px", showText = true }) {
  const ink = scales().ink;
  el.innerHTML = `<div class="heat" style="grid-template-columns:${rowWidth} repeat(${cols.length}, minmax(${colMin}, 1fr))">
    <span></span>${cols.map((c) => `<span class="hc" title="${esc(c)}">${esc(c)}</span>`).join("")}
    ${rows
      .map(
        (r, ri) =>
          `<span class="hl" title="${esc(r)}">${esc(r)}</span>` +
          cols
            .map((_, ci) => {
              const c = cell(ri, ci);
              if (!c) return `<span class="cell empty"></span>`;
              return `<button type="button" class="cell${c.thin ? " thin" : ""}${c.onClick ? " clickable" : ""}" data-r="${ri}" data-c="${ci}" style="background-color:${c.fill};color:${ink(c.fill)}" aria-label="${esc(c.aria || "")}">${showText ? esc(c.text ?? "") : ""}</button>`;
            })
            .join(""),
      )
      .join("")}
  </div>`;
  el.querySelectorAll(".cell[data-r]").forEach((b) => {
    const c = cell(+b.dataset.r, +b.dataset.c);
    if (c.tip) bindTip(b, c.tip);
    if (c.onClick) b.addEventListener("click", c.onClick);
    else b.tabIndex = 0;
  });
}

export function scaleLegend(kind, left, right, mid) {
  const sc = scales();
  const stops = kind === "div" ? [-1, -0.5, 0, 0.5, 1].map((v) => sc.diverging(v)) : [0, 0.25, 0.5, 0.75, 1].map((t) => sc.sequential(t));
  return `<div class="scale-legend"><span>${esc(left)}</span><span class="ramp" style="background:linear-gradient(90deg,${stops.join(",")})"></span><span>${esc(right)}</span>${mid ? `<span>· ${esc(mid)}</span>` : ""}</div>`;
}

// ---------- calendar (activity) ----------
/** days: Map('YYYY-MM-DD' → {n, w, l, k, d}) */
export function calendar(el, days, { weeks = 53 } = {}) {
  const W = Math.max(el.clientWidth || 600, 260);
  const fitWeeks = Math.min(weeks, Math.floor((W - 30) / 13));
  const cell = Math.min(14, Math.floor((W - 30) / fitWeeks) - 2);
  const gap = 2, H = 7 * (cell + gap) + 20;
  const sc = scales();
  const max = Math.max(1, ...[...days.values()].map((d) => d.n));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - today.getDay() - (fitWeeks - 1) * 7);
  const svg = S("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Games played per day" });
  const surf = cssVar("--surface-3");
  let lastMonth = -1;
  for (let w = 0; w < fitWeeks; w++) {
    for (let d = 0; d < 7; d++) {
      const day = new Date(start); day.setDate(start.getDate() + w * 7 + d);
      if (day > today) continue;
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      const v = days.get(key);
      const x = 28 + w * (cell + gap), y = 16 + d * (cell + gap);
      const rect = S("rect", { x, y, width: cell, height: cell, rx: 3, fill: v ? sc.sequential(0.2 + 0.8 * Math.sqrt(v.n / max)) : surf, tabindex: v ? 0 : null }, svg);
      if (v) bindTip(rect, () => ({ title: day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }), rows: [{ label: "Games", value: String(v.n) }, { label: "Record", value: `${v.w}–${v.l}` }, { label: "K/D", value: fmt.n2(v.k / Math.max(v.d, 1)) }] }));
      if (d === 0 && day.getMonth() !== lastMonth && w < fitWeeks - 1) {
        lastMonth = day.getMonth();
        S("text", { x, y: 10, class: "tick" }, svg).textContent = day.toLocaleDateString(undefined, { month: "short" });
      }
    }
  }
  ["Mon", "Wed", "Fri"].forEach((lbl, i) => (S("text", { x: 0, y: 16 + (1 + i * 2) * (cell + gap) + cell - 2, class: "tick" }, svg).textContent = lbl));
  el.replaceChildren(svg);
}

// ---------- small static marks ----------
export function spark(values, { w = 120, h = 28, color = "var(--s1)", ref } = {}) {
  if (values.length < 2) return "";
  const min = Math.min(...values, ref ?? Infinity), max = Math.max(...values, ref ?? -Infinity);
  const X = (i) => (i / (values.length - 1)) * w;
  const Y = (v) => h - 3 - ((v - min) / Math.max(max - min, 1e-9)) * (h - 6);
  const d = values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  const refLine = ref != null ? `<line x1="0" x2="${w}" y1="${Y(ref)}" y2="${Y(ref)}" stroke="var(--axis)" stroke-width="1"/>` : "";
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${refLine}<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/><circle cx="${X(values.length - 1)}" cy="${Y(values[values.length - 1])}" r="3" fill="${color}"/></svg>`;
}

export function resultStrip(rows, { max = 30, big = false } = {}) {
  return `<div class="strip">${rows
    .slice(-max)
    .map((r) => `<button type="button" class="res ${r.out}${big ? " lg" : ""}" data-idx="${r.idx}" title="${esc(`${r.out === "W" ? "Win" : r.out === "L" ? "Loss" : r.out === "D" ? "Left early" : "Tie"} · ${r.mapName} · ${r.modeShort} · ${r.k}/${r.d}/${r.a}`)}">${r.out === "D" ? "Q" : r.out}</button>`)
    .join("")}</div>`;
}

export function confHtml(level) {
  const label = ["", "Low confidence", "Medium confidence", "High confidence"][level];
  return `<span class="conf" title="${label}: based on sample size and how consistent the effect is"><span class="dots">${[1, 2, 3].map((i) => `<i class="${i <= level ? "on" : ""}"></i>`).join("")}</span>${label.split(" ")[0]}</span>`;
}

export function dataTable(headers, rows) {
  return `<div class="table-wrap"><table class="t"><thead><tr>${headers.map((h, i) => `<th class="${i ? "n" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${i ? "n" : ""}">${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}
