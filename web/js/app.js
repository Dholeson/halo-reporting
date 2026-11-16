// App shell: routing (hash), global filters, presets & saved views, theme.
import { $, esc, icon, store, debounce, toast, fmt, ago, initials, accountColor, cssVar } from "./util.js";
import { loadData, rowsFor, applyFilters, RANGES, QUEUES, latestVersion } from "./data.js";
import { hideTip } from "./charts.js";
import * as overview from "./views/overview.js";
import * as briefing from "./views/briefing.js";
import * as coach from "./views/coach.js";
import * as maps from "./views/maps.js";
import * as ranked from "./views/ranked.js";
import * as matches from "./views/matches.js";
import * as squad from "./views/squad.js";
import { openMatch, closeMatch } from "./views/drawer.js";
import { initArt } from "./art.js";
import * as gh from "./gh.js";
import { openSearch, openActivity, activityButtonHtml, pendingView, partialBanner, wirePartialBanner, closeModal } from "./views/people.js";

const VIEWS = [
  { id: "overview", label: "Overview", icon: "overview", mod: overview },
  { id: "briefing", label: "Briefing", icon: "briefing", mod: briefing },
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
function setFilter(patch) {
  state.f = { ...state.f, ...patch };
  store.set("filters", state.f);
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
      store.set("filters", state.f);
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
    list.push({ name: name.slice(0, 60), view: state.view, f: { ...state.f }, params: { ...state.params, match: undefined } });
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
  const isBrief = view === "briefing";
  const who = f.who === "me" ? null : db.players.find((p) => p.xuid === f.who);
  const scoutJob = scouting ? gh.jobFor([f.who.slice(6)]) : null;
  const whoName = scouting ? scoutJob?.players[0]?.label || f.who.slice(6) : who ? who.gamertag : db.me.length > 1 ? "Me" : db.me[0]?.gamertag || "Me";
  const whoSub = scouting ? "scouting…" : who ? (who.me ? "one of your accounts" : "scouted player") : db.me.length > 1 ? `${db.me.length} accounts merged` : "your account";
  const meIdx = who ? db.me.indexOf(who) : -1;
  const avColor = who ? (meIdx >= 0 ? accountColor(meIdx) : cssVar("--tie")) : null;
  const nonDefault = F_KEYS.some((k) => k !== "who" && f[k] !== DEFAULT_F[k]);

  $("#filterbar").innerHTML = `<div class="filters">
    <button class="who" id="who-btn" type="button" title="Switch player or search" aria-haspopup="dialog">
      <span class="avatar" style="${avColor ? `--c1:${avColor};--c2:${avColor}` : "--c1:var(--s1);--c2:var(--accent)"}">${scouting ? '<span class="spin" style="width:14px;height:14px;border-width:2px"></span>' : esc(initials(whoName))}</span>
      <span style="text-align:left"><span class="who-name">${esc(whoName)}</span><br><span class="who-sub">${esc(whoSub)}</span></span>
      ${icon("search", "chev")}
    </button>
    <span class="fsep"></span>
    ${isBrief ? "" : `<div class="seg" role="group" aria-label="Time range">${RANGES.map((r) => `<button type="button" data-range="${r.id}" aria-pressed="${f.range === r.id}">${esc(r.label)}</button>`).join("")}</div>`}
    <select class="select ${f.queue !== "all" ? "active" : ""}" id="f-queue" aria-label="Queue">${QUEUES.map((q) => `<option value="${q.id}" ${f.queue === q.id ? "selected" : ""}>${esc(q.label)}</option>`).join("")}</select>
    ${isBrief ? '<span class="note" style="white-space:nowrap">Briefings use your full history</span>' : `
    <select class="select ${f.fam ? "active" : ""}" id="f-fam" aria-label="Mode"><option value="">All modes</option>${count("famName").map(([n, c]) => `<option value="${esc(n)}" ${f.fam === n ? "selected" : ""}>${esc(n)} (${c})</option>`).join("")}</select>
    <select class="select ${f.map ? "active" : ""}" id="f-map" aria-label="Map"><option value="">All maps</option>${count("mapName").map(([n, c]) => `<option value="${esc(n)}" ${f.map === n ? "selected" : ""}>${esc(n)} (${c})</option>`).join("")}</select>`}
    <span class="fsep"></span>
    <button class="btn" type="button" id="views-btn" aria-haspopup="true">${icon("bookmark")}Views</button>
    ${nonDefault ? `<button class="btn ghost" type="button" id="reset">${icon("reset")}Reset</button>` : ""}
  </div>`;

  $("#who-btn").addEventListener("click", (e) => (document.querySelector("#people-pop") ? document.querySelector("#people-pop").remove() : openSearch(lastCtx, e.currentTarget)));
  $("#f-queue").addEventListener("change", (e) => setFilter({ queue: e.target.value }));
  $("#f-fam")?.addEventListener("change", (e) => setFilter({ fam: e.target.value }));
  $("#f-map")?.addEventListener("change", (e) => setFilter({ map: e.target.value }));
  document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => setFilter({ range: b.dataset.range })));
  $("#reset")?.addEventListener("click", () => setFilter({ range: "all", queue: "all", fam: "", map: "" }));
  $("#views-btn").addEventListener("click", (e) => (document.querySelector("#views-pop") ? closeMenus() : openMenu(e.currentTarget)));
}

