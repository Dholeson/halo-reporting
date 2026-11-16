import { esc, fmt, icon, cssVar } from "../util.js";
import { agg, mean } from "../stats.js";
import { barList } from "../charts.js";
import { coach, focusAreas } from "../insights.js";
import { insightCard, mountInsightCharts, noGames } from "./common.js";
import { rangeLabel } from "../data.js";

const ARCHETYPES = {
  apex: { name: "Apex Slayer", line: "You win your fights and live to tell it. Above-lobby kills without the extra deaths." },
  trader: { name: "Aggressive Trader", line: "You take a lot of fights and win plenty, but you trade your life for it often." },
  anchor: { name: "Anchor", line: "Hard to kill. You hold positions and keep your team in the game." },
  support: { name: "Support", line: "You set up kills: high assists relative to your own kills." },
  breaker: { name: "Shield Breaker", line: "You do the damage, and your team often gets the finish." },
  allround: { name: "All-rounder", line: "Balanced numbers with no extreme. You adapt to what the game needs." },
};

export function playstyle(rows) {
  if (rows.length < 15) return null;
  const killsRel = mean(rows.map((r) => r.k)) / Math.max(mean(rows.map((r) => r.lobbyAvgK)), 0.1);
  const deathsRel = mean(rows.map((r) => r.d)) / Math.max(mean(rows.map((r) => r.lobbyAvgD)), 0.1);
  const dmgRel = mean(rows.map((r) => r.dmgShare));
  const a = agg(rows);
  const assistRatio = a.as / Math.max(a.k, 1);
  let key = "allround";
  if (killsRel >= 1.15 && deathsRel <= 1.0) key = "apex";
  else if (killsRel >= 1.08 && deathsRel > 1.04) key = "trader";
  else if (dmgRel >= 1.08 && killsRel < 1.04) key = "breaker";
  else if (deathsRel <= 0.92 && killsRel < 1.08) key = "anchor";
  else if (assistRatio >= 0.75) key = "support";
  return { key, ...ARCHETYPES[key], killsRel, deathsRel, dmgRel, assistRatio };
}

export function render(ctx) {
  const { rows, el, f } = ctx;
  if (!rows.length) { el.innerHTML = noGames(ctx); return; }
  const list = coach(rows, ctx);
  const focus = focusAreas(list, 3);
  const strengths = list.filter((i) => i.tone === "good").slice(0, 3);
  const rest = list.filter((i) => !focus.includes(i) && !strengths.includes(i));
  const style = playstyle(rows.filter((r) => !r.casual));
  const desc = [rangeLabel(f.range), f.queue !== "all" ? f.queue : "", f.fam, f.map].filter(Boolean).join(" · ");

  el.innerHTML = `
  <div class="page-head"><div><h1>Coaching report</h1><p>Built from ${fmt.int(rows.filter((r) => !r.casual).length)} games (${esc(desc)}; minigames excluded). Every call shows its confidence. Narrow the filters (say, Ranked + one mode) for sharper advice.</p></div></div>

  ${style ? `<section class="card">
    <div class="grid g2" style="align-items:center">
      <div>
        <div class="eyebrow">Your playstyle</div>
        <h2 style="font-size:28px;font-weight:800;margin-top:4px">${esc(style.name)}</h2>
        <p class="text-2" style="margin-top:6px;max-width:48ch">${esc(style.line)}</p>
        <p class="note" style="margin-top:8px">Compared with the average player in your own lobbies, so it adjusts for the skill level you're matched against. You average ${fmt.n2(style.assistRatio)} assists per kill.</p>
      </div>
      <div><div id="fingerprint"></div></div>
    </div>
  </section>` : ""}

  <div class="section-title"><h2>Focus areas</h2><span class="note">The three changes with the biggest expected payoff</span></div>
  <div class="grid g3">${focus.length ? focus.map((ins, i) => `<article class="card focus-card"><div class="focus-rank">${i + 1}</div><div><div class="eyebrow">${esc(ins.area)}</div><h3>${esc(ins.title)}</h3><p>${esc(ins.verdict)}</p>${ins.tip ? `<p class="tipline"><b>Try this:</b> ${esc(ins.tip)}</p>` : ""}<p style="margin-top:8px"><a href="#" data-jump="${esc(ins.id)}">See the evidence</a></p></div></article>`).join("") : '<p class="note">Nothing to fix with confidence in this slice. Widen the filters for more data.</p>'}</div>

  ${strengths.length ? `<div class="section-title"><h2>Strengths</h2><span class="note">Keep doing these</span></div>
  <div class="grid g3">${strengths.map((ins) => `<article class="card focus-card"><div class="focus-rank" style="background:color-mix(in srgb,var(--good) 14%,transparent);color:var(--good-text)">${icon("check")}</div><div><div class="eyebrow">${esc(ins.area)}</div><h3>${esc(ins.title)}</h3><p>${esc(ins.verdict)}</p></div></article>`).join("")}</div>` : ""}

  <div class="section-title"><h2>All findings</h2><span class="note">${list.length} analyses ran on this slice</span></div>
  <div class="grid g2" id="all-insights">${[...focus, ...strengths, ...rest].map((i) => insightCard(i)).join("")}</div>`;

  if (style) {
    const item = (label, rel, better, note) => ({
      label, value: Math.max(-0.25, Math.min(0.25, rel - 1)), display: `${rel.toFixed(2)}×`, note,
      color: (rel - 1) * better >= 0 ? cssVar("--div-pos") : cssVar("--div-neg"),
      tip: () => ({ title: label, rows: [{ label: "You vs lobby average", value: `${rel.toFixed(2)}×` }], note: better > 0 ? "Higher is better" : "Lower is better" }),
    });
    barList(el.querySelector("#fingerprint"), [
      item("Kills", style.killsRel, 1, "vs lobby"),
      item("Deaths", style.deathsRel, -1, "vs lobby"),
      item("Damage", style.dmgRel, 1, "vs lobby"),
    ], { diverging: true, max: 0.25, head: ["You vs the average player in your lobbies", "← less · more →", ""] });
  }
  mountInsightCharts(el, list);
  el.querySelectorAll("[data-jump]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    el.querySelector(`#ins-${CSS.escape(a.dataset.jump)}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
}
