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
        page = await (await client.stats.get_match_history(xuid, start, PAGE, match_type)).json()
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
        cache[key] = (await (await fetch(asset["AssetId"], asset["VersionId"])).json())["PublicName"]
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

        client = HaloInfiniteClient(http, me.spartan_token, me.clearance_token, requests_per_second=3)

        players = {bare_xuid(k): v for k, v in load_json(DATA / "players.json").items()}
        players[bare_xuid(me.xuid)] = me.gamertag
        for gt in tracked_gamertags():
            if gt.lower() in (g.lower() for g in players.values()):
                continue
            user = await (await client.profile.get_user_by_gamertag(gt)).json()
            players[bare_xuid(user["xuid"])] = user["gamertag"]

        seen = known_match_ids()
        todo: list[str] = []
        for xuid, gt in players.items():
            ids = await new_match_ids(client, xuid, seen | set(todo), cap, backfill, match_type)
            print(f"{gt} (xuid {xuid}): {len(ids)} new {match_type} matches")
            todo += ids

        assets = load_json(DATA / "assets.json")
        by_month: dict[str, list[str]] = {}
        for i, mid in enumerate(todo, 1):
            match = await (await client.stats.get_match_stats(mid)).json()
            info = match["MatchInfo"]
            await asset_name(client, assets, "map", info.get("MapVariant"))
            await asset_name(client, assets, "mode", info.get("UgcGameVariant"))
            await asset_name(client, assets, "playlist", info.get("Playlist"))
            by_month.setdefault(info["StartTime"][:7], []).append(json.dumps(match, separators=(",", ":")))
            if i % 25 == 0:
                print(f"  fetched {i}/{len(todo)}")

        for month, lines in by_month.items():
            with open(MATCHES / f"{month}.jsonl", "a") as f:
                f.write("\n".join(lines) + "\n")
        dump_json(DATA / "players.json", players)
        dump_json(DATA / "assets.json", assets)
        print(f"Stored {len(todo)} new matches.")


if __name__ == "__main__":
    asyncio.run(main())
