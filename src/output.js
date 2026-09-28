/*!
 * @file        src/output.js
 * @description Document composer and preview.
 *              Assembles layout, artwork and cut geometry into the one SVG
 *              string a laser ever sees, pages a run across sheets, packs a
 *              deck into a ZIP, and builds the per-stage preview.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/LaserCutCards}
 *
 * SPDX-FileCopyrightText: 2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { emptyPassNote, emptyJobNote, REVIEW, SUITS, RANK_LABELS, resolveLayout, resolveTarget, sheetPages, passOperations, patternBudget } from './core.js';
import { el, num, escapeText, svgDocument, rectPath, Path, LayerSink, renderLayers, countPoints } from './svg.js';
import { resolveFace, buildFace, buildBackGeometry, emitBack, cardOutlinePath } from './art.js';

const SINGLE_POSITION = [{ x: 0, y: 0, col: 0, row: 0, index: 0 }];
const unique = (...lists) => [...new Set(lists.flat())];

// Captions are drawn in millimetres, so a packed view shrinks them; this is
// their floor at fit. FIT_PADDING matches createViewport's fit().
const CAPTION_MIN_PX = 14;
const FIT_PADDING = 0.04;

function minCaptionMm(px, docW, docH) {
  if (!px || !(px.w > 0) || !(px.h > 0)) return 0;
  const pad = 2 * Math.max(docW, docH) * FIT_PADDING;
  return CAPTION_MIN_PX / Math.min(px.w / (docW + pad), px.h / (docH + pad));
}

/* ── job ──────────────────────────────────────────────────────────────────── */

/* What the Design view shows is what an export produces: the selected card,
its suit, or the deck, in fixed deck order. */
function jobCards(state, scope = state.view.scope) {
  const { suit, rank } = state.face;
  if (scope === 'card') return [{ suit, rank }];
  const suits = scope === 'suit' ? [suit] : SUITS;
  return suits.flatMap((s) => Array.from({ length: 13 }, (_, i) => ({ suit: s, rank: i + 1 })));
}

/* ── pages ────────────────────────────────────────────────────────────────── */

/* Card positions on a page, relative to its first card. */
function pagePositions(layout, page) {
  const { card, gap } = layout;
  return Array.from({ length: page.count }, (_, index) => {
    const col = index % page.cols;
    const row = Math.floor(index / page.cols);
    return { x: col * (card.widthMm + gap), y: row * (card.heightMm + gap), col, row, index };
  });
}

/* A page's stock: its cards plus the uncut edge on every side. A full page is
exactly the authored stock; a short one is cut down to the cards it holds. */
function pageStock(layout, page) {
  const { card, gap, marginMm } = layout;
  return {
    widthMm: page.cols * card.widthMm + (page.cols - 1) * gap + 2 * marginMm,
    heightMm: page.rows * card.heightMm + (page.rows - 1) * gap + 2 * marginMm
  };
}

/* The squaring cut, added after the cards so it is the last cut in the file. */
function addStockOutline(sink, stock, corner) {
  sink.addCut(rectPath(corner.x, corner.y, stock.widthMm, stock.heightMm), 2 * (stock.widthMm + stock.heightMm));
}

/* Backs are identical on every card, so one back file serves every page of the
same shape; `runs` is how many pages use it. */
function backFiles(pages) {
  const byShape = new Map();
  for (const page of pages) {
    const key = `${page.cols}x${page.rows}`;
    if (byShape.has(key)) byShape.get(key).runs += 1;
    else byShape.set(key, { page, runs: 1, key });
  }
  return [...byShape.values()];
}

function cardState(state, card) {
  return { ...state, face: { ...state.face, ...card } };
}

/* ── shared emitter ───────────────────────────────────────────────────────── */

/* state.back holds primitives only, so its serialisation is a complete key for
every pattern parameter, including any added later. */
function backCacheKey(state, layout, budget) {
  const { card, safe } = layout;
  return [JSON.stringify(state.back), card.widthMm, card.heightMm, safe.x, safe.w, safe.h, budget].join('|');
}

function backGeometryFor(state, layout, cache) {
  const budget = patternBudget(layout);
  if (!cache) return buildBackGeometry(state, layout.card, layout.safe, budget);
  const key = backCacheKey(state, layout, budget);
  if (!cache.has(key)) cache.set(key, buildBackGeometry(state, layout.card, layout.safe, budget));
  return cache.get(key);
}

