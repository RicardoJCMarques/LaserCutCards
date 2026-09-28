/*!
 * @file        src/core.js
 * @description Parameter kernel.
 *              Machine-facing constants, numeric helpers, the state tree and
 *              its clamping pass, the division-first layout resolver, the pass
 *              and pattern-budget rules and the URL codec. Imports nothing, so
 *              the whole model runs headless.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/LaserCutCards}
 *
 * SPDX-FileCopyrightText: 2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// All lengths are millimetres. SVG user units are millimetres. Y increases downward.
// A single-card file has its origin at the card corner. A sheet file is its own
// stock with the origin at the stock corner; pages are filled rectangles with the
// margin all round, so a sheet turned over left to right lands on the same frame.
export const PRECISION = 3;

// Sub-threshold width that importers resolve to a hairline. Trotec wants ~0.001mm;
// 0.01 is the value that survives Inkscape/Illustrator round-trips without collapsing to 0.
const HAIRLINE_MM = 0.01;

// Colour -> operation is assigned inside the machine software, not by the file.
// No two operations may share a colour or a colour-keyed importer cannot split
// them. Engrave levels are written as greys unless the target lists a colour per
// level: LightBurn keys layers to exact entries of a fixed palette that holds
// three greys, so any other grey would share a layer with a different depth.
export const TARGETS = {
  generic: {
    id: 'generic',
    label: 'Generic (Grayscale Tone Mapping)',
    cut: '#FF0000',
    score: '#0000FF',
    hairlineMm: 0.01
  },
  lightburn: {
    id: 'lightburn',
    label: 'LightBurn (Palette Layers)',
    cut: '#FF0000',
    score: '#0000FF',
    engrave: ['#000000', '#00E000', '#D0D000', '#FF8000', '#00E0E0', '#FF00FF', '#B4B4B4', '#0000A0'],
    hairlineMm: 0.01
  },
  trotec: {
    id: 'trotec',
    label: 'Trotec JobControl',
    cut: '#FF0000',
    score: '#0000FF',
    hairlineMm: 0.001
  }
};
const DEFAULT_TARGET = 'generic';

// art.js owns the theme registry and resolveTheme falls back on an unknown id,
// so core never imports it and the dependency direction stays one-way.
export const DEFAULT_THEME_ID = 'classic';

// Distinct fills become distinct <path> elements. Quantising caps element count on
// faceted court art.
export const GRAY_LEVELS = 8;

for (const target of Object.values(TARGETS)) {
  const colours = [target.cut, target.score, ...(target.engrave || [])].map(c => c.toUpperCase());
  if ((target.engrave && target.engrave.length !== GRAY_LEVELS) || new Set(colours).size !== colours.length) {
    throw new Error(`target "${target.id}" needs ${GRAY_LEVELS} engrave colours, distinct from each other and from cut and score`);
  }
}

export const LIMITS = {
  minCardMm: 10,
  maxCardMm: 2000,
  // Back pattern points, as countPoints counts them. Each card gets the smaller
  // of its own allowance and its share of the sheet's.
  patternPointsPerCard: 150000,
  patternPointsPerSheet: 600000
};

// Review grid metrics. These describe the on-screen contact sheet only; no
// exported file is ever laid out with them.
export const REVIEW = {
  gapRatio: 0.14, // of card width, between tiles
  maxColumns: 13
};

// Fractions of artUnit(field) unless noted. state.art multiplies these.
export const TUNING = {
  pipScale: 0.16, // fraction of the artwork frame's shorter edge
  acePipScale: 0.35, // fraction of the artwork frame's shorter edge
  indexRankHeight: 0.08, // fraction of the card's shorter edge
  indexSuitScale: 0.45, // relative to the index rank glyph
  indexGutter: 0.3, // air between an index column and the field, in index rank heights
  courtAspect: 0.62, // width over height of the frame the court meshes are drawn in
  // Rank glyphs are centrelines given body at render time. Fraction of the glyph
  // em, so it tracks whatever size the glyph is placed at.
  glyphWeight: 0.15,
  // Real decks lift the 9's centre pip clear of the y=0.4 row.
  ninePipCentreOffset: -0.02
};

// One range per numeric parameter. The rail reads its bounds from here and
// clampState enforces the same ones, so a link cannot carry a value the rail
// could not have produced. A limit that depends on another parameter, such as a
// radius against the card it rounds, is applied at resolve time instead and is
// never written back.
export const RANGES = {
  'stock.widthMm': { min: 20, max: 3000, step: 1 },
  'stock.heightMm': { min: 20, max: 3000, step: 1 },
  'stock.marginMm': { min: 0, max: 50, step: 0.5 },
  'stock.gapMm': { min: 0, max: 40, step: 0.5 },
  'grid.cols': { min: 1, max: 12, step: 1, integer: true },
  'grid.rows': { min: 1, max: 12, step: 1, integer: true },
  'card.cornerRadiusMm': { min: 0, max: 40, step: 0.5 },
  'card.safeMarginMm': { min: 0, max: 40, step: 0.5 },
  'face.rank': { min: 1, max: 13, step: 1, integer: true },
  'face.redTone': { min: 0, max: 5, step: 1, integer: true },
  'back.seed': { min: 0, max: 2147483647, step: 1, integer: true },
  'back.rotation': { min: -180, max: 180, step: 1 },
  'back.guillLobes': { min: 3, max: 60, step: 1, integer: true },
  'back.guillTurns': { min: 1, max: 29, step: 1, integer: true },
  'back.guillDepth': { min: 0, max: 1.5, step: 0.05 },
  'back.guillLines': { min: 1, max: 12, step: 1, integer: true },
  'back.truchetTile': { min: 2, max: 60, step: 0.5 },
  'back.truchetProb': { min: 0, max: 1, step: 0.05 },
  'back.ringSpacing': { min: 2, max: 60, step: 0.5 },
  'back.latticeCell': { min: 2, max: 60, step: 0.5 },
  'back.spiralPitch': { min: 2, max: 60, step: 0.5 },
  'back.spiralArms': { min: 1, max: 12, step: 1, integer: true },
  'back.hexSize': { min: 2, max: 60, step: 0.5 },
  'back.halftoneCell': { min: 0.5, max: 20, step: 0.25 },
  'back.halftoneGamma': { min: 0.2, max: 4, step: 0.05 },
  'art.scale': { min: 0.5, max: 2, step: 0.05 },
  'art.pip': { min: 0.5, max: 2, step: 0.05 },
  'art.ace': { min: 0.5, max: 2, step: 0.05 },
  'art.index': { min: 0.5, max: 2, step: 0.05 },
  'art.weight': { min: 0.4, max: 2.2, step: 0.05 }
};

/* ── numeric helpers ──────────────────────────────────────────────────────── */

