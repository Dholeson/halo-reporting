"""Pull new matches for tracked players and append raw match JSON to data/.

Layout:
  data/matches/YYYY-MM.jsonl   one raw match-stats JSON object per line
  data/players.json            {xuid: gamertag} for tracked players
  data/assets.json             {"<assetId>:<versionId>": "Public Name"}
  data/skill/YYYY-MM.jsonl     per-match skill: CSR before/after, team MMRs, expected kills/deaths
  data/gamertags.json          {xuid: gamertag} for people you play with often
  data/art/                    official map / mode art (resized) and the medal sprite sheet
  data/last.json               when the latest tracked game ended (drives hot/cool polling)
  data/players_meta.json       {xuid: {history, checked}}: total games Halo reports, for "N of M loaded"

Raw JSON on purpose: if Halo adds fields, nothing breaks, and the report can
start using them later without re-fetching.

Env:
  HALO_REFRESH_TOKEN, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   (required)
  MAX_NEW_MATCHES   cap on new matches per player per run (default 100)
  BACKFILL          "1" = keep paging past known matches to fill old history
  MATCH_TYPE        all | matchmaking | custom | local (default matchmaking)
  ONLY_PLAYERS      comma-separated gamertags or XUIDs: only pull history for these this run
  ONLY_ME           "1" = only poll accounts marked [me] (the frequent polls use this)
  TRACK_SELF        "1" = also track the account that signed in
  RATE              requests per second per Halo service (default 3)
  TOPUP             "1" = also backfill players (yours and scouted) whose stored history is incomplete
  TOPUP_MAX         cap on top-up matches per run (default 600)
  SKILL_MAX         max matches to enrich with skill data per run (default 600)
  GAMERTAG_MIN      resolve names for co-players seen at least this often (default 3)
"""

import asyncio
import io
import json
import os
import re
import time
from pathlib import Path

from aiohttp import ClientSession
from spnkr import HaloInfiniteClient

from halo.auth import app_from_env, save_refresh_token, sign_in
from halo.players import TAG_RE, XUID_RE, entry_xuid, tracked_entries

DATA = Path("data")
MATCHES = DATA / "matches"
PAGE = 25