function renderFooter() {
  const repo = location.hostname.endsWith("github.io") ? `https://github.com/${location.hostname.split(".")[0]}/${location.pathname.split("/").filter(Boolean)[0] || ""}` : null;
  $("#footer").innerHTML = `<span>Data updated ${esc(ago(Date.parse(db.generated) / 1000))} · ${fmt.int(db.rows.length)} player-games · new games arrive within 5–15 min while you play</span>
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
    const key = f.who.slice(6).toLowerCase();
    const hit = db.players.find((p) => p.xuid === key || p.gamertag.toLowerCase() === key);
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
  const ctx = { db, f, params, all, rows, prev, el: $("#view"), go, setFilter, setParam, toast, refreshChrome, meRows: () => rowsFor(db, "me") };
  ctx.openMatch = (r) => openMatch(r, ctx);
  lastCtx = ctx;
  renderTabs();
  renderFilterBar();
  refreshChrome();
  if (scouting) {
    document.title = "Scouting · Debrief";
    pendingView(ctx, f.who.slice(6));
    renderFooter();
    return;
  }
  const v = VIEWS.find((x) => x.id === view);
  document.title = `${v.label} · Debrief`;
  document.querySelector('.tab[aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  try {
    v.mod.render(ctx);
    const banner = partialBanner(ctx);
    if (banner) { ctx.el.insertAdjacentHTML("afterbegin", banner); wirePartialBanner(ctx.el, ctx); }
  } catch (e) {
    console.error(e);
    ctx.el.innerHTML = `<div class="card empty"><h3>Something broke on this page</h3><p>${esc(e.message)}</p></div>`;
  }
  renderFooter();
  if (params.match && $("#drawer").hidden) {
    const r = all.find((x) => x.mid === params.match);
    if (r) openMatch(r, ctx);
  }
}

function setFilterSilently(patch) {
  state.f = { ...state.f, ...patch };
  store.set("filters", state.f);
  history.replaceState(null, "", hashFor(state.view, state.f, state.params));
}

function refreshChrome() {
  const slot = $("#activity-slot");
  if (!slot) return;
  slot.innerHTML = activityButtonHtml();
  $("#activity-btn").onclick = () => openActivity(lastCtx);
}

/** Reload data in place (after an update finishes or when newer data is live). */
async function reload() {
  const before = db.rows.length;
  db = await loadData();
  initArt(db.art);
  $("#fresh").hidden = true;
  render();
  return db.rows.length - before;
}

function watchFreshness() {
  // An open tab (or your phone coming back to it) notices new games without a manual refresh.
  const check = async () => {
    if (document.visibilityState !== "visible" || gh.activeJobs().length) return;
    const v = await latestVersion();
    if (!v || v.generated === db.generated) return;
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
    if (state.f.who.startsWith("scout:")) render();
  });
  gh.onNewData(async (job) => {
    const added = await reload();
    if (job.kind === "scout") {
      const keys = job.players.map((p) => String(p.key).toLowerCase());
      const hit = db.players.find((p) => keys.includes(p.xuid) || keys.includes(p.gamertag.toLowerCase()));
      if (hit && state.f.who.startsWith("scout:")) setFilter({ who: hit.xuid });
      toast(hit ? `${hit.gamertag}'s dossier is ready` : "Scouting finished, but that player wasn't found (private history or typo?)");
    } else toast(added > 0 ? `Updated: ${added} new game${added === 1 ? "" : "s"}` : "Up to date: no new games");
  });
  gh.resume();
  watchFreshness();
  addEventListener("hashchange", () => {
    const prevView = state.view;
    state = parseHash();
    store.set("filters", state.f);
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