/* Cut geometry for the placed cards, with its exact length.
With spacing, every card is its own closed contour. With no spacing adjacent
cards share an edge, so each card keeps only its own corner arcs and a shared
edge is emitted once instead of twice. There is no toggle: zero spacing is the
condition, and a rounded corner no longer rules the saving out.
Segments along one grid line are deliberately not chained into a single run.
At any corner radius they are separated by the arcs that turn away from the
line, and at zero radius chaining saves only pierces that the controller's own
path ordering already removes. */
function cutGeometry(layout, positions, offset = { x: 0, y: 0 }) {
  const { cols, card, gap } = layout;
  const w = card.widthMm;
  const h = card.heightMm;
  const r = card.cornerRadiusMm;
  const n = positions.length;
  if (!n) return { d: '', lengthMm: 0 };
  if (gap > 0 || n === 1) {
    const perimeter = 2 * (w - 2 * r) + 2 * (h - 2 * r) + 2 * Math.PI * r;
    const d = positions.map((pos) => cardOutlinePath({ x: pos.x + offset.x, y: pos.y + offset.y }, card)).join(' ');
    return { d, lengthMm: perimeter * n };
  }
  const filled = new Set(positions.map((pos) => `${pos.col},${pos.row}`));
  const has = (c, rr) => filled.has(`${c},${rr}`);
  const rows = positions.reduce((m, pos) => Math.max(m, pos.row), 0) + 1;
  const inner = new Path();
  const arcs = new Path();
  const outer = new Path();
  let lengthMm = 0;
  for (let c = 0; c <= cols; c++) {
    for (let rr = 0; rr < rows; rr++) {
      const left = has(c - 1, rr);
      const right = has(c, rr);
      if (!left && !right) continue;
      const x = offset.x + c * w;
      const y = offset.y + rr * h;
      (left && right ? inner : outer).M(x, y + r).L(x, y + h - r);
      lengthMm += h - 2 * r;
    }
  }
  for (let rr = 0; rr <= rows; rr++) {
    for (let c = 0; c < cols; c++) {
      const above = has(c, rr - 1);
      const below = has(c, rr);
      if (!above && !below) continue;
      const x = offset.x + c * w;
      const y = offset.y + rr * h;
      (above && below ? inner : outer).M(x + r, y).L(x + w - r, y);
      lengthMm += w - 2 * r;
    }
  }
  if (r > 0) {
    for (const pos of positions) {
      const x = pos.x + offset.x;
      const y = pos.y + offset.y;
      arcs.M(x + w - r, y).A(r, r, 0, 1, x + w, y + r);
      arcs.M(x + w, y + h - r).A(r, r, 0, 1, x + w - r, y + h);
      arcs.M(x + r, y + h).A(r, r, 0, 1, x, y + h - r);
      arcs.M(x, y + r).A(r, r, 0, 1, x + r, y);
      lengthMm += 2 * Math.PI * r;
    }
  }
  const d = [inner, arcs, outer].filter((p) => !p.empty).map(String).join(' ');
  return { d, lengthMm };
}

function applyOperations(sink, ops) {
  if (!ops.score) {
    sink.score.length = 0;
    sink.scoreMm = 0;
  }
  if (!ops.engrave) sink.engrave.clear();
  return sink;
}

/* Artwork plus cut path for one sheet's worth of cards, at an arbitrary offset.
`cards` names the face at each position; backs are identical and ignore it.
Returns the notes of whatever limited the artwork on this card size. */
function emitCards(state, layout, sink, opts) {
  const { positions, cards, side, operations, cache } = opts;
  const offset = opts.offset || { x: 0, y: 0 };
  let notes;
  if (side === 'back') {
    const geometry = backGeometryFor(state, layout, cache);
    for (const pos of positions) emitBack(geometry, { x: pos.x + offset.x, y: pos.y + offset.y }, sink);
    notes = geometry.notes;
  } else {
    const fit = resolveFace(state, layout.card, layout.safe);
    positions.forEach((pos, i) => {
      buildFace(cardState(state, cards[i]), layout.card, layout.safe, { x: pos.x + offset.x, y: pos.y + offset.y }, fit, sink);
    });
    notes = fit.notes;
  }
  if (operations.cut) {
    const cut = cutGeometry(layout, positions, offset);
    sink.addCut(cut.d, cut.lengthMm);
  }
  return notes;
}

