"""Build the static site: copy web/ into site/ and export the data it reads.

site/data.json     one row per tracked player per match (column-oriented, compact)
site/lobbies.json  per-match scoreboard for every player, loaded lazily by match details
site/player_matches.parquet  the same rows, for anyone who wants to poke at it in DuckDB/pandas

Everything is precomputed here except the analysis itself, which runs in the
browser so filters are instant.
"""

import hashlib
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

from halo.players import me_xuids

DATA = Path("data")
SITE = Path("site")
WEB = Path("web")

FAMILY = {
    6: "Slayer", 8: "Elimination", 9: "Fiesta", 11: "Strongholds", 12: "King of the Hill",
    14: "Total Control", 15: "Capture the Flag", 17: "Extraction", 18: "Oddball",
    22: "Infection & Minigames", 23: "VIP", 24: "Escalation", 41: "Assault", 42: "Firefight",
}
EXPERIENCE = {2: "Arena", 3: "Big Team", 4: "Bots", 5: "Featured"}
OUTCOME = {1: "T", 2: "W", 3: "L", 4: "D"}


def secs(d) -> float:
    m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?", d or "")
    if not m:
        return 0.0
    h, mi, s = (float(x) if x else 0.0 for x in m.groups())
    return round(h * 3600 + mi * 60 + s, 1)


