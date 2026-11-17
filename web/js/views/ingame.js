// In-game: one screen for the match you're in. Pick the map and mode (one tap), then it shows what
// your wins look like here, your game plan, the map's callouts, spawns and objectives for this mode,
// the mode's rules and coaching, and tap-to-start respawn timers. Built to sit on a phone or second
// monitor next to the game: big type, no app chrome, the screen stays on.

import { esc, fmt, icon, scales, toast } from "../util.js";
import { agg } from "../stats.js";
import { resultStrip } from "../charts.js";
import { emptyState, wireMatchLinks } from "./common.js";
import { mapArt, artLayer } from "../art.js";
import { matchup, plan, winTargets, sessionNow, loadPlaybooks, mapBook } from "../playbook.js";
import { mapSchematic, calloutList } from "../mapviz.js";
import * as gh from "../gh.js";

const RECENT_DAYS = 120;

export function render(ctx) {
  const { el, params } = ctx;
  const base = ctx.all; // every game of the selected player: the screen hides the filters, so it ignores them
  if (!base.length) {
    el.innerHTML = emptyState("No games yet", "Once games are ingested, the in-game screen fills in.", "crosshair");
    return;
  }
  const map = params.bmap || "", fam = params.bfam || "";
  if (!map || !fam) return picker(ctx, base, map, fam);
  screen(ctx, base, map, fam);
}

/** Called by the app when you navigate away: let the screen sleep again. */
export function leave() {
  releaseWake();
  clearTimeout(afterTimer);
  unsub?.();
  unsub = null;
}

// ---------- picker ----------
function combos(base) {
  const now = Date.now() / 1000, since = now - RECENT_DAYS * 86400;
  const m = new Map();
  for (const r of base) {
    const key = `${r.mapName}|${r.famName}`;
    const c = m.get(key) || { map: r.mapName, fam: r.famName, n: 0, recent: 0, w: 0, d: 0, last: 0 };
    c.n++;
    if (r.t >= since) c.recent++;
    if (r.win) c.w++;
    if (r.decided) c.d++;
    c.last = Math.max(c.last, r.t);
    m.set(key, c);
  }
  return [...m.values()].sort((a, b) => b.recent - a.recent || b.n - a.n);
}

