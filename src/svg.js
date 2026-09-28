/*!
 * @file        src/svg.js
 * @description Emit layer.
 *              Coordinate formatting, the path builder, shape helpers and the
 *              document root that pins physical scale; affine matrices in SVG
 *              composition order and path-data baking; the operation layers,
 *              stroke outlines and boundary trimming.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/LaserCutCards}
 *
 * SPDX-FileCopyrightText: 2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { PRECISION, GRAY_LEVELS, clamp, hairlineFor } from './core.js';

/* ── primitives ───────────────────────────────────────────────────────────── */

export function num(n) {
  if (!Number.isFinite(n)) throw new RangeError(`non-finite coordinate: ${n}`);
  let s = n.toFixed(PRECISION);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/* Builds path data with implicit command repetition. M is always written out: a
pair repeated after M is an implicit line-to, which would join two subpaths. */
export class Path {
  constructor() {
    this._parts = [];
    this._last = '';
  }

  _cmd(letter, nums) {
    if (letter !== this._last || letter === 'M') {
      this._parts.push(letter + nums.join(' '));
      this._last = letter;
    } else {
      this._parts.push(nums.join(' '));
    }
    return this;
  }

  M(x, y) {
    return this._cmd('M', [num(x), num(y)]);
  }

  L(x, y) {
    return this._cmd('L', [num(x), num(y)]);
  }

  C(x1, y1, x2, y2, x, y) {
    return this._cmd('C', [num(x1), num(y1), num(x2), num(y2), num(x), num(y)]);
  }

  A(rx, ry, largeArc, sweep, x, y) {
    return this._cmd('A', [num(rx), num(ry), '0', largeArc ? '1' : '0', sweep ? '1' : '0', num(x), num(y)]);
  }

  Z() {
    this._parts.push('Z');
    this._last = 'Z';
    return this;
  }

  polyline(points, close = false) {
    points.forEach(([x, y], i) => (i === 0 ? this.M(x, y) : this.L(x, y)));
    if (close) this.Z();
    return this;
  }

  get empty() {
    return this._parts.length === 0;
  }

  toString() {
    return this._parts.join(' ');
  }
}

export function rectPath(x, y, w, h) {
  return new Path().polyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true).toString();
}

export function roundedRectPath(x, y, w, h, r) {
  const rr = clamp(r, 0, Math.min(w, h) / 2);
  if (rr <= 0) return rectPath(x, y, w, h);
  return new Path()
    .M(x + rr, y)
    .L(x + w - rr, y)
    .A(rr, rr, 0, 1, x + w, y + rr)
    .L(x + w, y + h - rr)
    .A(rr, rr, 0, 1, x + w - rr, y + h)
    .L(x + rr, y + h)
    .A(rr, rr, 0, 1, x, y + h - rr)
    .L(x, y + rr)
    .A(rr, rr, 0, 1, x + rr, y)
    .Z()
    .toString();
}

export function circlePath(cx, cy, r) {
  return new Path().M(cx - r, cy).A(r, r, 0, 1, cx + r, cy).A(r, r, 0, 1, cx - r, cy).Z().toString();
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const NEEDS_ESCAPE = /[&<>"]/;
const ESCAPE_ALL = /[&<>"]/g;

/* Attribute values and text content. Path data never contains these characters,
so the test keeps multi-megabyte `d` strings from being copied. */
export function escapeText(value) {
  const s = String(value);
  return NEEDS_ESCAPE.test(s) ? s.replace(ESCAPE_ALL, (c) => ESCAPES[c]) : s;
}

function attrs(map) {
  return Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${escapeText(v)}"`)
    .join('');
}

/* `children` is markup; text content goes through escapeText first. */
export function el(tag, map, children) {
  const open = `<${tag}${attrs(map)}`;
  return children ? `${open}>${children}</${tag}>` : `${open}/>`;
}

/* Physical width/height plus a matching unitless viewBox pins the import scale. */
export function svgDocument({ widthMm, heightMm, body }) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + el(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      version: '1.1',
      width: `${num(widthMm)}mm`,
      height: `${num(heightMm)}mm`,
      viewBox: `0 0 ${num(widthMm)} ${num(heightMm)}`,
    },
    `\n${body}\n`,
  );
}

/* ── affine placement ─────────────────────────────────────────────────────── */

export const mIdentity = () => [1, 0, 0, 1, 0, 0];
export const mTranslate = (tx, ty) => [1, 0, 0, 1, tx, ty];
export const mScale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];

