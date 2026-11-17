// Map playbook visuals: a top-down schematic (zones, how they connect, spawns, this mode's
// objectives) drawn from web/playbook/maps.json, or a plain callout list when the layout isn't
// known well enough to draw. Schematics are original diagrams of relative positions, not to scale.

import { esc } from "./util.js";

const KIND_LABEL = { "power-weapon": "Power weapon", "power-up": "Power-up", equipment: "Equipment", weapon: "Weapon", grenade: "Grenades" };
const GENERIC = /^(weapon rack|equipment pad|weapon pad|grenade pad)$/i;
const ZONE_FONT = 2.8, BASE_FONT = 3.1, SPAWN_FONT = 2.4;

// Text width in schematic units. Measured with the page's own font when a canvas is available, so
// labels don't collide in practice; a per-character estimate otherwise (tests, very old browsers).
let measure = null;
function textWidth(text, size, weight) {
  try {
    if (measure === null) {
      const ctx = document.createElement("canvas").getContext("2d");
      const family = getComputedStyle(document.body).fontFamily || "sans-serif";
      measure = ctx ? (t, w) => { ctx.font = `${w} 100px ${family}`; return ctx.measureText(t).width / 100; } : false;
    }
    if (measure) return measure(text, weight) * size * 1.04;
  } catch { measure = false; }
  return text.length * size * 0.6;
}

/** Greedy label placement around each mark: eight spots close in, then eight further out (those get
 *  a leader line). Takes the first free spot; if none is free, the one that overlaps least. */
function placer() {
  const boxes = [];
  const overlap = (b) => boxes.reduce((sum, o) => {
    const ox = Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x), oy = Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y);
    return ox > 0 && oy > 0 ? sum + ox * oy : sum;
  }, 0);
  return {
    boxes,
    block(x, y, r) { boxes.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r }); },
    label(text, x, y, size, r, weight = 650) {
      const w = textWidth(text, size, weight), h = size * 1.2;
      const spots = [];
      for (const [d, lead] of [[r + 0.7, false], [r + 4.2, true]]) {
        const k = d * 0.72;
        spots.push(
          { x: x + d, y: y - h / 2 }, { x: x - d - w, y: y - h / 2 },
          { x: x - w / 2, y: y - d - h }, { x: x - w / 2, y: y + d },
          { x: x + k, y: y - k - h }, { x: x + k, y: y + k }, { x: x - k - w, y: y - k - h }, { x: x - k - w, y: y + k },
        );
        spots.slice(-8).forEach((s) => { s.lead = lead; });
      }
      let pick = spots.find((s) => overlap({ x: s.x, y: s.y, w, h }) === 0);
      if (!pick) pick = spots.map((s) => ({ s, o: overlap({ x: s.x, y: s.y, w, h }) + (s.lead ? 0.5 : 0) })).sort((a, b) => a.o - b.o)[0].s;
      boxes.push({ x: pick.x, y: pick.y, w, h });
      // leader: from the mark's edge toward the label's nearest point
      let lead = "";
      if (pick.lead) {
        const nx = Math.max(pick.x, Math.min(x, pick.x + w)), ny = Math.max(pick.y, Math.min(y, pick.y + h));
        const dx = nx - x, dy = ny - y, len = Math.hypot(dx, dy) || 1;
        lead = `<line class="mz-lead" x1="${(x + (dx / len) * r).toFixed(2)}" y1="${(y + (dy / len) * r).toFixed(2)}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}"/>`;
      }
      return { x: +pick.x.toFixed(2), y: +(pick.y + h * 0.78).toFixed(2), lead };
    },
  };
}

/** Short name for a spawn on the drawing ("Sniper / Skewer", not the full research wording). */
const spawnName = (s) => s.short || (String(s.item).length <= 16 ? s.item : `${String(s.item).slice(0, 15)}…`);