function picker(ctx, base, map, fam) {
  const { el } = ctx;
  const last = base[base.length - 1];
  const all = combos(base);
  const usual = all.filter((c) => c.n >= 3).slice(0, innerWidth < 760 ? 12 : 18);
  const overall = agg(base).wr ?? 0.5;
  const sc = scales();
  const dot = (c) => (c.d ? `<span class="dotwr" style="background:${sc.diverging(Math.max(-1, Math.min(1, ((c.w + 4 * overall) / (c.d + 4) - overall) / 0.15)))}"></span>` : "");
  const tile = (c) => {
    const art = mapArt(c.map, "thumb");
    return `<button class="tile ig-combo${art ? " with-art" : ""}" type="button" data-go="${esc(c.map)}|${esc(c.fam)}">${artLayer(art, "scrim-bottom")}<span class="t-body"><span class="t-name">${esc(c.map)}</span><span class="t-mode">${esc(c.fam)}</span><span class="t-meta">${dot(c)}${c.d ? fmt.pct(c.w / c.d) : "–"} · ${c.n} games</span></span></button>`;
  };
  const maps = [...new Set(all.map((c) => c.map))];
  const fams = [...new Set(all.filter((c) => !map || c.map === map).map((c) => c.fam))];
  el.innerHTML = `
  <div class="page-head"><div><h1>In-game</h1><p>Loading into a match? Pick it here. You get one screen to play from: what your wins look like on this map, your game plan, callouts and objectives, and respawn timers. Leave it open on your phone or a second monitor.</p></div></div>
  ${last ? `<button class="ig-same" type="button" data-go="${esc(last.mapName)}|${esc(last.famName)}">${artLayer(mapArt(last.mapName), "fade-right")}<span class="eyebrow">Same as your last game</span><span class="ig-same-name">${esc(last.mapName)} · ${esc(last.famName)}</span><span class="note">${esc(fmt.dateTime(last.t))}</span></button>` : ""}
  <section class="mt"><div class="eyebrow" style="margin-bottom:8px">Your usual matchups <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">most played in the last ${RECENT_DAYS} days first</span></div>
    <div class="tiles ig-combos">${usual.map(tile).join("")}</div></section>
  <details class="card mt" ${map && !fam ? "open" : ""}><summary class="ig-more"><span><b>Something else</b> <span class="note">any map and mode</span></span><span class="btn">Choose</span></summary>
    <div class="picker mt">
      <div class="picker-row"><div class="eyebrow">Map</div><div class="chips">${maps.map((m) => `<button class="chip" type="button" data-map="${esc(m)}" aria-pressed="${m === map}">${esc(m)}</button>`).join("")}</div></div>
      <div class="picker-row"><div class="eyebrow">Mode${map ? ` <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">played on ${esc(map)}</span>` : ""}</div><div class="chips">${fams.map((f) => `<button class="chip" type="button" data-fam="${esc(f)}" aria-pressed="${f === fam}">${esc(f)}</button>`).join("")}</div></div>
    </div>
  </details>`;
  el.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => { const [m, f] = b.dataset.go.split("|"); ctx.go("ingame", { bmap: m, bfam: f }); }));
  el.querySelectorAll("[data-map]").forEach((b) => b.addEventListener("click", () => ctx.go("ingame", { bmap: b.dataset.map === map ? "" : b.dataset.map, bfam: "" })));
  el.querySelectorAll("[data-fam]").forEach((b) => b.addEventListener("click", () => ctx.go("ingame", { bmap: map || all.find((c) => c.fam === b.dataset.fam)?.map || "", bfam: b.dataset.fam })));
  releaseWake();
  clearTimeout(afterTimer);
  unsub?.();
  unsub = null;
  try { sessionStorage.removeItem("debrief.igPick"); } catch { /* storage blocked */ } // the next pick starts a new match clock
}

// ---------- the screen ----------
function screen(ctx, base, map, fam) {
  const { el } = ctx;
  const m = matchup(base, map, fam);
  const { A, verdict: v } = m;
  const targets = winTargets(m);
  const items = plan(m, base, base).slice(0, 4);
  const sess = sessionNow(base);
  const tone = v.tone === "good" ? "good" : v.tone === "bad" ? "bad" : "even";
  const last = base[base.length - 1];
  const justPlayed = last && Date.now() / 1000 - (last.t + (last.dur || 0)) < 40 * 60;
  const lastHere = justPlayed && last.mapName === map && last.famName === fam;

  el.innerHTML = `
  <div class="ig" data-tone="${tone}">
    <header class="ig-head">${artLayer(mapArt(map), "fade-right")}
      <a class="btn ig-back" href="#/ingame" aria-label="Pick another match">${icon("chev", "flip")}Change</a>
      <div class="ig-title"><div class="eyebrow">${esc(v.label)}</div><h1>${esc(map)} <span>·</span> ${esc(fam)}</h1></div>
      <div class="ig-rec">${A.decided ? `<b class="num">${fmt.pct(A.wr)}</b><span>${A.w}–${A.decided - A.w} here · K/D ${fmt.n2(A.kd)}${A.csrN ? ` · ${fmt.signed(A.csrNet, fmt.int)} CSR` : ""}</span>` : "<span>First time here</span>"}</div>
      <div class="ig-tools">
        <button class="icon-btn" type="button" id="ig-wake" aria-pressed="false" title="Keep the screen on">${icon("awake")}</button>
        <button class="icon-btn" type="button" id="ig-full" title="Full screen" aria-label="Full screen">${icon("expand")}</button>
      </div>
    </header>
    <p class="ig-status" id="ig-status">${statusLine()}</p>
    ${justPlayed ? `<div class="ig-last ${last.win ? "good" : last.loss ? "bad" : ""}"><span class="res ${last.out}">${last.out === "D" ? "Q" : last.out}</span><span><b>Last game${lastHere ? " here" : `: ${esc(last.mapName)} · ${esc(last.famName)}`}</b> ${last.teamScore != null ? `${fmt.int(last.teamScore)}–${fmt.int(last.enemyScore)} · ` : ""}${last.k}/${last.d}/${last.a}${last.csrDelta != null ? ` · ${fmt.signed(last.csrDelta, fmt.int)} CSR` : ""}</span><a class="btn" href="#/ingame">Next match</a></div>` : ""}
    <div class="ig-grid">
      <section class="ig-col ig-you">
        <div class="ig-card o-targets"><div class="ig-h">${icon("target")}What your wins look like ${targets ? `<span class="note">${targets.scope === "here" ? "here" : `in ${esc(targets.scope)}`} · ${targets.wins}W ${targets.losses}L</span>` : ""}</div>
          ${targets?.items.length ? `<div class="ig-targets" style="--n:${targets.items.length}">${targets.items.map((t) => `<div class="ig-target"><span class="lbl">${esc(t.label)}</span><b class="num">${t.better < 0 ? "≤" : "≥"}${esc(t.fmt(t.win))}</b><span class="note">wins ${esc(t.fmt(t.win))} · losses ${esc(t.fmt(t.loss))}</span></div>`).join("")}</div>`
            : targets?.flat ? '<p class="note">Your wins and losses here look alike on kills, deaths and damage: what decides these games is teamwork and the objective, not your stat line.</p>'
            : '<p class="note">Not enough wins and losses here yet to set targets.</p>'}
        </div>
        <div class="ig-card o-plan"><div class="ig-h">${icon("brain")}Game plan</div>
          <ol class="ig-plan">${items.map((it) => `<li><b>${esc(it.title)}</b><span>${esc(it.detail)}</span></li>`).join("")}</ol>
        </div>
        ${sess ? `<div class="ig-card ig-session o-session"><div class="ig-h">${icon("clock")}This session</div><div class="ig-sess"><b class="num">${sess.w}–${sess.l}</b><span>game ${sess.next} next · ${sess.streak > 1 ? `${sess.streak} ${sess.streakOut === "W" ? "wins" : "losses"} in a row` : sess.streakOut === "W" ? "won the last one" : "lost the last one"}</span></div>${resultStrip(sess.games, { max: 20 })}</div>` : ""}
        ${A.n ? `<div class="ig-card o-games"><div class="ig-h">${icon("matches")}Your games here</div>${resultStrip(m.here, { max: 20 })}<div class="ig-recent">${m.here.slice(-4).reverse().map((r) => `<button class="link-btn" type="button" data-idx="${r.idx}"><span class="res ${r.out}">${r.out === "D" ? "Q" : r.out}</span> ${esc(fmt.date(r.t))} · ${r.k}/${r.d}/${r.a}</button>`).join("")}</div></div>` : ""}
      </section>
      <section class="ig-col ig-map" id="ig-map"><div class="ig-card o-map"><div class="ig-h">${icon("maps")}${esc(map)}</div><p class="note">Loading map notes…</p></div></section>
      <section class="ig-col ig-mode" id="ig-mode"></section>
    </div>
  </div>`;
  wireMatchLinks(el, ctx);
  wireTools(el);
  checkAfterMatch(ctx, m, map, fam);
  unsub?.();
  unsub = gh.onChange(() => { const st = document.querySelector("#ig-status"); if (st) st.innerHTML = statusLine(); });
  loadPlaybooks().then((books) => { if (el.isConnected) fillBooks(el, books, map, fam); });
}

/** Whether results will show up here by themselves (the app's Updates button is hidden in this mode). */
function statusLine() {
  if (!gh.connected()) return `${icon("clock")} Not connected to GitHub, so your results won't load here by themselves. Connect from the Updates button on the main screen.`;
  if (!gh.pref("autoCheck", true)) return `${icon("clock")} Automatic checks are off (Updates panel), so results only arrive on GitHub's schedule.`;
  const run = gh.runningJobs()[0];
  if (run) return `<span class="spin" aria-hidden="true"></span> ${run.kind === "sync" ? "Checking Halo for new games" : run.kind === "scout" ? "Scouting" : "Loading history"}: ${esc(run.stage || "")}`;
  return `${icon("check")} Your result loads here after the match.`;
}
let unsub = null;

