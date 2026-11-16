"""Pull new matches for tracked players and append raw match JSON to data/.

Layout:
  data/matches/YYYY-MM.jsonl   one raw match-stats JSON object per line
  data/players.json            {xuid: gamertag} for tracked players
  data/assets.json             {"<assetId>:<versionId>": "Public Name"}
  data/skill/YYYY-MM.jsonl     per-match skill: CSR before/after, team MMRs, expected kills/deaths
  data/gamertags.json          {xuid: gamertag} for people you play with often
  data/art/                    official map / mode art (resized) and the medal sprite sheet

Raw JSON on purpose: if Halo adds fields, nothing breaks, and the report can
start using them later without re-fetching.

Env:
  HALO_REFRESH_TOKEN, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   (required)
  MAX_NEW_MATCHES   cap on new matches per player per run (default 100)
  BACKFILL          "1" = keep paging past known matches to fill old history
  MATCH_TYPE        all | matchmaking | custom | local (default matchmaking)
  ONLY_PLAYERS      comma-separated gamertags: only pull history for these this run
  TRACK_SELF        "1" = also track the account that signed in
  SKILL_MAX         max matches to enrich with skill data per run (default 600)
  GAMERTAG_MIN      resolve names for co-players seen at least this often (default 3)
"""

import asyncio
import io
import json
import os
import re
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
    # "Gamertag [me]" marks your own accounts; the tag is for the report, not the API.
    return [re.sub(r"\s*\[[^\]]*\]\s*$", "", l) for l in lines if l and not l.startswith("#")]


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
        try:
            meta = await call(lambda: client.gamecms_hacs.get_medal_metadata(), "medals")
            sheet = meta["sprites"]["small"]
            png = await (await client.gamecms_hacs.get_image(sheet["path"])).read()
            (ART / "medals.png").write_bytes(png)
            manifest["medals"] = {
                "sheet": "art/medals.png", "columns": sheet["columns"], "size": sheet["size"],
                "sprite": {str(md["nameId"]): md["spriteIndex"] for md in meta.get("medals", [])},
            }
        except Exception as e:
            print(f"  medal art skipped: {why(e)}")
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
