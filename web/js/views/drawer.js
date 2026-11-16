import { $, esc, fmt, icon, cssVar } from "../util.js";
import { barList, hideTip } from "../charts.js";
import { lobbyFor } from "../data.js";
import { resultWord, badges } from "./common.js";
import { mapArt, artLayer, medalIcon } from "../art.js";

let lastFocus = null;

export function closeMatch(ctx) {
  const d = $("#drawer");
  if (d.hidden) return;
  d.hidden = true;
  $("#scrim").hidden = true;
  document.body.style.overflow = "";
  hideTip();
  ctx?.setParam?.("match", "");
  lastFocus?.focus?.();
}

export async function openMatch(r, ctx) {
  if (!r) return;
  lastFocus = document.activeElement;
  const d = $("#drawer"), scrim = $("#scrim");
  d.hidden = false;
  scrim.hidden = false;
  document.body.style.overflow = "hidden";
  ctx.setParam("match", r.mid);
  const tracked = new Set(ctx.db.players.map((p) => p.xuid));

  d.innerHTML = `
  <div class="drawer-head">
    <span class="res lg ${r.out}">${r.out === "D" ? "Q" : r.out}</span>
    <div style="min-width:0"><h2>${esc(r.mapVariant)} · ${esc(r.modeShort)}</h2><div class="sub">${esc(resultWord(r))} · ${esc(r.plName)} · ${esc(fmt.dateTime(r.t))} · ${esc(fmt.secs(r.dur))} · ${esc(r.player.gamertag)}</div></div>
    <button class="icon-btn" type="button" id="close-drawer" aria-label="Close">${icon("close")}</button>
  </div>
  <div class="drawer-body">
    ${mapArt(r.mapName) ? `<div class="drawer-hero has-art">${artLayer(mapArt(r.mapName), "scrim-bottom")}<div><div class="dh-title">${esc(r.mapName)} · ${esc(r.famName)} · ${esc(r.plName)}</div>${r.teamScore != null && r.enemyScore != null ? `<div class="scoreline" style="justify-content:flex-start;margin-top:6px"><div><div class="team">Your team</div><span class="${r.win ? "good-text" : ""}">${fmt.int(r.teamScore)}</span></div><span>–</span><div><div class="team">Enemy</div><span class="${r.loss ? "bad-text" : ""}">${fmt.int(r.enemyScore)}</span></div></div>` : ""}</div></div>` : ""}
    ${!mapArt(r.mapName) && r.teamScore != null && r.enemyScore != null ? `<div class="card flat"><div class="scoreline"><div><div class="team">Your team</div><span class="${r.win ? "good-text" : ""}">${fmt.int(r.teamScore)}</span></div><span class="muted">–</span><div><div class="team">Enemy</div><span class="${r.loss ? "bad-text" : ""}">${fmt.int(r.enemyScore)}</span></div></div></div>` : ""}
    <div class="grid g3" style="gap:10px">
      ${mini("K / D / A", `${r.k} / ${r.d} / ${r.a}`, `${fmt.n2(r.kd)} K/D`)}
      ${mini("Damage", `${fmt.int(r.dd)}`, `${fmt.int(r.dt)} taken · ${fmt.n2(r.dmgRatio)} ratio`)}
      ${mini("Accuracy", fmt.acc(r.acc), `${r.sh}/${r.sf} shots · ${r.hs} headshot kills`)}
      ${mini("Impact", `${r.impact}`, "vs all your games (0–100)")}
      ${mini("Lobby damage rank", `#${r.dmgRank} of ${r.lobby}`, `#${r.kRank} on kills`)}
      ${mini("Avg life", fmt.secs(r.life), `best spree ${r.spree}`)}
    </div>
    ${badges(r) ? `<div class="badges" style="display:flex;gap:6px;flex-wrap:wrap">${badges(r)}</div>` : ""}
    ${r.csrPost != null || r.xk != null ? `<section class="card flat"><div class="card-head"><div><h3>Ranked</h3></div></div><dl class="kv">
      ${r.csrPost != null ? `<dt>CSR</dt><dd>${r.csrPre != null ? `${fmt.int(r.csrPre)} → ` : ""}${fmt.int(r.csrPost)} <span class="${(r.csrDelta ?? 0) >= 0 ? "good-text" : "bad-text"}">(${fmt.signed(r.csrDelta, fmt.int)})</span></dd><dt>Tier</dt><dd>${esc(r.tierName || "–")}</dd>` : ""}
      ${r.xk != null ? `<dt>Kills vs expected</dt><dd>${r.k} vs ${fmt.n1(r.xk)} <span class="${r.k >= r.xk ? "good-text" : "bad-text"}">(${fmt.signed(r.k - r.xk, fmt.n1)})</span></dd><dt>Deaths vs expected</dt><dd>${r.d} vs ${fmt.n1(r.xd)} <span class="${r.d <= r.xd ? "good-text" : "bad-text"}">(${fmt.signed(r.d - r.xd, fmt.n1)})</span></dd>` : ""}
      ${r.mmrDiff != null ? `<dt>Team MMR vs enemy</dt><dd>${fmt.int(r.mmr)} vs ${fmt.int(r.mmrEnemy)} (${fmt.signed(r.mmrDiff, fmt.int)})</dd>` : ""}
    </dl></section>` : ""}
    ${r.objMode ? `<section class="card flat"><div class="card-head"><div><h3>Objective</h3></div></div><dl class="kv"><dt>Time on objective</dt><dd>${fmt.secs(r.objt)}</dd><dt>Objective plays</dt><dd>${fmt.int(r.obja)}</dd><dt>Objective kills</dt><dd>${fmt.int(r.objk)}</dd></dl></section>` : ""}
    <section class="card flat"><div class="card-head"><div><h3>You vs the lobby</h3><div class="sub">Lobby average across all players in this match</div></div></div><div id="vs-lobby"><p class="note">Loading lobby…</p></div></section>
    <section class="card flat"><div class="card-head"><div><h3>Scoreboard</h3></div></div><div id="scoreboard"><p class="note">Loading lobby…</p></div></section>
    ${r.medals?.length ? `<section class="card flat"><div class="card-head"><div><h3>Medals</h3></div></div><div class="medal-list">${r.medals.map(([i, c]) => `<span class="medal">${medalIcon(i, 24) || icon("medal")}${esc(ctx.db.medals[i] || "Medal")}${c > 1 ? ` <b>×${c}</b>` : ""}</span>`).join("")}</div></section>` : ""}
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" type="button" id="brief-this">${icon("briefing")}Brief ${esc(r.mapName)} · ${esc(r.famName)}</button><button class="btn" type="button" id="copy-match">${icon("link")}Copy link</button></div>
  </div>`;

  const close = () => closeMatch(ctx);
  d.querySelector("#close-drawer").addEventListener("click", close);
  d.querySelector("#close-drawer").focus();
  scrim.onclick = close;
  d.querySelector("#brief-this").addEventListener("click", () => { close(); ctx.go("briefing", { bmap: r.mapName, bfam: r.famName }); });
  d.querySelector("#copy-match").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); ctx.toast("Link copied"); } catch { ctx.toast("Couldn't copy. Use the address bar."); }
  });

  const lobby = await lobbyFor(r);
  if (d.hidden) return;
  const vs = d.querySelector("#vs-lobby"), sb = d.querySelector("#scoreboard");
  if (!lobby) {
    vs.innerHTML = sb.innerHTML = '<p class="note">Lobby details aren\'t available for this match.</p>';
    return;
  }
  const me = lobby.find((p) => p.xuid === r.player.xuid);
  const avg = (k) => lobby.reduce((s, p) => s + (p[k] || 0), 0) / lobby.length;
  const items = [
    ["Kills", r.k, avg("k"), 1, fmt.n1], ["Deaths", r.d, avg("d"), -1, fmt.n1], ["Assists", r.a, avg("a"), 1, fmt.n1],
    ["Damage", r.dd, avg("dd"), 1, fmt.int], ["Accuracy", r.acc ?? 0, avg("acc"), 1, (v) => `${v.toFixed(1)}%`],
  ];
  barList(vs, items.map(([label, you, lob, better, f]) => {
    const rel = lob ? you / lob - 1 : 0;
    return { label, value: Math.max(-1, Math.min(1, rel)), display: f(you), note: `avg ${f(lob)}`, color: rel * better >= 0 ? cssVar("--div-pos") : cssVar("--div-neg"), tip: () => ({ title: label, rows: [{ label: "You", value: f(you) }, { label: "Lobby average", value: f(lob) }] }) };
  }), { diverging: true, max: 1 });

  const teams = [...new Set(lobby.map((p) => p.team))].sort((a, b) => (a === me?.team ? -1 : b === me?.team ? 1 : a - b));
  const nameOf = (p) => (p.bot ? "Bot" : p.name || `Player ··${p.xuid.slice(-4)}`);
  sb.innerHTML = teams.map((t) => {
    const ps = lobby.filter((p) => p.team === t).sort((a, b) => b.ps - a.ps || b.k - a.k);
    const label = t === me?.team ? "Your team" : teams.length > 2 ? `Team ${t + 1}` : "Enemy team";
    return `<div class="eyebrow" style="margin:8px 0 4px">${esc(label)} · ${esc(ps[0]?.out === "W" ? "Won" : ps[0]?.out === "L" ? "Lost" : "")}</div>
      <div class="table-wrap"><table class="t"><thead><tr><th>Player</th><th class="n">K</th><th class="n">D</th><th class="n">A</th><th class="n">Damage</th><th class="n">Acc</th><th class="n">Score</th></tr></thead><tbody>
      ${ps.map((p) => `<tr class="${tracked.has(p.xuid) ? "me" : ""}"><td class="lead">${esc(nameOf(p))}${tracked.has(p.xuid) ? ' <span class="badge acc">tracked</span>' : ""}</td><td class="n">${p.k}</td><td class="n">${p.d}</td><td class="n">${p.a}</td><td class="n">${fmt.int(p.dd)}</td><td class="n">${p.acc.toFixed(1)}%</td><td class="n">${fmt.int(p.ps)}</td></tr>`).join("")}
      </tbody></table></div>`;
  }).join("");
}

function mini(label, value, sub) {
  return `<div class="mini-stat"><div class="l">${esc(label)}</div><div class="v">${esc(value)}</div><div class="note">${esc(sub)}</div></div>`;
}
