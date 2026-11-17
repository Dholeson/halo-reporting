"""Compile map and mode research into web/playbook/maps.json and modes.json (the In-game screen's notes).

Input is research JSON: {"maps": [...], "modes": {...}} as returned by the research workflow (or wrapped
in {"result": ...}). Each map has zones (callout, kind, x/y 0-100 top-down, level, notes, confidence),
links, spawns, objectives, tips and sources; each fact carries a confidence. This script keeps high/medium facts, maps modes to the app's families (social-only items are dropped: the
playbook is for ranked), gives objectives a short marker for the schematic, flags zones whose
position is only estimated, and turns sources into public links (local paths never ship).
Usage: python3 scripts/build_playbook.py RESEARCH.json web/playbook [web/playbook/maps.json]
  The optional third argument keeps maps already published that RESEARCH doesn't cover.
  The result is checked (references resolve, no local paths, known modes) before it counts as done."""
import json, re, sys, datetime
from urllib.parse import urlparse

FAMILIES = ["Slayer", "Capture the Flag", "Oddball", "King of the Hill", "Strongholds", "Assault", "Extraction",
            "Total Control", "Elimination", "Fiesta", "VIP", "Escalation", "Infection & Minigames", "Firefight"]
ALIASES = {"ctf": "Capture the Flag", "capture the flag": "Capture the Flag", "koth": "King of the Hill",
           "king of the hill": "King of the Hill", "neutral bomb": "Assault", "assault": "Assault",
           "strongholds": "Strongholds", "oddball": "Oddball", "slayer": "Slayer", "team slayer": "Slayer",
           "ranked slayer": "Slayer", "extraction": "Extraction", "total control": "Total Control",
           "all": "all", "any": "all", "all modes": "all"}
OK = {"high", "medium"}

def fam(name):
    k = re.sub(r"\s+", " ", str(name or "")).strip().lower()
    k = re.sub(r"^(ranked|arena)[: ]+", "", k)
    if k in ALIASES: return ALIASES[k]
    if "social" in k or "quick play" in k: return None
    for f in FAMILIES:
        if f.lower() in k: return f
    if "ctf" in k or "flag" in k: return "Capture the Flag"
    if "hill" in k: return "King of the Hill"
    if "bomb" in k: return "Assault"
    return None

def modes_of(lst):
    """[] means every mode; None means 'not a ranked mode' (drop the item)."""
    if not lst: return []
    out = []
    for m in lst:
        f = fam(m)
        if f == "all": return []
        if f and f not in out: out.append(f)
    return out or None

def keep(x): return x.get("confidence", "medium") in OK

# ---------- sources ----------
REPOS = {"jgtm/levelup": "LevelUp: map callouts, objectives and pads read from the game's map files",
         "gravllift/halo-infinite-maps": "halo-infinite-maps: objective and weapon-pad catalog",
         "jgtm/halo-infinite-film-decoder": "halo-infinite-film-decoder: objective order from match films",
         "acurtis166/spnkr": "SPNKr: Halo Infinite API client (medal and asset data)",
         "nuzzles/halo_api": "halo_api: Halo Infinite API models"}
MINE = {"url": "", "title": "Your match history in Debrief (medals, scores, timings)"}

def source(s):
    """One source as {url, title}, or None to drop it. Local paths become public links."""
    url = (s.get("url") if isinstance(s, dict) else s) or ""
    title = (s.get("title") if isinstance(s, dict) else "") or ""
    low = url.lower()
    if re.search(r"data/matches|site/data|player's data|player data|local analysis|your games|match data", low): return MINE
    if "levelup" in low or "streets/lu" in low or "src_levelup" in low: url = "https://github.com/JGtm/LevelUp"
    elif "spnkr" in low: url = "https://github.com/acurtis166/SPNKr"
    elif re.search(r"/tmp/|/root/|/home/|file://|^local", low): return None
    m = re.match(r"https?://(?:www\.)?github\.com/([^/]+/[^/#?]+)", url, re.I)
    if m:
        repo = m.group(1).lower()
        return {"url": f"https://github.com/{m.group(1)}", "title": REPOS.get(repo, f"{m.group(1)} (GitHub)")}
    if not re.match(r"https?://", url): return None
    if not title:
        u = urlparse(url)
        host = u.netloc.removeprefix("www.")
        tail = [p for p in u.path.split("/") if p]
        title = host + (f": {tail[-1].replace('-', ' ').replace('_', ' ')}" if tail else "")
    return {"url": url, "title": title}

def sources(lst, cap=14):
    out, seen = [], set()
    for s in lst or []:
        x = source(s)
        if not x: continue
        k = x["url"] or x["title"]
        if k in seen: continue
        seen.add(k); out.append(x)
    # the player's own data last, then the cap
    out.sort(key=lambda x: x is MINE)
    return out[:cap]

