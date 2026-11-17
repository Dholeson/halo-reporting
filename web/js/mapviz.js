// Map playbook visuals: a top-down schematic (zones, how they connect, spawns, this mode's
// objectives) drawn from web/playbook/maps.json, or a plain callout list when the layout isn't
// known well enough to draw. Schematics are original diagrams of relative positions, not to scale.

import { esc } from "./util.js";

const KIND_LABEL = { "power-weapon": "Power weapon", "power-up": "Power-up", equipment: "Equipment", weapon: "Weapon", grenade: "Grenades" };
const short = (s, n = 16) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** Greedy label placement: try right, left, above, below; skip spots that collide. */
function placer() {
  const boxes = [];
  const hit = (b) => boxes.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
  return {
    block(x, y, r) { boxes.push({ x: x - r, y: y - r, w: 2 * r, h: 2 * r }); },
    label(text, x, y, size, r) {
      const w = text.length * size * 0.56, h = size * 1.15;
      const spots = [
        { x: x + r + 0.8, y: y - h / 2, anchor: "start" },
        { x: x - r - 0.8 - w, y: y - h / 2, anchor: "start" },
        { x: x - w / 2, y: y - r - 0.6 - h, anchor: "start" },
        { x: x - w / 2, y: y + r + 0.6, anchor: "start" },
      ];
      const pick = spots.find((s) => !hit({ x: s.x, y: s.y, w, h })) || spots[0];
      boxes.push({ x: pick.x, y: pick.y, w, h });
      return { x: pick.x, y: pick.y + h * 0.8 };
    },
  };
}