def num(v, digits: int | None = None):
    """A finite number or None. Halo sends "NaN" (as a string) when it can't compute a value,
    and a float NaN would write JSON that browsers refuse to parse."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):
        return None
    return round(f, digits) if digits is not None else f


def load(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def jsonl(folder: Path):
    for f in sorted(folder.glob("*.jsonl")):
        for line in f.read_text().splitlines():
            if line.strip():
                yield json.loads(line)


def bare(pid: str) -> str:
    return pid[5:-1] if pid.startswith("xuid(") else pid


class Index:
    """String -> small int, so the JSON carries numbers instead of repeated names."""

    def __init__(self):
        self.items: list[str] = []
        self.pos: dict[str, int] = {}

    def __call__(self, s: str) -> int:
        if s not in self.pos:
            self.pos[s] = len(self.items)
            self.items.append(s)
        return self.pos[s]


def medal_names() -> dict[int, str]:
    try:
        from spnkr.models.refdata import MedalNameId
        return {m.value: m.display_name for m in MedalNameId}
    except Exception:
        return {}


def core(p) -> dict:
    """Sum CoreStats across teams (a player can switch teams mid-match)."""
    out: dict = {}
    for t in p.get("PlayerTeamStats", []):
        c = t["Stats"]["CoreStats"]
        for k in ("Kills", "Deaths", "Assists", "HeadshotKills", "MeleeKills", "GrenadeKills",
                  "PowerWeaponKills", "ShotsFired", "ShotsHit", "DamageDealt", "DamageTaken",
                  "PersonalScore", "CalloutAssists", "MaxKillingSpree", "Spawns",
                  "ObjectivesCompleted", "VehicleDestroys", "Hijacks", "Betrayals", "Suicides"):
            v = c.get(k, 0) or 0
            out[k] = max(out.get(k, 0), v) if k == "MaxKillingSpree" else out.get(k, 0) + v
        out["life"] = secs(c.get("AverageLifeDuration"))
        for md in c.get("Medals", []):
            out.setdefault("medals", {})
            out["medals"][md["NameId"]] = out["medals"].get(md["NameId"], 0) + md["Count"]
    return out


def objective(p) -> tuple[float, float, float]:
    """(objective time s, objective actions, objective-related kills), mode-agnostic."""
    t = a = k = 0.0
    for team in p.get("PlayerTeamStats", []):
        st = team["Stats"]
        if z := st.get("ZonesStats"):
            t += secs(z.get("ZoneOccupationTime") or z.get("StrongholdOccupationTime"))
            a += (z.get("ZoneCaptures", 0) or 0) + (z.get("StrongholdCaptures", 0) or 0) + (z.get("StrongholdSecures", 0) or 0)
            k += (z.get("ZoneDefensiveKills", 0) or 0) + (z.get("ZoneOffensiveKills", 0) or 0) \
                + (z.get("StrongholdDefensiveKills", 0) or 0) + (z.get("StrongholdOffensiveKills", 0) or 0)
        if c := st.get("CaptureTheFlagStats"):
            t += secs(c.get("TimeAsFlagCarrier"))
            a += (c.get("FlagCaptures", 0) or 0) * 3 + (c.get("FlagReturns", 0) or 0) + (c.get("FlagGrabs", 0) or 0)
            k += (c.get("FlagCarriersKilled", 0) or 0) + (c.get("FlagReturnersKilled", 0) or 0)
        if o := st.get("OddballStats"):
            t += secs(o.get("TimeAsSkullCarrier"))
            a += o.get("SkullGrabs", 0) or 0
            k += o.get("SkullCarriersKilled", 0) or 0
    return round(t, 1), a, k


def main() -> None:
    if SITE.exists():
        shutil.rmtree(SITE)
    shutil.copytree(WEB, SITE)
    art = load(DATA / "art" / "manifest.json", {})
    if (DATA / "art").exists():
        shutil.copytree(DATA / "art", SITE / "art", ignore=shutil.ignore_patterns("manifest.json"))

    players = load(DATA / "players.json", {})
    assets = load(DATA / "assets.json", {})
    gamertags = load(DATA / "gamertags.json", {})
    tracked = {f"xuid({x})": i for i, x in enumerate(players)}
    names = medal_names()
    me = me_xuids(players)  # same parsing as the ingest (halo/players.py)

    skill: dict[str, dict] = {}
    for s in jsonl(DATA / "skill"):
        for v in s.get("Value", []) or []:
            if v.get("ResultCode", 0) == 0 and v.get("Result"):
                skill[f"{s['MatchId']}|{v['Id']}"] = v["Result"]

    maps, mapvs, modes, playlists, families, tiers, seasons, medal_ix = (Index() for _ in range(8))
    xuid_ix = Index()  # co-players, for squad/rival analysis

    def asset(a) -> str | None:
        return assets.get(f"{a['AssetId']}:{a['VersionId']}") if a else None

    cols = ["mid", "t", "dur", "p", "map", "mapv", "mode", "fam", "pl", "ranked", "exp", "out", "place",
            "k", "d", "a", "hs", "mel", "gren", "pw", "sf", "sh", "dd", "dt", "life", "spree", "ps",
            "call", "spawns", "objt", "obja", "objk", "done", "jip",
            "lobby", "lobbyK", "lobbyDD", "dmgRank", "kRank", "teamK", "teamD", "teamDD", "enemyK", "enemyD", "teamScore", "enemyScore",
            "season", "csrPre", "csrPost", "tier", "mmr", "mmrEnemy", "xk", "xd", "xkSd", "xdSd",
            "teams", "mates", "foes", "medals"]
    rows: list[list] = []
    lobbies: dict[str, list] = {}

    done: set[str] = set()
    for m in jsonl(DATA / "matches"):
        info = m["MatchInfo"]
        ours = [p for p in m["Players"] if p["PlayerId"] in tracked and p.get("PlayerTeamStats")]
        mid = m["MatchId"]
        if not ours or mid in done:  # a match can only count once, even if it was stored twice
            continue
        done.add(mid)
        t = int(datetime.fromisoformat(info["StartTime"].replace("Z", "+00:00")).timestamp())
        dur = secs(info.get("Duration"))
        mapv = asset(info.get("MapVariant")) or "Unknown map"
        mode = asset(info.get("UgcGameVariant")) or "Unknown mode"
        pl = asset(info.get("Playlist")) or ("Custom game" if info.get("LifecycleMode") != 3 else "Unknown playlist")
        fam = FAMILY.get(info.get("GameVariantCategory"), "Other")
        humans = [p for p in m["Players"] if p.get("PlayerTeamStats")]
        stats = {p["PlayerId"]: core(p) for p in humans}
        team_scores = {tm["TeamId"]: tm["Stats"]["CoreStats"].get("Score", 0) for tm in m.get("Teams", [])}
        by_dmg = sorted(humans, key=lambda p: -stats[p["PlayerId"]].get("DamageDealt", 0))
        by_k = sorted(humans, key=lambda p: -stats[p["PlayerId"]].get("Kills", 0))

        # lobby scoreboard (lazy-loaded by the match drawer)
        lobbies[mid] = [[
            bare(p["PlayerId"]), p.get("LastTeamId", 0), OUTCOME.get(p.get("Outcome"), "?"), p.get("Rank", 0),
            stats[p["PlayerId"]].get("Kills", 0), stats[p["PlayerId"]].get("Deaths", 0), stats[p["PlayerId"]].get("Assists", 0),
            stats[p["PlayerId"]].get("DamageDealt", 0), stats[p["PlayerId"]].get("DamageTaken", 0),
            round(100 * stats[p["PlayerId"]].get("ShotsHit", 0) / max(stats[p["PlayerId"]].get("ShotsFired", 0), 1), 1),
            stats[p["PlayerId"]].get("PersonalScore", 0), 1 if p.get("PlayerType") == 2 else 0,
        ] for p in humans]

        for p in ours:
            c = stats[p["PlayerId"]]
            team = p.get("LastTeamId", 0)
            mates = [q for q in humans if q.get("LastTeamId") == team and q is not p]
            foes = [q for q in humans if q.get("LastTeamId") != team]
            sum_ = lambda ps, k: sum(stats[q["PlayerId"]].get(k, 0) for q in ps)
            enemy_scores = [v for k, v in team_scores.items() if k != team]
            sk = skill.get(f"{mid}|{p['PlayerId']}") or {}
            rr = sk.get("RankRecap") or {}
            pre, post = rr.get("PreMatchCsr") or {}, rr.get("PostMatchCsr") or {}
            perf = sk.get("StatPerformances") or {}
            mmrs = sk.get("TeamMmrs") or {}
            enemy_mmr = [x for k, v in mmrs.items() if str(k) != str(team) and (x := num(v)) is not None]
            stat = lambda kind, field: num(((perf.get(kind) or {}).get(field)), 2)
            pre_v, post_v = num(pre.get("Value")), num(post.get("Value"))
            objt, obja, objk = objective(p)
            part = p.get("ParticipationInfo") or {}
            medals = c.get("medals", {})
            tier = ""
            if post.get("Tier") and post_v is not None and post_v >= 0:
                tier = post["Tier"] if post["Tier"] == "Onyx" else f"{post['Tier']} {post.get('SubTier', 0) + 1}"
            season = (info.get("SeasonId") or "").rsplit("/", 1)[-1].replace(".json", "").replace("CsrSeason", "Season ")
            rows.append([
                mid, t, dur, tracked[p["PlayerId"]], maps(mapv.split(" - ")[0]), mapvs(mapv), modes(mode), families(fam),
                playlists(pl), 1 if "Ranked" in pl else 0, EXPERIENCE.get(info.get("PlaylistExperience"), "Other"),
                OUTCOME.get(p.get("Outcome"), "?"), p.get("Rank", 0),
                c.get("Kills", 0), c.get("Deaths", 0), c.get("Assists", 0), c.get("HeadshotKills", 0),
                c.get("MeleeKills", 0), c.get("GrenadeKills", 0), c.get("PowerWeaponKills", 0),
                c.get("ShotsFired", 0), c.get("ShotsHit", 0), c.get("DamageDealt", 0), c.get("DamageTaken", 0),
                c.get("life", 0), c.get("MaxKillingSpree", 0), c.get("PersonalScore", 0),
                c.get("CalloutAssists", 0), c.get("Spawns", 0), objt, obja, objk,
                1 if part.get("PresentAtCompletion", True) else 0, 1 if part.get("JoinedInProgress") else 0,
                len(humans), sum(stats[q["PlayerId"]].get("Kills", 0) for q in humans),
                sum(stats[q["PlayerId"]].get("DamageDealt", 0) for q in humans),
                by_dmg.index(p) + 1, by_k.index(p) + 1,
                sum_(mates, "Kills") + c.get("Kills", 0), sum_(mates, "Deaths") + c.get("Deaths", 0),
                sum_(mates, "DamageDealt") + c.get("DamageDealt", 0), sum_(foes, "Kills"), sum_(foes, "Deaths"),
                team_scores.get(team), max(enemy_scores) if enemy_scores else None,
                seasons(season) if season else None,
                int(pre_v) if pre_v is not None and pre_v >= 0 else None,
                int(post_v) if post_v is not None and post_v >= 0 else None,
                tiers(tier) if tier else None,
                num(sk.get("TeamMmr"), 0),
                round(sum(enemy_mmr) / len(enemy_mmr)) if enemy_mmr else None,
                stat("Kills", "Expected"),
                stat("Deaths", "Expected"),
                stat("Kills", "StdDev"),
                stat("Deaths", "StdDev"),
                0 if info.get("TeamsEnabled") is False else 1,
                [xuid_ix(bare(q["PlayerId"])) for q in mates if q.get("PlayerType") == 1],
                [xuid_ix(bare(q["PlayerId"])) for q in foes if q.get("PlayerType") == 1],
                [[medal_ix(k), v] for k, v in sorted(medals.items(), key=lambda kv: -kv[1])],
            ])

    rows.sort(key=lambda r: r[1])
    meta = load(DATA / "players_meta.json", {})
    player_xuids = list(players)
    stored_by = {}
    for r in rows:
        stored_by[r[3]] = stored_by.get(r[3], 0) + 1

    # Keep co-players seen 2+ times (squadmates, rivals); one-offs are noise and bloat.
    mi, fi = cols.index("mates"), cols.index("foes")
    seen_count: dict[int, int] = {}
    for r in rows:
        for i in r[mi] + r[fi]:
            seen_count[i] = seen_count.get(i, 0) + 1
    keep = sorted(i for i, n in seen_count.items() if n >= 2)
    remap = {old: new for new, old in enumerate(keep)}
    for r in rows:
        r[mi] = [remap[i] for i in r[mi] if i in remap]
        r[fi] = [remap[i] for i in r[fi] if i in remap]
    name_of = lambda x: gamertags.get(x) or players.get(x)
    people = [[xuid_ix.items[i], name_of(xuid_ix.items[i]), seen_count[i]] for i in keep]
    SITE.joinpath("data").mkdir(exist_ok=True)
    payload = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "aliases": load(DATA / "aliases.json", {}),
        "players": [{"xuid": x, "gamertag": g, "me": x in me,
                     "stored": stored_by.get(i, 0), "history": (meta.get(x) or {}).get("history")}
                    for i, (x, g) in enumerate(players.items())],
        "maps": maps.items, "mapVariants": mapvs.items, "modes": modes.items, "playlists": playlists.items,
        "families": families.items, "tiers": tiers.items, "seasons": seasons.items,
        "people": people,
        "medals": [names.get(k, f"Medal {k}") for k in medal_ix.items],
        "art": {
            "maps": {k: v for k, v in (art.get("maps") or {}).items() if v},
            "modes": {k: v for k, v in (art.get("modes") or {}).items() if v},
            "medals": {**{k: v for k, v in art["medals"].items() if k != "sprite"},
                       "sprite": [art["medals"]["sprite"].get(str(k)) for k in medal_ix.items]} if art.get("medals") else None,
        },
        "cols": cols, "rows": rows,
    }
    # Same data, same digest: a rebuild that found nothing new (a quiet check, a code deploy) is
    # recognisably identical, so open tabs neither reload nor announce "fresh data".
    same = {k: v for k, v in payload.items() if k != "generated"}
    payload["digest"] = hashlib.sha1(json.dumps(same, separators=(",", ":"), sort_keys=True, allow_nan=False).encode()).hexdigest()[:16]
    (SITE / "data" / "data.json").write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False))
    # Lobby scoreboards, sharded by month so the match drawer only fetches what it needs.
    (SITE / "data" / "lobbies").mkdir(exist_ok=True)
    month_of = {r[0]: datetime.fromtimestamp(r[1], timezone.utc).strftime("%Y-%m") for r in rows}
    shards: dict[str, dict] = {}
    for mid, lobby in lobbies.items():
        shards.setdefault(month_of[mid], {})[mid] = lobby
    for month, matches in shards.items():
        xuids = {r[0] for lobby in matches.values() for r in lobby}
        (SITE / "data" / "lobbies" / f"{month}.json").write_text(json.dumps(
            {"cols": ["xuid", "team", "out", "place", "k", "d", "a", "dd", "dt", "acc", "ps", "bot"],
             "names": {x: gamertags.get(x) or players.get(x) for x in xuids if gamertags.get(x) or players.get(x)},
             "matches": matches}, separators=(",", ":")))

    try:
        import duckdb
        con = duckdb.connect()
        flat = [r[:-3] for r in rows]  # drop list columns (mates, foes, medals)
        con.execute("create table pm (" + ", ".join(f'"{c}" varchar' for c in cols[:-3]) + ")")
        if flat:
            con.executemany(f"insert into pm values ({','.join('?' * len(flat[0]))})", [[None if v is None else str(v) for v in r] for r in flat])
        con.execute(f"copy pm to '{SITE / 'data' / 'player_matches.parquet'}' (format parquet)")
    except Exception as e:  # parquet is a bonus, never block the site
        print(f"parquet export skipped: {e}")

    # Tiny file the app polls to notice fresh data (and to version the big fetches).
    (SITE / "data" / "version.json").write_text(json.dumps({
        "generated": payload["generated"], "digest": payload["digest"], "games": len(rows),
        "players": {x: stored_by.get(i, 0) for i, x in enumerate(player_xuids)},
    }))

    size = (SITE / "data" / "data.json").stat().st_size
    print(f"Wrote site/ with {len(rows)} player-matches ({size / 1024:.0f} KB data.json)")


if __name__ == "__main__":
    main()
