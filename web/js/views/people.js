// People: search, person cards, scouting, the activity panel and the
// "still loading" states. Anything that starts an update goes through gh.js.

import { $, esc, fmt, icon, initials, ago, toast, accountColor, cssVar } from "../util.js";
import * as gh from "../gh.js";
import { agg } from "../stats.js";

const VALID_KEY = /^(?:[A-Za-z0-9 ]{1,16}(?:#\d{1,5})?|(?:xuid\()?\d{16}\)?)$/;
const label = (job) => (job.kind === "sync" ? "Sync" : `${job.kind === "full" ? "Full history" : "Scout"}: ${job.players.map((p) => p.label || p.key).join(", ")}`);

// ---------- modal ----------
let current = null; // the open modal: {owner, onClose[], prevScrim}
export function modal(html, { wide = false } = {}) {
  closeModal();
  const m = $("#modal"), scrim = $("#scrim");
  const owner = Symbol("modal");
  current = { owner, onClose: [], prevScrim: scrim.onclick, prevScrimHidden: scrim.hidden };
  m.innerHTML = `<div class="modal-card${wide ? " wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  m.hidden = false;
  scrim.hidden = false;
  const close = () => { if (current?.owner === owner) closeModal(); };
  m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  m.onclick = (e) => { if (e.target === m) close(); };
  scrim.onclick = close;
  setTimeout(() => m.querySelector("input, button")?.focus(), 30);
  return { el: m, close, isOpen: () => current?.owner === owner, onClose: (fn) => current?.owner === owner && current.onClose.push(fn) };
}
export function closeModal() {
  const m = $("#modal");
  if (!m || m.hidden || !current) return false;
  const c = current;
  current = null;
  m.hidden = true;
  m.innerHTML = "";
  const scrim = $("#scrim");
  scrim.onclick = c.prevScrim; // e.g. the match drawer's "click outside to close"
  scrim.hidden = $("#drawer").hidden ? true : c.prevScrimHidden;
  for (const fn of c.onClose) { try { fn(); } catch { /* ignore */ } }
  return true;
}

// ---------- connect ----------
export function openConnect(ctx, { then } = {}) {
  const r = gh.repo();
  const { el, close } = modal(`
    <div class="mc-head"><h2>Connect GitHub</h2><button class="icon-btn" data-close aria-label="Close">${icon("close")}</button></div>
    <p class="text-2">Updates (Sync now, scouting new players, loading full histories) run as GitHub Actions in your repo. To start them from here, Debrief needs a token that can do exactly that and nothing else.</p>
    <ol class="steps">
      <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a></li>
      <li><b>Repository access:</b> Only select repositories → <b>${esc(r ? r.name : "this repo")}</b></li>
      <li><b>Permissions:</b> Repository → <b>Actions: Read and write</b>. Nothing else.</li>
      <li>Generate, copy, and paste it here.</li>
    </ol>
    ${r ? "" : `<label class="field"><span>Repository (owner/name)</span><input id="repo-in" placeholder="owner/halo-reporting" autocomplete="off"></label>`}
    <label class="field"><span>Token</span><input id="tok-in" type="password" placeholder="github_pat_…" autocomplete="off" spellcheck="false"></label>
    <label class="check"><input type="checkbox" id="tok-remember"> <span>Keep me connected on this device</span></label>
    <p class="note">By default the token is forgotten when you close this tab. If you keep it, note that every GitHub Pages site you publish under ${esc(r ? `${r.owner}.github.io` : "your github.io address")} shares this browser storage, so only do it if you don't publish other Pages sites there. Visitors without a token stay read-only.</p>
    <p class="error" id="tok-err" hidden></p>
    <div class="mc-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="tok-go">Connect</button></div>`);
  const go = async () => {
    const tok = el.querySelector("#tok-in").value.trim();
    const repoIn = el.querySelector("#repo-in")?.value.trim();
    const err = el.querySelector("#tok-err");
    if (!tok) return;
    const btn = el.querySelector("#tok-go");
    btn.disabled = true;
    btn.textContent = "Checking…";
    try {
      const override = repoIn && repoIn.includes("/") ? { owner: repoIn.split("/")[0].trim(), name: repoIn.split("/")[1].trim() } : null;
      await gh.connect(tok, { repoOverride: override, remember: el.querySelector("#tok-remember").checked });
      close();
      toast("Connected. Updates are enabled on this device.");
      then?.();
      ctx.refreshChrome();
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message;
      btn.disabled = false;
      btn.textContent = "Connect";
    }
  };
  el.querySelector("#tok-go").addEventListener("click", go);
  el.querySelector("#tok-in").addEventListener("keydown", (e) => e.key === "Enter" && go());
}

/** Run an update, asking to connect first if needed. */
export async function startJob(ctx, kind, players) {
  // Not connected yet: connect first, then carry on with the same request.
  if (!gh.connected()) return new Promise((resolve) => openConnect(ctx, { then: () => resolve(startJob(ctx, kind, players)) }));
  try {
    const job = await gh.request(kind, players);
    toast(kind === "sync" ? "Sync started" : kind === "scout" ? `Scouting ${players.map((p) => p.label || p.key).join(", ")}…` : "Loading the full history…");
    ctx.refreshChrome();
    return job;
  } catch (e) {
    toast(e.message === "not-connected" ? "Connect GitHub first" : `Couldn't start: ${e.message}`);
  }
}

export function scout(ctx, person) {
  const raw = String(person.xuid || person.key).trim();
  const key = /^\d{16}$/.test(gh.normKey(raw)) ? gh.normKey(raw) : raw; // xuid(…) → bare digits; gamertags keep their case
  const job = startJob(ctx, "scout", [{ key, label: person.name || person.label || key }]);
  Promise.resolve(job).then((j) => j && ctx.setFilter({ who: `scout:${key}` }));
}

// ---------- stepper ----------
export function stepper(job, { compact = false } = {}) {
  const labels = gh.STAGE_LABELS;
  const at = job.state === "done" ? labels.length : job.stageIndex ?? 0;
  if (compact) return `<div class="stepper compact" aria-label="${esc(job.stage || "")}">${labels.map((_, i) => `<i class="${i < at ? "done" : i === at ? "now" : ""}"></i>`).join("")}</div>`;
  return `<ol class="stepper">${labels.map((l, i) => `<li class="${i < at ? "done" : i === at && job.state !== "failed" ? "now" : ""}"><span class="dot">${i < at ? icon("check") : ""}</span>${esc(l)}</li>`).join("")}</ol>`;
}

// ---------- activity panel ----------
export function activityButtonHtml() {
  const active = gh.activeJobs();
  const failed = gh.jobs().some((j) => j.state === "failed" && Date.now() - Date.parse(j.updatedAt || j.createdAt) < 3600e3);
  return `<button class="icon-btn activity${active.length ? " busy" : ""}" id="activity-btn" type="button" aria-label="${active.length ? `${active.length} update${active.length === 1 ? "" : "s"} running` : "Updates"}" title="Updates">
    ${active.length ? '<span class="spin" aria-hidden="true"></span>' : icon("reset")}
    ${active.length ? `<span class="count">${active.length}</span>` : failed ? '<span class="count bad">!</span>' : ""}
  </button>`;
}

export function openActivity(ctx) {
  const render = () => {
    const list = [...gh.jobs()].reverse().slice(0, 12);
    const r = gh.repo();
    return `
    <div class="mc-head"><h2>Updates</h2><button class="icon-btn" data-close aria-label="Close">${icon("close")}</button></div>
    <div class="sync-row">
      <div><b>Sync now</b><p class="note">Pulls new games for everyone you track. New games also arrive automatically: every 5 min while you're playing, every 15 min otherwise.</p></div>
      <button class="btn primary" id="sync-now">${icon("reset")}Sync now</button>
    </div>
    ${gh.pausedJobs().length ? `<div class="callout">${icon("clock")} <b>${gh.pausedJobs().length} update${gh.pausedJobs().length === 1 ? " is" : "s are"} paused.</b> They were started in another tab or session; connect here to keep following them.</div>` : ""}
    ${list.length ? `<div class="jobs">${list.map((j) => `
      <div class="job ${esc(j.state)}">
        <div class="job-top"><b>${esc(label(j))}</b><span class="note">${esc(ago(Date.parse(j.createdAt) / 1000))}</span></div>
        ${j.state === "failed" ? `<p class="bad-text">${esc(j.error || "Failed")}</p>` : `<div class="job-stage">${stepper(j, { compact: true })}<span>${esc(j.stage || "")}</span></div>`}
        ${j.url ? `<a class="note" href="${esc(j.url)}" target="_blank" rel="noopener">View run on GitHub</a>` : ""}
      </div>`).join("")}</div>` : '<p class="note">No updates yet.</p>'}
    <div class="mc-foot">
      ${gh.connected() ? `<span class="note">${icon("check")} Connected to ${esc(r.owner)}/${esc(r.name)} ${gh.remembered() ? "on this device" : "in this tab"}</span><button class="link-btn" id="disc">Disconnect</button>` : `<span class="note">Not connected: updates can't be started from this device.</span><button class="link-btn" id="conn">Connect GitHub</button>`}
      ${list.some((j) => !gh.isActive(j)) ? '<button class="link-btn" id="clear">Clear finished</button>' : ""}
    </div>`;
  };
  const m = modal(render());
  const { el, close } = m;
  const redraw = () => { if (!m.isOpen()) return; el.querySelector(".modal-card").innerHTML = render(); wire(); };
  const wire = () => {
    el.querySelector("#sync-now")?.addEventListener("click", () => {
      if (!gh.connected()) { close(); startJob(ctx, "sync", []); return; } // the connect dialog takes over
      startJob(ctx, "sync", []).then(redraw);
    });
    el.querySelector("#disc")?.addEventListener("click", () => { gh.disconnect(); redraw(); ctx.refreshChrome(); });
    el.querySelector("#conn")?.addEventListener("click", () => { close(); openConnect(ctx); });
    el.querySelector("#clear")?.addEventListener("click", () => { gh.clearFinished(); redraw(); });
    el.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  };
  wire();
  m.onClose(gh.onChange(redraw));
}

// ---------- people search ----------
function knownPeople(db) {
  return db.people.filter((p) => p.gt && !db.players.some((x) => x.xuid === p.xuid)).sort((a, b) => b.n - a.n);
}

export function openSearch(ctx, anchor) {
  const { db } = ctx;
  const pop = document.createElement("div");
  pop.className = "menu-pop people-pop";
  pop.id = "people-pop";
  pop.innerHTML = `<input class="search people-q" id="people-q" type="search" placeholder="Search players, or type a gamertag to scout" autocomplete="off" spellcheck="false" aria-label="Search players"><div class="people-list" id="people-list"></div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  const q = pop.querySelector("#people-q"), listEl = pop.querySelector("#people-list");
  const close = () => { pop.remove(); document.removeEventListener("pointerdown", outside); };
  const outside = (e) => { if (!e.target.closest("#people-pop") && !e.target.closest("#who-btn")) close(); };
  setTimeout(() => document.addEventListener("pointerdown", outside), 0);

  const item = (o) => `<button type="button" class="mi person-item" data-act="${esc(o.act)}" data-key="${esc(o.key)}" data-name="${esc(o.name || "")}">
      <span class="avatar" style="width:28px;height:28px;font-size:11px;border-radius:8px;--c1:${o.color || "var(--tie)"};--c2:${o.color || "var(--tie)"}">${o.spinner ? '<span class="spin" style="width:14px;height:14px;border-width:2px"></span>' : esc(initials(o.name || o.key))}</span>
      <span style="min-width:0;flex:1"><span class="pi-name">${esc(o.name || o.key)}</span><small>${esc(o.sub || "")}</small></span>
      ${o.badge ? `<span class="badge ${o.badgeCls || ""}">${esc(o.badge)}</span>` : ""}
    </button>`;

  const draw = () => {
    const query = q.value.trim().toLowerCase();
    const hit = (s) => !query || String(s || "").toLowerCase().includes(query);
    const sections = [];
    const me = [];
    if (db.me.length > 1 && hit("me")) me.push({ act: "who", key: "me", name: "Me", sub: `All ${db.me.length} accounts merged`, color: "var(--s1)" });
    db.me.forEach((p, i) => hit(p.gamertag) && me.push({ act: "who", key: p.xuid, name: p.gamertag, sub: historyLine(p) || "Your account", color: accountColor(i) }));
    if (me.length) sections.push(["You", me]);
    const scouted = db.others.filter((p) => hit(p.gamertag)).map((p) => ({ act: "who", key: p.xuid, name: p.gamertag, sub: historyLine(p) || "Scouted player", badge: partial(p) ? "loading history" : "", color: cssVar("--tie") }));
    if (scouted.length) sections.push(["Scouted players", scouted]);
    const running = gh.activeJobs().filter((j) => j.kind !== "sync").flatMap((j) => j.players.map((p) => ({ j, p }))).filter(({ p }) => hit(p.label) || hit(p.key))
      .map(({ j, p }) => ({ act: "pending", key: p.key, name: p.label || p.key, sub: j.stage || "Scouting…", spinner: true }));
    if (running.length) sections.push(["Scouting now", running]);
    const people = knownPeople(db).filter((p) => hit(p.gt)).slice(0, query ? 12 : 6).map((p) => ({ act: "person", key: p.xuid, name: p.gt, sub: `In ${fmt.int(p.n)} of your games`, badge: "not scouted" }));
    if (people.length) sections.push([query ? "People you've played with" : "People you play with most", people]);
    const raw = q.value.trim();
    const exact = [...db.players.map((p) => p.gamertag), ...knownPeople(db).map((p) => p.gt)].some((n) => n.toLowerCase() === query);
    if (raw && !exact && VALID_KEY.test(raw)) sections.push(["Scout", [{ act: "scout", key: raw, name: `Scout “${raw}”`, sub: "Fetch their match history (first look in about 3 minutes)", badge: gh.connected() ? "" : "needs GitHub", badgeCls: "acc" }]]);
    listEl.innerHTML = sections.map(([h, items]) => `<div class="mh">${esc(h)}</div>${items.map(item).join("")}`).join("") || '<p class="note" style="padding:10px">No one matches. Type a full gamertag to scout them.</p>';
    listEl.querySelectorAll(".person-item").forEach((b) => b.addEventListener("click", () => {
      const { act, key, name } = b.dataset;
      close();
      if (act === "who") ctx.setFilter({ who: key });
      else if (act === "pending") ctx.setFilter({ who: `scout:${key}` });
      else if (act === "person") openPerson(ctx, { xuid: key, name });
      else if (act === "scout") scout(ctx, { key, name: key });
    }));
  };
  q.addEventListener("input", draw);
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter") listEl.querySelector(".person-item")?.click();
    if (e.key === "Escape") close();
  });
  draw();
  q.focus();
}

// ---------- person card ----------
export function openPerson(ctx, { xuid, name }) {
  const { db } = ctx;
  const tracked = db.players.find((p) => p.xuid === xuid);
  const person = db.people.find((p) => p.xuid === xuid);
  const meRows = ctx.meRows();
  const withR = person ? meRows.filter((r) => r.mates.includes(person.i)) : [];
  const vsR = person ? meRows.filter((r) => !r.ffa && r.foes.includes(person.i)) : [];
  const W = agg(withR), V = agg(vsR);
  const display = name || person?.gt || tracked?.gamertag || `Player ··${String(xuid).slice(-6)}`;
  const job = gh.jobFor([xuid, display]);
  const pending = gh.isActive(job);
  const { el, close } = modal(`
    <div class="mc-head"><div style="display:flex;gap:12px;align-items:center"><span class="avatar" style="width:44px;height:44px;--c1:var(--tie);--c2:var(--tie)">${esc(initials(display))}</span><div><h2>${esc(display)}</h2><div class="note">XUID ${esc(xuid)}</div></div></div><button class="icon-btn" data-close aria-label="Close">${icon("close")}</button></div>
    <div class="split">
      <div class="mini-stat"><div class="l">On your team</div><div class="v">${withR.length ? `${W.w}–${W.decided - W.w}` : "–"}</div><div class="note">${withR.length ? `${fmt.int(withR.length)} games · ${fmt.pct(W.wr)}` : person ? "Never" : "Under 2 shared games"}</div></div>
      <div class="mini-stat"><div class="l">Against you (team modes)</div><div class="v">${vsR.length ? `${V.w}–${V.decided - V.w}` : "–"}</div><div class="note">${vsR.length ? `your record in ${fmt.int(vsR.length)} games` : person ? "Never" : "Under 2 shared games"}</div></div>
    </div>
    ${tracked ? `<p class="text-2">${esc(display)} is tracked. ${esc(historyLine(tracked) || "")}</p>` : pending ? `<div class="callout"><b>Scouting in progress.</b> ${esc(job.stage || "")}${stepper(job)}</div>` : `<p class="text-2">Scouting pulls their newest 300 games now (about 3 minutes) and the rest of their history in the background. They'll appear under Scouted players.</p>`}
    <div class="mc-actions">
      ${tracked ? `<button class="btn primary" id="p-open">Open ${esc(display)}'s dossier</button>` : pending ? `<button class="btn" id="p-pending">Follow progress</button>` : `<button class="btn primary" id="p-scout">${icon("people")}Scout ${esc(display)}</button>`}
    </div>`);
  el.querySelector("#p-open")?.addEventListener("click", () => { close(); ctx.setFilter({ who: xuid }); });
  el.querySelector("#p-pending")?.addEventListener("click", () => { close(); ctx.setFilter({ who: `scout:${job.players[0].key}` }); });
  el.querySelector("#p-scout")?.addEventListener("click", () => { close(); scout(ctx, { xuid, name: display }); });
}

/** Make [data-person] elements inside root open person cards. */
export function wirePeople(root, ctx) {
  root.querySelectorAll("[data-person]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const xuid = b.dataset.person;
    const tracked = ctx.db.players.find((p) => p.xuid === xuid);
    if (tracked && b.dataset.direct === "1") ctx.setFilter({ who: xuid });
    else openPerson(ctx, { xuid, name: b.dataset.name });
  }));
}

// ---------- loading states ----------
export function partial(p) {
  return p && p.history && p.stored < p.history * 0.97;
}
export function historyLine(p) {
  if (!p) return "";
  if (p.history) return partial(p) ? `${fmt.int(p.stored)} of ~${fmt.int(p.history)} games loaded` : `${fmt.int(p.stored)} games`;
  return p.stored ? `${fmt.int(p.stored)} games` : "";
}

/** Banner when the profile in view doesn't have its full history yet. */
export function partialBanner(ctx) {
  const { db, f } = ctx;
  const ps = f.who === "me" ? db.me : db.players.filter((p) => p.xuid === f.who);
  const inc = ps.filter(partial);
  if (!inc.length) return "";
  const stored = ps.reduce((s, p) => s + p.stored, 0), total = ps.reduce((s, p) => s + Math.max(p.history || 0, p.stored), 0);
  const job = gh.jobFor(inc.map((p) => p.xuid));
  const running = job && job.kind === "full" && gh.isActive(job);
  return `<div class="loading-banner" role="status">
    <span class="spin" aria-hidden="true"></span>
    <div><b>Showing ${fmt.int(stored)} of ~${fmt.int(total)} games.</b> ${running ? `Loading the rest now: ${esc(job.stage || "")}.` : "Older games load in the background every 6 hours, so trends will sharpen as they arrive."}</div>
    ${running ? stepper(job, { compact: true }) : `<button class="btn" id="load-full" type="button">Load everything now</button>`}
  </div>`;
}
export function wirePartialBanner(root, ctx) {
  root.querySelector("#load-full")?.addEventListener("click", () => {
    const { db, f } = ctx;
    const ps = (f.who === "me" ? db.me : db.players.filter((p) => p.xuid === f.who)).filter(partial);
    startJob(ctx, "full", ps.map((p) => ({ key: p.xuid, label: p.gamertag })));
  });
}

/** The page shown while a scouted player's first games are still being fetched. */
export function pendingView(ctx, key) {
  const job = gh.jobFor([key]);
  const name = job?.players.find((p) => String(p.key).toLowerCase() === key.toLowerCase())?.label || key;
  if (!job) {
    ctx.el.innerHTML = `<div class="card empty">${icon("people")}<h3>${esc(name)} isn't tracked yet</h3><p>Scout them to pull their match history.</p><button class="btn primary" id="pv-scout">Scout ${esc(name)}</button></div>`;
    ctx.el.querySelector("#pv-scout").addEventListener("click", () => scout(ctx, { key, name }));
    return;
  }
  if (job.state === "done" && job.live === false) {
    ctx.el.innerHTML = `<section class="card pending-card"><div class="eyebrow">Scouting</div><h1>${esc(name)}</h1>
      <p class="text-2">Their games were saved, but the site hasn't published them yet. They'll appear with the next update, usually within a few minutes.</p>
      <div class="mc-actions" style="justify-content:flex-start"><button class="btn primary" id="pv-reload">Check again</button></div></section>`;
    ctx.el.querySelector("#pv-reload").addEventListener("click", () => location.reload());
    return;
  }
  if (job.state === "done" && (ctx.reloading() || (job.version && Date.parse(ctx.db.generated) < Date.parse(job.version)))) {
    ctx.el.innerHTML = `<section class="card pending-card"><div class="eyebrow">Scouting</div><h1>${esc(name)}</h1><p class="text-2">Done. Loading their dossier…</p>${stepper(job)}</section>`;
    return;
  }
  if (job.state === "done") {
    // The run finished and the new data is loaded, but the player isn't in it: not found.
    ctx.el.innerHTML = `<div class="card empty">${icon("alert")}<h3>Couldn't find ${esc(name)}</h3>
      <p>The update finished, but Halo didn't return a player called “${esc(name)}”. Check the spelling (newer gamertags may need their #1234 suffix), or their match history may be private.</p>
      <div class="mc-actions" style="justify-content:center"><button class="btn primary" id="pv-search">${icon("search")}Search again</button><button class="btn" id="pv-back">Back to me</button></div></div>`;
    ctx.el.querySelector("#pv-search").addEventListener("click", () => document.querySelector("#who-btn")?.click());
    ctx.el.querySelector("#pv-back").addEventListener("click", () => ctx.setFilter({ who: "me" }));
    return;
  }
  const failed = job.state === "failed";
  ctx.el.innerHTML = `<section class="card pending-card">
      <div class="eyebrow">${failed ? "Scouting failed" : "Scouting"}</div>
      <h1>${esc(name)}</h1>
      ${failed ? `<p class="bad-text">${esc(job.error || "Something went wrong.")}</p><div class="mc-actions" style="justify-content:flex-start"><button class="btn primary" id="pv-retry">Try again</button>${job.url ? `<a class="btn" href="${esc(job.url)}" target="_blank" rel="noopener">View run on GitHub</a>` : ""}</div>`
      : `<p class="text-2">Pulling their newest 300 games from Halo. This usually takes 3–5 minutes, and you can keep browsing. This page switches to their dossier the moment it's ready. The rest of their history follows in the background.</p>
      ${stepper(job)}
      <div class="skeleton-grid" aria-hidden="true">${Array.from({ length: 6 }, () => '<div class="sk"></div>').join("")}</div>
      ${job.url ? `<a class="note" href="${esc(job.url)}" target="_blank" rel="noopener">Follow the run on GitHub</a>` : ""}`}
    </section>`;
  ctx.el.querySelector("#pv-retry")?.addEventListener("click", () => scout(ctx, { key, name }));
}
