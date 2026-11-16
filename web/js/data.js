// Loads data/data.json, decodes the column-oriented rows, and derives the
// per-game metrics every view uses. Identity ("who") selection produces its
// own annotated copy: sessions, streak context and impact depend on which
// accounts are merged.

export const OBJECTIVE_FAMILIES = new Set(["Capture the Flag", "King of the Hill", "Strongholds", "Oddball", "Total Control"]);
// Minigames/PvE: wins and losses there don't mean much, so coaching ignores them.
export const CASUAL_FAMILIES = new Set(["Infection & Minigames", "Firefight"]);
const SESSION_GAP = 50 * 60; // seconds of idle between games that starts a new session

let VERSION = "";
/** Small, cache-busted file that says which build is live (and lets big fetches be versioned). */
export async function latestVersion() {
  try {
    const r = await fetch(`data/version.json?t=${Date.now()}`, { cache: "no-store" });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

export async function loadData() {
  const v = await latestVersion();
  VERSION = v?.generated || String(Date.now());
  // Versioned URL: the CDN can't hand back an older copy right after an update.
  const res = await fetch(`data/data.json?v=${encodeURIComponent(VERSION)}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`data.json: HTTP ${res.status}`);
  const raw = await res.json();
  shardCache.clear(); // after the body: a render during the download can't refill it with old data
  return decode(raw);
}

function decode(raw) {
  const cols = raw.cols;
  const rows = raw.rows.map((arr, idx) => {
    const r = { idx };
    for (let j = 0; j < cols.length; j++) r[cols[j]] = arr[j];
    r.player = raw.players[r.p];
    r.mapName = raw.maps[r.map];
    r.mapVariant = raw.mapVariants?.[r.mapv] ?? r.mapName;
    r.modeName = raw.modes[r.mode];
    r.modeShort = r.modeName.includes(":") ? r.modeName.split(":").slice(1).join(":") : r.modeName;
    r.famName = raw.families[r.fam];
    r.plName = raw.playlists[r.pl];
    r.seasonName = r.season != null ? raw.seasons[r.season] : null;
    r.tierName = r.tier != null ? raw.tiers[r.tier] : null;
    r.min = Math.max(r.dur || 0, 60) / 60;
    r.win = r.out === "W";
    r.loss = r.out === "L" || r.out === "D";
    r.dnf = r.out === "D" || !r.done;
    r.decided = r.out === "W" || r.out === "L" || r.out === "D" || r.out === "T";
    r.acc = r.sf ? (r.sh / r.sf) * 100 : null;
    r.kd = r.k / Math.max(r.d, 1);
    r.kda = r.k + r.a / 3 - r.d;
    r.dmgRatio = r.dd / Math.max(r.dt, 1);
    r.hsPct = r.k ? r.hs / r.k : null;
    r.k10 = (r.k / r.min) * 10;
    r.d10 = (r.d / r.min) * 10;
    r.a10 = (r.a / r.min) * 10;
    r.dd10 = (r.dd / r.min) * 10;
    r.csrDelta = r.csrPre != null && r.csrPost != null ? r.csrPost - r.csrPre : null;
    r.mmrDiff = r.mmr != null && r.mmrEnemy != null ? r.mmr - r.mmrEnemy : null;
    r.lobbyAvgDD = r.lobbyDD / Math.max(r.lobby, 1);
    r.dmgShare = r.dd / Math.max(r.lobbyAvgDD, 1); // 1.0 = exactly lobby-average damage
    r.kShare = r.teamK ? r.k / r.teamK : null;
    r.dpk = r.k ? r.dd / r.k : null;
    r.lobbyDpk = r.lobbyK ? r.lobbyDD / r.lobbyK : null;
    r.lobbyAvgD = (r.teamD + r.enemyD) / Math.max(r.lobby, 1);
    r.lobbyAvgK = r.lobbyK / Math.max(r.lobby, 1);
    r.xkDiff = r.xk != null ? r.k - r.xk : null;
    r.xdDiff = r.xd != null ? r.d - r.xd : null;
    r.objMode = OBJECTIVE_FAMILIES.has(r.famName);
    r.casual = CASUAL_FAMILIES.has(r.famName);
    r.ffa = r.teams === 0; // free-for-all: only 1st place is a "win", and everyone is an "opponent"
    r.mvp = r.dmgRank === 1 && r.kRank === 1 && r.lobby > 2;
    r.date = new Date(r.t * 1000);
    return r;
  });
  rows.sort((a, b) => a.t - b.t);
  const players = raw.players.map((p, i) => ({ ...p, i }));
  return {
    generated: raw.generated,
    players,
    me: players.filter((p) => p.me),
    others: players.filter((p) => !p.me),
    maps: raw.maps,
    modes: raw.modes,
    families: raw.families,
    playlists: raw.playlists,
    seasons: raw.seasons,
    medals: raw.medals,
    people: raw.people.map(([xuid, gt, n], i) => ({ i, xuid, gt, n })),
    rows,
    hasSkill: rows.some((r) => r.csrPost != null || r.xk != null),
    aliases: raw.aliases || {},
    art: raw.art || {},
  };
}

// ---------- identity ----------
// Cached per dataset: rows computed from an old dataset can never be served for a new one.
const caches = new WeakMap();

/** Rows for an identity ("me" = all [me] accounts merged, else one xuid), annotated. */
export function rowsFor(db, who) {
  let cache = caches.get(db);
  if (!cache) caches.set(db, (cache = new Map()));
  if (cache.has(who)) return cache.get(who);
  const ids = who === "me" ? new Set(db.me.map((p) => p.i)) : new Set(db.players.filter((p) => p.xuid === who).map((p) => p.i));
  const rows = db.rows.filter((r) => ids.has(r.p)).map((r) => ({ ...r }));
  annotate(rows);
  cache.set(who, rows);
  return rows;
}

function annotate(rows) {
  let session = -1, prevEnd = -Infinity, gameNo = 0, lossRun = 0, winRun = 0, prevOut = null;
  for (const r of rows) {
    if (r.t - prevEnd > SESSION_GAP) {
      session++;
      gameNo = 0;
      lossRun = 0;
      winRun = 0;
      prevOut = null;
    }
    r.session = session;
    r.gameNo = ++gameNo;
    r.prevOut = prevOut;
    r.lossRunBefore = lossRun;
    r.winRunBefore = winRun;
    lossRun = r.loss ? lossRun + 1 : 0;
    winRun = r.win ? winRun + 1 : 0;
    prevOut = r.out;
    prevEnd = r.t + (r.dur || 0);
  }
  // Session sizes (for "game 3 of 7")
  const sizes = new Map();
  for (const r of rows) sizes.set(r.session, (sizes.get(r.session) || 0) + 1);
  for (const r of rows) r.sessionSize = sizes.get(r.session);

  // Impact: a 0–100 percentile of a composite (net kills/10, net damage/10,
  // lobby damage placement, small bonus for winning). Relative to *your* games.
  const feats = rows.map((r) => [
    ((r.k + r.a / 3 - r.d) / r.min) * 10,
    ((r.dd - r.dt) / r.min) * 10,
    r.lobby > 1 ? 1 - (r.dmgRank - 1) / (r.lobby - 1) : 0.5,
  ]);
  const z = feats[0]?.map((_, j) => {
    const vals = feats.map((f) => f[j]);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(vals.length - 1, 1)) || 1;
    return [m, sd];
  });
  if (!z) return;
  const raw = feats.map((f, i) => f.reduce((s, v, j) => s + (v - z[j][0]) / z[j][1], 0) / f.length + (rows[i].win ? 0.35 : 0));
  const order = raw.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  order.forEach(([, i], rank) => (rows[i].impact = Math.round((rank / Math.max(order.length - 1, 1)) * 100)));
}

// ---------- filters ----------
export const RANGES = [
  { id: "session", label: "Last session" },
  { id: "7d", label: "7D", days: 7 },
  { id: "30d", label: "30D", days: 30 },
  { id: "90d", label: "90D", days: 90 },
  { id: "season", label: "Season" },
  { id: "1y", label: "1Y", days: 365 },
  { id: "all", label: "All" },
];
export const QUEUES = [
  { id: "all", label: "All queues" },
  { id: "ranked", label: "Ranked" },
  { id: "social", label: "Social" },
  { id: "btb", label: "Big Team" },
  { id: "event", label: "Featured / events" },
];

export function queueMatch(r, q) {
  switch (q) {
    case "ranked": return r.ranked === 1;
    case "social": return !r.ranked && r.exp === "Arena";
    case "btb": return r.exp === "Big Team";
    case "event": return r.exp === "Featured" || r.exp === "Other";
    default: return true;
  }
}

/** Time window for a range; returns {from, to, label} or null for all-time. `prev` gives the previous equal window. */
export function windowFor(rows, range, prev = false) {
  const now = Date.now() / 1000;
  const def = RANGES.find((r) => r.id === range);
  if (!def || range === "all" || !rows.length) return null;
  if (def.days) {
    const span = def.days * 86400;
    return prev ? { from: now - 2 * span, to: now - span } : { from: now - span, to: Infinity };
  }
  if (range === "session") {
    const sessions = [...new Set(rows.map((r) => r.session))];
    const target = sessions[sessions.length - (prev ? 2 : 1)];
    if (target === undefined) return { session: -999 };
    return { session: target };
  }
  if (range === "season") {
    const seasons = [...new Set(rows.filter((r) => r.seasonName).map((r) => r.seasonName))];
    const target = seasons[seasons.length - (prev ? 2 : 1)];
    return { season: target ?? "__none__" };
  }
  return null;
}

const inWindow = (r, w) => !w || (w.session !== undefined ? r.session === w.session : w.season !== undefined ? r.seasonName === w.season : r.t >= w.from && r.t < w.to);

export function applyFilters(rows, f, { prev = false, ignore = [] } = {}) {
  const w = ignore.includes("range") ? null : windowFor(rows, f.range, prev);
  return rows.filter(
    (r) =>
      queueMatch(r, ignore.includes("queue") ? "all" : f.queue) &&
      (ignore.includes("fam") || !f.fam || r.famName === f.fam) &&
      (ignore.includes("map") || !f.map || r.mapName === f.map) &&
      inWindow(r, w),
  );
}

export function rangeLabel(range) {
  return { session: "last session", "7d": "last 7 days", "30d": "last 30 days", "90d": "last 90 days", season: "this ranked season", "1y": "last 12 months", all: "all time" }[range] || range;
}
export function prevLabel(range) {
  return { session: "previous session", "7d": "prior 7 days", "30d": "prior 30 days", "90d": "prior 90 days", season: "last season", "1y": "prior year" }[range] || "before";
}

// ---------- lobby shards (lazy) ----------
const shardCache = new Map();
export async function lobbyFor(row) {
  const month = new Date(row.t * 1000).toISOString().slice(0, 7);
  if (!shardCache.has(month)) {
    shardCache.set(month, fetch(`data/lobbies/${month}.json?v=${encodeURIComponent(VERSION)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  const shard = await shardCache.get(month);
  if (!shard || !shard.matches[row.mid]) return null;
  const C = shard.cols;
  return shard.matches[row.mid].map((a) => {
    const o = {};
    C.forEach((c, i) => (o[c] = a[i]));
    o.name = shard.names[o.xuid] || null;
    return o;
  });
}