/* ── export ───────────────────────────────────────────────────────────────── */

function generateStockCutDocument(state, page) {
  const layout = resolveLayout(state);
  const target = resolveTarget(state);
  const doc = pageStock(layout, page);
  const sink = new LayerSink();
  addStockOutline(sink, doc, { x: 0, y: 0 });
  const svg = svgDocument({ widthMm: doc.widthMm, heightMm: doc.heightMm, body: renderLayers(sink, target) });
  return { svg, notes: layout.notes, stats: { cutMm: sink.cutMm, scoreMm: 0, points: countPoints(sink), bytes: svg.length } };
}

function generatePocketCutDocument(state) {
  const layout = resolveLayout(state);
  const target = resolveTarget(state);
  const sink = new LayerSink();
  sink.addCut(cardOutlinePath({ x: 0, y: 0 }, layout.card), 2 * (layout.card.widthMm + layout.card.heightMm));
  const svg = svgDocument({ widthMm: layout.card.widthMm, heightMm: layout.card.heightMm, body: renderLayers(sink, target) });
  return { svg, notes: layout.notes, stats: { cutMm: sink.cutMm, scoreMm: 0, points: countPoints(sink), bytes: svg.length } };
}


/* The only producer of a cut file.
opts.single  one card at the origin, nothing around it
opts.page    a page from sheetPages: the document is its stock, origin at the
            stock corner
opts.cards   the face at each position
opts.side    'face' | 'back', default the view's side
opts.cache   Map reused across calls to keep pattern geometry warm */
function generateDocument(state, opts = {}) {
  const layout = resolveLayout(state);
  if (!layout.valid) throw new Error(layout.notes[0]);
  const target = resolveTarget(state);
  const side = opts.side || state.view.side;
  const operations = passOperations(state, side);
  const sink = new LayerSink();
  let doc;
  let notes;
  if (opts.single) {
    notes = emitCards(state, layout, sink, { positions: SINGLE_POSITION, cards: opts.cards, side, operations, cache: opts.cache });
    doc = { widthMm: layout.card.widthMm, heightMm: layout.card.heightMm };
  } else {
    const m = layout.marginMm;
    notes = emitCards(state, layout, sink, { positions: pagePositions(layout, opts.page), cards: opts.cards, side, operations, cache: opts.cache, offset: { x: m, y: m } });
    doc = pageStock(layout, opts.page);
  }
  applyOperations(sink, operations);
  const svg = svgDocument({ widthMm: doc.widthMm, heightMm: doc.heightMm, body: renderLayers(sink, target) });
  return { svg, notes: unique(layout.notes, notes), stats: { cutMm: sink.cutMm, scoreMm: sink.scoreMm, points: countPoints(sink), bytes: svg.length } };
}

function jobStem(state, cards) {
  if (cards.length === 1) {
    const { suit, rank } = cards[0];
    return `${suit}-${String(rank).padStart(2, '0')}-${RANK_LABELS[rank].toLowerCase()}`;
  }
  return state.view.scope === 'suit' ? `${state.face.suit}s` : 'deck';
}

