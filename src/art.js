/*!
 * @file        src/art.js
 * @description Artwork renderer and theme registry.
 *              Binds glyph sets to a court renderer and validates them before
 *              they reach a render; fits every face element to the card it is
 *              drawn on and composes the face; generates the back patterns
 *              within a point budget.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/LaserCutCards}
 *
 * SPDX-FileCopyrightText: 2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TUNING, RANK_LABELS, COURT_RANKS, DEFAULT_THEME_ID, GRAY_LEVELS, PATTERNS, STRETCH_PATTERNS, HALFTONE_FIELDS, SUITS, RED_SUITS, artUnit, artScale, clamp, mulberry32, guillochePair } from './core.js';
import { Path, circlePath, roundedRectPath, LayerSink, weldStrokes, transformPathData, mIdentity, mCompose, mTranslate, mScale, mRotate, mApply, mPlaceGlyph, clipSegment, densify, trimPolyline, polylineLengthMm, simplifyPolyline } from './svg.js';
import { SUIT_PATHS, SUIT_PATHS_ANGULAR, STROKE_FONT, RANK_OUTLINES, COURT_FACETS_GEOMETRIC } from './art-data.js';

/* ── theme registry ───────────────────────────────────────────────────────── */

// A theme binds a suit set and a rank font. The court mesh is geometry, not
// artwork, so every theme shares it and the card decides which renderer to use.
export const THEMES = {};

function resolveTheme(id) {
  return Object.hasOwn(THEMES, id) ? THEMES[id] : THEMES[DEFAULT_THEME_ID];
}

/* Reports every way a glyph set breaks the authoring contract, as a list of
messages. transformPathData is the authority on acceptable path data, so paths
are checked by running them through it rather than by a second copy of the
rule that could drift. */
function validateGlyphSet(set, label = 'theme') {
  const problems = [];
  const identity = mIdentity();
  const isPair = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  const checkPath = (where, d) => {
    if (typeof d !== 'string' || !d.trim()) {
      problems.push(`${where}: path data is missing`);
      return;
    }
    try {
      transformPathData(d, identity);
    } catch (error) {
      problems.push(`${where}: ${error.message}`);
    }
  };
  const suits = set.suits || {};
  const rankFont = set.rankFont || {};
  const rankOutlines = set.rankOutlines || {};
  const courts = set.courts || {};
  for (const [name, d] of Object.entries(suits)) checkPath(`${label}.suits.${name}`, d);
  for (const [ch, glyph] of Object.entries(rankFont)) {
    const where = `${label}.rankFont.${ch}`;
    if (!(glyph.adv > 0)) problems.push(`${where}: adv must be a positive number`);
    if (!Array.isArray(glyph.strokes) || !glyph.strokes.length) {
      problems.push(`${where}: strokes must be a non-empty array`);
      continue;
    }
    for (const stroke of glyph.strokes) {
      if (!Array.isArray(stroke) || stroke.length < 2) {
        problems.push(`${where}: every stroke needs at least two points`);
      } else if (!stroke.every(isPair)) {
        problems.push(`${where}: stroke points must be finite [x, y] pairs`);
      }
    }
  }
  for (const [ch, glyph] of Object.entries(rankOutlines)) {
    const where = `${label}.rankOutlines.${ch}`;
    if (!(glyph.adv > 0)) problems.push(`${where}: adv must be a positive number`);
    checkPath(where, glyph.d);
  }
  for (const [rank, facets] of Object.entries(courts)) {
    if (!Array.isArray(facets)) {
      problems.push(`${label}.courts.${rank}: expected an array of facets`);
      continue;
    }
    facets.forEach((facet, i) => {
      const where = `${label}.courts.${rank}[${i}]`;
      if (!Number.isInteger(facet.tone) || facet.tone < 0 || facet.tone >= GRAY_LEVELS) {
        problems.push(`${where}: tone must be an integer engrave step, 0..${GRAY_LEVELS - 1}`);
      }
      if (!Array.isArray(facet.pts) || facet.pts.length < 3) {
        problems.push(`${where}: a facet needs at least three points`);
      } else if (!facet.pts.every(isPair)) {
        problems.push(`${where}: facet points must be finite [u, v] pairs`);
      }
    });
  }
  // A missing glyph would silently drop off its card or fail mid-render.
  for (const suit of SUITS) {
    if (!Object.hasOwn(suits, suit)) problems.push(`${label}.suits.${suit}: missing`);
  }
  for (const ch of new Set(Object.values(RANK_LABELS).join(''))) {
    if (!Object.hasOwn(rankOutlines, ch) && !Object.hasOwn(rankFont, ch)) {
      problems.push(`${label}: no glyph for rank character '${ch}'`);
    }
  }
  for (const rank of COURT_RANKS) {
    if (!Object.hasOwn(courts, rank)) problems.push(`${label}.courts.${rank}: missing`);
  }
  return problems;
}