# ---------- wording ----------
def you(text):
    """Research notes say 'the player'; the site talks to you."""
    if not isinstance(text, str): return text
    t = re.sub(r"\bthe player's own\b", "your own", text)
    t = re.sub(r"\bThe player's\b", "Your", t)
    t = re.sub(r"\bthe player's\b", "your", t)
    t = re.sub(r"\bPlayer data\b", "Your data", t)
    t = re.sub(r"\(player data\)", "(your data)", t)
    t = re.sub(r"\bplayer data\b", "your data", t)
    return t

def deep_you(x):
    if isinstance(x, str): return you(x)
    if isinstance(x, list): return [deep_you(v) for v in x]
    if isinstance(x, dict): return {k: (deep_you(v) if k not in ("sources", "url") else v) for k, v in x.items()}
    return x

# ---------- per-map extras that the research described in prose ----------
AREAS = {
    # Recharge's positions are too rough to draw; group its callouts the way the research describes them.
    "Recharge": {
        "Middle": ["Pit", "Batteries", "Bridge", "Control Room"],
        "Top floor": ["Attic", "Maintenance Bay", "Orange Pipes", "Maintenance Elbow Stairs"],
        "Whirlpool / Elevator side": ["Whirlpool Dam", "Whirlpool Ledge", "Elevator", "Sneaky"],
        "Hydro / Long Hall side": ["Hydro", "Long Hall", "Platform", "Storage", "Overhang", "Blue Pipes"],
        "Location not confirmed": ["Turbine"],
    },
}

# Short names for the drawing and the timers. First match wins.
SHORT = [(r"sniper.*skewer|skewer.*sniper", "Sniper / Skewer"), (r"overshield.*camo|camo.*overshield", "OS / Camo"),
         (r"active camo|^camo", "Camo"), (r"overshield", "Overshield"), (r"sniper", "Sniper"), (r"rocket|spnkr", "Rockets"),
         (r"skewer", "Skewer"), (r"hammer.*sword|sword.*hammer", "Hammer / Sword"), (r"shock rifle", "Shock Rifle"),
         (r"grapple", "Grapple"), (r"repulsor", "Repulsor"), (r"translocator", "Translocator"), (r"drop wall", "Drop Wall"),
         (r"threat sensor", "Sensor"), (r"plasma gren", "Plasmas"), (r"spike gren", "Spikes"), (r"frag", "Frags"),
         (r"tactical rifle|commando", "BR / Commando"), (r"^br75", "BR75"), (r"sidearm|disruptor|plasma pistol|mangler", "Sidearm"),
         (r"heatwave|bulldog", "Heatwave"), (r"^power-up( pad)?\b", "Power-up")]
def short(item):
    for pat, name in SHORT:
        if re.search(pat, str(item or ""), re.I): return name
    return item if len(str(item or "")) <= 16 else None

def mark(o, f):
    lab = str(o.get("label") or "")
    if f == "Capture the Flag": return "⚑"
    if f == "Oddball": return "●"
    if f == "Strongholds":
        m = re.fullmatch(r"\s*([ABC])\s*", lab)
        return m.group(1) if m else "Z"
    if f == "King of the Hill":
        return str(o["order"]) if isinstance(o.get("order"), (int, float)) else "H"
    return (lab[:2] if len(lab) <= 2 else "•")

def objective_label(o, f):
    lab = str(o.get("label") or "")
    if f == "King of the Hill" and lab.strip().upper() in ("H", "HILL"): return "Hill"
    if f == "Strongholds" and lab.strip().upper() in ("SH", "Z", "ZONE"): return "Zone"
    return lab

def clean_map(m):
    zones = [z for z in m.get("zones", []) if z.get("name") and isinstance(z.get("x"), (int, float)) and isinstance(z.get("y"), (int, float))]
    names = {z["name"].lower() for z in zones}
    areas = {n.lower(): a for a, ns in AREAS.get(m["map"], {}).items() for n in ns}
    def zone_ok(n): return str(n or "").lower() in names
    out_z = []
    for z in zones:
        o = {k: z.get(k) for k in ("name", "kind", "side", "x", "y", "level", "notes")}
        o["side"] = "" if str(o.get("side") or "").lower() in ("", "neutral", "none") else o["side"]
        if z.get("confidence") == "low": o["approx"] = True  # the name is a real callout; its spot is a guess
        if z["name"].lower() in areas: o["area"] = areas[z["name"].lower()]
        out_z.append({k: v for k, v in o.items() if v not in (None, "")})
    spawns = []
    for s in m.get("spawns", []):
        if not keep(s): continue
        md = modes_of(s.get("modes"))
        if md is None: continue  # social-only
        o = {k: s.get(k) for k in ("item", "kind", "zone", "respawnSec", "notes")} | {"modes": md, "short": short(s.get("item"))}
        if not zone_ok(o["zone"]): o["zone"] = ""  # not placed on the drawing
        spawns.append({k: v for k, v in o.items() if v not in (None,)})
    objectives = []
    for o in m.get("objectives", []):
        if not keep(o): continue
        f = fam(o.get("mode"))
        if not f or f == "all": continue
        x = {"mode": f, "label": objective_label(o, f), "mark": mark(o, f), "zone": o.get("zone") or "",
             "order": o.get("order"), "notes": o.get("notes") or ""}
        objectives.append({k: v for k, v in x.items() if v not in (None,)})
    tips = []
    for t in m.get("tips", []):
        if not keep(t): continue
        md = modes_of(t.get("modes"))
        if md is None: continue
        tips.append({"text": t["text"], "modes": md})
    links = [{k: l.get(k) for k in ("from", "to", "kind")} for l in m.get("links", []) if zone_ok(l.get("from")) and zone_ok(l.get("to"))]
    return deep_you({"map": m["map"], "aka": m.get("aka", []), "summary": m.get("summary", ""), "symmetric": m.get("symmetric"),
            "layoutConfidence": m.get("layoutConfidence", "low"),
            "zones": out_z, "links": links, "spawns": spawns, "objectives": objectives, "tips": tips}) | {"sources": sources(m.get("sources"))}