/* Every file the view's side needs for the cards the Design view shows. One card
is a single document; more page across sheets, and each back file serves every
page of its shape, with the run count in its name. */
export function generateJob(state, opts = {}) {
  const layout = resolveLayout(state);
  if (!layout.valid) throw new Error(layout.notes[0]);
  const empty = emptyJobNote(state);
  if (empty) throw new Error(empty);

  const cards = jobCards(state);
  const stem = jobStem(state, cards);
  const jobs = [];
  const faceOps = passOperations(state, 'face');
  const backOps = passOperations(state, 'back');
  const hasFace = faceOps.cut || faceOps.engrave;
  const hasBack = backOps.cut || backOps.score || backOps.engrave;
  const hasStock = state.output.stockCut && state.view.scope !== 'card';

  if (cards.length === 1) {
    if (hasFace) {
      jobs.push({ name: `card-${stem}.svg`, opts: { single: true, cards, side: 'face' } });
    }
    if (hasBack) {
      jobs.push({ name: hasFace ? `card-${stem}-back.svg` : `back-${state.back.pattern}.svg`, opts: { single: true, cards, side: 'back' } });
    }
  } else {
    const pages = sheetPages(layout, cards.length);
    if (hasFace) {
      pages.forEach((page, i) => {
        jobs.push({
          name: `${stem}-faces-${String(i + 1).padStart(2, '0')}.svg`,
          opts: { page, cards: cards.slice(page.start, page.start + page.count), side: 'face' }
        });
      });
    }
    if (hasBack) {
      for (const { page, runs, key } of backFiles(pages)) {
        jobs.push({
          name: `${stem}-backs-${key}-x${runs}.svg`,
          opts: { page, side: 'back' }
        });
      }
    }
    if (state.output.backJig && hasBack) {
      jobs.push({
        name: `${stem}-back-single.svg`,
        opts: {
          single: true,
          cards: [cards[0]],
          side: 'back',
          operations: { cut: false, score: backOps.score, engrave: backOps.engrave }
        }
      });
      jobs.push({
        name: `${stem}-jig-pocket.svg`,
        isPocketCut: true
      });
    }
    if (hasStock) {
      const stockPages = backFiles(pages);
      stockPages.forEach(({ page, key }) => {
        const name = stockPages.length === 1 ? `${stem}-stock-cut.svg` : `${stem}-stock-cut-${key}.svg`;
        jobs.push({ name, isStockCut: true, page });
      });
    }
  }

  let jobStemName = stem;
  if (hasFace && !hasBack) jobStemName = `${stem}-faces`;
  else if (!hasFace && hasBack) jobStemName = `${stem}-backs`;

  const notes = new Set();
  const files = jobs.map(job => {
    let doc;
    if (job.isStockCut) {
      doc = generateStockCutDocument(state, job.page);
    } else if (job.isPocketCut) {
      doc = generatePocketCutDocument(state);
    } else {
      doc = generateDocument(state, { cache: opts.cache, side: job.opts.side, ...job.opts });
    }
    doc.notes.forEach(n => notes.add(n));
    return { name: job.name, svg: doc.svg };
  });

  return { files, stem: jobStemName, notes: [...notes] };
}

/* ── ZIP ──────────────────────────────────────────────────────────────────── */

let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

const dosTime = (d) => (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
const dosDate = (d) => ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

/* ZIP with compression method 0 (stored), as bytes. */
export function zipStore(files) {
  const encoder = new TextEncoder();
  const entries = files.map((f) => {
    const name = encoder.encode(f.name);
    const data = encoder.encode(f.text);
    return { name, data, crc: crc32(data) };
  });
  const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const buffer = new ArrayBuffer(localSize + centralSize + 22);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const now = new Date();
  const time = dosTime(now);
  const date = dosDate(now);
  let offset = 0;
  for (const entry of entries) {
    entry.offset = offset;
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 0x0800, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, date, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.data.length, true);
    view.setUint32(offset + 22, entry.data.length, true);
    view.setUint16(offset + 26, entry.name.length, true);
    view.setUint16(offset + 28, 0, true);
    bytes.set(entry.name, offset + 30);
    bytes.set(entry.data, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralStart = offset;
  for (const entry of entries) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true);
    view.setUint16(offset + 6, 20, true);
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, date, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.data.length, true);
    view.setUint32(offset + 24, entry.data.length, true);
    view.setUint16(offset + 28, entry.name.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, entry.offset, true);
    bytes.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, entries.length, true);
  view.setUint16(offset + 10, entries.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);
  return bytes;
}

/* ── preview ──────────────────────────────────────────────────────────────── */

/* A page's stock, its usable area and a card-shaped substrate under every placed
card, with the stock corner at `corner`. Emitted before the artwork, so
document order puts the material behind it. */
function stockChrome(layout, stock, corner, positions) {
  const m = layout.marginMm;
  const parts = [
    el('path', { class: 'stock', d: rectPath(corner.x, corner.y, stock.widthMm, stock.heightMm), fill: 'none', stroke: 'none' }),
    el('path', { class: 'usable', d: rectPath(corner.x + m, corner.y + m, stock.widthMm - 2 * m, stock.heightMm - 2 * m), fill: 'none', stroke: 'none' })
  ];
  for (const pos of positions) {
    const d = cardOutlinePath({ x: corner.x + m + pos.x, y: corner.y + m + pos.y }, layout.card);
    parts.push(el('path', { class: 'card', d, fill: 'none', stroke: 'none' }));
  }
  return el('g', { class: 'chrome' }, parts.join(''));
}