/* Adds or replaces a theme. Throws rather than let a bad glyph set reach a cut file. */
function registerTheme(theme) {
  if (!theme || !theme.id) throw new Error('a theme needs an id');
  const problems = validateGlyphSet(theme, theme.id);
  if (problems.length) {
    throw new Error(`theme "${theme.id}" rejected:\n  ${problems.join('\n  ')}`);
  }
  THEMES[theme.id] = theme;
  return theme;
}

// Built-in themes pass the same gate as any other, so a bad path in art-data.js
// stops the app at load with a message instead of surfacing mid-render.
registerTheme({ id: 'classic', label: 'Classic', suits: SUIT_PATHS, rankFont: STROKE_FONT, rankOutlines: RANK_OUTLINES, courts: COURT_FACETS_GEOMETRIC });
registerTheme({ id: 'angular', label: 'Angular', suits: SUIT_PATHS_ANGULAR, rankFont: STROKE_FONT, rankOutlines: RANK_OUTLINES, courts: COURT_FACETS_GEOMETRIC });

/* ── card outline ─────────────────────────────────────────────────────────── */

export function cardOutlinePath(origin, card) {
  return roundedRectPath(origin.x, origin.y, card.widthMm, card.heightMm, card.cornerRadiusMm);
}

/* ── face layout ──────────────────────────────────────────────────────────── */

const N = TUNING.ninePipCentreOffset;

/* Pip centroids in normalized art-area space. Anything below v=0.5 is drawn inverted. */
const PIP_LAYOUT = {
  1: [[0.5, 0.5]],
  2: [[0.5, 0.2], [0.5, 0.8]],
  3: [[0.5, 0.2], [0.5, 0.5], [0.5, 0.8]],
  4: [[0.25, 0.2], [0.75, 0.2], [0.25, 0.8], [0.75, 0.8]],
  5: [[0.25, 0.2], [0.75, 0.2], [0.5, 0.5], [0.25, 0.8], [0.75, 0.8]],
  6: [[0.25, 0.2], [0.75, 0.2], [0.25, 0.5], [0.75, 0.5], [0.25, 0.8], [0.75, 0.8]],
  7: [[0.25, 0.2], [0.75, 0.2], [0.5, 0.35], [0.25, 0.5], [0.75, 0.5], [0.25, 0.8], [0.75, 0.8]],
  8: [[0.25, 0.2], [0.75, 0.2], [0.5, 0.35], [0.25, 0.5], [0.75, 0.5], [0.5, 0.65], [0.25, 0.8], [0.75, 0.8]],
  9: [[0.25, 0.2], [0.75, 0.2], [0.25, 0.4], [0.75, 0.4], [0.5, 0.5 + N], [0.25, 0.6], [0.75, 0.6], [0.25, 0.8], [0.75, 0.8]],
  10: [[0.25, 0.2], [0.75, 0.2], [0.5, 0.3], [0.25, 0.4], [0.75, 0.4], [0.25, 0.6], [0.75, 0.6], [0.5, 0.7], [0.25, 0.8], [0.75, 0.8]],
};
const INVERT_EPSILON = 1e-6;

// Air between an index rank's ink and the suit below it, in suit sizes.
const INDEX_SUIT_GAP = 0.12;

/* A landscape card lays the same arrangement along its long axis. The flip
travels with the arrangement rather than with the card: the far half of the
run reads upside down either way round, which is what gives the field the
180° symmetry that lets a card be read from either end. */
function pipLayout(rank, landscape) {
  return PIP_LAYOUT[rank].map(([u, v]) => {
    if (!landscape) return [u, v, v > 0.5 + INVERT_EPSILON];
    const x = v;
    const y = u;
    const flip = y > 0.5 + INVERT_EPSILON || (Math.abs(y - 0.5) <= INVERT_EPSILON && x > 0.5 + INVERT_EPSILON);
    return [x, y, flip];
  });
}

/* Largest glyph box every centroid of a layout can carry without leaving the field. */
function maxPipSize(rank, field) {
  let room = Infinity;
  for (const [u, v] of pipLayout(rank, field.landscape)) {
    room = Math.min(room, u * field.w, (1 - u) * field.w, v * field.h, (1 - v) * field.h);
  }
  return 2 * room;
}

/* An authored filled outline wins per character; otherwise the centreline. */
function glyphFor(theme, ch) {
  if (theme.rankOutlines && theme.rankOutlines[ch]) {
    return { kind: 'outline', ...theme.rankOutlines[ch] };
  }
  const s = theme.rankFont[ch];
  return s ? { kind: 'stroke', ...s } : null;
}

/* Ink extent of a label in em units from its text origin, stroke included. An
authored outline counts as its whole advance box. */
function inkBounds(theme, label, strokeEm) {
  const half = strokeEm / 2;
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  let cursor = 0;
  for (const ch of label) {
    const g = glyphFor(theme, ch);
    if (!g) continue;
    if (g.kind === 'outline') {
      b.minX = Math.min(b.minX, cursor);
      b.maxX = Math.max(b.maxX, cursor + g.adv);
      b.minY = Math.min(b.minY, 0);
      b.maxY = Math.max(b.maxY, 1);
    } else {
      for (const stroke of g.strokes) {
        for (const [x, y] of stroke) {
          b.minX = Math.min(b.minX, cursor + x - half);
          b.maxX = Math.max(b.maxX, cursor + x + half);
          b.minY = Math.min(b.minY, y - half);
          b.maxY = Math.max(b.maxY, y + half);
        }
      }
    }
    cursor += g.adv;
  }
  return b;
}

