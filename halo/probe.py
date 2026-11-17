"""Live match probe: what do Xbox and Halo report about the match you're in?

Start it right before you play one matchmade game (Debrief's In-game tab has a button, or Actions >
Live match probe > Run workflow). For MINUTES minutes, every POLL seconds, it asks:

- Xbox presence (userpresence.xboxlive.com, level=all) for your own accounts: is Halo Infinite running,
  on which device, and the status text the game sets (it might say "Menus", or name the map and mode).
- Halo's lobby presence (lobby-hi.svc.halowaypoint.com/hi/presence), which the game uses for friends'
  status: fireteam details, playlist and match details.

Each change is printed as it happens. At the end a summary on the run's page answers the question:
could Debrief load your match by itself, from which source, and how soon after the match started? The
full timeline is saved as probe.json (an artifact on the run). Only your own accounts are queried,
tokens are never printed, and any other player's ID is replaced with "someone".
"""

import asyncio
import datetime as dt
import json
import os
import re
import time
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout

from halo.auth import app_from_env, save_refresh_token, sign_in
from halo.players import me_xuids

HALO_TITLE = "2043073184"
XBOX_BATCH = "https://userpresence.xboxlive.com/users/batch"
LOBBY = "https://lobby-hi.svc.halowaypoint.com/hi/presence"
UGC = "https://discovery-infiniteugc.svc.halowaypoint.com/hi"
XUID16 = re.compile(r"\b\d{16}\b")
MODES = ["Slayer", "Oddball", "Strongholds", "King of the Hill", "Capture the Flag", "CTF", "Assault", "Neutral Bomb",
         "Extraction", "Total Control", "Elimination", "Fiesta", "VIP", "Escalation", "Infection", "Firefight", "Husky Raid"]


def clock() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%H:%M:%S")


def redact(obj, mine: set[str]):
    """Keep the structure, hide other players' IDs and anything long enough to be a token."""
    if isinstance(obj, dict):
        return {k: redact(v, mine) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v, mine) for v in obj]
    if isinstance(obj, int) and len(str(obj)) == 16:
        return obj if str(obj) in mine else "someone"
    if isinstance(obj, str):
        s = XUID16.sub(lambda m: m.group(0) if m.group(0) in mine else "someone", obj)
        return s if len(s) <= 160 else f"{s[:48]}…({len(s)} chars)"
    return obj


async def xbox_presence(http: ClientSession, auth: str, xuids: list[str]) -> tuple[int, dict]:
    headers = {"Authorization": auth, "x-xbl-contract-version": "3", "Accept": "application/json",
               "Accept-Language": "en-US", "Content-Type": "application/json"}
    async with http.post(XBOX_BATCH, json={"users": xuids, "level": "all"}, headers=headers) as r:
        status = r.status
        body = await r.json(content_type=None) if status == 200 else (await r.text())[:200]
    if status != 200:
        return status, {"error": body}
    out = {}
    for u in body or []:
        halo = []
        for d in u.get("devices") or []:
            for t in d.get("titles") or []:
                if str(t.get("id")) == HALO_TITLE or "halo infinite" in str(t.get("name", "")).lower():
                    halo.append({"device": d.get("type"), "state": t.get("state"), "placement": t.get("placement"),
                                 "text": (t.get("activity") or {}).get("richPresence")})
        out[str(u.get("xuid"))] = {"state": u.get("state"), "halo": halo}
    return status, out


