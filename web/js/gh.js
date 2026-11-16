// GitHub connection + job tracker.
// The site is static, so starting an ingest means calling the GitHub API with a fine-grained
// token (this repo only, Actions read/write). By default the token lives in this tab only
// (sessionStorage): every Pages site under <owner>.github.io shares one origin, so anything
// stored for good is readable by the owner's other Pages sites. "Remember" is an explicit opt-in.
//
// GitHub keeps ONE pending run per concurrency group and cancels the older one, so requests
// are held here until GitHub is idle, released one dispatch at a time, and held scouts are
// batched into a single run.

const API = "https://api.github.com";
const WORKFLOW = "ingest.yml";
const ACTIVE = new Set(["held", "dispatching", "dispatched", "queued", "in_progress", "publishing"]);
const TAB = Math.random().toString(36).slice(2);
const listeners = new Set();
const newDataHandlers = new Set();
let timer = null;
let busy = false;
let memRepo = null;

// ---------- storage (namespaced per repo) ----------
const safe = (fn, d) => { try { return fn(); } catch { return d; } };
export function repo() {
  if (memRepo) return memRepo;
  const saved = safe(() => JSON.parse(localStorage.getItem("debrief.repo")), null);
  if (saved?.owner && saved?.name) return saved;
  if (location.hostname.endsWith("github.io")) {
    const name = location.pathname.split("/").filter(Boolean)[0];
    if (name) return { owner: location.hostname.split(".")[0], name };
  }
  return null;
}
const ns = (k) => { const r = repo(); return `debrief:${r ? `${r.owner}/${r.name}` : "_"}:${k}`; };
// The first version stored the token origin-wide under a fixed key. Never leave it behind.
safe(() => { localStorage.removeItem("debrief.ghToken"); localStorage.removeItem("debrief.jobs"); });
const lsGet = (k, d) => safe(() => { const v = localStorage.getItem(ns(k)); return v === null ? d : JSON.parse(v); }, d);
const lsSet = (k, v) => safe(() => (v === null ? localStorage.removeItem(ns(k)) : localStorage.setItem(ns(k), JSON.stringify(v))));
const ssGet = (k, d) => safe(() => { const v = sessionStorage.getItem(ns(k)); return v === null ? d : JSON.parse(v); }, d);
const ssSet = (k, v) => safe(() => (v === null ? sessionStorage.removeItem(ns(k)) : sessionStorage.setItem(ns(k), JSON.stringify(v))));

export const token = () => ssGet("token", null) || lsGet("token", null);
export const remembered = () => !!lsGet("token", null);
export const connected = () => !!(token() && repo());
export const jobs = () => lsGet("jobs", []);
const saveJobs = (list) => { lsSet("jobs", list.slice(-30)); emit(); };
const liveJobs = () => jobs().filter((j) => ACTIVE.has(j.state));
/** Another tab holds the polling lease: it is driving the jobs and this tab follows via storage events. */
const drivenElsewhere = () => { const l = lsGet("lease", null); return !!l && l.tab !== TAB && l.until > Date.now(); };
/** Jobs this tab can drive (it has a token). */
export const activeJobs = () => (connected() ? liveJobs() : []);
/** Jobs in motion, driven by this tab or another one. What the UI should show as running. */
export const runningJobs = () => (connected() || drivenElsewhere() ? liveJobs() : []);
/** Jobs nobody is driving: this tab has no token and no other tab is polling. */
export const pausedJobs = () => (connected() || drivenElsewhere() ? [] : liveJobs());
export const isActive = (j) => !!j && ACTIVE.has(j.state);
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const onNewData = (fn) => (newDataHandlers.add(fn), () => newDataHandlers.delete(fn));
function emit() { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } }

/** "xuid(123)", "123", "Name" → comparable key */
export const normKey = (k) => { const s = String(k ?? "").trim().toLowerCase(); const m = s.match(/^(?:xuid\()?(\d{16})\)?$/); return m ? m[1] : s; };