const meshReachCache = new WeakMap();

/* Furthest facet point from the frame centre, per axis, in frame units. */
function meshReach(facets) {
  let reach = meshReachCache.get(facets);
  if (!reach) {
    reach = { u: 0, v: 0 };
    for (const facet of facets) {
      for (const [u, v] of facet.pts) {
        reach.u = Math.max(reach.u, Math.abs(u - 0.5));
        reach.v = Math.max(reach.v, Math.abs(v - 0.5));
      }
    }
    meshReachCache.set(facets, reach);
  }
  return reach;
}

/* Face metrics for one card size. Deck-wide - independent of the selected suit
and rank - so a sheet computes it once and every card on it shares one index
size, one pip size and one court size.
`safe` is the artwork frame. Caps only guard the frame; whether elements touch
stays the user's call. */
export function resolveFace(state, card, safe) {
  const theme = resolveTheme(state.theme);
  const { face } = state;
  const notes = [];
  const fit = (label, key, cap, shown = true) => {
    const requested = artScale(state, key);
    if (!(requested > cap)) return requested;
    if (shown) notes.push(`${label} limited to ${Math.floor(cap * 100)}% on this card.`);
    return cap;
  };
  // A fraction of the em, which the index scale already sizes, so the master
  // scale reaches the weight once, through the em.
  const strokeEm = TUNING.glyphWeight * state.art.weight;
  const unit = artUnit(safe);
  const s = TUNING.indexSuitScale;

  // Indices are sized off the card and each cluster's own ink starts on the frame
  // corner, so the margin moves them by exactly its value on both axes.
  const metrics = {};
  let bandHalf = 0;
  let clusterH = 0;
  for (const [rank, label] of Object.entries(RANK_LABELS)) {
    const b = inkBounds(theme, label, strokeEm);
    const h = b.maxY - b.minY;
    const half = Math.max((b.maxX - b.minX) / 2, s);
    metrics[rank] = { centerX: (b.minX + b.maxX) / 2, minY: b.minY, h, half };
    bandHalf = Math.max(bandHalf, half);
    clusterH = Math.max(clusterH, h + 2 * s * (1 + INDEX_SUIT_GAP));
  }
  const rankH1 = Math.min(card.widthMm, card.heightMm) * TUNING.indexRankHeight;
  const indexCap = unit / (rankH1 * Math.max(2 * clusterH, 4 * bandHalf));
  const rankH = rankH1 * fit('Corner indices', 'index', indexCap, face.showIndices);
  const index = { rankH, suitSize: 2 * s * rankH, strokeEm, metrics };

  // Pips and courts share the field between the index columns. Sizes are checked
  // against this card and the same card turned, so rotating the stock changes
  // their arrangement, never their size.
  const band = face.showIndices ? 2 * bandHalf * rankH + rankH * TUNING.indexGutter : 0;
  const landscape = card.widthMm > card.heightMm;
  const fields = [
    { w: Math.max(1, safe.w - 2 * band), h: safe.h, landscape },
    { w: Math.max(1, safe.h - 2 * band), h: safe.w, landscape: card.heightMm > card.widthMm }
  ];
  const art = { x: safe.x + band, y: safe.y, w: fields[0].w, h: fields[0].h };

  const pipBase = unit * TUNING.pipScale;
  const aceBase = unit * TUNING.acePipScale;
  let pipRoom = Infinity;
  let aceRoom = Infinity;
  for (const f of fields) {
    for (let rank = 2; rank <= 10; rank++) pipRoom = Math.min(pipRoom, maxPipSize(rank, f));
    aceRoom = Math.min(aceRoom, maxPipSize(1, f));
  }
  const pipSize = pipBase * fit('Pips', 'pip', pipRoom / pipBase);
  const aceSize = aceBase * fit('Ace pip', 'ace', aceRoom / aceBase);

  // Meshes are drawn in a frame of TUNING.courtAspect and fitted uniformly. Every
  // court takes the height that fits the widest and tallest mesh in both
  // orientations, so the three always match and never resize with the stock.
  let courtH = Infinity;
  for (const f of fields) {
    for (const facets of Object.values(theme.courts)) {
      const reach = meshReach(facets);
      courtH = Math.min(courtH, f.w / (2 * reach.u * TUNING.courtAspect), f.h / (2 * reach.v));
    }
  }
  const courtFrame = { w: courtH * TUNING.courtAspect, h: courtH };

  return { theme, art, landscape, pipSize, aceSize, index, courtFrame, strokeEm, notes };
}

/* ── face emitters ────────────────────────────────────────────────────────── */

