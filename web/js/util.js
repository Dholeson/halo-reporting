// Small shared helpers: DOM, formatting, storage, color math.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const ok = (v) => v !== null && v !== undefined && Number.isFinite(v);
export const fmt = {
  int: (v) => (ok(v) ? Math.round(v).toLocaleString() : "–"),
  n1: (v) => (ok(v) ? v.toFixed(1) : "–"),
  n2: (v) => (ok(v) ? v.toFixed(2) : "–"),
  pct: (v) => (ok(v) ? `${Math.round(v * 100)}%` : "–"),
  pct1: (v) => (ok(v) ? `${(v * 100).toFixed(1)}%` : "–"),
  acc: (v) => (ok(v) ? `${v.toFixed(1)}%` : "–"),
  k: (v) => (!ok(v) ? "–" : Math.abs(v) >= 10000 ? `${(v / 1000).toFixed(0)}k` : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v).toString()),
  secs: (v) => {
    if (!ok(v)) return "–";
    const s = Math.round(v);
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
  },
  hours: (mins) => (mins >= 120 ? `${Math.round(mins / 60).toLocaleString()} h` : `${Math.round(mins)} min`),
  signed: (v, f = fmt.n1) => (!ok(v) ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${f(Math.abs(v))}`),
  date: (t, opts) => new Date(t * 1000).toLocaleDateString(undefined, opts || { month: "short", day: "numeric", year: "numeric" }),
  dateShort: (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  month: (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" }),
  time: (t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  dateTime: (t) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
};

export function ago(t) {
  const s = Date.now() / 1000 - t;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  if (d < 14) return `${d} day${d === 1 ? "" : "s"} ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  if (d < 730) return `${Math.round(d / 30)} months ago`;
  return `${Math.round(d / 365)} years ago`;
}

export const plural = (n, word, pl = `${word}s`) => `${fmt.int(n)} ${n === 1 ? word : pl}`;

export const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`debrief.${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`debrief.${k}`, JSON.stringify(v));
    } catch {
      /* private mode / blocked storage: preferences just won't persist */
    }
  },
};

export function debounce(fn, ms = 120) {
  let id;
  return (...a) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...a), ms);
  };
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---- color: OKLab interpolation keeps ramps perceptually even ----
function hexToRgb(h) {
  h = h.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
}
const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function rgbToOklab([r, g, b]) {
  [r, g, b] = [r, g, b].map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToHex([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return "#" + rgb.map((c) => Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255).toString(16).padStart(2, "0")).join("");
}
export function mix(a, b, t) {
  const A = rgbToOklab(hexToRgb(a));
  const B = rgbToOklab(hexToRgb(b));
  t = Math.min(1, Math.max(0, t));
  return oklabToHex(A.map((v, i) => v + (B[i] - v) * t));
}

// Theme-aware scales. Read once per render (theme changes trigger a re-render).
export function scales() {
  const pos = cssVar("--div-pos"), neg = cssVar("--div-neg"), mid = cssVar("--div-mid");
  const lo = cssVar("--seq-lo"), hi = cssVar("--seq-hi");
  return {
    // v in [-1, 1]; positive = better than baseline (blue), negative = worse (red)
    diverging: (v) => (v >= 0 ? mix(mid, pos, Math.min(1, v)) : mix(mid, neg, Math.min(1, -v))),
    sequential: (t) => mix(lo, hi, t),
    // readable ink on a filled cell
    ink: (hex) => {
      const [r, g, b] = hexToRgb(hex).map(toLin);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.32 ? "#0b0b0b" : "#ffffff";
    },
  };
}

export const ACCOUNT_COLORS = ["--s1", "--s2", "--s3"];
export const accountColor = (i) => (i < 3 ? cssVar(ACCOUNT_COLORS[i]) : cssVar("--tie"));

export function initials(name) {
  const parts = String(name || "?").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || parts[0]?.[1] || "")).toUpperCase();
}

export function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2200);
}

// Inline icons (stroke-based, inherit currentColor)
const P = {
  overview: '<path d="M3 13h4v7H3zM10 4h4v16h-4zM17 9h4v11h-4z"/>',
  briefing: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4"/>',
  coach: '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z"/>',
  maps: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/>',
  ranked: '<path d="M12 2l3 6 6 1-4.5 4.4L18 20l-6-3.2L6 20l1.5-6.6L3 9l6-1z" fill="none"/><path d="M12 7v6"/>',
  matches: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  squad: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.3c3 .1 5.5 2.6 5.5 5.7"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 1.5v3M12 19.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1.5 12h3M19.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  flame: '<path d="M12 22c4.4 0 7-2.9 7-6.8 0-4.7-4.4-6.7-5-11.2-2.7 1.7-4.1 4.5-3.8 7.5-1.1-.6-1.9-1.8-2-3.2C6.3 9.9 5 12.4 5 15.2 5 19.1 7.6 22 12 22z"/>',
  snow: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 4l3 2 3-2M9 20l3-2 3 2"/>',
  steady: '<path d="M3 12h18M15 6l6 6-6 6"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  shield: '<path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
  people: '<circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M2 20c0-3 2.7-5 6-5s6 2 6 5M14 15.2c.6-.1 1.3-.2 2-.2 3.3 0 6 2 6 5"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 21h8M9 17h6v4H9z"/>',
  skull: '<path d="M12 3a8 8 0 0 0-5 14.2V20h10v-2.8A8 8 0 0 0 12 3z"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>',
  crosshair: '<circle cx="12" cy="12" r="8"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>',
  tip: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.6 1 2.5h6c0-.9.2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  chev: '<path d="M6 9l6 6 6-6"/>',
  reset: '<path d="M4 4v6h6M20 20v-6h-6"/><path d="M20 10A8 8 0 0 0 6 5.3L4 10M4 14a8 8 0 0 0 14 4.7l2-4.7"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  medal: '<circle cx="12" cy="15" r="6"/><path d="M8 3l4 6 4-6M12 12.5l.9 1.9 2.1.3-1.5 1.5.4 2.1-1.9-1-1.9 1 .4-2.1-1.5-1.5 2.1-.3z"/>',
  hourglass: '<path d="M6 2h12M6 22h12M7 2c0 6 10 6 10 10S7 16 7 22M17 2c0 6-10 6-10 10s10 4 10 10"/>',
  spark: '<path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l3.5 3.5M15.5 15.5L19 19M5 19l3.5-3.5M15.5 8.5L19 5"/>',
};
export const icon = (name, cls = "") =>
  `<svg class="${cls}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ""}</svg>`;
