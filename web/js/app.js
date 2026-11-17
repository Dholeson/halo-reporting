// App shell: routing (hash), global filters, presets & saved views, theme.
import { $, esc, icon, store, debounce, toast, fmt, ago, initials, accountColor, cssVar } from "./util.js";
import { loadData, rowsFor, applyFilters, RANGES, QUEUES, latestVersion } from "./data.js";
import { hideTip } from "./charts.js";
import * as overview from "./views/overview.js";
import * as briefing from "./views/briefing.js";
import * as ingame from "./views/ingame.js";
import * as coach from "./views/coach.js";
import * as maps from "./views/maps.js";
import * as ranked from "./views/ranked.js";
import * as matches from "./views/matches.js";
import * as squad from "./views/squad.js";
import { openMatch, closeMatch } from "./views/drawer.js";
import { initArt } from "./art.js";
import * as gh from "./gh.js";
import { openSearch, openActivity, activityButtonHtml, pendingView, partialBanner, wirePartialBanner, closeModal } from "./views/people.js";
let reloading = false;
let reloadFailed = false;

const VIEWS = [
  { id: "overview", label: "Overview", icon: "overview", mod: overview },
  { id: "briefing", label: "Briefing", icon: "briefing", mod: briefing },
  { id: "ingame", label: "In-game", icon: "crosshair", mod: ingame },
  { id: "coach", label: "Coach", icon: "coach", mod: coach },
  { id: "maps", label: "Maps & Modes", icon: "maps", mod: maps },
  { id: "ranked", label: "Ranked", icon: "ranked", mod: ranked },
  { id: "matches", label: "Matches", icon: "matches", mod: matches },
  { id: "squad", label: "Squad", icon: "squad", mod: squad },
];
const DEFAULT_F = { who: "me", range: "all", queue: "all", fam: "", map: "" };
const F_KEYS = Object.keys(DEFAULT_F);

let db;
let state = { view: "overview", f: { ...DEFAULT_F }, params: {} };
let lastCtx = null;
let lastWidth = innerWidth;

// ---------- routing ----------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = h.split("?");
  const view = VIEWS.find((v) => v.id === path)?.id || "overview";
  const sp = new URLSearchParams(query);
  const f = { ...DEFAULT_F, ...store.get("filters", {}) };
  if (String(f.who).startsWith("scout:")) f.who = "me"; // only a URL may point at a scouting page
  for (const k of F_KEYS) if (sp.has(k)) f[k] = sp.get(k);
  const params = {};
  for (const [k, v] of sp) if (!F_KEYS.includes(k)) params[k] = v;
  return { view, f, params };
}
function hashFor(view, f, params = {}) {
  const sp = new URLSearchParams();
  for (const k of F_KEYS) if (f[k] !== DEFAULT_F[k]) sp.set(k, f[k]);
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const q = sp.toString();
  return `#/${view}${q ? `?${q}` : ""}`;
}
function go(view, params = {}) {
  const next = hashFor(view, state.f, params);
  if (next === location.hash) render();
  else location.hash = next;
  scrollTo({ top: 0 });
}
const persistable = (f) => {
  if (!f.who.startsWith("scout:")) return f;
  const prev = store.get("filters", {}).who;
  return { ...f, who: prev && !String(prev).startsWith("scout:") ? prev : "me" };
};
/** Which tracked player a typed key means: XUID, exact gamertag, or the alias the ingest recorded for
 *  it (e.g. "Name#1234", which Halo's profile returns as just "Name"). Exact matches only: stripping a
 *  suffix could land on a different player who shares the base name. */