def load_json(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


def dump_json(path: Path, obj: dict) -> None:
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n")


def known_match_ids() -> set[str]:
    ids = set()
    for f in MATCHES.glob("*.jsonl"):
        for line in f.read_text().splitlines():
            if line.strip():
                ids.add(json.loads(line)["MatchId"])
    return ids


def bare_xuid(x: str | int) -> str:
    """'xuid(123)' / '123' / 123 -> '123'. One format on disk, everywhere."""
    s = str(x).strip()
    return s[5:-1] if s.startswith("xuid(") else s


def why(e: Exception) -> str:
    """Short, secret-free description of a failed request (aiohttp errors carry status)."""
    status = getattr(e, "status", None)
    msg = getattr(e, "message", "") or str(e)
    return f"{type(e).__name__} {status or ''} {msg}".strip()[:200]


async def call(make, what: str, tries: int = 6):
    """Run a spnkr request and parse JSON, retrying 429s and 5xx with backoff.

    Honors Retry-After when Halo sends it. GitHub runners share IPs, so
    throttling can hit us even on the first request.
    """
    for attempt in range(tries):
        try:
            return await (await make()).json()
        except Exception as e:
            status = getattr(e, "status", None)
            if status != 429 and not (status and status >= 500) or attempt == tries - 1:
                raise
            headers = getattr(e, "headers", None) or {}
            try:
                wait = float(headers.get("Retry-After", ""))
            except ValueError:
                wait = 0
            wait = min(max(wait, 2 ** (attempt + 1)), 120)
            print(f"  {what}: HTTP {status}, retry {attempt + 1}/{tries - 1} in {wait:.0f}s"
                  f" (Retry-After={headers.get('Retry-After', 'none')})")
            await asyncio.sleep(wait)


# players.txt parsing lives in halo/players.py (shared with the report).
def tracked_gamertags() -> list[str]:
    return [e for e, _ in tracked_entries()]


async def new_match_ids(client, xuid: str, seen: set[str], cap: int, backfill: bool, match_type: str) -> list[str]:
    found: list[str] = []
    start = 0
    while len(found) < cap:
        page = await call(lambda: client.stats.get_match_history(xuid, start, PAGE, match_type), "history")
        results = page.get("Results", [])
        if not results:
            break
        for r in results:
            mid = r["MatchId"]
            if mid in seen or mid in found:
                if not backfill:
                    return found
                continue
            found.append(mid)
            if len(found) >= cap:
                break
        start += PAGE
    return found


async def asset_name(client, cache: dict, kind: str, asset: dict | None) -> None:
    if not asset:
        return
    key = f"{asset['AssetId']}:{asset['VersionId']}"
    if key in cache:
        return
    fetch = {
        "map": client.discovery_ugc.get_map,
        "mode": client.discovery_ugc.get_ugc_game_variant,
        "playlist": client.discovery_ugc.get_playlist,
    }[kind]
    try:
        cache[key] = (await call(lambda: fetch(asset["AssetId"], asset["VersionId"]), kind))["PublicName"]
    except Exception as e:  # deleted/private UGC assets 404; don't fail the run over a name
        print(f"  couldn't resolve {kind} {key}: {type(e).__name__}")
        cache[key] = None


SKILL = DATA / "skill"


def stored_counts(players: dict[str, str]) -> dict[str, int]:
    """Games stored locally per tracked xuid."""
    tracked = {f"xuid({x})": x for x in players}
    counts: dict[str, int] = {}
    for m in iter_matches():
        for p in m["Players"]:
            if x := tracked.get(p["PlayerId"]):
                counts[x] = counts.get(x, 0) + 1
    return counts


def iter_matches():
    for f in sorted(MATCHES.glob("*.jsonl")):
        for line in f.read_text().splitlines():
            if line.strip():
                yield json.loads(line)


async def enrich_skill(client, players: dict[str, str], limit: int) -> None:
    """CSR + expected performance per matchmade match. Failures are recorded so we don't retry forever."""
    SKILL.mkdir(exist_ok=True)
    done = set()
    for f in SKILL.glob("*.jsonl"):
        for line in f.read_text().splitlines():
            if line.strip():
                done.add(json.loads(line)["MatchId"])
    tracked = {f"xuid({x})" for x in players}
    todo = []
    for m in iter_matches():
        if m["MatchId"] in done or m["MatchInfo"].get("LifecycleMode") != 3:
            continue
        ours = [p["PlayerId"] for p in m["Players"] if p["PlayerId"] in tracked]
        if ours:
            todo.append((m["MatchInfo"]["StartTime"], m["MatchId"], ours))
    todo.sort(reverse=True)  # newest first
    print(f"Skill data: {len(todo)} matches missing, fetching up to {limit}")
    for i, (start, mid, ours) in enumerate(todo[:limit], 1):
        try:
            data = await call(lambda: client.skill.get_match_skill(mid, ours), "skill")
            row = {"MatchId": mid, "Value": data.get("Value", [])}
        except Exception as e:
            status = getattr(e, "status", None)
            if status == 429 or (status and status >= 500) or status is None:
                print(f"  stopping skill backfill: {why(e)}")
                return
            row = {"MatchId": mid, "Error": status}
        with open(SKILL / f"{start[:7]}.jsonl", "a") as f:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")
        if i % 50 == 0:
            print(f"  skill {i}/{min(limit, len(todo))}")


async def resolve_gamertags(client, players: dict[str, str], min_seen: int) -> None:
    """Names for people you play with/against repeatedly (squadmates, rivals)."""
    path = DATA / "gamertags.json"
    cache = load_json(path)
    tracked = {f"xuid({x})" for x in players}
    seen: dict[str, int] = {}
    for m in iter_matches():
        if not any(p["PlayerId"] in tracked for p in m["Players"]):
            continue
        for p in m["Players"]:
            pid = p["PlayerId"]
            if pid not in tracked and p.get("PlayerType") == 1:
                seen[pid] = seen.get(pid, 0) + 1
    want = [bare_xuid(x) for x, n in seen.items() if n >= min_seen and bare_xuid(x) not in cache]
    print(f"Gamertags: {len(want)} frequent co-players to resolve")
    for i in range(0, len(want), 50):
        batch = want[i:i + 50]
        try:
            users = await call(lambda: client.profile.get_users_by_id(batch), "gamertags")
        except Exception as e:
            print(f"  stopping gamertag lookup: {why(e)}")
            break
        for u in users:
            cache[bare_xuid(u["xuid"])] = u["gamertag"]
    dump_json(path, cache)


ART = DATA / "art"


def _end_ts(m: dict) -> int:
    from datetime import datetime

    from halo.report import secs

    info = m["MatchInfo"]
    start = datetime.fromisoformat(info["StartTime"].replace("Z", "+00:00")).timestamp()
    return int(start + secs(info.get("Duration")))


def update_markers(fetched: list[dict], me: set[str], full_run: bool) -> None:
    """data/last.json drives the workflow's gate:
    - last_game_end: when one of YOUR games last ended (hot 5-minute polling for 3 hours after).
      Scouted players' games don't count, or scouting an active player would keep polling hot.
    - last_full: when everyone (scouted players too) was last refreshed; the gate upgrades the
      next poll to a full refresh once this is 6 hours old.
    Only rewritten when something changes, so quiet polls produce no commit."""
    path = DATA / "last.json"
    cur = load_json(path)
    mine = {f"xuid({x})" for x in me}
    pool = fetched if "me_only" in cur else list(iter_matches())  # first run under this format: full scan
    ends = [_end_ts(m) for m in pool if any(p["PlayerId"] in mine for p in m["Players"])]
    new = dict(cur)
    new["me_only"] = True
    new["last_game_end"] = max([cur.get("last_game_end", 0) if "me_only" in cur else 0, *ends])
    if full_run:
        new["last_full"] = int(time.time())
    if new != cur:
        dump_json(path, new)


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "x"


def _jpeg(raw: bytes, width: int, quality: int) -> bytes:
    from PIL import Image  # only needed when art is fetched

    im = Image.open(io.BytesIO(raw)).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "JPEG", quality=quality, optimize=True, progressive=True)
    return out.getvalue()