function suitPathAt(theme, suit, cx, cy, size, rotationDeg, base) {
  const m = mCompose(base, mPlaceGlyph(cx, cy, size, rotationDeg));
  return transformPathData(theme.suits[suit], m);
}

// Welded labels per theme, for the one weight a render uses.
const weldCache = new WeakMap();

/* The stroked glyphs of `text` welded as one, in em units from its origin, so
glyphs that touch at a heavy weight merge instead of overlapping. */
function textWeld(theme, text, strokeEm) {
  let cached = weldCache.get(theme);
  if (!cached || cached.strokeEm !== strokeEm) {
    cached = { strokeEm, labels: new Map() };
    weldCache.set(theme, cached);
  }
  if (!cached.labels.has(text)) {
    const strokes = [];
    let cursor = 0;
    for (const ch of text) {
      const g = glyphFor(theme, ch);
      if (!g) continue;
      if (g.kind === 'stroke') {
        for (const stroke of g.strokes) strokes.push(stroke.map(([x, y]) => [x + cursor, y]));
      }
      cursor += g.adv;
    }
    cached.labels.set(text, weldStrokes(strokes, strokeEm));
  }
  return cached.labels.get(text);
}

/* Emits text whose glyph unit box maps through `base`, always filled on the
engrave layer. A centreline stroked at hairline width is not legible at card
scale, so the centreline is given body here rather than left to a stroke width
the exporter is not allowed to use. strokeEm is a fraction of the em, so the
body scales with whatever `base` does to the unit box. */
function emitText(sink, theme, text, base, gray, strokeEm) {
  let cursor = 0;
  for (const ch of text) {
    const g = glyphFor(theme, ch);
    if (!g) continue;
    if (g.kind === 'outline') sink.addEngrave(transformPathData(g.d, mCompose(base, mTranslate(cursor, 0))), gray);
    cursor += g.adv;
  }
  const p = new Path();
  for (const ring of textWeld(theme, text, strokeEm)) p.polyline(ring.map(([x, y]) => mApply(base, x, y)), true);
  sink.addEngrave(p.toString(), gray);
}

/* `base` is the corner the cluster's ink starts from. The rank's ink is centred
on the cluster's axis and its top sits on the base; the suit hangs below it. */
function emitIndexCluster(sink, theme, face, base, index) {
  const { rankH, suitSize, strokeEm } = index;
  const m = index.metrics[face.rank];
  const axis = m.half * rankH;
  const gray = suitGray(face);
  const textM = mCompose(base, mTranslate(axis - m.centerX * rankH, -m.minY * rankH), mScale(rankH, rankH));
  emitText(sink, theme, RANK_LABELS[face.rank], textM, gray, strokeEm);
  const suitY = m.h * rankH + suitSize * (INDEX_SUIT_GAP + 0.5);
  sink.addEngrave(transformPathData(theme.suits[face.suit], mCompose(base, mPlaceGlyph(axis, suitY, suitSize, 0))), gray);
}

function emitIndices(sink, fit, face, card, safe, origin) {
  if (!face.showIndices) return;
  const { index, theme } = fit;
  const span = 2 * index.metrics[face.rank].half * index.rankH;
  const left = origin.x + safe.x;
  const right = origin.x + card.widthMm - safe.x;
  const top = origin.y + safe.y;
  const bottom = origin.y + card.heightMm - safe.y;
  // Turned clusters read from the opposite corner, so a base on the far side of
  // its corner sits one cluster width in.
  const corners = [mTranslate(left, top), mCompose(mTranslate(right, bottom), mRotate(180))];
  if (face.indexCorners === 4) {
    corners.push(mTranslate(right - span, top));
    corners.push(mCompose(mTranslate(left + span, bottom), mRotate(180)));
  }
  for (const base of corners) emitIndexCluster(sink, theme, face, base, index);
}

/* Red suits engrave shallower than black so the two read apart in the material.
Pips and the whole corner index take this depth, rank included: printed cards
colour both, and a fanned hand shows only the corners. */
function suitGray(face) {
  return RED_SUITS.has(face.suit) ? face.redTone / (GRAY_LEVELS - 1) : 0;
}

function emitPips(sink, fit, face, origin) {
  const { theme, art } = fit;
  const size = face.rank === 1 ? fit.aceSize : fit.pipSize;
  const base = mTranslate(origin.x, origin.y);
  const gray = suitGray(face);
  for (const [u, v, flip] of pipLayout(face.rank, fit.landscape)) {
    const cx = art.x + u * art.w;
    const cy = art.y + v * art.h;
    sink.addEngrave(suitPathAt(theme, face.suit, cx, cy, size, flip ? 180 : 0, base), gray);
  }
}

