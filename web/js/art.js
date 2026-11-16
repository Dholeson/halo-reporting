// Official Halo artwork fetched by the ingest (data/art). Everything here
// degrades to nothing when art hasn't been fetched yet.
import { esc } from "./util.js";

let A = { maps: {}, modes: {}, medals: null };
export function initArt(art) {
  A = { maps: {}, modes: {}, medals: null, ...(art || {}) };
}
export const hasArt = () => Object.keys(A.maps || {}).length > 0;
export const mapArt = (name, kind = "hero") => A.maps?.[name]?.[kind] || null;
export const modeArt = (fam, kind = "hero") => A.modes?.[fam]?.[kind] || null;

/** Inline style that exposes an image to CSS as --art.
 *  Absolute URL on purpose: a relative url() inside a custom property resolves
 *  against the stylesheet that uses it (css/), not the page. */
export const artVar = (url) => (url ? `--art:url('${new URL(url, document.baseURI).href}')` : "");

/** Absolutely-positioned art layer for a `.has-art` container. */
export const artLayer = (url, cls = "") => (url ? `<div class="art ${cls}" style="${artVar(url)}" aria-hidden="true"></div>` : "");

/** A medal's sprite from the official sheet, or null if unavailable. */
export function medalIcon(medalIdx, px = 22) {
  const m = A.medals;
  const si = m?.sprite?.[medalIdx];
  if (!m || si == null) return null;
  const col = si % m.columns, row = Math.floor(si / m.columns);
  return `<span class="medal-art" style="width:${px}px;height:${px}px;background-image:url('${esc(new URL(m.sheet, document.baseURI).href)}');background-size:${m.columns * px}px auto;background-position:-${col * px}px -${row * px}px" aria-hidden="true"></span>`;
}