def _pick_image(files: dict) -> str | None:
    """Prefer the wide hero shot, then screenshots, then the thumbnail."""
    imgs = [p for p in (files.get("FileRelativePaths") or []) if p.lower().endswith((".jpg", ".jpeg", ".png"))]
    for want in ("hero", "screenshot", "thumbnail"):
        for p in imgs:
            if want in p.lower():
                return p
    return imgs[0] if imgs else None


async def _download(http, url: str) -> bytes:
    async with http.get(url) as resp:
        resp.raise_for_status()
        return await resp.read()


async def fetch_art(http, client, players: dict[str, str], assets: dict, min_games: int = 2) -> None:
    """Official artwork for the maps and modes you play, plus the medal sprite sheet.

    Images are resized and committed so Pages serves them directly (no auth, no hotlinking).
    """
    from halo.report import FAMILY

    manifest = load_json(ART / "manifest.json") or {}
    manifest.setdefault("maps", {})
    manifest.setdefault("modes", {})
    tracked = {f"xuid({x})" for x in players}
    maps: dict[str, dict] = {}
    modes: dict[str, dict] = {}
    for m in iter_matches():
        if not any(p["PlayerId"] in tracked for p in m["Players"]):
            continue
        info = m["MatchInfo"]
        if a := info.get("MapVariant"):
            name = (assets.get(f"{a['AssetId']}:{a['VersionId']}") or "").split(" - ")[0]
            if name:
                d = maps.setdefault(name, {})
                d[(a["AssetId"], a["VersionId"])] = d.get((a["AssetId"], a["VersionId"]), 0) + 1
        if (a := info.get("UgcGameVariant")) and (fam := FAMILY.get(info.get("GameVariantCategory"))):
            d = modes.setdefault(fam, {})
            d[(a["AssetId"], a["VersionId"])] = d.get((a["AssetId"], a["VersionId"]), 0) + 1

    jobs = []
    for kind, groups, fetch in (("maps", maps, client.discovery_ugc.get_map), ("modes", modes, client.discovery_ugc.get_ugc_game_variant)):
        for name, variants in sorted(groups.items(), key=lambda kv: -sum(kv[1].values())):
            if name in manifest[kind] or sum(variants.values()) < min_games:
                continue
            jobs.append((kind, name, max(variants, key=variants.get), fetch))
    print(f"Art: {len(jobs)} maps/modes to fetch")
    (ART / "maps").mkdir(parents=True, exist_ok=True)
    (ART / "modes").mkdir(parents=True, exist_ok=True)
    for i, (kind, name, (aid, vid), fetch) in enumerate(jobs, 1):
        try:
            asset = await call(lambda: fetch(aid, vid), kind)
            files = asset.get("Files") or {}
            rel = _pick_image(files)
            if not rel:
                manifest[kind][name] = None
                continue
            raw = await _download(http, files["Prefix"].rstrip("/") + "/" + rel.lstrip("/"))
            base = f"{kind}/{slug(name)}"
            (ART / f"{base}.jpg").write_bytes(_jpeg(raw, 1280, 74))
            (ART / f"{base}-thumb.jpg").write_bytes(_jpeg(raw, 400, 70))
            manifest[kind][name] = {"hero": f"art/{base}.jpg", "thumb": f"art/{base}-thumb.jpg"}
        except Exception as e:
            status = getattr(e, "status", None)
            if status in (400, 401, 403, 404):
                manifest[kind][name] = None  # permanent: don't retry every run
            else:
                print(f"  art paused at {name}: {why(e)}")
                break
        if i % 20 == 0:
            dump_json(ART / "manifest.json", manifest)

    if not manifest.get("medals"):
        stage = "metadata"
        try:
            meta = await call(lambda: client.gamecms_hacs.get_medal_metadata(), "medals")
            sprites = meta.get("sprites") or meta.get("Sprites") or {}
            stage = f"sprite sheet (keys: {sorted(sprites)[:6]})"
            sheet = sprites.get("small") or sprites.get("medium") or next(iter(sprites.values()))
            stage = f"image {sheet.get('path')}"
            png = await (await client.gamecms_hacs.get_image(sheet["path"])).read()
            (ART / "medals.png").write_bytes(png)
            medals = meta.get("medals") or meta.get("Medals") or []
            manifest["medals"] = {
                "sheet": "art/medals.png", "columns": sheet["columns"], "size": sheet["size"],
                "sprite": {str(md.get("nameId", md.get("NameId"))): md.get("spriteIndex", md.get("SpriteIndex")) for md in medals},
            }
            manifest.pop("medals_error", None)
        except Exception as e:
            # Recorded in the committed manifest: Actions logs aren't always easy to get at.
            manifest["medals_error"] = f"{stage}: {why(e)}"
            print(f"  medal art skipped at {stage}: {why(e)}")
    dump_json(ART / "manifest.json", manifest)