class Lobby:
    """Halo's lobby presence. Nobody has published a working third-party call, so try the plausible
    request shapes once, keep the first that answers 200, and back off if none does."""

    def __init__(self, sess, xuids: list[str]):
        self.sess, self.xuids = sess, xuids
        self.shape = None
        self.attempts: list[dict] = []
        self.next_try = 0.0

    def shapes(self):
        spartan = {"x-343-authorization-spartan": self.sess.spartan_token, "Accept": "application/json"}
        clearance = {**spartan, "343-clearance": self.sess.clearance_token}
        as_str = {"Xuids": [f"xuid({x})" for x in self.xuids]}
        as_num = {"Xuids": [int(x) for x in self.xuids]}
        return [
            ("POST xuid() strings", "POST", spartan, as_str),
            ("POST numbers", "POST", spartan, as_num),
            ("POST strings + clearance", "POST", clearance, as_str),
            ("GET", "GET", spartan, None),
        ]

    async def poll(self, http: ClientSession):
        if self.shape is None:
            if time.time() < self.next_try:
                return None, {"note": "waiting to retry"}
            for name, method, headers, body in self.shapes():
                status, data, ctype = await self._call(http, method, headers, body)
                self.attempts.append({"at": clock(), "shape": name, "status": status, "type": ctype,
                                      "body": data if status != 200 else "(ok)"})
                print(f"{clock()}  LOBBY try {name}: HTTP {status} {ctype}")
                if status == 200:
                    self.shape = (method, headers, body)
                    return status, data
            self.next_try = time.time() + 120  # maybe it only answers in some phases; try again later
            return status, {"error": "no request shape worked", "last": data}
        method, headers, body = self.shape
        status, data, _ = await self._call(http, method, headers, body)
        return status, data

    async def _call(self, http, method, headers, body):
        async with http.request(method, LOBBY, headers={**headers, **({"Content-Type": "application/json"} if body else {})}, json=body) as r:
            ctype = r.headers.get("Content-Type", "").split(";")[0]
            if "json" in ctype:
                data = await r.json(content_type=None)
            else:
                raw = await r.read()
                data = {"nonJson": ctype, "bytes": len(raw), "text": raw[:120].decode("utf-8", "replace") if r.status != 200 else ""}
            return r.status, data, ctype