/* An inverted range resolves to its lower bound. */
export function clamp(v, lo, hi) {
  return v < lo || hi < lo ? lo : v > hi ? hi : v;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/* A hypotrochoid whose lobes and turns share a factor retraces itself and
scores the same line again, so it is drawn from the reduced pair. Turns stay
below lobes or the rolling circle vanishes. */
export function guillochePair(back) {
  const turns = Math.min(back.guillTurns, back.guillLobes - 1);
  const g = gcd(back.guillLobes, turns);
  return { lobes: back.guillLobes / g, turns: turns / g };
}

/* Same seed and parameters must always produce byte-identical geometry. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = a + 0x6d2b79f5 >>> 0;
    let t = Math.imul(a ^ a >>> 15, a | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const mm1 = (v) => String(Math.round(v * 10) / 10);

/* ── vocabulary ───────────────────────────────────────────────────────────── */

export const SUITS = ['spade', 'heart', 'diamond', 'club'];
export const SUIT_MARKS = { spade: '♠', heart: '♥', diamond: '♦', club: '♣' };
// Engraved shallower than the black suits so the pair reads apart in the material.
export const RED_SUITS = new Set(['heart', 'diamond']);
export const PATTERNS = ['guilloche', 'truchet', 'rings', 'spiral', 'lattice', 'hex', 'halftone'];
// Round figures that can be opened out to the frame's aspect. The rest are
// grids or straight lines, where a stretch only changes an angle.
export const STRETCH_PATTERNS = ['guilloche', 'rings'];
// Patterns drawn as filled dots, which engrave. Every other pattern is linework, which scores.
export const DOT_PATTERNS = ['halftone'];

// Rank index to glyph key. Vocabulary, not artwork: a theme supplies the glyph
// each key resolves to, but the deck always has these thirteen.
export const RANK_LABELS = { 1: 'A', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K' };
export const COURT_RANKS = new Set([11, 12, 13]);

const STAGES = ['layout', 'design', 'output'];
const SIDES = ['face', 'back'];
const SCOPES = ['card', 'suit', 'deck'];

// What varies the dot size across the card, and what each dot is cut as.
export const HALFTONE_FIELDS = ['radial', 'linear', 'diagonal', 'conic', 'rings', 'waves', 'corner'];
export const HALFTONE_SHAPES = ['dot', 'square', 'diamond'];
const DECK_SIZE = 52;

/* ── state ────────────────────────────────────────────────────────────────── */

/* Links carry only the fields that differ from these values, so once links are
in circulation a changed default silently changes every link that relied on
it. Change one only together with a version alias that decodes older links
against the old value. */
export function defaultState() {
  return {
    stock: { widthMm: 600, heightMm: 400, marginMm: 5, gapMm: 5 },
    // The division is the shape control: 2 x 3 gives portrait cells, 3 x 2 gives
    // landscape ones. The card fills its cell, so there is no second opinion
    // about proportion to reconcile.
    grid: { cols: 2, rows: 1 },
    // The margin is added to the corner radius, so the frame always clears the arcs.
    card: { cornerRadiusMm: 5, safeMarginMm: 7.5 },
    // The selected card: shown at card scope, and its suit at suit scope.
    face: { suit: 'spade', rank: 1, showIndices: true, indexCorners: 2, redTone: 3 },
    back: {
      pattern: 'guilloche',
      seed: 12345,
      rotation: 0, // degrees; rings are round and ignore it
      stretch: true,
      // A hypotrochoid closes after `turns` revolutions and draws `lobes` of
      // them, so the pair is the figure. Depth is the pen offset as a fraction
      // of the rolling circle: 0 is a plain polygon, 1 a full rosette.
      guillLobes: 9,
      guillTurns: 4,
      guillDepth: 0.75,
      guillLines: 3,
      truchetTile: 12,
      truchetProb: 0.5,
      ringSpacing: 5,
      latticeCell: 14,
      spiralPitch: 6,
      spiralArms: 3,
      hexSize: 10,
      halftoneCell: 4,
      halftoneGamma: 1,
      halftoneField: 'radial',
      halftoneShape: 'dot',
      halftoneStagger: true,
      halftoneInvert: false
    },
    // Multipliers over TUNING. Every default of 1 reproduces the shipped baseline.
    art: { scale: 1, pip: 1, ace: 1, index: 1, weight: 1 },
    // side and scope are shared by Design and Output: what is shown is what exports.
    view: { stage: 'layout', side: 'face', scope: 'suit' },
    // Each side keeps its own switches. stockCut squares the stock on the face pass.
    output: {
      target: DEFAULT_TARGET,
      face: { cut: true, engrave: true },
      back: { cut: false, score: true, engrave: true },
      stockCut: false,
      backJig: false
    },
    theme: DEFAULT_THEME_ID
  };
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
  return obj;
}

export function resolveTarget(state) {
  const id = state.output.target;
  return Object.hasOwn(TARGETS, id) ? TARGETS[id] : TARGETS[DEFAULT_TARGET];
}

export function hairlineFor(target) {
  return target && target.hairlineMm != null ? target.hairlineMm : HAIRLINE_MM;
}

/* Reference length for artwork sizing: the shorter edge. The layout grid
stretches with the card, the glyphs do not, so a wide cell must not inflate a
glyph past the short edge it sits against. */
export function artUnit(region) {
  return Math.min(region.w, region.h);
}

/* Master scale times the named element's own multiplier. */
export function artScale(state, key) {
  return state.art.scale * state.art[key];
}

/* ── layout ───────────────────────────────────────────────────────────────── */

/* The artwork frame clears the corner arcs: the corner radius is inset first and
the margin added on top, on both axes. Faces and backs share it. */
function safeArea(card, safeMarginMm) {
  const inset = clamp(card.cornerRadiusMm + safeMarginMm, 0, Math.min(card.widthMm, card.heightMm) / 2 - 1);
  return { x: inset, y: inset, w: card.widthMm - 2 * inset, h: card.heightMm - 2 * inset, r: 0 };
}

/* Stock and division in, geometry out. Nothing here is ever stored in state.
The card is the cell, so proportion is whatever the division implies and the
block covers the usable area exactly. Positions place the first card at 0,0.
Limits that depend on another parameter are applied here and reported rather
than written back, so an authored value survives an intermediate layout that
could not carry it. */
export function resolveLayout(state) {
  const { stock, grid, card } = state;
  const notes = [];
  const { cols, rows } = grid;
  const gap = stock.gapMm;
  const marginMm = clamp(stock.marginMm, 0, Math.min(stock.widthMm, stock.heightMm) / 2 - 1);
  const usableW = stock.widthMm - 2 * marginMm;
  const usableH = stock.heightMm - 2 * marginMm;
  const widthMm = (usableW - (cols - 1) * gap) / cols;
  const heightMm = (usableH - (rows - 1) * gap) / rows;
  const tooSmall = widthMm < LIMITS.minCardMm || heightMm < LIMITS.minCardMm;
  const tooLarge = widthMm > LIMITS.maxCardMm || heightMm > LIMITS.maxCardMm;
  const valid = !tooSmall && !tooLarge;
  if (tooSmall) notes.push(`${cols} x ${rows} leaves no usable card on this stock.`);
  else if (tooLarge) notes.push(`Cards over ${LIMITS.maxCardMm} mm are not supported; divide the stock further.`);
  const short = Math.min(widthMm, heightMm);
  const cornerRadiusMm = clamp(card.cornerRadiusMm, 0, short / 2);
  const resolvedCard = { widthMm, heightMm, cornerRadiusMm };
  const safe = safeArea(resolvedCard, card.safeMarginMm);
  const safeMarginMm = Math.max(0, safe.x - cornerRadiusMm);
  if (stock.marginMm > marginMm) {
    notes.push(`Uncut edge limited to ${mm1(marginMm)} mm by the stock size.`);
  }
  if (valid && card.cornerRadiusMm > cornerRadiusMm) {
    notes.push(`Corner radius limited to ${mm1(cornerRadiusMm)} mm by the card size.`);
  }
  if (valid && card.safeMarginMm > safeMarginMm + 1e-9) {
    notes.push(`Artwork margin limited to ${mm1(safeMarginMm)} mm by the card size.`);
  }
  const positions = [];
  for (let i = 0; i < cols * rows; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.push({ x: col * (widthMm + gap), y: row * (heightMm + gap), col, row, index: i });
  }
  const stockArea = stock.widthMm * stock.heightMm;
  return {
    valid,
    cols,
    rows,
    count: cols * rows,
    gap,
    marginMm,
    card: resolvedCard,
    safe,
    safeMarginMm,
    usable: { widthMm: usableW, heightMm: usableH },
    positions,
    ratio: short > 0 ? Math.max(widthMm, heightMm) / short : 1,
    utilization: valid && stockArea > 0 ? cols * rows * widthMm * heightMm / stockArea : 0,
    notes
  };
}

/* How `total` cards page across the division: full sheets first, then the
remaining complete rows, then one short row. Every page is a filled rectangle,
so a page turned over lands on itself and never needs mirroring. */
export function sheetPages(layout, total = DECK_SIZE) {
  const { cols, rows } = layout;
  const pages = [];
  let start = 0;
  const add = (c, r) => {
    pages.push({ cols: c, rows: r, count: c * r, start });
    start += c * r;
  };
  while (total - start >= cols * rows) add(cols, rows);
  const fullRows = Math.floor((total - start) / cols);
  if (fullRows) add(cols, fullRows);
  if (total - start) add(total - start, 1);
  return pages;
}

/* The operations a pass emits. Each side keeps its own switches, so the face
pass can engrave and square the stock while the back pass engraves and cuts.
Faces carry no score geometry, and a back pattern is either linework, which
scores, or dots, which engrave, so the other switch has nothing to act on. */
export function passOperations(state, side) {
  const ops = state.output[side];
  if (side === 'face') return { cut: ops.cut, score: false, engrave: ops.engrave };
  const dots = DOT_PATTERNS.includes(state.back.pattern);
  return { cut: ops.cut, score: ops.score && !dots, engrave: ops.engrave && dots };
}

export function emptyJobNote(state){
  const faceOps = passOperations(state, 'face');
  const backOps = passOperations(state, 'back');
  const hasFace = faceOps.cut || faceOps.engrave;
  const hasBack = backOps.cut || backOps.score || backOps.engrave;
  const hasStock = state.output.stockCut && state.view.scope !== 'card';
  if (hasFace || hasBack || hasStock) return '';
  return 'No operations selected to emit. Turn on Cut, Score or Engrave.';
}

/* Why the view's pass would write files with nothing in them, or '' when it
would not. The stock outline counts only where there is stock, which a
single card has not. */
export function emptyPassNote(state) {
  const { side, scope } = state.view;
  const ops = passOperations(state, side);
  if (ops.cut || ops.score || ops.engrave) return '';
  if (side === 'face') {
    if (state.output.stockCut && scope !== 'card') return '';
    return 'The face pass has nothing to emit. Turn on Cut cards or Engrave.';
  }
  const operation = DOT_PATTERNS.includes(state.back.pattern) ? 'Engrave' : 'Score';
  return `The back pass has nothing to emit. Turn on ${operation} or Cut cards.`;
}

/* Point allowance for one card's back pattern on this division. */
export function patternBudget(layout) {
  const share = LIMITS.patternPointsPerSheet / Math.max(1, layout.count);
  return Math.floor(Math.min(LIMITS.patternPointsPerCard, share));
}

/* ── pattern randomisation ────────────────────────────────────────────────── */

/* Only Truchet consumes the PRNG; the rest are fully determined by their
parameters. So the button draws new parameters rather than a new seed, which
is the only reading under which it does something on every pattern. */
const round2 = (v) => Math.round(v * 100) / 100;

const PATTERN_RANDOM = {
  guilloche(back, rnd) {
    back.guillLobes = 5 + Math.round(rnd() * 25);
    // Turns near half the lobe count give the densest rosette.
    back.guillTurns = 1 + Math.round(rnd() * (back.guillLobes - 2));
    back.guillDepth = round2(0.3 + rnd() * 1);
    back.guillLines = 1 + Math.round(rnd() * 4);
  },
  spiral(back, rnd) {
    back.spiralPitch = round2(2 + rnd() * 12);
    back.spiralArms = 1 + Math.round(rnd() * 7);
  },
  hex(back, rnd) {
    back.hexSize = round2(4 + rnd() * 18);
  },
  truchet(back, rnd) {
    back.truchetTile = round2(4 + rnd() * 18);
    back.truchetProb = round2(0.25 + rnd() * 0.5);
  },
  rings(back, rnd) {
    back.ringSpacing = round2(2 + rnd() * 12);
  },
  lattice(back, rnd) {
    back.latticeCell = round2(3 + rnd() * 22);
  },
  halftone(back, rnd) {
    back.halftoneCell = round2(1.5 + rnd() * 6);
    back.halftoneGamma = round2(0.4 + rnd() * 2);
    back.halftoneField = HALFTONE_FIELDS[Math.floor(rnd() * HALFTONE_FIELDS.length)];
    back.halftoneShape = HALFTONE_SHAPES[Math.floor(rnd() * HALFTONE_SHAPES.length)];
    back.halftoneStagger = rnd() > 0.4;
    back.halftoneInvert = rnd() > 0.75;
  }
};

/* The rail offers what PATTERNS lists, so anything keyed off it has to answer
for every entry. Randomise throws outside guard(), and a missing generator
falls back silently to guilloche. */
for (const pattern of PATTERNS) {
  if (!PATTERN_RANDOM[pattern]) throw new Error(`pattern "${pattern}" has no randomiser`);
}
for (const pattern of [...STRETCH_PATTERNS, ...DOT_PATTERNS]) {
  if (!PATTERNS.includes(pattern)) throw new Error(`"${pattern}" is listed as a pattern but PATTERNS lacks it`);
}

export function randomisePattern(state, rnd = Math.random) {
  const { back } = state;
  PATTERN_RANDOM[back.pattern](back, rnd);
  back.rotation = Math.round(rnd() * 36 - 18) * 5;
  back.seed = Math.floor(rnd() * 2 ** 31);
  return state;
}

/* Whether the seed reaches the geometry at all for this pattern. */
export function patternUsesSeed(pattern) {
  return pattern === 'truchet';
}

/* ── clamping ─────────────────────────────────────────────────────────────── */

/* Mutates state into a valid configuration: fixed ranges and vocabularies
only. Limits that depend on other parameters belong to resolveLayout and the
pattern generators, and whether a pass has anything to emit is reported at
draw time, so no authored value is ever rewritten because of another.
options.themes lists the valid theme ids, which art.js owns. */
export function clampState(state, options = {}) {
  const base = defaultState();
  for (const [path, range] of Object.entries(RANGES)) {
    let v = Number(getPath(state, path));
    if (!Number.isFinite(v)) v = getPath(base, path);
    v = clamp(v, range.min, range.max);
    setPath(state, path, range.integer ? Math.round(v) : v);
  }
  const { face, back, view, output } = state;
  if (!SUITS.includes(face.suit)) face.suit = 'spade';
  face.showIndices = Boolean(face.showIndices);
  face.indexCorners = face.indexCorners === 4 ? 4 : 2;
  if (!PATTERNS.includes(back.pattern)) back.pattern = 'guilloche';
  if (!HALFTONE_FIELDS.includes(back.halftoneField)) back.halftoneField = 'radial';
  if (!HALFTONE_SHAPES.includes(back.halftoneShape)) back.halftoneShape = 'dot';
  back.stretch = Boolean(back.stretch);
  back.halftoneStagger = Boolean(back.halftoneStagger);
  back.halftoneInvert = Boolean(back.halftoneInvert);
  if (!STAGES.includes(view.stage)) view.stage = 'layout';
  if (!SIDES.includes(view.side)) view.side = 'face';
  if (!SCOPES.includes(view.scope)) view.scope = 'suit';
  if (!Object.hasOwn(TARGETS, output.target)) output.target = DEFAULT_TARGET;
  for (const side of SIDES) {
    for (const op of Object.keys(output[side])) output[side][op] = Boolean(output[side][op]);
  }
  output.stockCut = Boolean(output.stockCut);
  output.backJig = Boolean(output.backJig);
  const { themes } = options;
  if (typeof state.theme !== 'string' || (themes && !themes.includes(state.theme))) {
    state.theme = DEFAULT_THEME_ID;
  }
  return state;
}

/* ── URL codec ────────────────────────────────────────────────────────────── */

// From the first release an alias is permanent, since links in the wild store
// it: never rename or reuse one, and retire it for good with its field.
const ALIAS = {
  'stock.widthMm': 'sw', 'stock.heightMm': 'sh', 'stock.marginMm': 'sm', 'stock.gapMm': 'sg',
  'grid.cols': 'gc', 'grid.rows': 'gr',
  'card.cornerRadiusMm': 'cc', 'card.safeMarginMm': 'cs',
  'face.suit': 'fs', 'face.rank': 'fr', 'face.redTone': 'fz', 'face.showIndices': 'fi', 'face.indexCorners': 'fn',
  'back.pattern': 'kp', 'back.seed': 'kd', 'back.rotation': 'kr', 'back.stretch': 'ks',
  'back.guillLobes': 'g1', 'back.guillTurns': 'g2', 'back.guillDepth': 'g3', 'back.guillLines': 'g4',
  'back.truchetTile': 't1', 'back.truchetProb': 't2', 'back.ringSpacing': 'r1', 'back.latticeCell': 'l1',
  'back.spiralPitch': 'p1', 'back.spiralArms': 'p2', 'back.hexSize': 'x1',
  'back.halftoneCell': 'h1', 'back.halftoneGamma': 'h2', 'back.halftoneField': 'h3', 'back.halftoneShape': 'h4',
  'back.halftoneStagger': 'h6', 'back.halftoneInvert': 'h7',
  'art.scale': 'as', 'art.pip': 'ap', 'art.ace': 'aa', 'art.index': 'ax', 'art.weight': 'aw',
  'view.stage': 'vt', 'view.side': 'vd', 'view.scope': 'vs',
  'output.target': 'ot', 'output.stockCut': 'oc', 'output.backJig': 'oj', 
  'output.face.cut': 'o1', 'output.face.engrave': 'o3',
  'output.back.cut': 'b1', 'output.back.score': 'b2', 'output.back.engrave': 'b3',
  theme: 'th'
};

// A Map, not an object: a fragment key such as `constructor` must not resolve
// to an inherited member.
const ALIAS_REVERSE = new Map(Object.entries(ALIAS).map(([path, alias]) => [alias, path]));

// A field without an alias silently drops out of links and storage, and two
// fields on one alias overwrite each other.
// REVIEW - This syntax is confusing? Why does it have the brackets like this?
{
  const leaves = (node, prefix) => Object.entries(node).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value !== null && typeof value === 'object' ? leaves(value, path) : [path];
  });
  const fields = leaves(defaultState(), '');
  for (const path of fields) {
    if (!Object.hasOwn(ALIAS, path)) throw new Error(`state field "${path}" has no URL alias`);
  }
  for (const path of Object.keys(ALIAS)) {
    if (!fields.includes(path)) throw new Error(`URL alias "${ALIAS[path]}" names no state field`);
  }
  if (ALIAS_REVERSE.size !== fields.length) throw new Error('two state fields share a URL alias');
}