async function api(path, { method = "GET", body, tok = token(), r = repo() } = {}) {
  if (!tok) { const err = new Error("not connected"); err.status = 401; err.tok = null; throw err; } // disconnected mid-tick
  const url = path.startsWith("http") ? path : `${API}/repos/${r.owner}/${r.name}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${tok}`, "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = `${res.status} ${(await res.json()).message || ""}`.trim(); } catch { /* not JSON */ }
    const err = new Error(msg);
    err.status = res.status;
    err.tok = tok; // a 401 only means something if this is still the token in use
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/** Validate first, then store. Throws a readable error if the token can't do the job. */
export async function connect(tok, { repoOverride = null, remember = false } = {}) {
  const r = repoOverride || repo();
  if (!r) throw new Error("Couldn't tell which repository this site belongs to. Enter owner/repo.");
  try {
    await api("", { tok, r });
  } catch (e) {
    throw new Error(e.status === 401 ? "GitHub rejected that token (expired or mistyped)." : e.status === 404 ? "That token can't see this repository. Give it access to this repo." : `GitHub said: ${e.message}`);
  }
  try {
    await api(`/actions/workflows/${WORKFLOW}`, { tok, r });
  } catch (e) {
    throw new Error(e.status === 403 || e.status === 404 ? "The token needs the Actions permission (Read and write)." : `GitHub said: ${e.message}`);
  }
  if (repoOverride) { memRepo = repoOverride; safe(() => localStorage.setItem("debrief.repo", JSON.stringify(repoOverride))); }
  ssSet("token", remember ? null : tok);
  lsSet("token", remember ? tok : null);
  ssSet("dropped", null);
  lsSet("dropped", null);
  emit();
  resume(); // jobs that were paused for lack of a token carry on now
}
/** Why the token went away, if GitHub rejected it (shared across tabs when it was the remembered one). */
export const droppedReason = () => (connected() ? null : ssGet("dropped", null) || lsGet("dropped", null));
/** The user's own Disconnect: forget every stored token, with no "rejected" story attached. */
export function disconnect() {
  ssSet("token", null);
  lsSet("token", null);
  ssSet("dropped", null);
  lsSet("dropped", null);
  safe(() => localStorage.removeItem("debrief.ghToken"));
  releaseLease();
  emit();
  watch();
}
/** GitHub rejected `tok`: forget only the slot(s) holding that exact token, and say why. */
function dropToken(tok, reason) {
  if (ssGet("token", null) === tok) { ssSet("token", null); ssSet("dropped", reason); }
  if (lsGet("token", null) === tok) { lsSet("token", null); lsSet("dropped", reason); }
  if (!connected()) releaseLease();
  emit();
  watch();
}
/** A tab that can't poll any more hands the lease on at once, so others take over or show "paused". */
function releaseLease() { if (lsGet("lease", null)?.tab === TAB) lsSet("lease", null); }

const rid = () => Math.random().toString(36).slice(2, 10);

/**
 * kind: "sync" (everyone, newest games) | "scout" (first look at new players) | "full" (whole history)
 * players: [{key: gamertag or xuid, label: display name}]
 */
export async function request(kind, players = []) {
  if (!connected()) throw new Error("not-connected");
  const list = jobs();
  const sig = (ps) => ps.map((p) => normKey(p.key)).sort().join();
  const dup = list.find((j) => isActive(j) && j.kind === kind && sig(j.players) === sig(players));
  if (dup) return dup;
  const job = { id: rid(), kind, players, createdAt: new Date().toISOString(), state: "held", stage: "Starting…", stageIndex: 0, errors: 0 };
  saveJobs([...list, job]);
  tick();
  return job;
}

function patch(ids, changes) {
  const set = new Set([].concat(ids));
  const list = jobs();
  let changed = false;
  for (const j of list) {
    if (!set.has(j.id)) continue;
    if (Object.entries(changes).some(([k, v]) => JSON.stringify(j[k]) !== JSON.stringify(v))) {
      Object.assign(j, changes, { updatedAt: new Date().toISOString() });
      changed = true;
    }
  }
  if (changed) saveJobs(list);
}

// Workflow steps → the few stages people care about. Post/cleanup steps count as the last stage.
export const STAGE_LABELS = ["Waiting for a runner", "Setting up", "Pulling games from Halo", "Saving", "Building and publishing", "Going live"];
function stageOf(job, step) {
  const n = String(step).toLowerCase();
  if (job === "gate") return 1;
  if (job === "publish") return 4;
  if (/^post |complete job|commit new data/.test(n)) return 3;
  if (/pull new matches|rotate refresh/.test(n)) return 2;
  return 1;
}

// ---------- tab coordination: one tab talks to GitHub, the others watch ----------
/**
 * "lead": this tab polls. "claimed": it just wrote the lease and must wait a beat. false: another tab polls.
 * localStorage reaches other tabs asynchronously, so two tabs claiming at the same moment can each read
 * their own write back. A claim only counts once it has survived until this tab's next tick: by then both
 * tabs see the same winner, and the loser backs off before anything is dispatched twice.
 */
function lead() {
  const now = Date.now();
  const l = lsGet("lease", null);
  if (l && l.tab !== TAB && l.until > now) return false;
  lsSet("lease", { tab: TAB, until: now + 15000 });
  return l?.tab === TAB ? "lead" : "claimed";
}
// A reloaded page gets a new TAB id: hand the lease back on the way out so it can poll at once.
addEventListener("pagehide", () => releaseLease());
addEventListener("pageshow", (e) => { if (e.persisted) { resume(); watch(); } }); // back from the bfcache
const seenStates = new Map(jobs().map((j) => [j.id, j.state]));
addEventListener("storage", (e) => {
  if (e.key && e.key.endsWith(":token")) { // a remembered token appeared or was dropped in another tab
    if (connected()) ssSet("dropped", null);
    emit(); resume(); watch(); return;
  }
  if (e.key && e.key.endsWith(":lease")) { resume(); watch(); return; } // the polling tab may have left: take over
  if (!e.key || !e.key.endsWith(":jobs")) return;
  // Another tab finished a job: load the new data here too, once per batch.
  const finished = new Map();
  for (const j of jobs()) {
    if (j.state === "done" && seenStates.get(j.id) !== "done") finished.set(j.rid || j.id, [...(finished.get(j.rid || j.id) || []), j]);
    seenStates.set(j.id, j.state);
  }
  for (const group of finished.values()) runHandlers(group);
  emit();
  resume(); // keep a heartbeat in every connected tab, so one can take over if the polling tab goes away
  watch();
});

/** Tell the app a batch finished (once per batch, with every player in it). */
async function runHandlers(group, extra = {}) {
  for (const j of group) seenStates.set(j.id, "done");
  const players = [];
  for (const p of group.flatMap((j) => j.players)) if (!players.some((q) => normKey(q.key) === normKey(p.key))) players.push(p);
  const merged = { ...group[0], ...extra, ids: group.map((j) => j.id), players };
  for (const fn of newDataHandlers) {
    try { await fn(merged); } catch (e) { console.warn("reload after update failed", e); }
  }
}

async function releaseHeld() {
  const held = activeJobs().filter((j) => j.state === "held");
  if (!held.length) return;
  const runs = await api(`/actions/workflows/${WORKFLOW}/runs?per_page=20`);
  patch(held.map((j) => j.id), { errors: 0 }); // GitHub answered: reset the transient-error count
  const busyRun = runs.workflow_runs.some((r) => r.status !== "completed");
  const inFlight = jobs().some((j) => j.state === "dispatched" || j.state === "dispatching");
  if (busyRun || inFlight) {
    patch(held.map((j) => j.id), { stage: busyRun ? "Queued behind another update" : "Starting…" });
    return;
  }
  // One dispatch per tick. Held scouts (or full-history requests) ride in a single run.
  const first = held[0];
  const batch = first.kind === "sync" ? [first] : held.filter((j) => j.kind === first.kind);
  const players = [];
  for (const p of batch.flatMap((j) => j.players)) if (!players.some((q) => normKey(q.key) === normKey(p.key))) players.push(p);
  const id = rid();
  const inputs = { request_id: id, gamertags: players.map((p) => p.key).join(", ") };
  if (first.kind === "scout") inputs.phase = "scout";
  if (first.kind === "full") inputs.phase = "full";
  if (first.kind === "sync") { inputs.max_new_matches = "200"; inputs.skill_max = "600"; }
  // Claim first: if the POST's response is lost, the next tick finds the run by [rid] instead of
  // dispatching a duplicate.
  const ids = batch.map((j) => j.id);
  patch(ids, { state: "dispatching", rid: id, dispatchedAt: new Date().toISOString(), stage: "Waiting for a runner", stageIndex: 0 });
  try {
    await api(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: "main", inputs } });
    patch(ids, { state: "dispatched", errors: 0 });
  } catch (e) {
    if (e.status === 401) { patch(ids, { state: "held", rid: null }); throw e; } // token: pause, don't fail
    if ([403, 404, 422].includes(e.status)) {
      // A definite refusal: retrying won't help, and a stuck request would block everything behind it.
      patch(ids, { state: "failed", error: e.status === 403 ? "GitHub refused to start the update. The token needs Actions: Read and write on this repository." : `GitHub refused to start the update (${e.message}).` });
      return;
    }
    throw e; // network or 5xx: the POST may have landed; follow() looks for the run before retrying
  }
}