function resolveKey(key) {
  const k = gh.normKey(key);
  const x = db.aliases?.[k] || k;
  return db.players.find((p) => p.xuid === x || p.gamertag.toLowerCase() === k) || null;
}
const olderThan = (iso) => !!iso && Date.parse(db.generated) < Date.parse(iso);
/** What the identity button should say while a scouting placeholder is showing. */
function scoutState(key) {
  const job = gh.jobFor([key]);
  if (!job) return { spin: false, sub: "not tracked" };
  if (gh.pausedJobs().some((x) => x.id === job.id)) return { spin: false, sub: "paused" };
  if (gh.isActive(job)) return { spin: true, sub: "scouting…" };
  if (job.state === "failed") return { spin: false, sub: "scout failed" };
  if (job.live === false && olderThan(job.liveAfter || job.completedAt)) return { spin: false, sub: "saved, publishing" };
  if (reloading) return { spin: true, sub: "loading…" };
  if (olderThan(job.version)) return reloadFailed ? { spin: false, sub: "couldn't load" } : { spin: true, sub: "loading…" };
  return { spin: false, sub: "not found" };
}
function setFilter(patch) {
  state.f = { ...state.f, ...patch };
  store.set("filters", persistable(state.f));
  history.replaceState(null, "", hashFor(state.view, state.f, state.params));
  render();
}
function setParam(k, v) {
  state.params = { ...state.params, [k]: v };
  if (!v) delete state.params[k];
  history.replaceState(null, "", hashFor(state.view, state.f, state.params));
}

// ---------- presets ----------
function presets() {
  const all = rowsFor(db, state.f.who);
  const famCount = new Map();
  for (const r of all) if (r.ranked) famCount.set(r.famName, (famCount.get(r.famName) || 0) + 1);
  const topFams = [...famCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n]) => n);
  return [
    { name: "Last session", sub: "Every game from your latest sitting", f: { range: "session", queue: "all", fam: "", map: "" } },
    { name: "Ranked · last 30 days", sub: "Your current ranked form", f: { range: "30d", queue: "ranked", fam: "", map: "" } },
    { name: "This ranked season", sub: "Ranked games in the current CSR season", f: { range: "season", queue: "ranked", fam: "", map: "" } },
    ...topFams.map((fam) => ({ name: `Ranked ${fam}`, sub: "All-time, one mode: the sharpest coaching", f: { range: "all", queue: "ranked", fam, map: "" } })),
    { name: "Social & events", sub: "Everything outside ranked", f: { range: "all", queue: "social", fam: "", map: "" } },
    { name: "Career", sub: "Every game, all time", f: { range: "all", queue: "all", fam: "", map: "" } },
  ];
}