/* Size of the export file this sink would become, for the status bar. `layers`
is the rendered layer markup; svgDocument wraps it without changing it. */
function fileMetrics(sink, layers, widthMm, heightMm) {
  return {
    filePoints: countPoints(sink),
    fileBytes: svgDocument({ widthMm, heightMm, body: '' }).length + layers.length
  };
}

function layoutStats(layout) {
  return { valid: true, cols: layout.cols, rows: layout.rows, cardWidthMm: layout.card.widthMm, cardHeightMm: layout.card.heightMm, ratio: layout.ratio, utilization: layout.utilization };
}

/* A division with more cells than a deck has no full first sheet: the export
cuts the deck into pages of whole rows, each on stock cut to size, rather
than onto the stock the Stock stage draws. */
function pagingNotes(layout, cards) {
  if (layout.count <= cards) return [];
  const shapes = sheetPages(layout, cards).map(page => `${page.cols} x ${page.rows}`);
  return [`A deck fills ${cards} of the ${layout.count} cells. Export writes it as ${shapes.join(' and ')} sheets, each on stock cut to size.`];
}

/* Stage 1: the stock with the first sheet of the deck on it, exactly as the
deck export cuts it. */
function buildLayoutStage(state, layout, opts) {
  const target = resolveTarget(state);
  const operations = passOperations(state, 'face');
  const m = layout.marginMm;
  const cards = jobCards(state, 'deck').slice(0, layout.count);
  const positions = layout.positions.slice(0, cards.length);
  const stock = { widthMm: state.stock.widthMm, heightMm: state.stock.heightMm };
  const sink = new LayerSink();
  const notes = emitCards(state, layout, sink, {
    positions,
    cards,
    side: 'face',
    operations,
    cache: opts.cache,
    offset: { x: m, y: m },
  });
  if (state.output.stockCut) addStockOutline(sink, stock, { x: 0, y: 0 });
  applyOperations(sink, operations);
  const layers = renderLayers(sink, target, true);
  const body = `${stockChrome(layout, stock, { x: 0, y: 0 }, positions)}\n${layers}`;
  return {
    svg: svgDocument({ widthMm: stock.widthMm, heightMm: stock.heightMm, body }),
    notes: unique(layout.notes, notes, pagingNotes(layout, cards.length)),
    stats: {
      ...layoutStats(layout),
      stage: 'layout',
      tiles: positions.length,
      docWidthMm: stock.widthMm,
      docHeightMm: stock.heightMm,
      stockWidthMm: stock.widthMm,
      stockHeightMm: stock.heightMm,
      cutMm: sink.cutMm,
      scoreMm: sink.scoreMm,
      ...fileMetrics(sink, layers, stock.widthMm, stock.heightMm),
    },
  };
}

/* Stage 2: the cards the scope names, or the one back every card shares. Packed
to the viewport rather than laid out in one row: thirteen cards across a laptop
is sixty pixels each, which is not a review of anything. */
function buildDesignStage(state, layout, opts) {
  const target = resolveTarget(state);
  const { card, safe } = layout;
  const back = state.view.side === 'back';
  const cards = back ? [null] : jobCards(state);
  const gap = card.widthMm * REVIEW.gapRatio;
  const cellW = card.widthMm + gap;
  const cellH = card.heightMm + gap;
  const aspect = opts.aspect > 0 ? opts.aspect : 16 / 9;
  const cols = Math.max(1, Math.min(REVIEW.maxColumns, cards.length, Math.round(Math.sqrt(aspect * cards.length * cellH / cellW))));
  const rows = Math.ceil(cards.length / cols);
  const fit = back ? null : resolveFace(state, card, safe);
  const geometry = back ? backGeometryFor(state, layout, opts.cache) : null;
  const parts = cards.map((face, index) => {
    const origin = { x: gap / 2 + (index % cols) * cellW, y: gap / 2 + Math.floor(index / cols) * cellH };
    const sink = new LayerSink();
    if (back) emitBack(geometry, origin, sink);
    else buildFace(cardState(state, face), card, safe, origin, fit, sink);
    const outline = cardOutlinePath(origin, card);
    sink.addCut(outline);
    return el('g', { class: 'chrome' }, el('path', { class: 'card', d: outline, fill: 'none', stroke: 'none' })) + renderLayers(sink, target, true);
  });
  const docWidthMm = cols * cellW;
  const docHeightMm = rows * cellH;
  return {
    svg: svgDocument({ widthMm: docWidthMm, heightMm: docHeightMm, body: parts.join('\n') }),
    notes: unique(layout.notes, fit ? fit.notes : [], geometry ? geometry.notes : []),
    stats: { ...layoutStats(layout), stage: 'design', side: state.view.side, tiles: cards.length, cols, rows, docWidthMm, docHeightMm }
  };
}