/* The mesh is a partition and its tones are already quantiser steps, so the
facets are emitted exactly as authored and paint order cannot matter. */
function emitCourtFacets(sink, fit, face, origin) {
  const { theme, art, courtFrame } = fit;
  const base = mTranslate(origin.x, origin.y);
  const cx = art.x + art.w / 2;
  const cy = art.y + art.h / 2;
  const place = (u, v) => mApply(base, cx + (u - 0.5) * courtFrame.w, cy + (v - 0.5) * courtFrame.h);
  for (const facet of theme.courts[face.rank]) {
    const gray = facet.tone / (GRAY_LEVELS - 1);
    sink.addEngrave(new Path().polyline(facet.pts.map(([u, v]) => place(u, v)), true).toString(), gray);
    sink.addEngrave(new Path().polyline(facet.pts.map(([u, v]) => place(1 - u, 1 - v)), true).toString(), gray);
  }
}

/* Face artwork for one card, added to `sink`. Cut geometry is added by the
composer. Pass `fit` from resolveFace when placing many cards of one size. */
export function buildFace(state, card, safe, origin, fit = resolveFace(state, card, safe), sink = new LayerSink()) {
  const { face } = state;
  if (COURT_RANKS.has(face.rank)) emitCourtFacets(sink, fit, face, origin);
  else emitPips(sink, fit, face, origin);
  emitIndices(sink, fit, face, card, safe, origin);
  return sink;
}

/* ── back patterns ────────────────────────────────────────────────────────── */

/* A grid turned by `degrees` still has to cover the frame, so it is laid out
over the square that contains the frame at any angle and rotated about the
frame's centre; the trim cuts it back afterwards. */
function turnedGrid(box, degrees) {
  if (!degrees) return { area: box, turn: (pts) => pts };
  const t = degrees * Math.PI / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const side = Math.hypot(box.w, box.h);
  return {
    area: { x: cx - side / 2, y: cy - side / 2, w: side, h: side },
    turn: (pts) => pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c])
  };
}

// Largest gap between a sampled arc and the true curve.
const CHORD_TOLERANCE_MM = 0.05;
// Coordinate pairs in one circlePath dot: M, then two arcs.
const DOT_POINTS = 8;
// Below this a dot is a scorch mark rather than a tone.
const MIN_DOT_MM = 0.05;

function arcSegments(radius, sweep) {
  if (!(radius > CHORD_TOLERANCE_MM)) return 2;
  const perSegment = 2 * Math.acos(1 - CHORD_TOLERANCE_MM / radius);
  return Math.max(2, Math.ceil(sweep / perSegment));
}

/* Points an arc contributes once densify has split its chords to `step`. */
function arcPoints(radius, sweep, step) {
  return Math.max(arcSegments(radius, sweep), Math.ceil((radius * sweep) / step)) + 1;
}

/* Smallest pitch at or above `requested` whose estimated point count fits the
budget. Counts fall roughly with the square of the pitch, so each pass scales
by the square root of the overshoot. Rounded up to 0.1 mm so the note names
the value actually used. */
function fitPitch(requested, budget, estimate) {
  let pitch = requested;
  for (let i = 0; i < 12; i++) {
    const count = estimate(pitch);
    if (count <= budget) break;
    pitch *= Math.sqrt(count / budget) * 1.01;
  }
  return pitch === requested ? pitch : Math.ceil(pitch * 10) / 10;
}

function budgetNote(what, pitch) {
  return `${what} raised to ${Math.round(pitch * 10) / 10} mm to keep the sheet file manageable.`;
}

/* A hypotrochoid, authored as the two numbers that describe it: the curve
closes after `turns` revolutions and draws `lobes` of them. Radii are a
consequence, and the figure is scaled to the card, so neither is a length the
user should have to think in. */
function guilloche(box, back, { budget }) {
  const { lobes, turns } = guillochePair(back);
  const rolling = lobes - turns;
  const pen = back.guillDepth * turns;
  const k = rolling / turns;
  const maxRadius = rolling + pen || 1;
  // One scale, sized to cover the longer axis, so a rosette stays round on any
  // card and the boundary trim decides what reaches the edge.
  const scale = Math.max(box.w, box.h) / 2 / maxRadius;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const requested = Math.ceil(turns * 240);
  const steps = Math.min(requested, Math.max(240, Math.floor(budget / Math.max(1, back.guillLines))));
  const notes = [];
  if (lobes !== back.guillLobes || turns !== back.guillTurns) {
    notes.push(`${back.guillLobes} lobes and ${back.guillTurns} turns draw as ${lobes} and ${turns}.`);
  }
  if (steps < requested) notes.push('Guilloché detail reduced to keep the sheet file manageable.');
  const polylines = [];
  for (let line = 0; line < back.guillLines; line++) {
    // Copies are true rotations, spread across one lobe pitch so they interleave
    // instead of landing back on the first curve.
    const a = back.rotation * Math.PI / 180 + line * 2 * Math.PI / (lobes * back.guillLines);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * turns * 2 * Math.PI;
      const x = rolling * Math.cos(t) + pen * Math.cos(k * t);
      const y = rolling * Math.sin(t) - pen * Math.sin(k * t);
      pts.push([cx + (x * ca - y * sa) * scale, cy + (x * sa + y * ca) * scale]);
    }
    polylines.push(pts);
  }
  return { polylines, dots: [], notes };
}

