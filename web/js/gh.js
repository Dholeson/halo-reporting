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
const ACTIVE = new Set(["held", "dispatched", "queued", "in_progress", "publishing"]);
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
const lsGet = (k, d) => safe(() => { const v = localStorage.getItem(ns(k)); return v === null ? d : JSON.parse(v); }, d);
const lsSet = (k, v) => safe(() => (v === null ? localStorage.removeItem(ns(k)) : localStorage.setItem(ns(k), JSON.stringify(v))));
const ssGet = (k, d) => safe(() => { const v = sessionStorage.getItem(ns(k)); return v === null ? d : JSON.parse(v); }, d);
const ssSet = (k, v) => safe(() => (v === null ? sessionStorage.removeItem(ns(k)) : sessionStorage.setItem(ns(k), JSON.stringify(v))));

export const token = () => ssGet("token", null) || lsGet("token", null);
export const remembered = () => !!lsGet("token", null);
export const connected = () => !!(token() && repo());
export const jobs = () => lsGet("jobs", []);
const saveJobs = (list) => { lsSet("jobs", list.slice(-30)); emit(); };
export const activeJobs = () => jobs().filter((j) => ACTIVE.has(j.state));
export const isActive = (j) => !!j && ACTIVE.has(j.state);
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const onNewData = (fn) => (newDataHandlers.add(fn), () => newDataHandlers.delete(fn));
function emit() { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } }

/** "xuid(123)", "123", "Name" → comparable key */
export const normKey = (k) => { const s = String(k ?? "").trim().toLowerCase(); const m = s.match(/^(?:xuid\()?(\d{16})\)?$/); return m ? m[1] : s; };

async function api(path, { method = "GET", body, tok = token(), r = repo() } = {}) {
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
  emit();
}
export function disconnect() { ssSet("token", null); lsSet("token", null); emit(); }

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
  let hit = false;
  for (const j of list) if (set.has(j.id)) { Object.assign(j, changes, { updatedAt: new Date().toISOString() }); hit = true; }
  if (hit) saveJobs(list);
}

// Workflow steps → the few stages people care about. Post/cleanup steps count as the last stage.
export const STAGE_LABELS = ["Waiting for a runner", "Setting up", "Pulling games from Halo", "Saving", "Building and publishing", "Going live"];
function stageOf(job, step) {
  const n = `${job} ${step}`.toLowerCase();
  if (job === "publish") return 4;
  if (/post |complete job/.test(n)) return 3;
  if (/commit new data/.test(n)) return 3;
  if (/pull new matches|rotate refresh/.test(n)) return 2;
  return 1;
}

// ---------- tab coordination: one tab talks to GitHub, the others watch ----------
function lead() {
  const now = Date.now();
  const l = lsGet("lease", null);
  if (l && l.tab !== TAB && l.until > now) return false;
  lsSet("lease", { tab: TAB, until: now + 15000 });
  return lsGet("lease", null)?.tab === TAB;
}
const seenStates = new Map(jobs().map((j) => [j.id, j.state]));
addEventListener("storage", (e) => {
  if (!e.key || !e.key.endsWith(":jobs")) return;
  // Another tab finished a job: load the new data here too.
  for (const j of jobs()) {
    if (j.state === "done" && seenStates.get(j.id) !== "done") runHandlers(j);
    seenStates.set(j.id, j.state);
  }
  emit();
});

async function runHandlers(job, version) {
  seenStates.set(job.id, "done");
  for (const fn of newDataHandlers) {
    try { await fn(job, version); } catch (e) { console.warn("reload after update failed", e); }
  }
}

async function releaseHeld() {
  const held = activeJobs().filter((j) => j.state === "held");
  if (!held.length) return;
  const runs = await api(`/actions/workflows/${WORKFLOW}/runs?per_page=20`);
  const busyRun = runs.workflow_runs.some((r) => r.status !== "completed");
  const inFlight = jobs().some((j) => j.state === "dispatched"); // dispatched, run not visible yet
  if (busyRun || inFlight) {
    const stage = busyRun ? "Queued behind another update" : "Starting…";
    const stale = held.filter((j) => j.stage !== stage).map((j) => j.id);
    if (stale.length) patch(stale, { stage });
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
  await api(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: "main", inputs } });
  patch(batch.map((j) => j.id), { state: "dispatched", rid: id, dispatchedAt: new Date().toISOString(), stage: "Waiting for a runner", stageIndex: 0, errors: 0 });
}