// ---------- check for the result right after the match should end ----------
// Picking a match starts a clock: once your typical game on this map and mode would be over, the site
// checks Halo for it (the usual auto-check rules apply: connected, switched on, nothing ran recently).
let afterTimer = null;
function checkAfterMatch(ctx, m, map, fam) {
  const key = `${map}|${fam}`;
  let pick = null;
  try { pick = JSON.parse(sessionStorage.getItem("debrief.igPick") || "null"); } catch { /* storage blocked */ }
  if (!pick || pick.key !== key || Date.now() - pick.at > 45 * 60e3) {
    pick = { key, at: Date.now() };
    try { sessionStorage.setItem("debrief.igPick", JSON.stringify(pick)); } catch { /* storage blocked */ }
  }
  clearTimeout(afterTimer);
  const latest = ctx.all[ctx.all.length - 1];
  if (latest && latest.t * 1000 >= pick.at - 3 * 60e3) return; // the match you picked has landed: nothing left to wait for
  const durs = (m.here.length >= 5 ? m.here : m.famRows).map((r) => r.dur).filter((d) => d > 60).sort((a, b) => a - b);
  const typical = durs.length ? durs[durs.length >> 1] : 12 * 60;
  const ends = pick.at + typical * 1000;
  // A minute after a typical game ends (post-game screens), then once more 5 minutes later in case it
  // ran long. Each only counts checks made after its own estimate of the end.
  const plan = [{ at: ends + 60e3, after: ends }, { at: ends + 6 * 60e3, after: ends + 5 * 60e3 }].filter((x) => x.at > Date.now());
  const next = () => {
    const x = plan.shift();
    if (x) afterTimer = setTimeout(() => { ctx.checkNow?.({ after: x.after }); next(); }, x.at - Date.now());
  };
  next();
}