/* Stage 3 when the job is one card: that card at true size. */
function buildSingleStage(state, layout, opts, cards) {
  const side = state.view.side;
  const target = resolveTarget(state);
  const operations = passOperations(state, side);
  const { card } = layout;
  const sink = new LayerSink();
  const notes = new Set(layout.notes);
  emitCards(state, layout, sink, { positions: SINGLE_POSITION, cards, side, operations, cache: opts.cache }).forEach((n) => notes.add(n));
  applyOperations(sink, operations);
  const layers = renderLayers(sink, target, true);
  const labelH = card.heightMm * 0.09;
  const caption = `${side === 'back' ? 'Back' : 'Card'} · one file`;
  const chrome = el('g', { class: 'chrome' }, [
    el('path', { class: 'card', d: cardOutlinePath({ x: 0, y: 0 }, card), fill: 'none', stroke: 'none' }),
    el('text', { class: 'sheet-label', x: num(card.widthMm / 2), y: num(card.heightMm + labelH * 0.5), 'font-size': num(labelH * 0.34), 'text-anchor': 'middle' }, escapeText(caption))
  ].join(''));
  return {
    svg: svgDocument({ widthMm: card.widthMm, heightMm: card.heightMm + labelH, body: `${chrome}\n${layers}` }),
    notes: [...notes],
    stats: { ...layoutStats(layout), stage: 'output', side, tiles: 1, fileScope: 'card', docWidthMm: card.widthMm, docHeightMm: card.heightMm + labelH, stockWidthMm: card.widthMm, stockHeightMm: card.heightMm, cutMm: sink.cutMm, scoreMm: sink.scoreMm, ...fileMetrics(sink, layers, card.widthMm, card.heightMm) }
  };
}