export function mRotate(deg) {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, s, -s, c, 0, 0];
}

/* Composition order matches SVG: mMul(A, B) applies B first. */
function mMul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

export function mCompose(...ms) {
  return ms.reduce((acc, m) => mMul(acc, m), mIdentity());
}

export function mApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/* Places a unit-box glyph centred at (cx,cy) at uniform size, rotated about its centre. */
export function mPlaceGlyph(cx, cy, size, rotationDeg = 0) {
  return mCompose(mTranslate(cx, cy), mRotate(rotationDeg), mScale(size), mTranslate(-0.5, -0.5));
}

const TRANSFORMABLE = new Set(['M', 'L', 'C', 'S', 'Q', 'T', 'Z']);
const PATH_TOKEN = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

/* Applies an affine matrix to path data by transforming every coordinate pair.
Valid only for commands whose operands are all coordinate pairs, so authored
glyph data must be absolute M/L/C/S/Q/T/Z. Arcs and relative commands throw. */
export function transformPathData(d, m) {
  const out = [];
  const pending = [];
  let match;
  PATH_TOKEN.lastIndex = 0;
  const flush = () => {
    if (pending.length % 2 !== 0) throw new SyntaxError('glyph path has an odd coordinate count');
    for (let i = 0; i < pending.length; i += 2) {
      const [x, y] = mApply(m, pending[i], pending[i + 1]);
      out.push(num(x), num(y));
    }
    pending.length = 0;
  };
  while ((match = PATH_TOKEN.exec(d)) !== null) {
    if (match[1]) {
      const letter = match[1].toUpperCase();
      if (!TRANSFORMABLE.has(letter) || match[1] !== letter) {
        throw new SyntaxError(`glyph path uses '${match[1]}'; only absolute M L C S Q T Z are supported`);
      }
      flush();
      out.push(letter);
    } else {
      pending.push(parseFloat(match[2]));
    }
  }
  flush();
  return out.join(' ').replace(/([A-Z]) /g, '$1');
}

/* ── operation layers ─────────────────────────────────────────────────────── */

/* Quantised grey step: 0 is full-depth engrave, GRAY_LEVELS - 1 is bare material. */
function grayLevel(gray) {
  return Math.round(clamp(gray, 0, 1) * (GRAY_LEVELS - 1));
}

function levelHex(level) {
  const v = Math.round((level / (GRAY_LEVELS - 1)) * 255);
  const h = v.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

/* Accumulates subpaths per operation so each operation collapses to one element
per fill. The length argument is optional: a generator that still holds its
point array can report an exact figure, one that does not contributes zero. */
export class LayerSink {
  constructor() {
    this.cut = [];
    this.score = [];
    this.engrave = new Map(); // grey level -> subpaths
    this.cutMm = 0;
    this.scoreMm = 0;
  }

  addCut(d, lengthMm = 0) {
    if (!d) return this;
    this.cut.push(d);
    this.cutMm += lengthMm;
    return this;
  }

  addScore(d, lengthMm = 0) {
    if (!d) return this;
    this.score.push(d);
    this.scoreMm += lengthMm;
    return this;
  }

  addEngrave(d, gray = 0) {
    if (!d) return this;
    const level = grayLevel(gray);
    if (!this.engrave.has(level)) this.engrave.set(level, []);
    this.engrave.get(level).push(d);
    return this;
  }

  merge(other) {
    this.cut.push(...other.cut);
    this.score.push(...other.score);
    this.cutMm += other.cutMm || 0;
    this.scoreMm += other.scoreMm || 0;
    for (const [level, ds] of other.engrave) {
      if (!this.engrave.has(level)) this.engrave.set(level, []);
      this.engrave.get(level).push(...ds);
    }
    return this;
  }
}

/* Presentation attributes only, so author CSS outranks them: the preview
restyles cut and score lines without the markup changing.
A preview marks groups with class rather than id, because a review grid draws
many tiles in one document and repeating id="cut" would be invalid, and fills
engrave levels with the greys they stand for. An export keeps the ids and
fills each level with the target's own colour for it, when it lists one. */
export function renderLayers(sink, target, preview = false) {
  const groups = [];
  const hairline = hairlineFor(target);
  const mark = name => (preview ? { class: name } : { id: name });
  const fill = level => (!preview && target.engrave ? target.engrave[level] : levelHex(level));
  if (sink.engrave.size) {
    const paths = [...sink.engrave.keys()]
      .sort((a, b) => a - b)
      .map(level => el('path', {
        d: sink.engrave.get(level).join(' '),
        fill: fill(level),
        'fill-rule': 'nonzero',
        stroke: 'none',
      }));
    groups.push(el('g', mark('engrave'), paths.join('')));
  }
  if (sink.score.length) {
    groups.push(el('g', mark('score'), el('path', {
      d: sink.score.join(' '),
      fill: 'none',
      stroke: target.score,
      'stroke-width': num(hairline),
    })));
  }
  if (sink.cut.length) {
    groups.push(el('g', mark('cut'), el('path', {
      d: sink.cut.join(' '),
      fill: 'none',
      stroke: target.cut,
      'stroke-width': num(hairline),
    })));
  }
  return groups.join('');
}

/* Scanned rather than matched: a 52-tile review grid runs this over hundreds of
kilobytes of path data every frame, and the regex form allocated a string per
number to produce a single status-bar figure. */
function countNumbers(d) {
  let n = 0;
  let inNumber = false;
  for (let i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i);
    if (c === 45) {
      n++;
      inNumber = true;
    } else if ((c >= 48 && c <= 57) || c === 46) {
      if (!inNumber) n++;
      inNumber = true;
    } else {
      inNumber = false;
    }
  }
  return n;
}

