"""players.txt parsing, shared by ingest and report so they can never disagree.

One entry per line: a gamertag (classic, or modern with a #1234 suffix) or an
XUID (bare digits or xuid(...)). A trailing "[me]" marks your own accounts.
"""

import re
from pathlib import Path

XUID_RE = re.compile(r"^(?:xuid\()?(\d{16})\)?$", re.IGNORECASE)  # Xbox XUIDs are 16 digits
TAG_RE = re.compile(r"\s*\[([^\]]*)\]\s*$")


def entry_xuid(entry: str) -> str | None:
    """The bare XUID if the entry is one, else None."""
    m = XUID_RE.match(entry.strip())
    return m.group(1) if m else None


def tracked_entries(path: Path = Path("players.txt")) -> list[tuple[str, bool]]:
    """players.txt lines as (gamertag-or-xuid, is_me)."""
    if not path.exists():
        return []
    out = []
    for line in (l.strip() for l in path.read_text().splitlines()):
        if not line or line.startswith("#"):
            continue
        m = TAG_RE.search(line)
        out.append((TAG_RE.sub("", line).strip(), bool(m and m.group(1).strip().lower() == "me")))
    return out


def me_xuids(players: dict[str, str], path: Path = Path("players.txt")) -> set[str]:
    """XUIDs of your own accounts. If nothing is marked [me], every tracked player counts."""
    marked_x, marked_g = set(), set()
    for entry, is_me in tracked_entries(path):
        if is_me:
            if x := entry_xuid(entry):
                marked_x.add(x)
            else:
                marked_g.add(entry.lower())
    if not marked_x and not marked_g:
        return set(players)
    return {x for x, g in players.items() if x in marked_x or g.lower() in marked_g}
