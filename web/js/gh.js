// GitHub connection + job tracker.
// The site is static, so to start an ingest it calls the GitHub API with a
// fine-grained token the owner pastes in once (this repo only, Actions read/write).
// The token lives only in this browser. Without it, everything stays read-only.

import { store } from "./util.js";

const API = "https://api.github.com";
const WORKFLOW = "ingest.yml";
const ACTIVE = new Set(["held", "dispatched", "queued", "in_progress", "publishing"]);
const listeners = new Set();
let timer = null;
let busy = false;

export function repo() {
  const saved = store.get("repo", null);
  if (saved?.owner && saved?.name) return saved;
  if (location.hostname.endsWith("github.io")) {
    return { owner: location.hostname.split(".")[0], name: location.pathname.split("/").filter(Boolean)[0] || `${location.hostname}` };
  }
  return null;
}
export const token = () => store.get("ghToken", null);
export const connected = () => !!(token() && repo());
export const jobs = () => store.get("jobs", []);
const saveJobs = (list) => { store.set("jobs", list.slice(-30)); emit(); };
export const activeJobs = () => jobs().filter((j) => ACTIVE.has(j.state));
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
function emit() { for (const fn of listeners) { try { fn(); } catch (e) { console.warn(e); } } }

async function api(path, { method = "GET", body, tok = token() } = {}) {
  const r = repo();
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

/** Validate and store a token. Throws a readable error if it can't do the job. */
export async function connect(tok, repoOverride) {
  if (repoOverride) store.set("repo", repoOverride);
  if (!repo()) throw new Error("Couldn't tell which repository this site belongs to. Enter owner/repo.");
  try {
    await api("", { tok });
  } catch (e) {
    throw new Error(e.status === 401 ? "GitHub rejected that token (expired or mistyped)." : e.status === 404 ? "That token can't see this repository. Give it access to this repo." : `GitHub said: ${e.message}`);
  }
  try {
    await api(`/actions/workflows/${WORKFLOW}`, { tok });
  } catch (e) {
    throw new Error(e.status === 403 || e.status === 404 ? "The token needs the Actions permission (Read and write)." : `GitHub said: ${e.message}`);
  }
  store.set("ghToken", tok);
  emit();
}
export function disconnect() { store.set("ghToken", null); emit(); }

const rid = () => Math.random().toString(36).slice(2, 10);

/**
 * Ask the ingest workflow to run.
 * kind: "sync" (everyone, newest games) | "scout" (fast first look at new players) | "full" (whole history)
 * players: [{key: gamertag or xuid, label: display name}]
 */
export async function request(kind, players = []) {
  if (!connected()) throw new Error("not-connected");
  const list = jobs();
  const keyOf = (p) => String(p.key).toLowerCase();
  // De-duplicate: the same request already in flight just keeps running.
  const dup = list.find((j) => ACTIVE.has(j.state) && j.kind === kind && j.players.map(keyOf).join() === players.map(keyOf).join());
  if (dup) return dup;
  const job = { id: rid(), kind, players, createdAt: new Date().toISOString(), state: "held", stage: "Waiting to start", log: [] };
  saveJobs([...list, job]);
  tick();
  return job;
}

const newDataHandlers = new Set();
export const onNewData = (fn) => (newDataHandlers.add(fn), () => newDataHandlers.delete(fn));

function patch(id, changes) {
  const list = jobs();
  const j = list.find((x) => x.id === id);
  if (!j) return null;
  Object.assign(j, changes, { updatedAt: new Date().toISOString() });
  saveJobs(list);
  return j;
}

// Map the workflow's step names to a few stages people care about.
const STAGES = [
  { label: "Waiting for a runner", match: () => false },
  { label: "Setting up", match: (n) => /set up job|checkout|setup-uv|uv sync|run settings|add looked-up/i.test(n) },
  { label: "Pulling games from Halo", match: (n) => /pull new matches|rotate refresh/i.test(n) },
  { label: "Saving", match: (n) => /commit new data/i.test(n) },
  { label: "Building and publishing", match: (n) => /build report|configure-pages|upload-pages|deploy-pages/i.test(n) },
];
export const STAGE_LABELS = [...STAGES.map((s) => s.label), "Going live"];

async function step(job) {
  if (job.state === "held") {
    // GitHub keeps one pending run and cancels older pending ones, so never stack requests.
    const runs = await api(`/actions/workflows/${WORKFLOW}/runs?per_page=20`);
    const waiting = runs.workflow_runs.filter((r) => ["queued", "pending", "waiting", "requested"].includes(r.status));
    if (waiting.length) return patch(job.id, { stage: "Queued behind another update" });
    const inputs = { request_id: job.id, gamertags: job.players.map((p) => p.key).join(", ") };
    if (job.kind === "scout") inputs.phase = "scout";
    if (job.kind === "full") inputs.phase = "full";
    if (job.kind === "sync") { inputs.max_new_matches = "200"; inputs.skill_max = "600"; }
    await api(`/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: "main", inputs } });
    return patch(job.id, { state: "dispatched", dispatchedAt: new Date().toISOString(), stage: "Waiting for a runner", stageIndex: 0 });
  }
  if (!job.runId) {
    const runs = await api(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=15`);
    const run = runs.workflow_runs.find((r) => (r.display_title || r.name || "").includes(`[${job.id}]`));
    if (!run) {
      if (Date.now() - Date.parse(job.dispatchedAt) > 3 * 60 * 1000) return patch(job.id, { state: "failed", error: "GitHub accepted the request but the run never appeared. Check the Actions tab." });
      return null;
    }
    patch(job.id, { runId: run.id, url: run.html_url, runStartedAt: run.run_started_at || run.created_at });
    job = jobs().find((j) => j.id === job.id);
  }
  if (job.state === "publishing") {
    // The run is done; wait until Pages actually serves the new build.
    const v = await fetch(`data/version.json?t=${Date.now()}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    // Both timestamps come from GitHub's side, so device clock skew can't confuse this.
    if (v && Date.parse(v.generated) >= Date.parse(job.runStartedAt || job.createdAt)) {
      patch(job.id, { state: "done", stage: "Done", stageIndex: STAGE_LABELS.length, finishedAt: new Date().toISOString() });
      for (const fn of newDataHandlers) fn(job, v);
      return null;
    }
    if (Date.now() - Date.parse(job.completedAt) > 6 * 60 * 1000) return patch(job.id, { state: "done", stage: "Done (the site may take a minute to refresh)", stageIndex: STAGE_LABELS.length });
    return null;
  }
  const run = await api(`/actions/runs/${job.runId}`);
  if (run.status === "completed") {
    if (run.conclusion === "success") return patch(job.id, { state: "publishing", stage: "Going live", stageIndex: STAGE_LABELS.length - 1, completedAt: new Date().toISOString() });
    return patch(job.id, { state: "failed", error: run.conclusion === "cancelled" ? "The run was cancelled." : "The run failed. Open it on GitHub for details." });
  }
  // Which step is it on?
  let stageIndex = 0, detail = "";
  try {
    const js = await api(`/actions/runs/${job.runId}/jobs`);
    const ingest = js.jobs.find((j) => j.name === "ingest");
    const cur = ingest?.steps?.find((s) => s.status === "in_progress") || [...(ingest?.steps || [])].reverse().find((s) => s.status === "completed");
    if (cur) {
      const idx = STAGES.findIndex((s) => s.match(cur.name));
      stageIndex = idx >= 0 ? idx : 1;
      detail = cur.name;
    } else if (js.jobs.find((j) => j.name === "gate")?.status === "in_progress") stageIndex = 0;
  } catch { /* stage detail is nice-to-have */ }
  return patch(job.id, { state: run.status === "queued" ? "queued" : "in_progress", stage: STAGES[stageIndex].label, stageIndex, detail });
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (const job of activeJobs()) {
      try {
        await step(job);
      } catch (e) {
        if (e.status === 401) { patch(job.id, { state: "failed", error: "Your GitHub token expired or was revoked. Reconnect in settings." }); continue; }
        if (e.status === 403 && /rate limit/i.test(e.message)) continue; // try again next tick
        patch(job.id, { state: "failed", error: `GitHub: ${e.message}` });
      }
    }
  } finally {
    busy = false;
  }
  clearTimeout(timer);
  if (activeJobs().length) timer = setTimeout(tick, document.visibilityState === "visible" ? 4000 : 15000);
}

export function resume() {
  if (activeJobs().length) tick();
}
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && resume());

export function clearFinished() {
  saveJobs(jobs().filter((j) => ACTIVE.has(j.state)));
}

/** Most relevant job for a player key (gamertag or xuid), newest first. */
export function jobFor(keys) {
  const ks = keys.filter(Boolean).map((k) => String(k).toLowerCase());
  return [...jobs()].reverse().find((j) => j.players.some((p) => ks.includes(String(p.key).toLowerCase()) || ks.includes(String(p.label || "").toLowerCase())));
}