// ---------- map and mode playbooks ----------
const famKey = (f) => String(f || "").toLowerCase();
const forMode = (list, fam) => (list || []).filter((x) => !x.modes?.length || x.modes.some((m) => famKey(m) === famKey(fam) || famKey(fam).includes(famKey(m)) || famKey(m) === "all"));

function fillBooks(el, books, map, fam) {
  if (timerFor !== `${map}|${fam}`) { timerState.clear(); timerFor = `${map}|${fam}`; }
  const book = mapBook(books, map);
  const mode = books.modes?.[fam] || null;
  const mapEl = el.querySelector("#ig-map"), modeEl = el.querySelector("#ig-mode");
  // map: schematic (or callout list), spawns, objectives for this mode, tips
  if (book) {
    const objs = (book.objectives || []).filter((o) => famKey(o.mode) === famKey(fam) || famKey(fam).includes(famKey(o.mode)));
    const spawns = forMode(book.spawns, fam);
    const tips = forMode(book.tips, fam);
    const drawn = book.layoutConfidence && book.layoutConfidence !== "low";
    mapEl.innerHTML = `
      <div class="ig-card o-map"><div class="ig-h">${icon("maps")}${esc(map)} <span class="note">${drawn ? "schematic, not to scale" : "callouts"}</span></div>
        ${book.summary ? `<p class="ig-sum">${esc(book.summary)}</p>` : ""}
        ${drawn ? mapSchematic(book, { fam, objectives: objs, spawns }) : calloutList(book, { objectives: objs, spawns })}
      </div>
      ${objs.length ? `<div class="ig-card o-obj"><div class="ig-h">${icon("flag")}${esc(fam)} objectives</div><ul class="ig-list">${objs.sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).map((o) => `<li><b>${esc(o.label)}</b><span>${esc(o.zone)}${o.notes ? ` · ${esc(o.notes)}` : ""}</span></li>`).join("")}</ul></div>` : ""}
      ${tips.length ? `<div class="ig-card o-tips"><div class="ig-h">${icon("tip")}On ${esc(map)}</div><ul class="ig-list ig-tips">${tips.slice(0, 6).map((t) => `<li><span>${esc(t.text)}</span></li>`).join("")}</ul></div>` : ""}`;
  } else {
    mapEl.innerHTML = `<div class="ig-card o-map"><div class="ig-h">${icon("maps")}${esc(map)}</div><p class="note">No map notes for ${esc(map)} yet. Your numbers and the ${esc(fam)} playbook still apply.</p></div>`;
  }
  // timers: this map's spawns with a respawn time, then the sandbox defaults
  const timers = [];
  for (const s of forMode(book?.spawns, fam)) if (s.respawnSec) timers.push({ id: `${s.item}@${s.zone}`, label: s.item, where: s.zone, secs: s.respawnSec, kind: s.kind });
  for (const g of books.general?.respawns || []) if (g.seconds && !timers.some((t) => t.label.toLowerCase() === g.item.toLowerCase())) timers.push({ id: g.item, label: g.item, where: g.notes || "", secs: g.seconds, kind: "power-up" });
  // mode playbook
  modeEl.innerHTML = `
    ${timers.length ? `<div class="ig-card o-timers"><div class="ig-h">${icon("hourglass")}Timers <span class="note">tap when it's taken</span></div><div class="ig-timers" id="ig-timers">${timers.map(timerHtml).join("")}</div></div>` : ""}
    ${mode ? `<div class="ig-card o-mode"><div class="ig-h">${icon("trophy")}${esc(fam)}</div>
      ${mode.rankedRules ? `<p class="ig-rules">${esc(mode.rankedRules)}</p>` : ""}
      ${mode.principles?.length ? `<ol class="ig-plan">${mode.principles.slice(0, 5).map((p) => `<li><b>${esc(p.title)}</b><span>${esc(p.text)}</span></li>`).join("")}</ol>` : ""}
      ${mode.soloQ?.length ? `<div class="ig-h sub">${icon("people")}Solo queue</div><ul class="ig-list ig-tips">${mode.soloQ.slice(0, 3).map((t) => `<li><span>${esc(t)}</span></li>`).join("")}</ul>` : ""}
    </div>` : `<div class="ig-card o-mode"><div class="ig-h">${icon("trophy")}${esc(fam)}</div><p class="note">No playbook for ${esc(fam)} yet.</p></div>`}`;
  wireTimers(modeEl);
}

// ---------- timers ----------
const timerState = new Map(); // id -> {end, total, warned}; cleared when the matchup changes
let timerFor = "";
let tickHandle = null;
let audio = null;
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, "0")}`;
function timerHtml(t) {
  return `<button class="ig-timer" type="button" data-timer="${esc(t.id)}" data-secs="${t.secs}" data-kind="${esc(t.kind || "")}"><span class="tl">${esc(t.label)}</span><span class="tw">${esc(t.where || "")}</span><b class="tc num">${fmtClock(t.secs)}</b><i class="tbar"></i></button>`;
}
function wireTimers(root) {
  root.querySelectorAll("[data-timer]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.timer, secs = +b.dataset.secs;
    const cur = timerState.get(id);
    if (cur && Date.now() - cur.started < 1500) { timerState.delete(id); paint(); return; } // a quick second tap cancels
    timerState.set(id, { end: Date.now() + secs * 1000, total: secs, started: Date.now(), warned: false, done: false });
    paint();
    if (!tickHandle) tickHandle = setInterval(paint, 250);
  }));
  paint();
}
function beep(freq = 880, ms = 140) {
  try {
    audio = audio || new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq; g.gain.value = 0.08;
    o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + ms / 1000);
  } catch { /* no audio */ }
}
function paint() {
  let running = false;
  for (const b of document.querySelectorAll("[data-timer]")) {
    const st = timerState.get(b.dataset.timer), total = +b.dataset.secs;
    const c = b.querySelector(".tc"), bar = b.querySelector(".tbar");
    if (!st) { b.classList.remove("on", "soon", "up"); c.textContent = fmtClock(total); bar.style.transform = "scaleX(0)"; continue; }
    const left = (st.end - Date.now()) / 1000;
    if (left <= -15) { timerState.delete(b.dataset.timer); b.classList.remove("on", "soon", "up"); c.textContent = fmtClock(total); bar.style.transform = "scaleX(0)"; continue; }
    running = true;
    b.classList.add("on");
    b.classList.toggle("soon", left > 0 && left <= 10);
    b.classList.toggle("up", left <= 0);
    c.textContent = left > 0 ? fmtClock(Math.ceil(left)) : "UP";
    bar.style.transform = `scaleX(${Math.max(0, Math.min(1, left / st.total))})`;
    if (left <= 10 && left > 0 && !st.warned) { st.warned = true; navigator.vibrate?.(60); beep(660); }
    if (left <= 0 && !st.done) { st.done = true; navigator.vibrate?.([90, 60, 90]); beep(990, 220); }
  }
  if (!running && tickHandle) { clearInterval(tickHandle); tickHandle = null; }
}