function truchet(box, back, { rng, budget, step }) {
  const { area, turn } = turnedGrid(box, back.rotation);
  const fitsBox = Math.min(box.w, box.h);
  const requested = clamp(back.truchetTile, 1, fitsBox);
  const estimate = t => Math.ceil(area.w / t) * Math.ceil(area.h / t) * 2 * arcPoints(t / 2, Math.PI / 2, step);
  const size = Math.min(fitPitch(requested, budget, estimate), fitsBox);
  const notes = size > requested ? [budgetNote('Tile size', size)] : [];
  // Centred on the frame and run past it, so the trim decides where the tiles
  // stop at every angle, as it does for every other pattern.
  const cols = Math.ceil(area.w / size);
  const rows = Math.ceil(area.h / size);
  const ox = area.x + (area.w - cols * size) / 2;
  const oy = area.y + (area.h - rows * size) / 2;
  const rad = size / 2;
  const seg = arcSegments(rad, Math.PI / 2);
  const quarter = (cx, cy, startDeg) => {
    const pts = [];
    for (let i = 0; i <= seg; i++) {
      const a = ((startDeg + (i / seg) * 90) * Math.PI) / 180;
      pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
    }
    return turn(pts);
  };
  const polylines = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = ox + col * size;
      const y = oy + row * size;
      if (rng() > back.truchetProb) {
        polylines.push(quarter(x, y, 0));
        polylines.push(quarter(x + size, y + size, 180));
      } else {
        polylines.push(quarter(x + size, y, 90));
        polylines.push(quarter(x, y + size, 270));
      }
    }
  }
  return { polylines, dots: [], notes };
}

function rings(box, back, { budget, step }) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const maxR = Math.hypot(box.w, box.h) / 2;
  const estimate = (s) => {
    let n = 0;
    for (let i = 1; i <= Math.floor(maxR / s); i++) n += arcPoints(i * s, 2 * Math.PI, step);
    return n;
  };
  const spacing = fitPitch(back.ringSpacing, budget, estimate);
  const notes = spacing > back.ringSpacing ? [budgetNote('Ring spacing', spacing)] : [];
  const count = Math.max(1, Math.floor(maxR / spacing));
  const polylines = [];
  for (let i = 1; i <= count; i++) {
    const r = i * spacing;
    const seg = arcSegments(r, 2 * Math.PI);
    const pts = [];
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * 2 * Math.PI;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    polylines.push(pts);
  }
  return { polylines, dots: [], notes };
}

/* An Archimedean spiral. Arms are copies of one curve rotated about the centre,
so on any ray they interleave and the gap a reader sees is the curve's own
pitch divided by the arm count. The authored value is that visible gap, so the
curve is wound out by the arm count to produce it. */
function spiral(box, back, { budget, step }) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const maxR = Math.hypot(box.w, box.h) / 2;
  // Line length in a disc is its area over the gap, however many arms divide it.
  const estimate = gap => Math.PI * maxR * maxR / (gap * step);
  const gap = fitPitch(back.spiralPitch, budget, estimate);
  const notes = gap > back.spiralPitch ? [budgetNote('Turn spacing', gap)] : [];
  const polylines = [];
  for (let arm = 0; arm < back.spiralArms; arm++) {
    const phase = back.rotation * Math.PI / 180 + arm * 2 * Math.PI / back.spiralArms;
    const pts = [];
    // Chord tolerance on the local radius of curvature, as arcSegments does for
    // circles: fine where the arm turns tightly near the centre, sparse outside.
    const b = gap * back.spiralArms / (2 * Math.PI);
    for (let th = 0; ;) {
      const r = b * th;
      pts.push([cx + r * Math.cos(th + phase), cy + r * Math.sin(th + phase)]);
      if (r > maxR) break;
      const speed = Math.hypot(r, b);
      const rho = speed ** 3 / (r * r + 2 * b * b);
      th += rho * 2 * Math.acos(1 - Math.min(1, CHORD_TOLERANCE_MM / rho)) / speed;
    }
    polylines.push(pts);
  }
  return { polylines, dots: [], notes };
}