function openMenu(btn) {
  closeMenus();
  const saved = store.get("views", []);
  const pop = document.createElement("div");
  pop.className = "menu-pop";
  pop.id = "views-pop";
  pop.innerHTML = `<div class="mh">Presets</div>
    ${presets().map((p, i) => `<button class="mi" type="button" data-preset="${i}"><span><span>${esc(p.name)}</span><small>${esc(p.sub)}</small></span></button>`).join("")}
    <hr><div class="mh">Your saved views</div>
    ${saved.length ? saved.map((s, i) => `<div class="mi" role="button" tabindex="0" data-saved="${i}"><span><span>${esc(s.name)}</span><small>${esc(VIEWS.find((v) => v.id === s.view)?.label || "")}</small></span><button class="x" type="button" data-del="${i}" aria-label="Delete ${esc(s.name)}">✕</button></div>`).join("") : '<div class="mi" style="cursor:default"><small>Nothing saved yet</small></div>'}
    <hr>
    <button class="mi" type="button" id="save-view">${icon("bookmark")}<span>Save current view…</span></button>
    <button class="mi" type="button" id="copy-link">${icon("link")}<span>Copy link to this view</span></button>`;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  const ps = presets();
  pop.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { closeMenus(); setFilter(ps[+b.dataset.preset].f); toast(`Applied “${ps[+b.dataset.preset].name}”`); }));
  pop.querySelectorAll("[data-saved]").forEach((b) => {
    const apply = (e) => {
      if (e.target.closest("[data-del]")) return;
      const s = saved[+b.dataset.saved];
      closeMenus();
      state.f = { ...state.f, ...s.f };
      if (state.f.who.startsWith("scout:")) state.f.who = "me";
      store.set("filters", persistable(state.f));
      location.hash = hashFor(s.view, state.f, s.params || {});
    };
    b.addEventListener("click", apply);
    b.addEventListener("keydown", (e) => e.key === "Enter" && apply(e));
  });
  pop.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const list = store.get("views", []);
    list.splice(+b.dataset.del, 1);
    store.set("views", list);
    openMenu(btn);
  }));
  pop.querySelector("#save-view").addEventListener("click", () => {
    const name = prompt("Name this view", defaultViewName());
    if (!name) return;
    const list = store.get("views", []);
    list.push({ name: name.slice(0, 60), view: state.view, f: persistable({ ...state.f }), params: { ...state.params, match: undefined } });
    store.set("views", list);
    closeMenus();
    toast("View saved on this device");
  });
  pop.querySelector("#copy-link").addEventListener("click", async () => {
    closeMenus();
    try { await navigator.clipboard.writeText(location.href); toast("Link copied"); } catch { toast("Couldn't copy. Use the address bar."); }
  });
  setTimeout(() => document.addEventListener("pointerdown", outside), 0);
}
function outside(e) { if (!e.target.closest("#views-pop") && !e.target.closest("#views-btn")) closeMenus(); }
function closeMenus() {
  document.querySelector("#views-pop")?.remove();
  document.removeEventListener("pointerdown", outside);
}
function defaultViewName() {
  const { f } = state;
  return [VIEWS.find((v) => v.id === state.view)?.label, f.queue !== "all" ? f.queue : "", f.fam, f.map, RANGES.find((r) => r.id === f.range)?.label].filter(Boolean).join(" · ");
}

// ---------- chrome ----------
function renderTabs() {
  const q = hashFor("x", state.f).slice(3);
  $("#tabs").innerHTML = VIEWS.map((v) => `<a class="tab" href="#/${v.id}${q}" ${v.id === state.view ? 'aria-current="page"' : ""}>${icon(v.icon)}<span>${esc(v.label)}</span></a>`).join("");
}