/* Stage 4: every file the export writes, each on its own stock at true size. A
face job shows each page; a back job one file per page shape, captioned with
how often it runs. The question this stage answers is how much material and
machine time the current settings cost. */
function buildOutputStage(state, layout, opts) {
  const side = state.view.side;
  const cards = jobCards(state);
  if (cards.length === 1) return buildSingleStage(state, layout, opts, cards);
  const pages = sheetPages(layout, cards.length);
  const operations = passOperations(state, side);
  const target = resolveTarget(state);
  const stockCut = side === 'face' && state.output.stockCut;
  const jobs = side === 'back'
    ? backFiles(pages).map(({ page, runs, key }) => ({ page, runs, label: `Backs ${key} x${runs}` }))
    : pages.map((page, i) => ({ page, runs: 1, cards: cards.slice(page.start, page.start + page.count), label: `Sheet ${i + 1} / ${pages.length}` }));
  const notes = new Set(layout.notes);
  if (jobs.length < jobs.length) notes.add(`Showing the first ${jobs.length} of ${jobs.length} files.`);
  const m = layout.marginMm;
  const sw = state.stock.widthMm;
  const sh = state.stock.heightMm;
  const gapMm = Math.max(sw, sh) * 0.05;
  const aspect = opts.aspect > 0 ? opts.aspect : 16 / 9;
  const packFor = (labelH) => {
    const cols = Math.min(jobs.length, Math.max(1, Math.round(Math.sqrt(aspect * jobs.length * (sh + labelH + gapMm) / (sw + gapMm)))));
    return { labelH, cols, rows: Math.ceil(jobs.length / cols) };
  };
  let pack = packFor(sh * 0.1);
  const floor = minCaptionMm(opts.viewportPx, pack.cols * sw + (pack.cols - 1) * gapMm, pack.rows * (sh + pack.labelH) + (pack.rows - 1) * gapMm);
  if (floor > pack.labelH * 0.32) pack = packFor(Math.min(floor, sw * 0.08) / 0.32);
  const { labelH, cols, rows } = pack;
  const labelSize = labelH * 0.32;
  const sink = new LayerSink();
  const chrome = [];
  let file = null;
  let scoreMm = 0;
  let cardsCounted = 0;
  jobs.forEach((job, s) => {
    const sx = (s % cols) * (sw + gapMm);
    const sy = Math.floor(s / cols) * (sh + labelH + gapMm);
    const stock = pageStock(layout, job.page);
    const positions = pagePositions(layout, job.page);
    const sheet = new LayerSink();
    emitCards(state, layout, sheet, {positions, cards: job.cards, side, operations, cache: opts.cache, offset: {x : sx + m, y : sy + m}}).forEach(n => notes.add(n));
    applyOperations(sheet, operations);
    if (!file) file = fileMetrics(sheet, renderLayers(sheet, target, true), stock.widthMm, stock.heightMm);
    scoreMm += sheet.scoreMm * job.runs;
    cardsCounted += job.page.count * job.runs;
    sink.merge(sheet);
    chrome.push(stockChrome(layout, stock, { x: sx, y: sy }, positions));
    chrome.push(el('text', { class: 'sheet-label', x: num(sx + stock.widthMm / 2), y: num(sy + stock.heightMm + labelSize * 1.2), 'font-size': num(labelSize), 'text-anchor': 'middle' }, escapeText(job.label)));
  });
  // Exact for cut, which decides the run, and counted over every file rather
  // than only the ones shown.
  let cutMm = 0;
  for (const job of jobs) {
    if (operations.cut) cutMm += cutGeometry(layout, pagePositions(layout, job.page)).lengthMm * job.runs;
    if (stockCut) {
      const stock = pageStock(layout, job.page);
      cutMm += 2 * (stock.widthMm + stock.heightMm) * job.runs;
    }
  }
  if (cardsCounted && cardsCounted < cards.length) scoreMm *= cards.length / cardsCounted;
  const docWidthMm = cols * sw + (cols - 1) * gapMm;
  const docHeightMm = rows * (sh + labelH) + (rows - 1) * gapMm;
  return {
    svg: svgDocument({ widthMm: docWidthMm, heightMm: docHeightMm, body: `${chrome.join('\n')}\n${renderLayers(sink, target, true)}` }),
    notes: [...notes],
    stats: { ...layoutStats(layout), stage: 'output', side, tiles: cards.length, sheets: pages.length, per: layout.count, backFiles: side === 'back' ? jobs.length : 0, docWidthMm, docHeightMm, stockWidthMm: sw, stockHeightMm: sh, cutMm, scoreMm, ...(file || {}) }
  };
}

/* Any stage, when the division leaves no card: the stock and the reason on it. */
function buildInvalidStage(state, layout) {
  const stock = { widthMm: state.stock.widthMm, heightMm: state.stock.heightMm };
  const message = el('text', { class: 'canvas-message', x: num(stock.widthMm / 2), y: num(stock.heightMm / 2), 'font-size': num(Math.min(stock.widthMm, stock.heightMm) * 0.04), 'text-anchor': 'middle' }, escapeText(layout.notes[0]));
  const body = `${stockChrome(layout, stock, { x: 0, y: 0 }, [])}\n${el('g', { class: 'chrome' }, message)}`;
  return {
    svg: svgDocument({ widthMm: stock.widthMm, heightMm: stock.heightMm, body }),
    notes: layout.notes,
    stats: { stage: state.view.stage, valid: false, tiles: 0, docWidthMm: stock.widthMm, docHeightMm: stock.heightMm, stockWidthMm: stock.widthMm, stockHeightMm: stock.heightMm }
  };
}

/* The preview document for the current stage. */
export function buildPreview(state, opts = {}) {
  const layout = resolveLayout(state);
  if (!layout.valid) return buildInvalidStage(state, layout);
  if (state.view.stage === 'layout') return buildLayoutStage(state, layout, opts);
  if (state.view.stage === 'design') return buildDesignStage(state, layout, opts);
  const preview = buildOutputStage(state, layout, opts);
  const empty = emptyPassNote(state);
  if (empty) preview.notes.push(empty);
  return preview;
}