/* Implicit command repetition hides segment counts, so count coordinate pairs. */
export function countPoints(sink) {
  let n = 0;
  const tally = (ds) => {
    for (const d of ds) n += countNumbers(d);
  };
  tally(sink.cut);
  tally(sink.score);
  for (const ds of sink.engrave.values()) tally(ds);
  return Math.round(n / 2);
}

// Grid steps per pen radius, and ring tolerance as a fraction of the radius.
const WELD_STEPS = 6;
const WELD_TOLERANCE = 0.01;

/* Gives open polylines real body: every point within width / 2 of a stroke,
welded into closed rings that never overlap. Outlines run clockwise on screen
and counters the other way, so nonzero and even-odd fill agree. LightBurn
fills even-odd whatever the file says, so overlapping pieces of one glyph
would engrave there as holes.
Traced by marching squares over the distance to the strokes, WELD_STEPS grid
steps per radius: straight runs are exact, round caps and joins sit within
1/300 of the radius, and a concave corner is rounded by about a twelfth. */
export function weldStrokes(strokes, width) {
  const r = width / 2;
  const segments = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    stroke.forEach(([x, y], i) => {
      if (i) segments.push([stroke[i - 1][0], stroke[i - 1][1], x, y]);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    });
  }
  if (!(r > 0) || !segments.length) return [];
  const step = r / WELD_STEPS;
  const band = r + 2 * step;
  const x0 = minX - band;
  const y0 = minY - band;
  const nx = Math.ceil((maxX - minX + 2 * band) / step) + 1;
  const ny = Math.ceil((maxY - minY + 2 * band) / step) + 1;
  // Radius less distance, positive inside. Past the band only the sign is
  // read, so nodes no segment reaches keep a negative floor.
  const field = new Float64Array(nx * ny).fill(-band);
  for (const [ax, ay, bx, by] of segments) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - band - x0) / step));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + band - x0) / step));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - band - y0) / step));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + band - y0) / step));
    for (let j = j0; j <= j1; j++) {
      const py = y0 + j * step;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + i * step;
        const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
        const ex = ax + t * dx - px;
        const ey = ay + t * dy - py;
        const v = r - Math.sqrt(ex * ex + ey * ey);
        if (v > field[j * nx + i]) field[j * nx + i] = v;
      }
    }
  }
  // Edge 2k runs from node k to the node on its right, 2k + 1 to the node below.
  // next[e] is the crossing the contour reaches after e, inside on its right.
  const next = new Int32Array(2 * nx * ny).fill(-1);
  const inside = k => field[k] > 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = b + nx;
      const d = a + nx;
      const mask = (inside(a) ? 1 : 0) | (inside(b) ? 2 : 0) | (inside(c) ? 4 : 0) | (inside(d) ? 8 : 0);
      if (mask === 0 || mask === 15) continue;
      const top = 2 * a;
      const right = 2 * b + 1;
      const bottom = 2 * d;
      const left = 2 * a + 1;
      // Opposite corners inside: the cell centre decides whether they join.
      if (mask === 5 || mask === 10) {
        const joined = field[a] + field[b] + field[c] + field[d] > 0;
        if (mask === 5) {
          next[top] = joined ? right : left;
          next[bottom] = joined ? left : right;
        } else {
          next[joined ? left : right] = top;
          next[joined ? right : left] = bottom;
        }
        continue;
      }
      // Walking the cell clockwise, the contour starts where the walk leaves
      // the inside and ends where the walk comes back in.
      const corners = [a, b, c, d];
      const sides = [top, right, bottom, left];
      let from = -1;
      let to = -1;
      for (let k = 0; k < 4; k++) {
        const here = inside(corners[k]);
        const ahead = inside(corners[(k + 1) & 3]);
        if (here && !ahead) from = sides[k];
        else if (!here && ahead) to = sides[k];
      }
      next[from] = to;
    }
  }
  const crossing = e => {
    const k = e >> 1;
    const t = field[k] / (field[k] - field[e & 1 ? k + nx : k + 1]);
    const i = k % nx;
    const j = (k - i) / nx;
    return e & 1 ? [x0 + i * step, y0 + (j + t) * step] : [x0 + (i + t) * step, y0 + j * step];
  };
  const rings = [];
  for (let e = 0; e < next.length; e++) {
    if (next[e] < 0) continue;
    const ring = [];
    for (let at = e; next[at] >= 0;) {
      ring.push(crossing(at));
      const following = next[at];
      next[at] = -1;
      at = following;
    }
    const simple = simplifyPolyline([...ring, ring[0]], r * WELD_TOLERANCE);
    simple.pop();
    if (simple.length > 2) rings.push(simple);
  }
  return rings;
}

