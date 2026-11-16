import { esc, fmt, icon, initials, accountColor, cssVar } from "../util.js";
import { METRICS, goodness } from "../stats.js";
import { confHtml, spark } from "../charts.js";

/** Delta badge for metric m: arrow = direction, color = better/worse for you. */
export function deltaHtml(m, cur, base, { vs = "", digits } = {}) {
  if (cur == null || base == null || !Number.isFinite(cur) || !Number.isFinite(base)) return "";
  const M = METRICS[m];
  const diff = cur - base;
  const g = goodness(m, cur, base);
  const flat = Math.abs(g) < 0.04;
  const dir = diff > 0 ? "up" : "down";
  const cls = flat ? "flat" : `${dir} ${g > 0 ? "good" : "bad"}`;
  let txt;
  if (m === "wr" || m === "hsPct" || m === "kSharePct") txt = `${diff > 0 ? "+" : "−"}${Math.abs(diff * 100).toFixed(0)} pts`;
  else if (m === "acc") txt = `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(1)} pts`;
  else if (m === "lifeAvg" || m === "objtpg") txt = `${diff > 0 ? "+" : "−"}${fmt.secs(Math.abs(diff))}`;
  else if (M?.ratio) txt = `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(digits ?? 2)}`;
  else txt = `${diff > 0 ? "+" : "−"}${Math.abs(diff).toFixed(digits ?? 1)}`;
  const arrow = flat ? "" : icon(dir === "up" ? "up" : "down");
  const label = flat ? "about even" : `${dir === "up" ? "up" : "down"} ${txt}, ${g > 0 ? "better" : "worse"}`;
  return `<span class="delta ${cls}" aria-label="${esc(label)}${vs ? ` vs ${esc(vs)}` : ""}">${arrow ? `<span style="width:13px;height:13px;display:inline-flex">${arrow}</span>` : "±"}${esc(flat ? "even" : txt)}${vs ? ` <span class="vs">vs ${esc(vs)}</span>` : ""}</span>`;
}

export function kpiTile({ m, label, value, base, vs, sparkVals, sub, color }) {
  const M = METRICS[m] || {};
  return `<div class="card kpi">
    <div class="label"><span>${esc(label || M.label)}</span></div>
    <div class="value num">${esc((M.f || fmt.n2)(value))}</div>
    ${base != null ? deltaHtml(m, value, base, { vs }) : `<span class="delta flat">${esc(sub || "")}</span>`}
    ${sparkVals && sparkVals.length > 2 ? `<div class="spark">${spark(sparkVals, { color: color || "var(--s1)" })}</div>` : ""}
  </div>`;
}

export function avatar(who, db, { size = "", primary } = {}) {
  if (who === "me") {
    const name = primary?.gamertag || db.me[0]?.gamertag || "Me";
    return `<div class="avatar ${size}" style="--c1:var(--s1);--c2:var(--accent)" aria-hidden="true">${esc(initials(name))}</div>`;
  }
  const p = db.players.find((x) => x.xuid === who);
  const i = db.me.indexOf(p);
  const c = i >= 0 ? accountColor(i) : cssVar("--tie");
  return `<div class="avatar ${size}" style="--c1:${c};--c2:${c}" aria-hidden="true">${esc(initials(p?.gamertag))}</div>`;
}

/** The person this page is "about": the [me] account whose gamertag matches the Pages username, else the most recent. */
export function primaryAccount(db, all) {
  const host = location.hostname.endsWith("github.io") ? location.hostname.split(".")[0].toLowerCase() : "";
  const byHost = db.me.find((p) => p.gamertag.replace(/\s+/g, "").toLowerCase() === host);
  if (byHost) return byHost;
  const last = all[all.length - 1];
  return last ? db.players[last.p] : db.me[0];
}

export function whoLabel(ctx) {
  if (ctx.f.who === "me") return ctx.db.me.length > 1 ? "you (all accounts)" : "you";
  return ctx.db.players.find((p) => p.xuid === ctx.f.who)?.gamertag || "this player";
}

export function insightCard(ins, { compact = false } = {}) {
  return `<article class="card insight tone-${ins.tone}" id="ins-${esc(ins.id)}">
    <div class="i-head">
      <div class="i-icon">${icon(ins.icon)}</div>
      <div style="flex:1;min-width:0">
        <div class="i-area">${esc(ins.area)} · ${ins.tone === "bad" ? "Work on" : ins.tone === "good" ? "Strength" : "Insight"}</div>
        <h3>${esc(ins.title)}</h3>
      </div>
      ${confHtml(ins.conf)}
    </div>
    <p class="verdict">${esc(ins.verdict)}</p>
    ${ins.chart && !compact ? `<div class="chart" data-chart="${esc(ins.id)}"></div>` : ""}
    ${ins.tip ? `<div class="tip">${icon("tip")}<span><b>Try this:</b> ${esc(ins.tip)}</span></div>` : ""}
  </article>`;
}

export function mountInsightCharts(root, list) {
  for (const ins of list) {
    const el = root.querySelector(`[data-chart="${CSS.escape(ins.id)}"]`);
    if (el && ins.chart) ins.chart(el);
  }
}

export function emptyState(title, body, iconName = "overview") {
  return `<div class="card empty">${icon(iconName)}<h3>${esc(title)}</h3><p>${body}</p></div>`;
}

export function noGames(ctx) {
  return emptyState(
    "No games match these filters",
    `Nothing for ${esc(whoLabel(ctx))} in the current filters. Widen the time range or clear the map and mode filters.`,
    "calendar",
  );
}

/** Wire clicks on result chips / match buttons inside root to the match drawer. */
export function wireMatchLinks(root, ctx) {
  root.querySelectorAll("[data-idx]").forEach((b) =>
    b.addEventListener("click", () => {
      const r = ctx.all.find((x) => x.idx === +b.dataset.idx);
      if (r) ctx.openMatch(r);
    }),
  );
}

export function resultWord(r) {
  return r.out === "W" ? "Win" : r.out === "L" ? "Loss" : r.out === "D" ? "Left early" : r.out === "T" ? "Tie" : "—";
}

export function badges(r) {
  const b = [];
  if (r.mvp) b.push('<span class="badge gold">MVP</span>');
  else if (r.dmgRank === 1) b.push('<span class="badge acc">Top damage</span>');
  else if (r.kRank === 1) b.push('<span class="badge acc">Top frag</span>');
  if (r.d === 0 && r.win) b.push('<span class="badge gold">Flawless</span>');
  if (r.spree >= 10) b.push(`<span class="badge">${r.spree} spree</span>`);
  if (r.impact != null && r.impact <= 8) b.push('<span class="badge">Off night</span>');
  return b.join("");
}