async function follow(group) {
  const j = group[0], ids = group.map((x) => x.id);
  let runId = j.runId;
  if (!runId) {
    const runs = await api(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=20`);
    const run = runs.workflow_runs.find((r) => (r.display_title || r.name || "").includes(`[${j.rid}]`));
    if (!run) {
      if (Date.now() - Date.parse(j.dispatchedAt) > 3 * 60 * 1000) patch(ids, { state: "failed", error: "GitHub accepted the request but the run never appeared. Check the Actions tab." });
      return;
    }
    runId = run.id;
    patch(ids, { runId, url: run.html_url, runStartedAt: run.run_started_at || run.created_at, state: "queued" });
  }
  const cur = jobs().find((x) => x.id === j.id) || j;
  if (cur.state === "publishing") {
    // The run is done; wait until Pages actually serves a build from after it started.
    const v = await fetch(`data/version.json?t=${Date.now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const live = v && Date.parse(v.generated) >= Date.parse(cur.runStartedAt || cur.createdAt);
    const giveUp = Date.now() - Date.parse(cur.completedAt) > 10 * 60 * 1000;
    if (live || giveUp) {
      await runHandlers(cur, v);  // load the new data BEFORE the job counts as done
      patch(ids, { state: "done", stage: live ? "Done" : "Done (the site may take a minute to catch up)", stageIndex: STAGE_LABELS.length, version: v?.generated, finishedAt: new Date().toISOString() });
    }
    return;
  }
  const run = await api(`/actions/runs/${runId}`);
  let steps = null;
  try { steps = await api(`/actions/runs/${runId}/jobs`); } catch { /* progress detail is optional */ }
  if (run.status === "completed") {
    const ingestJob = steps?.jobs?.find((x) => x.name === "ingest");
    // A publish superseded by a newer deploy still means the data landed; that deploy shows it.
    if (run.conclusion === "success" || ingestJob?.conclusion === "success") {
      patch(ids, { state: "publishing", stage: "Going live", stageIndex: STAGE_LABELS.length - 1, completedAt: new Date().toISOString() });
    } else {
      patch(ids, { state: "failed", error: run.conclusion === "cancelled" ? "The run was cancelled." : "The run failed. Open it on GitHub for details." });
    }
    return;
  }
  let stageIndex = cur.stageIndex ?? 0, detail = cur.detail || "";
  const active = steps?.jobs?.filter((x) => x.status === "in_progress") || [];
  for (const job of active) {
    const s = job.steps?.find((x) => x.status === "in_progress") || [...(job.steps || [])].reverse().find((x) => x.status === "completed");
    if (s) { stageIndex = Math.max(stageIndex, stageOf(job.name, s.name)); detail = s.name; }
  }
  patch(ids, { state: run.status === "queued" ? "queued" : "in_progress", stage: STAGE_LABELS[stageIndex], stageIndex, detail, errors: 0 });
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (activeJobs().length && connected() && lead()) {
      try {
        await releaseHeld();
      } catch (e) {
        handleError(activeJobs().filter((j) => j.state === "held"), e);
      }
      const groups = new Map();
      for (const j of activeJobs()) if (j.state !== "held" && j.rid) groups.set(j.rid, [...(groups.get(j.rid) || []), j]);
      for (const group of groups.values()) {
        try {
          await follow(group);
        } catch (e) {
          handleError(group, e);
        }
      }
    }
  } finally {
    busy = false;
  }
  clearTimeout(timer);
  if (activeJobs().length) timer = setTimeout(tick, document.visibilityState === "visible" ? 4000 : 15000);
}

function handleError(group, e) {
  if (!group.length) return;
  const ids = group.map((j) => j.id);
  if (e.status === 401) return patch(ids, { state: "failed", error: "Your GitHub token expired or was revoked. Reconnect from the Updates panel." });
  if (e.status === 404 && group[0].runId) return patch(ids, { state: "failed", error: "That run no longer exists on GitHub." });
  // Network drops, 5xx and rate limits are usually momentary: keep going, give up only if it persists.
  const errors = (group[0].errors || 0) + 1;
  if (errors >= 8) return patch(ids, { state: "failed", error: `Lost contact with GitHub (${e.message}).` });
  patch(ids, { errors });
}

export function resume() {
  if (activeJobs().length) tick();
}
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && resume());

export function clearFinished() {
  saveJobs(jobs().filter((j) => ACTIVE.has(j.state)));
}

/** Most recent job that involves any of these players (gamertag or xuid, any form). */
export function jobFor(keys) {
  const ks = new Set(keys.filter(Boolean).map(normKey));
  return [...jobs()].reverse().find((j) => j.players.some((p) => ks.has(normKey(p.key)) || ks.has(normKey(p.label))));
}