/* Pointy-top honeycomb. Each cell draws three of its six edges and takes the
other three from its neighbours, so no edge is scored twice.
The authored size is the flat-to-flat width, which is also the horizontal
pitch between centres, so a hexagon and a Truchet tile at the same number
cover about the same area. The circumradius the trigonometry wants is that
over root three. A cell sits on the frame centre, so the honeycomb is
symmetric about it like every other pattern. */
function hex(box, back, { budget, step }) {
  const { area, turn } = turnedGrid(box, back.rotation);
  // Area, and the length of the three drawn edges, for a cell of unit width.
  const cellArea = 0.866;
  const cellRun = Math.sqrt(3);
  const estimate = w => ((area.w * area.h) / (cellArea * w * w)) * ((cellRun * w) / step + 4);
  const width = fitPitch(clamp(back.hexSize, 1, Math.min(box.w, box.h)), budget, estimate);
  const notes = width > back.hexSize ? [budgetNote('Cell width', width)] : [];
  const size = width / cellRun;
  const dx = width;
  const dy = size * 1.5;
  const midX = area.x + area.w / 2;
  const midY = area.y + area.h / 2;
  // A cell past the area on every side, so the edges a border cell leaves to
  // its missing neighbours fall outside the trim.
  const cols = Math.ceil(area.w / 2 / dx) + 1;
  const rows = Math.ceil(area.h / 2 / dy) + 1;
  const polylines = [];
  for (let row = -rows; row <= rows; row++) {
    for (let col = -cols; col <= cols; col++) {
      const cx = midX + col * dx + (row & 1 ? dx / 2 : 0);
      const cy = midY + row * dy;
      const pts = [];
      for (let i = 0; i <= 3; i++) {
        const a = ((30 + i * 60) * Math.PI) / 180;
        pts.push([cx + size * Math.cos(a), cy + size * Math.sin(a)]);
      }
      polylines.push(turn(pts));
    }
  }
  return { polylines, dots: [], notes };
}