// ---------- screen tools: keep awake, full screen ----------
let wake = null;
let wantWake = true;
let asking = null;
function requestWake() {
  if (!("wakeLock" in navigator) || !wantWake || document.visibilityState !== "visible") return Promise.resolve(false);
  if (wake) return Promise.resolve(true);
  asking ||= navigator.wakeLock.request("screen").then((lock) => {
    if (!document.querySelector(".ig-head") || !wantWake) { lock.release().catch(() => {}); return false; } // left meanwhile
    wake = lock;
    lock.addEventListener?.("release", () => { if (wake === lock) wake = null; syncWakeBtn(); });
    syncWakeBtn();
    return true;
  }, () => false).finally(() => { asking = null; });
  return asking;
}
function releaseWake() { try { wake?.release(); } catch { /* already gone */ } wake = null; }
function syncWakeBtn() {
  const b = document.querySelector("#ig-wake");
  if (!b) return;
  b.setAttribute("aria-pressed", String(!!wake));
  b.title = wake ? "Screen stays on (tap to allow sleep)" : "wakeLock" in navigator ? "Keep the screen on" : "This browser can't keep the screen on";
  b.setAttribute("aria-label", b.title);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && document.querySelector(".ig") && !wake) requestWake(); });
function wireTools(el) {
  const wb = el.querySelector("#ig-wake");
  if (!("wakeLock" in navigator)) wb.disabled = true;
  wb.addEventListener("click", async () => {
    if (wake) { wantWake = false; releaseWake(); syncWakeBtn(); toast("The screen can sleep again"); return; }
    wantWake = true;
    if (await requestWake()) toast("The screen stays on while this is open");
  });
  if (!wake) requestWake(); else syncWakeBtn();
  const fb = el.querySelector("#ig-full");
  if (!document.documentElement.requestFullscreen) fb.hidden = true;
  fb.addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch?.(() => {}));
}