export function mapSchematic(book, { objectives = [], spawns = [] } = {}) {
  const zones = (book.zones || []).filter((z) => Number.isFinite(z.x) && Number.isFinite(z.y));
  if (zones.length < 3) return calloutList(book, { objectives, spawns });
  const byName = new Map(zones.map((z) => [z.name.toLowerCase(), z]));
  const at = (name) => byName.get(String(name || "").toLowerCase());
  const P = placer();
  const links = [], dots = [], spawnMarks = [], objMarks = [], labels = [], leads = [];
  for (const l of book.links || []) {
    const a = at(l.from), b = at(l.to);
    if (a && b) links.push(`<line class="mz-link ${/jump|drop|lift/.test(l.kind || "") ? "soft" : ""}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
  }
  // objectives: lettered markers that replace their zone's dot
  const objAt = new Map();
  objectives.forEach((o, i) => {
    const z = at(o.zone);
    if (!z || objAt.has(z.name)) return;
    const label = o.mark || (/flag/i.test(o.label) ? "⚑" : o.label.length <= 2 ? o.label : String(o.order ?? i + 1));
    const team = /red/i.test(o.label) ? "red" : /blue/i.test(o.label) ? "blue" : "";
    objAt.set(z.name, 3.4);
    P.block(z.x, z.y, 3.5);
    objMarks.push(`<g class="mz-obj ${team}"><title>${esc(`${o.label}: ${o.zone}${o.notes ? `. ${o.notes}` : ""}`)}</title><circle cx="${z.x}" cy="${z.y}" r="3.4"/><text x="${z.x}" y="${z.y + 1.2}" text-anchor="middle">${esc(label)}</text></g>`);
  });
  const radius = (z) => objAt.get(z.name) || (z.kind === "base" ? 2.1 : 1.4);
  for (const z of zones) {
    if (objAt.has(z.name)) continue;
    P.block(z.x, z.y, radius(z));
    dots.push(`<g class="mz-zone k-${esc(z.kind)} ${z.side ? `side-${esc(z.side.toLowerCase())}` : ""}${z.approx ? " approx" : ""}"><title>${esc(`${z.name}${z.level ? ` (${z.level})` : ""}${z.approx ? ", spot approximate" : ""}${z.notes ? `. ${z.notes}` : ""}`)}</title><circle cx="${z.x}" cy="${z.y}" r="${radius(z)}"/></g>`);
  }
  // spawns: small shapes around their zone
  const seen = new Map(), spawnLabels = [];
  for (const s of spawns) {
    const z = at(s.zone);
    if (!z) continue;
    const n = seen.get(z.name) || 0;
    seen.set(z.name, n + 1);
    const ang = (-45 + n * 90) * (Math.PI / 180), d = radius(z) + 2.6;
    const sx = +(z.x + Math.cos(ang) * d).toFixed(2), sy = +(z.y + Math.sin(ang) * d).toFixed(2);
    const shape = s.kind === "power-weapon" ? `<path d="M${sx} ${sy - 1.8}L${sx + 1.8} ${sy}L${sx} ${sy + 1.8}L${sx - 1.8} ${sy}Z"/>`
      : s.kind === "power-up" ? `<circle cx="${sx}" cy="${sy}" r="1.5"/>`
      : `<rect x="${sx - 1.25}" y="${sy - 1.25}" width="2.5" height="2.5" rx=".4"/>`;
    P.block(sx, sy, 1.8);
    spawnMarks.push(`<g class="mz-spawn k-${esc(s.kind)}"><title>${esc(`${s.item} (${KIND_LABEL[s.kind] || s.kind}) at ${s.zone}${s.respawnSec ? `, every ${s.respawnSec} s` : ""}`)}</title>${shape}</g>`);
    if (!GENERIC.test(s.item)) spawnLabels.push({ s, sx, sy });
  }
  // labels, most useful first: objective zones, power-item zones, bases and high ground, the rest
  const rank = (z) => (objAt.has(z.name) ? 0 : spawns.some((s) => /^power/.test(s.kind) && at(s.zone) === z) ? 1 : /base|tower|high/.test(z.kind) ? 2 : 3);
  for (const z of [...zones].sort((a, b) => rank(a) - rank(b))) {
    const size = z.kind === "base" ? BASE_FONT : ZONE_FONT;
    const lab = P.label(z.name, z.x, z.y, size, radius(z), z.kind === "base" ? 800 : 650);
    if (lab.lead) leads.push(lab.lead);
    labels.push(`<text class="mz-zl k-${esc(z.kind)}${z.approx ? " approx" : ""}" x="${lab.x}" y="${lab.y}">${esc(z.name)}</text>`);
  }
  for (const { s, sx, sy } of spawnLabels) {
    const lab = P.label(spawnName(s), sx, sy, SPAWN_FONT, 1.8, 700);
    if (lab.lead) leads.push(lab.lead);
    labels.push(`<text class="mz-sl" x="${lab.x}" y="${lab.y}">${esc(spawnName(s))}</text>`);
  }
  // fit the view to everything drawn, labels included
  const xs = P.boxes.flatMap((b) => [b.x, b.x + b.w]), ys = P.boxes.flatMap((b) => [b.y, b.y + b.h]);
  const m = 1.5, x0 = Math.min(...xs) - m, y0 = Math.min(...ys) - m;
  const w = Math.max(...xs) + m - x0, h = Math.max(...ys) + m - y0;
  const kinds = [...new Set(spawns.filter((s) => at(s.zone)).map((s) => s.kind))];
  const legend = [
    objAt.size ? `<span><i class="lg-obj"></i>Objective</span>` : "",
    kinds.includes("power-weapon") ? `<span><i class="lg-pw"></i>Power weapon</span>` : "",
    kinds.includes("power-up") ? `<span><i class="lg-pu"></i>Power-up</span>` : "",
    kinds.some((k) => k === "equipment" || k === "weapon" || k === "grenade") ? `<span><i class="lg-eq"></i>Weapons &amp; equipment</span>` : "",
    zones.some((z) => /red/i.test(z.side || "")) ? `<span><i class="lg-red"></i>Red side</span>` : "",
    zones.some((z) => /blue/i.test(z.side || "")) ? `<span><i class="lg-blue"></i>Blue side</span>` : "",
    zones.some((z) => z.approx) ? `<span><i class="lg-approx"></i>Spot approximate</span>` : "",
  ].join("");
  const aria = `Schematic of ${book.map || "the map"}: ${zones.map((z) => z.name).join(", ")}.`;
  const f = (v) => +v.toFixed(2);
  return `<figure class="mz"><svg viewBox="${f(x0)} ${f(y0)} ${f(w)} ${f(h)}" role="img" aria-label="${esc(aria)}" preserveAspectRatio="xMidYMid meet">${links.join("")}${leads.join("")}${dots.join("")}${spawnMarks.join("")}${objMarks.join("")}${labels.join("")}</svg>
    <figcaption class="mz-legend">${legend}</figcaption></figure>`;
}

/** Callouts grouped by area (or side), each with what spawns there, which objectives sit on it,
 *  and its notes behind a tap. */
export function calloutList(book, { objectives = [], spawns = [] } = {}) {
  const zones = book.zones || [];
  if (!zones.length) return '<p class="note">No callouts recorded yet.</p>';
  const byArea = zones.some((z) => z.area);
  const groupOf = (z) => (byArea ? z.area || "Elsewhere"
    : /red/i.test(z.side || "") ? "Red side" : /blue/i.test(z.side || "") ? "Blue side" : z.kind === "mid" ? "Middle" : "Around the map");
  const groups = new Map();
  for (const z of zones) groups.set(groupOf(z), [...(groups.get(groupOf(z)) || []), z]);
  const order = byArea ? [...groups.keys()] : ["Red side", "Middle", "Blue side", "Around the map"].filter((g) => groups.has(g));
  const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
  const tag = (z) => [
    ...objectives.filter((o) => same(o.zone, z.name)).map((o) => `<span class="badge acc">${esc(o.label)}</span>`),
    ...spawns.filter((s) => same(s.zone, z.name)).map((s) => `<span class="badge k-${esc(s.kind)}">${esc(s.item)}</span>`),
  ].join("");
  const item = (z) => {
    const head = `<b>${esc(z.name)}</b>${z.level ? `<span class="note">${esc(z.level)}</span>` : ""}${tag(z)}`;
    return z.notes ? `<li><details><summary>${head}</summary><p>${esc(z.notes)}</p></details></li>` : `<li><div class="mz-li">${head}</div></li>`;
  };
  return `<div class="mz-list">${order.map((g) => `<div><div class="eyebrow">${esc(g)}</div><ul>${groups.get(g).map(item).join("")}</ul></div>`).join("")}</div>`;
}