function lattice(box, back, { budget, step }) {
  const diag = Math.hypot(box.w, box.h);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const requested = clamp(back.latticeCell, 1, diag);
  // Two families of lines cover the box: total length is about twice its area
  // over the spacing, plus the end points of every line that crosses it.
  const estimate = (s) => (2 * box.w * box.h) / (s * step) + (4 * (box.w + box.h)) / s;
  const spacing = fitPitch(requested, budget, estimate);
  const notes = spacing > requested ? [budgetNote('Line spacing', spacing)] : [];
  const count = Math.ceil(diag / spacing);
  const polylines = [];
  for (const angleDeg of [back.rotation, back.rotation + 90]) {
    const a = (angleDeg * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const nx = -dy;
    const ny = dx;
    for (let i = -count; i <= count; i++) {
      const ox = cx + nx * i * spacing;
      const oy = cy + ny * i * spacing;
      const clipped = clipSegment(ox - dx * diag, oy - dy * diag, ox + dx * diag, oy + dy * diag, box);
      if (clipped) polylines.push([[clipped[0], clipped[1]], [clipped[2], clipped[3]]]);
    }
  }
  return { polylines, dots: [], notes };
}

/* How the dot size varies across the card. Each returns 0 where the dot is
largest and 1 where it vanishes, measured from the box centre in millimetres. */
const HALFTONE_GRADIENTS = {
  radial: (x, y, g) => Math.hypot(x, y) / g.maxD,
  linear: (x, y, g) => 0.5 + y / g.h,
  diagonal: (x, y, g) => 0.5 + (x / g.w + y / g.h) / 2,
  conic: (x, y) => Math.atan2(y, x) / (2 * Math.PI) + 0.5,
  rings: (x, y, g) => {
    const t = (Math.hypot(x, y) / g.maxD) * 3;
    return Math.abs(t - Math.round(t)) * 2;
  },
  waves: (x, y, g) => (2 - Math.cos((6 * Math.PI * x) / g.w) - Math.cos((6 * Math.PI * y) / g.h)) / 4,
  corner: (x, y, g) => Math.max(Math.abs(x) / (g.w / 2), Math.abs(y) / (g.h / 2)),
};

function halftone(box, back, { budget }) {
  const requested = clamp(back.halftoneCell, 0.25, Math.min(box.w, box.h));
  const maxD = Math.hypot(box.w, box.h) / 2;
  const estimate = (c) => (Math.PI * (maxD + c) ** 2 / (c * c)) * DOT_POINTS;
  const cell = fitPitch(requested, budget, estimate);
  const notes = cell > requested ? [budgetNote('Dot pitch', cell)] : [];
  const field = HALFTONE_GRADIENTS[back.halftoneField] || HALFTONE_GRADIENTS.radial;
  const g = { w: box.w, h: box.h, maxD };
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const a = back.rotation * Math.PI / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  // The screen is generated in its own rotated frame over a disc that covers the
  // box, and trimmed afterwards, so the angle never crops a corner.
  const reach = Math.ceil((maxD + cell) / cell);
  const dots = [];
  for (let row = -reach; row <= reach; row++) {
    for (let col = -reach; col <= reach; col++) {
      const ux = (col + (back.halftoneStagger && (row & 1) ? 0.5 : 0)) * cell;
      const uy = row * cell;
      const x = ux * ca - uy * sa;
      const y = ux * sa + uy * ca;
      let t = clamp(field(x, y, g), 0, 1);
      if (back.halftoneInvert) t = 1 - t;
      const r = (cell / 2) * (1 - t) ** back.halftoneGamma * 0.95;
      if (r >= MIN_DOT_MM) dots.push({ cx: cx + x, cy: cy + y, r, gray: 0 });
    }
  }
  // Centre spacing to the next dot along each screen axis: staggered rows put
  // the next dot in the same column two rows away.
  const dotPitch = { x: cell, y: back.halftoneStagger ? 2 * cell : cell };
  return { polylines: [], dots, notes, dotShape: back.halftoneShape, dotAngle: a, dotPitch };
}

const GENERATORS = { guilloche, truchet, rings, spiral, lattice, hex, halftone };

/* core owns the vocabulary and the rail offers all of it, so an entry with no
generator here draws guilloche instead of failing. */
for (const pattern of PATTERNS) {
  if (!GENERATORS[pattern]) throw new Error(`pattern "${pattern}" has no generator`);
}
for (const field of HALFTONE_FIELDS) {
  if (!HALFTONE_GRADIENTS[field]) throw new Error(`halftone gradient "${field}" is not defined`);
}

/* Card-local back geometry, independent of sheet position so it can be cached
once per (pattern params, card size, budget) and re-emitted at each grid
origin. `budget` is the card's point allowance from patternBudget. */
export function buildBackGeometry(state, card, safe, budget) {
  const { back } = state;
  const box = { ...safe };
  const step = Math.max(0.5, Math.min(box.w, box.h) / 60);
  const generate = GENERATORS[back.pattern] || GENERATORS.guilloche;
  const stretch = back.stretch && STRETCH_PATTERNS.includes(back.pattern);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const side = Math.min(box.w, box.h);
  // A round figure is drawn on the square inscribed in the frame and opened out
  // to it afterwards, so the circle it would have drawn becomes the ellipse the
  // frame implies. Generators need no knowledge of this: they work in points.
  const field = stretch ? { x: cx - side / 2, y: cy - side / 2, w: side, h: side, r: 0 } : box;
  const genBudget = stretch ? Math.floor(budget * side * side / (box.w * box.h)) : budget;
  const raw = generate(field, back, { rng: mulberry32(back.seed), budget: genBudget, step });
  const sx = box.w / side;
  const sy = box.h / side;
  const open = ([x, y]) => [cx + (x - cx) * sx, cy + (y - cy) * sy];
  const polylines = [];
  let lengthMm = 0;
  for (const pts of raw.polylines) {
    for (const run of trimPolyline(densify(stretch ? pts.map(open) : pts, step), box)) {
      // Densified vertices exist for the trim test only; the file does not need them.
      polylines.push(simplifyPolyline(run, CHORD_TOLERANCE_MM));
      lengthMm += polylineLengthMm(run);
    }
  }
  // Polylines are trimmed, dots are clamped: a dot reaches cell/2 past its
  // centre, so testing the centre alone puts engrave ink across the cut line at
  // a small artwork margin. safeArea squares the frame, so the room to the edge
  // is the rectangle inset.
  const dots = [];
  for (const dot of raw.dots) {
    const reach = raw.dotShape === 'dot' || !raw.dotShape ? 1 : SQUARE_R;
    const room = Math.min(dot.cx - box.x, box.x + box.w - dot.cx, dot.cy - box.y, box.y + box.h - dot.cy);
    const r = Math.min(dot.r, room / reach);
    if (r >= MIN_DOT_MM) dots.push(r === dot.r ? dot : { ...dot, r });
  }
  return { polylines, dots, lengthMm, notes: raw.notes, dotShape: raw.dotShape, dotAngle: raw.dotAngle, dotPitch: raw.dotPitch };
}

// A square of this circumradius has the same area as a disc of radius 1, so the
// screen holds its tone when the dot shape changes.
const SQUARE_R = Math.sqrt(Math.PI / 2);

/* Wound to match circlePath's sweep, so touching dots union rather than cancel.
At the darkest tones a diamond's tips pass its neighbours' in the same row
and column. Each tip is cut square at half the pitch instead: the diamond on
the other side covers what is cut away, so the screen reads the same and no
two dots overlap. */
function dotPath(shape, cx, cy, r, turn, pitch) {
  if (shape !== 'square' && shape !== 'diamond') return circlePath(cx, cy, r);
  const rr = r * SQUARE_R;
  const points = [];
  for (let i = 0; i < 4; i++) {
    const a = turn + (shape === 'square' ? Math.PI / 4 : 0) + (i * Math.PI) / 2;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    const half = shape === 'diamond' ? (i & 1 ? pitch.y : pitch.x) / 2 : Infinity;
    if (rr <= half) {
      points.push([cx + rr * ux, cy + rr * uy]);
    } else {
      const w = rr - half;
      points.push(
        [cx + half * ux + w * uy, cy + half * uy - w * ux],
        [cx + half * ux - w * uy, cy + half * uy + w * ux],
      );
    }
  }
  return new Path().polyline(points, true).toString();
}

export function emitBack(geometry, origin, sink = new LayerSink()) {
  if (geometry.polylines.length) {
    const p = new Path();
    for (const run of geometry.polylines) p.polyline(run.map(([x, y]) => [x + origin.x, y + origin.y]));
    sink.addScore(p.toString(), geometry.lengthMm);
  }
  for (const d of geometry.dots) {
    const { dotShape, dotAngle, dotPitch } = geometry;
    sink.addEngrave(dotPath(dotShape, d.cx + origin.x, d.cy + origin.y, d.r, dotAngle || 0, dotPitch), d.gray);
  }
  return sink;
}