export function mapSchematic(book, { objectives = [], spawns = [] } = {}) {
  const zones = (book.zones || []).filter((z) => Number.isFinite(z.x) && Number.isFinite(z.y));
  if (zones.length < 3) return calloutList(book, { objectives, spawns });
  const byName = new Map(zones.map((z) => [z.name.toLowerCase(), z]));
  const at = (name) => byName.get(String(name || "").toLowerCase());
  const xs = zones.map((z) => z.x), ys = zones.map((z) => z.y);
  const pad = 9;
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  const w = Math.max(...xs) - Math.min(...xs) + 2 * pad, h = Math.max(...ys) - Math.min(...ys) + 2 * pad;
  const P = placer();
  const out = [];
  // links first, under everything
  for (const l of book.links || []) {
    const a = at(l.from), b = at(l.to);
    if (!a || !b) continue;
    out.push(`<line class="mz-link ${/jump|drop|lift/.test(l.kind || "") ? "soft" : ""}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`);
  }
  // objectives: big lettered markers under the zone dots
  const objMarks = [];
  objectives.forEach((o, i) => {
    const z = at(o.zone);
    if (!z) return;
    const label = /flag/i.test(o.label) ? "⚑" : o.label.length <= 2 ? o.label : String(o.order ?? i + 1);
    const team = /red/i.test(o.label) ? "red" : /blue/i.test(o.label) ? "blue" : "";
    P.block(z.x, z.y, 3.6);
    objMarks.push(`<g class="mz-obj ${team}"><title>${esc(`${o.label}: ${o.zone}${o.notes ? `. ${o.notes}` : ""}`)}</title><circle cx="${z.x}" cy="${z.y}" r="3.4"/><text x="${z.x}" y="${z.y + 1.25}" text-anchor="middle">${esc(label)}</text></g>`);
  });
  // spawns: small shapes offset from their zone
  const seen = new Map();
  const spawnMarks = [];
  for (const s of spawns) {
    const z = at(s.zone);
    if (!z) continue;
    const n = seen.get(z.name) || 0;
    seen.set(z.name, n + 1);
    const sx = z.x + (n % 2 ? -4.2 : 4.2), sy = z.y + (n >= 2 ? 3.6 : -3.6) * (n % 3 ? 1 : -1);
    const shape = s.kind === "power-weapon" ? `<path d="M${sx} ${sy - 1.8}L${sx + 1.8} ${sy}L${sx} ${sy + 1.8}L${sx - 1.8} ${sy}Z"/>`
      : s.kind === "power-up" ? `<circle cx="${sx}" cy="${sy}" r="1.5"/>`
      : `<rect x="${sx - 1.25}" y="${sy - 1.25}" width="2.5" height="2.5" rx=".4"/>`;
    P.block(sx, sy, 1.9);
    const lab = P.label(short(s.item, 14), sx, sy, 2.3, 1.9);
    spawnMarks.push(`<g class="mz-spawn k-${esc(s.kind)}"><title>${esc(`${s.item} (${KIND_LABEL[s.kind] || s.kind}) at ${s.zone}${s.respawnSec ? `, every ${s.respawnSec} s` : ""}`)}</title>${shape}<text x="${lab.x}" y="${lab.y}">${esc(short(s.item, 14))}</text></g>`);
  }
  // zones on top, labels placed around them
  const zoneMarks = zones.map((z) => {
    const r = z.kind === "base" ? 2.1 : 1.4;
    P.block(z.x, z.y, r);
    return { z, r };
  }).map(({ z, r }) => {
    const lab = P.label(short(z.name, 18), z.x, z.y, z.kind === "base" ? 2.9 : 2.6, r);
    return `<g class="mz-zone k-${esc(z.kind)} ${z.side ? `side-${esc(z.side.toLowerCase())}` : ""}"><title>${esc(`${z.name}${z.level ? `, ${z.level} level` : ""}${z.notes ? `. ${z.notes}` : ""}`)}</title><circle cx="${z.x}" cy="${z.y}" r="${r}"/><text x="${lab.x}" y="${lab.y}">${esc(short(z.name, 18))}</text></g>`;
  });
  const kinds = [...new Set(spawns.map((s) => s.kind))];
  const legend = [
    objectives.length ? `<span><i class="lg-obj"></i>Objective</span>` : "",
    kinds.includes("power-weapon") ? `<span><i class="lg-pw"></i>Power weapon</span>` : "",
    kinds.includes("power-up") ? `<span><i class="lg-pu"></i>Power-up</span>` : "",
    kinds.some((k) => k === "equipment" || k === "weapon" || k === "grenade") ? `<span><i class="lg-eq"></i>Equipment &amp; weapons</span>` : "",
    zones.some((z) => /red/i.test(z.side || "")) ? `<span><i class="lg-red"></i>Red side</span>` : "",
    zones.some((z) => /blue/i.test(z.side || "")) ? `<span><i class="lg-blue"></i>Blue side</span>` : "",
  ].join("");
  const aria = `Schematic of ${book.map || "the map"}: ${zones.map((z) => z.name).join(", ")}.`;
  return `<figure class="mz"><svg viewBox="${x0} ${y0} ${w} ${h}" role="img" aria-label="${esc(aria)}" preserveAspectRatio="xMidYMid meet">${out.join("")}${objMarks.join("")}${spawnMarks.join("")}${zoneMarks.join("")}</svg>
    <figcaption class="mz-legend">${legend}</figcaption></figure>`;
}

/** Callouts grouped by side, each with what spawns there and which objectives sit on it. */
export function calloutList(book, { objectives = [], spawns = [] } = {}) {
  const zones = book.zones || [];
  if (!zones.length) return '<p class="note">No callouts recorded yet.</p>';
  const groups = new Map();
  for (const z of zones) {
    const g = /red/i.test(z.side || "") ? "Red side" : /blue/i.test(z.side || "") ? "Blue side" : z.kind === "mid" ? "Middle" : "Around the map";
    groups.set(g, [...(groups.get(g) || []), z]);
  }
  const order = ["Red side", "Middle", "Blue side", "Around the map"];
  const tag = (z) => [
    ...objectives.filter((o) => o.zone.toLowerCase() === z.name.toLowerCase()).map((o) => `<span class="badge acc">${esc(o.label)}</span>`),
    ...spawns.filter((s) => s.zone.toLowerCase() === z.name.toLowerCase()).map((s) => `<span class="badge k-${esc(s.kind)}">${esc(s.item)}</span>`),
  ].join("");
  return `<div class="mz-list">${order.filter((g) => groups.has(g)).map((g) => `<div><div class="eyebrow">${g}</div><ul>${groups.get(g).map((z) => `<li><b>${esc(z.name)}</b>${z.level ? `<span class="note"> ${esc(z.level)}</span>` : ""} ${tag(z)}</li>`).join("")}</ul></div>`).join("")}</div>`;
}