function renderFilterBar() {
  const { f, view } = state;
  const scouting = f.who.startsWith("scout:");
  const all = scouting ? [] : rowsFor(db, f.who);
  const count = (key) => {
    const m = new Map();
    for (const r of all) m.set(r[key], (m.get(r[key]) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const isBrief = view === "briefing" || view === "ingame";
  const who = f.who === "me" ? null : db.players.find((p) => p.xuid === f.who);
  const scoutJob = scouting ? gh.jobFor([f.who.slice(6)]) : null;
  const ss = scouting ? scoutState(f.who.slice(6)) : null;
  const scoutLive = !!ss?.spin;
  const whoName = scouting ? scoutJob?.players.find((p) => gh.normKey(p.key) === gh.normKey(f.who.slice(6)))?.label || f.who.slice(6) : who ? who.gamertag : db.me.length > 1 ? "Me" : db.me[0]?.gamertag || "Me";
  const whoSub = scouting ? ss.sub : who ? (who.me ? "one of your accounts" : "scouted player") : db.me.length > 1 ? `${db.me.length} accounts merged` : "your account";
  const meIdx = who ? db.me.indexOf(who) : -1;
  const avColor = who ? (meIdx >= 0 ? accountColor(meIdx) : cssVar("--tie")) : null;
  const nonDefault = F_KEYS.some((k) => k !== "who" && f[k] !== DEFAULT_F[k]);

  $("#filterbar").innerHTML = `<div class="filters">
    <button class="who" id="who-btn" type="button" title="Switch player or search" aria-haspopup="dialog" data-sub="${esc(whoSub)}">
      <span class="avatar" style="${avColor ? `--c1:${avColor};--c2:${avColor}` : "--c1:var(--s1);--c2:var(--accent)"}">${scouting && scoutLive ? '<span class="spin" style="width:14px;height:14px;border-width:2px"></span>' : scouting ? icon("alert") : esc(initials(whoName))}</span>
      <span style="text-align:left"><span class="who-name">${esc(whoName)}</span><br><span class="who-sub">${esc(whoSub)}</span></span>
      ${icon("search", "chev")}
    </button>
    <span class="fsep"></span>
    ${isBrief ? "" : `<div class="seg" role="group" aria-label="Time range">${RANGES.map((r) => `<button type="button" data-range="${r.id}" aria-pressed="${f.range === r.id}">${esc(r.label)}</button>`).join("")}</div>`}
    ${view === "ingame" ? "" : `<select class="select ${f.queue !== "all" ? "active" : ""}" id="f-queue" aria-label="Queue">${QUEUES.map((q) => `<option value="${q.id}" ${f.queue === q.id ? "selected" : ""}>${esc(q.label)}</option>`).join("")}</select>`}
    ${isBrief ? `<span class="note" style="white-space:nowrap">${view === "ingame" ? "In-game uses every game you've played" : "Briefings use your full history"}</span>` : `
    <select class="select ${f.fam ? "active" : ""}" id="f-fam" aria-label="Mode"><option value="">All modes</option>${count("famName").map(([n, c]) => `<option value="${esc(n)}" ${f.fam === n ? "selected" : ""}>${esc(n)} (${c})</option>`).join("")}</select>
    <select class="select ${f.map ? "active" : ""}" id="f-map" aria-label="Map"><option value="">All maps</option>${count("mapName").map(([n, c]) => `<option value="${esc(n)}" ${f.map === n ? "selected" : ""}>${esc(n)} (${c})</option>`).join("")}</select>`}
    <span class="fsep"></span>
    <button class="btn" type="button" id="views-btn" aria-haspopup="true">${icon("bookmark")}Views</button>
    ${nonDefault ? `<button class="btn ghost" type="button" id="reset">${icon("reset")}Reset</button>` : ""}
  </div>`;

  $("#who-btn").addEventListener("click", (e) => (document.querySelector("#people-pop") ? document.querySelector("#people-pop").remove() : openSearch(lastCtx, e.currentTarget)));
  $("#f-queue")?.addEventListener("change", (e) => setFilter({ queue: e.target.value }));
  $("#f-fam")?.addEventListener("change", (e) => setFilter({ fam: e.target.value }));
  $("#f-map")?.addEventListener("change", (e) => setFilter({ map: e.target.value }));
  document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => setFilter({ range: b.dataset.range })));
  $("#reset")?.addEventListener("click", () => setFilter({ range: "all", queue: "all", fam: "", map: "" }));
  $("#views-btn").addEventListener("click", (e) => (document.querySelector("#views-pop") ? closeMenus() : openMenu(e.currentTarget)));
}

function renderFooter() {
  const repo = location.hostname.endsWith("github.io") ? `https://github.com/${location.hostname.split(".")[0]}/${location.pathname.split("/").filter(Boolean)[0] || ""}` : null;
  $("#footer").innerHTML = `<span>Data updated ${esc(ago(Date.parse(db.generated) / 1000))} · ${fmt.int(db.rows.length)} player-games · Debrief checks for new games while it's open and connected</span>
    <span><a href="data/player_matches.parquet">Raw data (Parquet)</a>${repo ? ` · <a href="${esc(repo)}">Source</a>` : ""}</span>
    <span style="flex-basis:100%">Halo © Microsoft Corporation. Debrief was created under Microsoft's <a href="https://www.xbox.com/en-US/developers/rules">Game Content Usage Rules</a> using assets from Halo Infinite, and it is not endorsed by or affiliated with Microsoft.</span>`;
}

function themeButton() {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const b = $("#theme-toggle");
  b.innerHTML = icon(dark ? "sun" : "moon");
  b.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  b.onclick = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("debrief.theme", next); } catch { /* storage blocked */ }
    themeButton();
    render();
  };
}

