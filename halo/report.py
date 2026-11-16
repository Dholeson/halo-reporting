"""Build site/index.html (and site/player_matches.parquet) from data/.

Flattens raw match JSON into one row per tracked player per match, loads it
into DuckDB, and renders a static page. No JS, no external requests.
"""

import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import duckdb

DATA = Path("data")
SITE = Path("site")
OUTCOME = {1: "Tie", 2: "Win", 3: "Loss", 4: "DNF"}


def iso_seconds(d: str | None) -> float:
    m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?", d or "")
    if not m:
        return 0.0
    h, mi, s = (float(x) if x else 0.0 for x in m.groups())
    return h * 3600 + mi * 60 + s


def rows():
    players = json.loads((DATA / "players.json").read_text()) if (DATA / "players.json").exists() else {}
    assets = json.loads((DATA / "assets.json").read_text()) if (DATA / "assets.json").exists() else {}
    tracked = {f"xuid({x})": gt for x, gt in players.items()}

    def name(a):
        return assets.get(f"{a['AssetId']}:{a['VersionId']}") if a else None

    for f in sorted((DATA / "matches").glob("*.jsonl")):
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            m = json.loads(line)
            info = m["MatchInfo"]
            for p in m["Players"]:
                gt = tracked.get(p["PlayerId"])
                if not gt or not p.get("PlayerTeamStats"):
                    continue
                cores = [t["Stats"]["CoreStats"] for t in p["PlayerTeamStats"]]
                shots_fired = sum(c.get("ShotsFired", 0) for c in cores)
                shots_hit = sum(c.get("ShotsHit", 0) for c in cores)
                yield {
                    "match_id": m["MatchId"],
                    "gamertag": gt,
                    "start_time": info["StartTime"],
                    "duration_s": iso_seconds(info.get("Duration")),
                    "map": name(info.get("MapVariant")) or "Unknown map",
                    "mode": name(info.get("UgcGameVariant")) or "Unknown mode",
                    "playlist": name(info.get("Playlist")) or "Custom / none",
                    "outcome": OUTCOME.get(p["Outcome"], "Other"),
                    "kills": sum(c["Kills"] for c in cores),
                    "deaths": sum(c["Deaths"] for c in cores),
                    "assists": sum(c["Assists"] for c in cores),
                    "damage_dealt": sum(c.get("DamageDealt", 0) for c in cores),
                    "damage_taken": sum(c.get("DamageTaken", 0) for c in cores),
                    "shots_fired": shots_fired,
                    "shots_hit": shots_hit,
                }


def table(cols: list[str], data: list[tuple], num_from: int = 1) -> str:
    head = "".join(f"<th{' class=n' if i >= num_from else ''}>{html.escape(c)}</th>" for i, c in enumerate(cols))
    body = ""
    for r in data:
        cells = ""
        for i, v in enumerate(r):
            cls = " class=n" if i >= num_from else ""
            if isinstance(v, str) and v in ("Win", "Loss", "Tie", "DNF"):
                cls = f" class='{v.lower()}'"
            cells += f"<td{cls}>{html.escape('' if v is None else str(v))}</td>"
        body += f"<tr>{cells}</tr>"
    return f"<div class=scroll><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>"


def sparkline(values: list[float], w: int = 280, h: int = 48) -> str:
    if len(values) < 2:
        return ""
    lo, hi = min(values + [1.0]), max(values + [1.0])
    span = (hi - lo) or 1
    pts = " ".join(f"{i * w / (len(values) - 1):.1f},{h - (v - lo) / span * h:.1f}" for i, v in enumerate(values))
    one = h - (1.0 - lo) / span * h
    return (f"<svg viewBox='0 0 {w} {h}' class=spark preserveAspectRatio=none role=img aria-label='Rolling K/D'>"
            f"<line x1=0 x2={w} y1={one:.1f} y2={one:.1f} class=ref /><polyline points='{pts}' /></svg>")


CSS = """
:root{--bg:#f6f7f9;--fg:#15181d;--muted:#5d6672;--card:#fff;--line:#e2e5ea;--accent:#2a6fdb;--win:#1f8a4c;--loss:#c23b3b}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e8ebef;--muted:#98a2ae;--card:#171b21;--line:#262c35;--accent:#6aa3ff;--win:#4cc37f;--loss:#ef6b6b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 10px}
.muted{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.card h3{margin:0 0 8px;font-size:16px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.stat b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.stat span{color:var(--muted);font-size:12px}
.spark{width:100%;height:48px;margin-top:10px}.spark polyline{fill:none;stroke:var(--accent);stroke-width:2;vector-effect:non-scaling-stroke}.spark .ref{stroke:var(--line);stroke-dasharray:4 4;vector-effect:non-scaling-stroke}
.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap;text-align:left}
th{color:var(--muted);font-weight:600}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.win{color:var(--win)}.loss{color:var(--loss)}
a{color:var(--accent)}
"""