def main(src, out, existing=None):
    r = json.load(open(src))
    r = r.get("result", r)
    stamp = datetime.date.today().isoformat()
    maps = {}
    if existing:
        try: maps = json.load(open(existing)).get("maps", {})
        except FileNotFoundError: pass
    for m in r.get("maps") or []:
        if m and m.get("map"):
            maps[m["map"]] = clean_map(m) | {"checked": stamp}
    json.dump({"compiled": stamp,
               "note": "Compiled from community guides, map-data catalogs on GitHub and your own match history, cross-checked where sources allowed. Facts in our own words; schematics are original diagrams of relative positions, not to scale.",
               "maps": dict(sorted(maps.items()))},
              open(f"{out}/maps.json", "w"), indent=1, ensure_ascii=False)
    md = r.get("modes")
    if md:
        modes = {}
        for x in md.get("modes", []):
            f = fam(x.get("family"))
            if not f or f == "all": continue
            modes[f] = deep_you({k: x.get(k) for k in ("rankedRules", "mechanics", "timers", "principles", "soloQ", "confidence")}) | {"sources": sources(x.get("sources"))}
        gen = md.get("general") or {}
        gen = {"respawns": [deep_you({k: g.get(k) for k in ("item", "seconds", "notes", "confidence")}) for g in gen.get("respawns", [])],
               "padNotes": you(gen.get("padNotes", "")), "sources": sources(gen.get("sources"))}
        json.dump({"compiled": stamp, "modes": modes, "general": gen}, open(f"{out}/modes.json", "w"), indent=1, ensure_ascii=False)
        print(f"modes: {len(modes)}; respawns: {len(gen['respawns'])}")
    print(f"maps: {len(maps)} ({', '.join(maps)})")

def validate(root):
    """Problems in the published files, as a list of strings (empty when all is well)."""
    maps = json.load(open(f"{root}/maps.json"))["maps"]
    modes = json.load(open(f"{root}/modes.json"))
    FAM = {"Slayer", "Capture the Flag", "Oddball", "King of the Hill", "Strongholds", "Assault", "Extraction", "Total Control", "Elimination", "Fiesta", "VIP", "Escalation"}
    bad = []
    raw = open(f"{root}/maps.json").read() + open(f"{root}/modes.json").read()
    for pat in [r"/tmp/", r"/home/", r"/root/", r"file://", r"scratchpad", r"the player's", r"\bthe player\b(?! who)"]:
        if re.search(pat, raw): bad.append(f"text matches {pat}")
    for name, m in maps.items():
        zn = {z["name"].lower() for z in m["zones"]}
        if len(zn) != len(m["zones"]): bad.append(f"{name}: duplicate zone names")
        for z in m["zones"]:
            if not (0 <= z["x"] <= 100 and 0 <= z["y"] <= 100): bad.append(f"{name}: {z['name']} off the grid")
        for l in m["links"]:
            if l["from"].lower() not in zn or l["to"].lower() not in zn: bad.append(f"{name}: link {l}")
        for s in m["spawns"]:
            if s["zone"] and s["zone"].lower() not in zn: bad.append(f"{name}: spawn zone {s['zone']}")
            if any(x not in FAM for x in s["modes"]): bad.append(f"{name}: spawn modes {s['modes']}")
        for o in m["objectives"]:
            if o["mode"] not in FAM: bad.append(f"{name}: objective mode {o['mode']}")
            if m["zones"] and o["zone"].lower() not in zn: bad.append(f"{name}: objective zone {o['zone']}")
            if not o.get("mark"): bad.append(f"{name}: objective without mark")
        for t in m["tips"]:
            if any(x not in FAM for x in t["modes"]): bad.append(f"{name}: tip modes {t['modes']}")
        for s in m["sources"]:
            if s["url"] and not s["url"].startswith("https://"): bad.append(f"{name}: source {s}")
        if not m["sources"]: bad.append(f"{name}: no sources")
    for f, x in modes["modes"].items():
        if f not in FAM: bad.append(f"mode {f}")
    return bad


if __name__ == "__main__":
    main(*sys.argv[1:4])
    problems = validate(sys.argv[2])
    print("\n".join(problems) if problems else "checked: references resolve, no local paths")
    sys.exit(1 if problems else 0)
