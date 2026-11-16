"""Pull new matches for tracked players and append raw match JSON to data/.

Layout:
  data/matches/YYYY-MM.jsonl   one raw match-stats JSON object per line
  data/players.json            {xuid: gamertag} for tracked players
  data/assets.json             {"<assetId>:<versionId>": "Public Name"}

Raw JSON on purpose: if Halo adds fields, nothing breaks, and the report can
start using them later without re-fetching.

Env:
  HALO_REFRESH_TOKEN, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   (required)
  MAX_NEW_MATCHES   cap on new matches per player per run (default 100)
  BACKFILL          "1" = keep paging past known matches to fill old history
  MATCH_TYPE        all | matchmaking | custom | local (default matchmaking)
  ONLY_PLAYERS      comma-separated gamertags: only pull history for these this run
  TRACK_SELF        "1" = also track the account that signed in
"""

import asyncio
import json
import os
from pathlib import Path

from aiohttp import ClientSession
from spnkr import HaloInfiniteClient

from halo.auth import app_from_env, save_refresh_token, sign_in

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


def tracked_gamertags() -> list[str]:
    path = Path("players.txt")
    if not path.exists():
        return []
    lines = (l.strip() for l in path.read_text().splitlines())
    return [l for l in lines if l and not l.startswith("#")]


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

        client = HaloInfiniteClient(http, me.spartan_token, me.clearance_token, requests_per_second=2)

        # players.txt is the source of truth; players.json just caches gamertag -> xuid.
        cache = {v.lower(): bare_xuid(k) for k, v in load_json(DATA / "players.json").items()}
        wanted = tracked_gamertags()
        if os.environ.get("TRACK_SELF") == "1":
            wanted.append(me.gamertag)
            cache[me.gamertag.lower()] = bare_xuid(me.xuid)

        players: dict[str, str] = {}
        for gt in wanted:
            if gt.lower() in cache:
                players[cache[gt.lower()]] = gt
                continue
            try:
                user = await call(lambda: client.profile.get_user_by_gamertag(gt), "profile")
            except Exception as e:
                print(f"::warning::Couldn't find gamertag {gt!r}: {why(e)}")
                continue
            players[bare_xuid(user["xuid"])] = user["gamertag"]
        dump_json(DATA / "players.json", players)

        only = {g.strip().lower() for g in os.environ.get("ONLY_PLAYERS", "").split(",") if g.strip()}
        seen = known_match_ids()
        todo: list[str] = []
        for xuid, gt in players.items():
            if only and gt.lower() not in only:
                continue
            try:
                ids = await new_match_ids(client, xuid, seen | set(todo), cap, backfill, match_type)
            except Exception as e:
                print(f"::warning::{gt}: couldn't read match history: {why(e)}")
                continue
            print(f"{gt} (xuid {xuid}): {len(ids)} new {match_type} matches")
            todo += ids

        assets = load_json(DATA / "assets.json")
        stored = 0
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
            if i % 25 == 0:
                print(f"  fetched {i}/{len(todo)}")
                dump_json(DATA / "assets.json", assets)

        dump_json(DATA / "assets.json", assets)
        print(f"Stored {stored} new matches.")


if __name__ == "__main__":
    asyncio.run(main())