async def main() -> None:
    cap = int(os.environ.get("MAX_NEW_MATCHES", "100"))
    backfill = os.environ.get("BACKFILL") == "1"
    match_type = os.environ.get("MATCH_TYPE", "matchmaking")
    MATCHES.mkdir(parents=True, exist_ok=True)

    async with ClientSession() as http:
        me = await sign_in(http, app_from_env(), os.environ["HALO_REFRESH_TOKEN"])
        # Save the rotated token immediately, so a later crash can't strand us on a dead one.
        save_refresh_token(me.new_refresh_token)
        print(f"Signed in as {me.gamertag}")

        client = HaloInfiniteClient(http, me.spartan_token, me.clearance_token, requests_per_second=int(os.environ.get("RATE", "3")))

        # players.txt is the source of truth (gamertags or XUIDs); players.json caches xuid -> gamertag.
        known = {bare_xuid(k): v for k, v in load_json(DATA / "players.json").items()}
        by_gt = {v.lower(): k for k, v in known.items()}
        entries = tracked_entries()
        if os.environ.get("TRACK_SELF") == "1":
            entries.append((me.gamertag, False))
            by_gt[me.gamertag.lower()] = bare_xuid(me.xuid)

        players: dict[str, str] = {}
        me_xuids: set[str] = set()
        not_found: set[str] = set()
        aliases: dict[str, str] = {}  # entry as typed (lowercased) -> xuid, for ONLY_PLAYERS matching
        for entry, is_me in entries:
            if x := entry_xuid(entry):
                xuid = x
                gt = known.get(xuid)
                if not gt:
                    try:
                        gt = (await call(lambda: client.profile.get_user_by_id(xuid), "profile"))["gamertag"]
                    except Exception as e:
                        print(f"::warning::Couldn't look up XUID {xuid}: {why(e)}")
                        if not is_me and (getattr(e, "status", None) == 404 or type(e).__name__ == "InvalidXuidError"):
                            not_found.add(entry)
                        continue
            elif entry.lower() in by_gt:
                xuid, gt = by_gt[entry.lower()], known.get(by_gt[entry.lower()], entry)
            else:
                try:
                    # "Name#1234": a raw '#' starts a URL fragment and the lookup would ask for "Name".
                    user = await call(lambda: client.profile.get_user_by_gamertag(entry.replace("#", "%23")), "profile")
                except Exception as e:
                    print(f"::warning::Couldn't find gamertag {entry!r}: {why(e)}")
                    if getattr(e, "status", None) == 404 and not is_me:
                        not_found.add(entry)
                    continue
                xuid, gt = bare_xuid(user["xuid"]), user["gamertag"]
            players[xuid] = gt
            aliases[entry.lower()] = aliases[gt.lower()] = aliases[xuid] = xuid
            if is_me:
                me_xuids.add(xuid)
        dump_json(DATA / "players.json", players)
        if not_found:  # a typo'd scout shouldn't warn on every run forever
            path = Path("players.txt")
            keep = [l for l in path.read_text().splitlines() if TAG_RE.sub("", l).strip() not in not_found]
            path.write_text("\n".join(keep) + "\n")
            print(f"Removed unknown players from players.txt: {', '.join(sorted(not_found))}")

        only = {aliases.get(g.strip().lower(), g.strip().lower()) for g in os.environ.get("ONLY_PLAYERS", "").split(",") if g.strip()}
        only = {aliases.get(m.group(1), m.group(1)) if (m := XUID_RE.match(o)) else o for o in only}
        only_me = os.environ.get("ONLY_ME") == "1" and bool(me_xuids)
        meta = load_json(DATA / "players_meta.json")
        seen = known_match_ids()
        todo: list[str] = []
        now = int(time.time())
        for xuid, gt in players.items():
            if only and xuid not in only:
                continue
            if only_me and xuid not in me_xuids:
                continue
            try:
                ids = await new_match_ids(client, xuid, seen | set(todo), cap, backfill, match_type)
            except Exception as e:
                print(f"::warning::{gt}: couldn't read match history: {why(e)}")
                continue
            print(f"{gt} (xuid {xuid}): {len(ids)} new {match_type} matches")
            todo += ids
            # How many games Halo says exist, so the report can show "N of M loaded".
            if backfill or now - meta.get(xuid, {}).get("checked", 0) > 86400:
                try:
                    c = await call(lambda: client.stats.get_match_count(xuid), "count")
                    key = {"matchmaking": "MatchmadeMatchesPlayedCount", "custom": "CustomMatchesPlayedCount", "local": "LocalMatchesPlayedCount"}.get(match_type, "MatchesPlayedCount")
                    meta[xuid] = {"history": c.get(key), "checked": now}
                except Exception as e:
                    print(f"  couldn't read match count for {gt}: {why(e)}")
        dump_json(DATA / "players_meta.json", meta)

        # Scouted players start with their newest games; fill in the rest a slice at a time.
        if os.environ.get("TOPUP") == "1":
            budget = int(os.environ.get("TOPUP_MAX", "600"))
            have = stored_counts(players)
            for xuid, gt in players.items():
                hist = (meta.get(xuid) or {}).get("history") or 0
                if budget <= 0 or not hist or have.get(xuid, 0) >= hist * 0.97:
                    continue
                try:
                    ids = await new_match_ids(client, xuid, seen | set(todo), budget, True, match_type)
                except Exception as e:
                    print(f"::warning::{gt}: top-up failed: {why(e)}")
                    continue
                print(f"{gt}: topping up history with {len(ids)} older matches ({have.get(xuid, 0)} of ~{hist} stored)")
                todo += ids
                budget -= len(ids)

        assets = load_json(DATA / "assets.json")
        stored = 0
        fetched: list[dict] = []
        for i, mid in enumerate(todo, 1):
            try:
                match = await call(lambda: client.stats.get_match_stats(mid), "match")
            except Exception as e:
                print(f"  skipped match {mid}: {why(e)}")
                continue
            info = match["MatchInfo"]
            await asset_name(client, assets, "map", info.get("MapVariant"))
            await asset_name(client, assets, "mode", info.get("UgcGameVariant"))
            await asset_name(client, assets, "playlist", info.get("Playlist"))
            with open(MATCHES / f"{info['StartTime'][:7]}.jsonl", "a") as f:
                f.write(json.dumps(match, separators=(",", ":")) + "\n")
            stored += 1
            fetched.append(match)
            if i % 25 == 0:
                print(f"  fetched {i}/{len(todo)}")
                dump_json(DATA / "assets.json", assets)

        dump_json(DATA / "assets.json", assets)
        update_markers(fetched, me_xuids or set(players), full_run=not only and not only_me)
        print(f"Stored {stored} new matches.")

        # Enrichment is best-effort: never let it fail the run.
        for step in (
            enrich_skill(client, players, int(os.environ.get("SKILL_MAX", "600"))),
            resolve_gamertags(client, players, int(os.environ.get("GAMERTAG_MIN", "3"))),
            fetch_art(http, client, players, assets),
        ):
            try:
                await step
            except Exception as e:
                print(f"::warning::enrichment step failed: {why(e)}")


if __name__ == "__main__":
    asyncio.run(main())