// ---------- render ----------
function render() {
  hideTip();
  closeMenus();
  let { view, f, params } = state;
  // "scout:<gamertag or xuid>" = a player whose first games are still being fetched
  if (f.who.startsWith("scout:")) {
    const hit = resolveKey(f.who.slice(6));
    if (hit) {
      setFilterSilently({ who: hit.xuid });
      f = state.f; // the placeholder is resolved; render the real dossier
    }
  }
  if (!f.who.startsWith("scout:") && f.who !== "me" && !db.players.some((p) => p.xuid === f.who)) f.who = "me";
  if (f.who === "me" && !db.me.length && db.players.length) f.who = db.players[0].xuid;
  const scouting = f.who.startsWith("scout:");
  const all = scouting ? [] : rowsFor(db, f.who);
  const rows = applyFilters(all, f);
  const prev = f.range !== "all" ? applyFilters(all, f, { prev: true }) : null;
  const ctx = { db, f, params, all, rows, prev, el: $("#view"), go, setFilter, setParam, toast, refreshChrome, meRows: () => rowsFor(db, "me"), dbNow: () => db, checkNow: (opts) => autoCheck(opts), reloading: () => reloading, reloadFailed: () => reloadFailed, reload: () => reload() };
  ctx.openMatch = (r) => openMatch(r, ctx);
  lastCtx = ctx;
  const v = VIEWS.find((x) => x.id === view);
  const shown = scouting ? null : v;
  if (lastView && lastView !== shown) lastView.mod.leave?.();
  lastView = shown;
  // The in-game screen, once a match is picked, takes the whole viewport: no tabs, filters or footer.
  document.body.classList.toggle("focus", !scouting && view === "ingame" && !!params.bmap && !!params.bfam);
  renderTabs();
  renderFilterBar();
  refreshChrome();
  if (scouting) {
    document.title = "Scouting · Debrief";
    pendingView(ctx, f.who.slice(6));
    renderFooter();
    return;
  }
  document.title = view === "ingame" && params.bmap ? `${params.bmap}${params.bfam ? ` · ${params.bfam}` : ""} · Debrief` : `${v.label} · Debrief`;
  document.querySelector('.tab[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  try {
    v.mod.render(ctx);
    const banner = view === "ingame" ? "" : partialBanner(ctx);
    if (banner) { ctx.el.insertAdjacentHTML("afterbegin", banner); wirePartialBanner(ctx.el, ctx); }
  } catch (e) {
    console.error(e);
    ctx.el.innerHTML = `<div class="card empty"><h3>Something broke on this page</h3><p>${esc(e.message)}</p></div>`;
  }
  renderFooter();
  if (params.match && $("#drawer").hidden) {
    const r = all.find((x) => x.mid === params.match);
    if (r) drawerReady = openMatch(r, ctx);
  }
}
let drawerReady = null; // resolves once the open match drawer has its lobby
let lastView = null;

function setFilterSilently(patch) {
  state.f = { ...state.f, ...patch };
  store.set("filters", persistable(state.f));
  history.replaceState(null, "", hashFor(state.view, state.f, state.params));
}

function refreshChrome() {
  const slot = $("#activity-slot");
  if (!slot) return;
  slot.innerHTML = activityButtonHtml(db.health);
  $("#activity-btn").onclick = () => openActivity(lastCtx);
}

/** Reload data in place (after an update finishes or when newer data is live). */
async function reload() {
  const before = db.rows.length;
  const drawer = $("#drawer");
  const reopenAt = !drawer.hidden && state.params.match ? drawer.scrollTop : null;
  reloading = true;
  try {
    const next = await loadData();
    db = next;
    reloadFailed = false;
    initArt(db.art);
    $("#fresh").hidden = true;
    // An open match's rows and people indices belong to the old data. Close it but keep it in the URL:
    // render() below reopens it from the new data, in place (no slide-in) and back at the same spot.
    if (reopenAt !== null) {
      drawer.classList.add("quiet");
      closeMatch();
      drawerReady = null;
    }
    return db.rows.length - before;
  } catch (e) {
    reloadFailed = true;
    const el = $("#fresh");
    el.innerHTML = `<span>Couldn't load the new data (${esc(e.message)})</span><button class="btn primary" type="button" id="fresh-go">Try again</button>`;
    el.hidden = false;
    $("#fresh-go").onclick = () => reload();
    return null;
  } finally {
    reloading = false;
    render();
    if (reopenAt !== null) {
      const opened = drawerReady;
      opened?.then(() => { if (!drawer.hidden) drawer.scrollTop = reopenAt; });
      requestAnimationFrame(() => requestAnimationFrame(() => drawer.classList.remove("quiet")));
    }
  }
}