def asset_refs(obj, path=""):
    """Every {AssetId, VersionId} pair in a lobby answer, with where it was found."""
    if isinstance(obj, dict):
        if "AssetId" in obj:
            yield path, obj.get("AssetId"), obj.get("VersionId")
        for k, v in obj.items():
            yield from asset_refs(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from asset_refs(v, f"{path}[{i}]")


async def asset_name(http, sess, cache: dict, path: str, aid: str, vid: str | None) -> str | None:
    if not aid:
        return None
    if aid in cache:
        return cache[aid]
    p = path.lower()
    kinds = (["playlists"] if "playlist" in p else []) + (["mapModePairs"] if "pair" in p else []) + \
            (["maps"] if "map" in p and "pair" not in p else []) + (["ugcGameVariants"] if "variant" in p or "mode" in p else [])
    kinds += [k for k in ("playlists", "mapModePairs", "maps", "ugcGameVariants") if k not in kinds]
    headers = {"x-343-authorization-spartan": sess.spartan_token, "343-clearance": sess.clearance_token, "Accept": "application/json"}
    for kind in kinds:
        url = f"{UGC}/{kind}/{aid}/versions/{vid}" if vid else f"{UGC}/{kind}/{aid}"
        try:
            async with http.get(url, headers=headers) as r:
                if r.status != 200:
                    continue
                d = await r.json(content_type=None)
            name = d.get("PublicName") or d.get("Name")
            if kind == "mapModePairs":
                parts = [x.get("PublicName") for x in (d.get("MapLink"), d.get("UgcGameVariantLink")) if isinstance(x, dict)]
                name = " · ".join(p for p in parts if p) or name
            cache[aid] = f"{kind[:-1]}: {name}"
            return cache[aid]
        except Exception:
            continue
    cache[aid] = None
    return None


def has_match(obj) -> bool:
    """Any MatchDetails that isn't empty, anywhere in the answer."""
    if isinstance(obj, dict):
        return any((k == "MatchDetails" and v not in (None, {}, [], "")) or has_match(v) for k, v in obj.items())
    if isinstance(obj, list):
        return any(has_match(v) for v in obj)
    return False


def known_maps() -> list[str]:
    try:
        return sorted(json.loads(Path("data/art/manifest.json").read_text()).get("maps", {}).keys(), key=len, reverse=True)
    except (OSError, ValueError):
        return []


def names_in(text: str, maps: list[str]) -> list[str]:
    t = (text or "").lower()
    return [n for n in maps + MODES if n.lower() in t]


def summary(timeline: list[dict], lobby: Lobby, names: dict, gamertags: dict, maps: list[str], started: str) -> str:
    texts: dict[str, list[tuple[str, str]]] = {}
    for e in timeline:
        if e["source"] != "xbox" or not isinstance(e["data"], dict):
            continue
        for x, u in e["data"].items():
            for h in u.get("halo", []):
                lst = texts.setdefault(gamertags.get(x, x), [])
                if h.get("text") is not None and (not lst or lst[-1][1] != h["text"]):
                    lst.append((e["at"], h["text"]))
    lobby_events = [e for e in timeline if e["source"] == "lobby"]
    match_seen = [e for e in lobby_events if e["status"] == 200 and has_match(e["data"])]
    xbox_named = [(gt, at, txt, names_in(txt, maps)) for gt, lst in texts.items() for at, txt in lst if names_in(txt, maps)]
    lobby_named = [n for n in names.values() if n]
    out = [f"## Live match probe ({started} to {clock()} UTC)", ""]
    if xbox_named or lobby_named:
        out.append("**Verdict: auto-detect looks possible.**")
        if xbox_named:
            gt, at, txt, hit = xbox_named[0]
            out.append(f"- Xbox status named {', '.join(hit)} for {gt} at {at}: “{txt}”")
        if lobby_named:
            out.append(f"- Halo's lobby presence pointed at: {'; '.join(sorted(set(lobby_named)))}")
    else:
        out.append("**Verdict: neither source named the map or mode.** If you played a matchmade game during the probe, "
                   "auto-detect isn't possible this way and the one-tap picker is the way to go. If you didn't, run it again.")
    out += ["", "### Xbox status text over time"]
    if texts:
        for gt, lst in texts.items():
            out.append(f"- **{gt}**: " + " → ".join(f"{at} “{t}”" for at, t in lst))
    else:
        out.append("- Halo Infinite never showed up in Xbox presence for your accounts (not running, or privacy hides it).")
    out += ["", "### Halo lobby presence"]
    ok = [a for a in lobby.attempts if a["status"] == 200]
    out.append(f"- Request: {ok[0]['shape'] if ok else 'no shape worked'}; attempts: " + ", ".join(f"{a['shape']} → {a['status']}" for a in lobby.attempts[:8]))
    out.append(f"- Changes seen: {len(lobby_events)}; answers with match details: {len(match_seen)}")
    if match_seen:
        out.append(f"- First match details at {match_seen[0]['at']}")
    return "\n".join(out) + "\n"


async def main() -> None:
    minutes, poll = float(os.environ.get("MINUTES") or 25), float(os.environ.get("POLL") or 10)
    players = json.loads(Path("data/players.json").read_text()) if Path("data/players.json").exists() else {}
    mine = sorted(me_xuids(players)) or []
    maps = known_maps()
    async with ClientSession(timeout=ClientTimeout(total=20)) as http:
        sess = await sign_in(http, app_from_env(), os.environ["HALO_REFRESH_TOKEN"])
        save_refresh_token(sess.new_refresh_token)  # stored by the next step, as in the ingest
        xuids = sorted(set(mine) | {sess.xuid.strip("xuid()")})
        gamertags = {x: players.get(x, x) for x in xuids}
        print(f"Watching {', '.join(gamertags.values())} for {minutes:g} min, every {poll:g} s. Signed in as {sess.gamertag}.")
        lobby, names, timeline = Lobby(sess, xuids), {}, []
        last = {"xbox": None, "lobby": None}
        started, end = clock(), time.time() + minutes * 60
        while time.time() < end:
            for source in ("xbox", "lobby"):
                try:
                    status, data = await (xbox_presence(http, sess.xbl_auth, xuids) if source == "xbox" else lobby.poll(http))
                except Exception as e:  # network blip: note it, keep going
                    status, data = "error", {"error": f"{type(e).__name__}: {str(e)[:120]}"}
                data = redact(data, set(xuids))
                key = json.dumps([status, data], sort_keys=True)
                if key == last[source]:
                    continue
                last[source] = key
                entry = {"at": clock(), "source": source, "status": status, "data": data}
                if source == "lobby" and status == 200:
                    for path, aid, vid in asset_refs(data):
                        n = await asset_name(http, sess, names, path, aid, vid)
                        if n:
                            entry.setdefault("names", {})[path] = n
                timeline.append(entry)
                if source == "xbox" and isinstance(data, dict) and "error" not in data:
                    line = "; ".join(f"{gamertags.get(x, x)}: {u.get('state')}" + "".join(f" [{h.get('device')}] “{h.get('text')}”" for h in u.get("halo", [])) for x, u in data.items())
                else:
                    line = json.dumps(data)[:600] + (f"  names: {entry['names']}" if entry.get("names") else "")
                print(f"{entry['at']}  {source.upper():5} HTTP {status}  {line}")
            await asyncio.sleep(poll)
        report = summary(timeline, lobby, names, gamertags, maps, started)
    print(report)
    Path("probe.json").write_text(json.dumps({"timeline": timeline, "lobbyAttempts": lobby.attempts, "names": names}, indent=1))
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(report)


if __name__ == "__main__":
    asyncio.run(main())