async function follow(group) {
  const j = group[0], ids = group.map((x) => x.id);
  let runId = j.runId;
  if (!runId) {
    const runs = await api(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=20`);
    const run = runs.workflow_runs.find((r) => (r.display_title || r.name || "").includes(`[${j.rid}]`));
    if (!run) {
      const age = Date.now() - Date.parse(j.dispatchedAt);
      // A claimed dispatch whose POST never landed: put it back in the queue after a grace period.
      if (j.state === "dispatching" && age > 90 * 1000) {
        for (const x of group) { // each request counts its own attempts, even when batched with newer ones
          const tries = (x.dispatchTries || 0) + 1;
          if (tries >= 3) patch(x.id, { state: "failed", error: "GitHub didn't accept the update after several tries. Try again in a few minutes." });
          else patch(x.id, { state: "held", rid: null, stage: "Retrying…", dispatchTries: tries });
        }
      }
      else if (age > 3 * 60 * 1000) patch(ids, { state: "failed", error: "GitHub accepted the request but the run never appeared. Check the Actions tab." });
      return;
    }
    runId = run.id;
    patch(ids, { runId, url: run.html_url, runStartedAt: run.run_started_at || run.created_at, state: "queued" });
  }
  const cur = jobs().find((x) => x.id === j.id) || j;
  if (cur.state === "publishing") {
    // The run is done; wait until Pages serves a build made after this run's data landed.
    const v = await fetch(`data/version.json?t=${Date.now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const live = !!v && Date.parse(v.generated) >= Date.parse(cur.liveAfter || cur.runStartedAt || cur.createdAt);
    const giveUp = Date.now() - Date.parse(cur.completedAt) > 10 * 60 * 1000;
    if (live || giveUp) {
      await runHandlers(group, { live, version: live ? v.generated : null }); // reload BEFORE "done"
      patch(ids, { state: "done", live, stage: live ? "Done" : "Saved; the site hasn't updated yet", stageIndex: STAGE_LABELS.length, version: live ? v.generated : null, finishedAt: new Date().toISOString() });
    }
    return;
  }
  const run = await api(`/actions/runs/${runId}`);
  let steps = null;
  try { steps = await api(`/actions/runs/${runId}/jobs`); } catch { /* progress detail is optional */ }
  if (run.status === "completed") {
    if (!steps) return; // decide only with the job details in hand; try again next tick
    const ingestJob = steps.jobs.find((x) => x.name === "ingest");
    const publishJob = steps.jobs.find((x) => x.name === "publish");
    const goLive = (after) => patch(ids, { state: "publishing", stage: "Going live", stageIndex: STAGE_LABELS.length - 1, completedAt: new Date().toISOString(), liveAfter: after });
    if (ingestJob?.conclusion !== "success") {
      patch(ids, { state: "failed", error: run.conclusion === "cancelled" ? "The run was cancelled." : "Pulling games failed. Open the run on GitHub for details." });
    } else if (publishJob?.conclusion === "success") {
      goLive(publishJob.started_at || cur.runStartedAt);
    } else if (publishJob?.conclusion === "cancelled" || publishJob?.conclusion === "skipped") {
      // Superseded by a newer deploy (or nothing new): any build after the data landed shows it.
      goLive(ingestJob.completed_at || cur.runStartedAt);
    } else {
      patch(ids, { state: "failed", error: "Games were saved, but publishing the site failed. The next update will publish them." });
    }
    return;
  }
  let stageIndex = cur.stageIndex ?? 0, detail = cur.detail || "";
  const active = steps?.jobs?.filter((x) => x.status === "in_progress") || [];
  for (const job of active) {
    if (job.name === "gate") continue;
    const s = job.steps?.find((x) => x.status === "in_progress") || [...(job.steps || [])].reverse().find((x) => x.status === "completed");
    if (s) { stageIndex = Math.max(stageIndex, stageOf(job.name, s.name)); detail = s.name; }
  }
  patch(ids, { state: run.status === "queued" ? "queued" : "in_progress", stage: STAGE_LABELS[stageIndex], stageIndex, detail, errors: 0 });
}

/** Hold leadership for the whole tick: the lease picks one tab; the Web Lock keeps its ticks from overlapping. */
function withLeadership(fn) {
  const l = lead();
  if (l !== "lead") return l; // one tab polls GitHub; the others follow through storage events
  const r = repo();
  if (navigator.locks?.request) return navigator.locks.request(`debrief:${r?.owner}/${r?.name}:tick`, { ifAvailable: true }, (lock) => (lock ? fn() : null));
  return fn();
}

async function tick() {
  if (busy) return;
  busy = true;
  let claimed = false;
  try {
    if (activeJobs().length) claimed = "claimed" === await withLeadership(async () => {
      try {
        await releaseHeld();
      } catch (e) {
        handleError(activeJobs().filter((j) => j.state === "held"), e);
      }
      const groups = new Map();
      for (const j of activeJobs()) if (j.state !== "held" && j.rid) groups.set(j.rid, [...(groups.get(j.rid) || []), j]);
      // anything in flight without a request id can't be followed: let it go rather than spin forever
      for (const j of activeJobs()) if (j.state !== "held" && !j.rid) patch(j.id, { state: "failed", error: "Lost track of this update." });
      for (const group of groups.values()) {
        try {
          await follow(group);
        } catch (e) {
          handleError(group, e);
        }
      }
    });
  } finally {
    busy = false;
  }
  clearTimeout(timer);
  if (activeJobs().length) timer = setTimeout(tick, claimed ? 600 : document.visibilityState === "visible" ? 4000 : 10000);
}

function handleError(group, e) {
  if (!group.length) return;
  const ids = group.map((j) => j.id);
  if (e.status === 401) {
    // Only if the rejected token is still the one in use: a request that raced a Disconnect, or used a
    // token since replaced, says nothing about the current one. Jobs pause until a valid token picks them up.
    if (e.tok && e.tok === token()) dropToken(e.tok, "GitHub rejected the token (expired or revoked).");
    return;
  }
  if (e.status === 404 && group[0].runId) return patch(ids, { state: "failed", error: "That run no longer exists on GitHub." });
  // Network drops, 5xx and rate limits are usually momentary: keep going, give up only if it persists.
  for (const x of group) {
    const errors = (x.errors || 0) + 1;
    if (errors >= 8) patch(x.id, { state: "failed", error: `Lost contact with GitHub (${e.message}).` });
    else patch(x.id, { errors });
  }
}

export function resume() {
  if (activeJobs().length) tick();
}
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && resume());

// A tab without a token can't poll, but it should notice when the tab that was polling goes away
// (its lease lapses), so "running" turns into "paused" instead of spinning forever.
let watchTimer = null;
let pausedSig = pausedJobs().map((j) => j.id).join();
function watch() {
  clearTimeout(watchTimer);
  const sig = pausedJobs().map((j) => j.id).join();
  if (sig !== pausedSig) { pausedSig = sig; emit(); }
  if (liveJobs().length && !connected()) watchTimer = setTimeout(watch, 5000);
}
watch();

export function clearFinished() {
  saveJobs(jobs().filter((j) => ACTIVE.has(j.state)));
}

/** Most recent job that involves any of these players (gamertag or xuid, any form). */
export function jobFor(keys) {
  const ks = new Set(keys.filter(Boolean).map(normKey));
  return [...jobs()].reverse().find((j) => j.players.some((p) => ks.has(normKey(p.key)) || ks.has(normKey(p.label))));
}