function encodeValue(v) {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  return encodeURIComponent(String(v));
}

function decodeValue(raw, sample) {
  const s = decodeURIComponent(raw);
  if (typeof sample === 'boolean') return s === '1';
  if (typeof sample === 'number') return Number(s);
  return s;
}

/* Emits only the fields that differ from defaults, keeping shareable links short.
'~' is unreserved, so the fragment survives browser normalisation untouched. */
export function encodeState(state) {
  const base = defaultState();
  const parts = [];
  for (const [path, alias] of Object.entries(ALIAS)) {
    const v = getPath(state, path);
    if (v === undefined || v === getPath(base, path)) continue;
    parts.push(`${alias}=${encodeValue(v)}`);
  }
  return parts.join('~');
}

/* Unrecognised aliases and malformed parts are skipped, so a link from an older
build, or a damaged one, keeps whatever of it still means the same thing
instead of collapsing to defaults. */
export function decodeState(encoded, options = {}) {
  const state = defaultState();
  if (encoded) {
    for (const part of String(encoded).split('~')) {
      const eq = part.indexOf('=');
      if (eq < 1) continue;
      const path = ALIAS_REVERSE.get(part.slice(0, eq));
      if (!path) continue;
      try {
        setPath(state, path, decodeValue(part.slice(eq + 1), getPath(state, path)));
      } catch {
        // A malformed percent-escape drops this part only.
      }
    }
  }
  clampState(state, options);
  return state;
}