// GitHub's scheduler can run hours late (new schedules sometimes not at all), so an open, connected
// Debrief checks Halo itself whenever nothing else has: when you open it (10 min since the last check),
// and while it stays open, in the background too (every 10 min if your last game ended in the past
// 3 hours, else every 30). A PC player's Debrief tab sits behind the game the whole session.
const OPEN_GAP = 10 * 60e3, IDLE_GAP = 30 * 60e3;
let autoChecking = false;
let askedAt = 0;
function lastGameEnd() {
  const mine = new Set(db.me.map((p) => db.players.indexOf(p)));
  let end = 0;
  for (const r of db.rows) if (mine.has(r.p)) end = Math.max(end, (r.t + (r.dur || 0)) * 1000);
  return end;
}
// `after`: a check right after a match (the in-game screen knows roughly when it ends). Only a check
// made after that moment makes it unnecessary; one from before the match says nothing about it.
async function autoCheck({ periodic = false, after = 0 } = {}) {
  const playing = Date.now() - lastGameEnd() < 3 * 3600e3 || !!document.querySelector(".ig-head"); // the in-game screen is up
  const gap = !periodic || playing ? OPEN_GAP : IDLE_GAP;
  const fresh = (t) => (after ? t >= after : Date.now() - t < gap); // a check at t still covers now
  const idle = () => gh.connected() && gh.pref("autoCheck", true) && !gh.runningJobs().length
    && !fresh(gh.pref("autoCheckAt", 0) || 0); // another tab may have just done it
  if (autoChecking || !idle() || (periodic && Date.now() - askedAt < 3 * 60e3)) return; // ask GitHub at most every 3 min
  autoChecking = true;
  askedAt = Date.now();
  const wasConnected = gh.connected();
  try {
    const last = await gh.lastCheck();
    if ((last && fresh(last)) || !idle()) return; // re-check: things moved while we asked
    gh.setPref("autoCheckAt", Date.now());
    await gh.request("sync", [], { auto: true });
    if (!periodic && document.visibilityState === "visible") toast("Checking Halo for new games…");
  } catch {
    // Offline, or GitHub said no: lastCheck drops a rejected token and the Updates panel says why.
    if (wasConnected && !gh.connected()) { toast("GitHub rejected the saved token, so Debrief can't check for new games. Reconnect in Updates."); refreshChrome(); }
  } finally {
    autoChecking = false;
  }
}

/** A new build with exactly the data on screen (a check that found nothing): only the "updated" time moves. */
function quietBuild(generated) {
  if (generated) db.generated = generated;
  reloadFailed = false; // what's on screen is what's live
  $("#fresh").hidden = true;
  renderFooter();
}

function watchFreshness() {
  // An open tab (or your phone coming back to it) notices new games without a manual refresh.
  const check = async () => {
    if (document.visibilityState !== "visible" || gh.runningJobs().length) return; // that update reloads by itself
    const v = await latestVersion();
    if (!v || v.generated === db.generated) return;
    if (v.digest && v.digest === db.digest) { quietBuild(v.generated); return; } // rebuilt, same data
    const diff = v.games - db.rows.length;
    const el = $("#fresh");
    el.innerHTML = `<span>${diff > 0 ? `${diff} new game${diff === 1 ? "" : "s"} are in` : "Fresh data is in"}</span><button class="btn primary" type="button" id="fresh-go">Refresh</button>`;
    el.hidden = false;
    $("#fresh-go").onclick = () => reload();
  };
  setInterval(check, 60000);
  document.addEventListener("visibilitychange", check);
}