def main() -> None:
    SITE.mkdir(exist_ok=True)
    con = duckdb.connect()
    data = list(rows())
    con.execute("""create table pm (match_id varchar, gamertag varchar, start_time timestamptz, duration_s double,
        map varchar, mode varchar, playlist varchar, outcome varchar, kills int, deaths int, assists int,
        damage_dealt int, damage_taken int, shots_fired int, shots_hit int)""")
    if data:
        con.executemany("insert into pm values (" + ",".join("?" * 15) + ")", [tuple(r.values()) for r in data])
    con.execute(f"copy pm to '{SITE / 'player_matches.parquet'}' (format parquet)")

    kd = "round(sum(kills)::double / greatest(sum(deaths),1), 2)"
    winp = "round(100.0 * count(*) filter (where outcome='Win') / count(*), 1)"
    acc = "round(100.0 * sum(shots_hit) / nullif(sum(shots_fired),0), 1)"

    cards = ""
    for gt, n, w, k, a, n30, kd30 in con.execute(f"""
        select gamertag, count(*), {winp}, {kd}, {acc},
               count(*) filter (where start_time > now() - interval 30 day),
               round(sum(kills) filter (where start_time > now() - interval 30 day)::double
                     / greatest(sum(deaths) filter (where start_time > now() - interval 30 day),1), 2)
        from pm group by 1 order by 2 desc""").fetchall():
        rolling = [r[0] for r in con.execute("""
            select sum(kills) over w::double / greatest(sum(deaths) over w, 1) from pm where gamertag = ?
            window w as (order by start_time rows between 19 preceding and current row)
            order by start_time desc limit 100""", [gt]).fetchall()][::-1]
        cards += f"""<div class=card><h3>{html.escape(gt)}</h3><div class=stats>
          <div class=stat><b>{n}</b><span>matches</span></div><div class=stat><b>{w}%</b><span>win rate</span></div>
          <div class=stat><b>{k}</b><span>K/D</span></div><div class=stat><b>{a if a is not None else '–'}%</b><span>accuracy</span></div>
          <div class=stat><b>{n30}</b><span>last 30d</span></div><div class=stat><b>{kd30 if n30 else '–'}</b><span>K/D 30d</span></div>
          </div>{sparkline(rolling)}<div class=muted>Rolling 20-match K/D, last 100 matches</div></div>"""

    recent = con.execute("""select strftime(start_time, '%Y-%m-%d %H:%M'), gamertag, map, mode, outcome, kills, deaths, assists,
        round(100.0*shots_hit/nullif(shots_fired,0),1) from pm order by start_time desc limit 50""").fetchall()
    by_map = con.execute(f"""select gamertag, map, count(*), {winp}, {kd} from pm group by 1,2 having count(*) >= 3
        order by 1, 3 desc""").fetchall()
    by_mode = con.execute(f"""select gamertag, mode, count(*), {winp}, {kd} from pm group by 1,2 having count(*) >= 3
        order by 1, 3 desc""").fetchall()

    updated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    body = f"""<main><h1>Halo Infinite report</h1>
<div class=muted>{len(data)} player-matches · updated {updated} · <a href="player_matches.parquet">raw data (Parquet)</a></div>
{('<div class=grid>' + cards + '</div>') if cards else '<p>No matches yet. The next scheduled run will fill this in.</p>'}
<h2>Recent matches</h2>{table(['Time (UTC)','Player','Map','Mode','Result','K','D','A','Acc %'], recent, num_from=5)}
<h2>By map</h2><div class=muted>3+ matches</div>{table(['Player','Map','Matches','Win %','K/D'], by_map, num_from=2)}
<h2>By mode</h2><div class=muted>3+ matches</div>{table(['Player','Mode','Matches','Win %','K/D'], by_mode, num_from=2)}
</main>"""
    (SITE / "index.html").write_text(f"""<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>Halo Report</title><style>{CSS}</style></head>
<body>{body}</body></html>""")
    print(f"Wrote {SITE / 'index.html'} ({len(data)} rows)")


if __name__ == "__main__":
    main()