/* Summed segment length of a polyline, for the score-length readout. */
export function polylineLengthMm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

/* Ramer-Douglas-Peucker: drops vertices within `tolerance` of the chord that
would replace them. Endpoints always survive, so trimmed crossings stay put. */
export function simplifyPolyline(points, tolerance) {
  const n = points.length;
  if (n < 3) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD2 = tol2;
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d2 = ex * ex + ey * ey;
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/* ── boundary tests and trimming ──────────────────────────────────────────── */

/* Winding-agnostic point test against an axis-aligned rounded rect. */
function insideRoundedRect(px, py, rect) {
  const { x, y, w, h, r } = rect;
  if (px < x || px > x + w || py < y || py > y + h) return false;
  if (r <= 0) return true;
  const cx = clamp(px, x + r, x + w - r);
  const cy = clamp(py, y + r, y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/* Liang-Barsky clip of a segment to an axis-aligned rect. Returns null when outside. */
export function clipSegment(x0, y0, x1, y1, rect) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - rect.x, rect.x + rect.w - x0, y0 - rect.y, rect.y + rect.h - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

/* trimPolyline tests vertices, so long chords must carry intermediate points. */
export function densify(points, maxStep) {
  if (points.length < 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / maxStep);
    for (let k = 1; k < n; k++) {
      out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
    }
    out.push([x1, y1]);
  }
  return out;
}

/* Splits a polyline into the runs inside `rect`, refining each crossing by bisection. */
export function trimPolyline(points, rect, refine = 5) {
  const runs = [];
  let current = null;
  let prev = null;
  let prevIn = false;
  const cross = (a, b) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < refine; i++) {
      const mid = (lo + hi) / 2;
      const p = [a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid];
      if (insideRoundedRect(p[0], p[1], rect)) lo = mid;
      else hi = mid;
    }
    return [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
  };
  for (const p of points) {
    const isIn = insideRoundedRect(p[0], p[1], rect);
    if (isIn && !prevIn) {
      current = [];
      if (prev) current.push(cross(p, prev));
      current.push(p);
    } else if (isIn) {
      current.push(p);
    } else if (prevIn) {
      current.push(cross(prev, p));
      if (current.length > 1) runs.push(current);
      current = null;
    }
    prev = p;
    prevIn = isIn;
  }
  if (current && current.length > 1) runs.push(current);
  return runs;
}