async function boot() {
  themeButton();
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (!document.documentElement.dataset.theme) { themeButton(); render(); } });
  try {
    db = await loadData();
  } catch (e) {
    $("#view").innerHTML = `<div class="card empty"><h3>Couldn't load your data</h3><p>${esc(e.message)}. If this is a fresh setup, run the <b>Ingest &amp; report</b> workflow once.</p></div>`;
    return;
  }
  initArt(db.art);
  if (!db.rows.length) {
    $("#view").innerHTML = `<div class="card empty"><h3>No matches yet</h3><p>Add gamertags with the <b>Ingest &amp; report</b> workflow (gamertags box) and they'll show up here after the run.</p></div>`;
    return;
  }
  state = parseHash();
  gh.onChange(() => {
    refreshChrome();
    if (!lastCtx) return;
    if (state.f.who.startsWith("scout:")) {
      // Only the scouting card and the identity button change; menus and selects stay put.
      const ss = scoutState(state.f.who.slice(6));
      const btn = $("#who-btn");
      if (btn && (btn.dataset.sub !== ss.sub)) renderFilterBar();
      pendingView(lastCtx, state.f.who.slice(6));
      return;
    }
    const old = $("#view .loading-banner");
    if (old) {
      const html = partialBanner(lastCtx);
      if (html) { old.outerHTML = html; wirePartialBanner($("#view"), lastCtx); } else old.remove();
    }
  });
  gh.onNewData(async (job) => {
    if (job.live === false) {
      if (job.auto) return; // nobody's waiting on an automatic check; its games come with the next build
      toast("Saved. The site hasn't published it yet; it'll appear with the next update.");
      render();
      return;
    }
    let added = 0;
    if (job.digest && job.digest === db.digest) quietBuild(job.version); // nothing new: leave the page alone
    else {
      added = await reload();
      if (added === null) return; // the "couldn't load" notice is up; don't claim anything about the data
    }
    if (job.kind === "scout") {
      const found = [...new Set(job.players.map((p) => resolveKey(p.key)).filter(Boolean))];
      const watching = state.f.who.startsWith("scout:") ? resolveKey(state.f.who.slice(6)) : null;
      // Switch only if you're on THIS scout's page, not someone else's.
      const target = watching && found.includes(watching) ? watching : null;
      if (target) setFilter({ who: target.xuid });
      const empty = found.filter((p) => !p.stored);
      if (!found.length) toast("Scouting finished, but that player wasn't found (typo, or private history?)");
      else if (empty.length) toast(`Found ${empty.map((p) => p.gamertag).join(", ")}, but no public matchmaking games`);
      else toast(`${found.map((p) => p.gamertag).join(", ")}: dossier ready`);
    } else if (job.auto) { if (added > 0) toast(`${added} new game${added === 1 ? " is" : "s are"} in`); }
    else toast(added > 0 ? `Updated: ${added} new game${added === 1 ? "" : "s"}` : "Up to date: no new games");
  });
  gh.resume();
  watchFreshness();
  autoCheck();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && autoCheck());
  setInterval(() => autoCheck({ periodic: true }), 60000);
  addEventListener("hashchange", () => {
    const prevView = state.view;
    state = parseHash();
    store.set("filters", persistable(state.f));
    if (!state.params.match) closeMatch();
    render();
    if (prevView !== state.view) $("#view").focus({ preventScroll: true });
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") { document.querySelector("#people-pop")?.remove(); if (closeModal()) return; closeMenus(); closeMatch({ setParam }); }
  });
  addEventListener("resize", debounce(() => {
    if (Math.abs(innerWidth - lastWidth) < 30) return;
    lastWidth = innerWidth;
    render();
  }, 200));
  render();
}

boot();
