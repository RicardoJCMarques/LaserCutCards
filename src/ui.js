/*!
 * @file        src/ui.js
 * @description Control rail, canvas and status bar.
 *              One declarative schema describes every parameter, its widget and
 *              the stage it belongs to, so the three-stage order is the only
 *              guidance the rail needs. The canvas pans and zooms by viewBox and
 *              resolves tile picks itself; the status bar reports what a run
 *              costs.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/LaserCutCards}
 *
 * SPDX-FileCopyrightText: 2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DOT_PATTERNS, emptyPassNote, emptyJobNote, TARGETS, SUITS, SUIT_MARKS, PATTERNS, STRETCH_PATTERNS, RANK_LABELS, HALFTONE_FIELDS, HALFTONE_SHAPES, RANGES, clamp, getPath, patternUsesSeed, passOperations, sheetPages, guillochePair } from './core.js';
import { THEMES } from './art.js';

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const opts = (values, label = titleCase) => values.map((v) => ({ value: v, label: label(v) }));
const mm = (n) => String(Math.round(n * 10) / 10);
const percent = (v) => `${Math.round(v * 100)}%`;
const isPattern = (name) => (s) => s.back.pattern === name;
const facesShown = (s) => s.view.side === 'face';
const backShown = (s) => s.view.side === 'back';
const dotPattern = s => DOT_PATTERNS.includes(s.back.pattern);
const invalidLayout = (s, c) => !c.layout.valid;
const JOB_SIZE = { card: 1, suit: 13, deck: 52 };

// What the export will produce, in the words of the rail.
const jobDigest = (s) => {
  if (backShown(s)) return plural(JOB_SIZE[s.view.scope], 'back');
  if (s.view.scope === 'card') return `${RANK_LABELS[s.face.rank]}${SUIT_MARKS[s.face.suit]}`;
  if (s.view.scope === 'suit') return `${SUIT_MARKS[s.face.suit]} · 13 cards`;
  return 'Deck · 52 cards';
};

// Design and Output share one side: what is shown is what exports.
const SIDE_FIELD = { key: 'view.side', label: 'Side', type: 'toggle', options: [{ value: 'face', label: 'Faces' }, { value: 'back', label: 'Back' }] };

export const STAGE_TABS = [
  { id: 'layout', label: '1 · Stock' },
  { id: 'design', label: '2 · Design' },
  { id: 'output', label: '3 · Output' },
];

// Numeric bounds come from RANGES in core.js. `effective` names the value the
// drawing actually uses when another parameter limits this one. */
const PANELS = [
  {
    id: 'stock', stage: 'layout', label: 'Material',
    fields: [
      { type: 'pair', label: 'Stock size (mm)', names: ['Width', 'Height'], keys: ['stock.widthMm', 'stock.heightMm'] },
      { key: 'stock.marginMm', label: 'Uncut edge (mm)', type: 'number', effective: (s, c) => c.layout.marginMm },
      { key: 'stock.gapMm', label: 'Gap between cards (mm)', type: 'number' },
      { type: 'hint', text: 'At zero gap neighbours share one cut edge, so it is cut once.' }
    ]
  },
  {
    id: 'division', stage: 'layout', label: 'Division',
    // The card fills its cell, so this heading is where the card size is decided
    // and the only place it needs reporting.
    digest: (s, c) => (c.layout.valid ? `${c.layout.count} up · ${Math.round(c.layout.card.widthMm)} x ${Math.round(c.layout.card.heightMm)} mm · ${plural(sheetPages(c.layout).length, 'sheet')}` : 'no usable card'),
    fields: [
      { type: 'pair', label: 'Columns and rows', names: ['Columns', 'Rows'], keys: ['grid.cols', 'grid.rows'] },
      { type: 'actions', items: [{ action: 'transpose', label: 'Rotate stock' }] },
      { key: 'card.cornerRadiusMm', label: 'Corner radius (mm)', type: 'number', effective: (s, c) => c.layout.card.cornerRadiusMm },
      { key: 'card.safeMarginMm', label: 'Artwork margin (mm)', type: 'number', effective: (s, c) => c.layout.safeMarginMm },
      { type: 'hint', text: 'Added to the corner radius on both axes. Faces and backs share it.' }
    ]
  },
  {
    id: 'showing', stage: 'design', label: 'Showing', digest: jobDigest,
    fields: [
      SIDE_FIELD,
      { key: 'view.scope', label: 'Cards', type: 'toggle', options: [{ value: 'card', label: 'One' }, { value: 'suit', label: 'Suit' }, { value: 'deck', label: 'Deck' }] },
      { key: 'face.suit', label: 'Suit', type: 'toggle', showIf: (s) => facesShown(s) && s.view.scope !== 'deck', options: SUITS.map((suit) => ({ value: suit, label: SUIT_MARKS[suit], aria: titleCase(suit) })) },
      { key: 'face.rank', label: 'Rank', type: 'select', showIf: (s) => facesShown(s) && s.view.scope === 'card', options: Object.entries(RANK_LABELS).map(([value, label]) => ({ value: Number(value), label })) }
    ]
  },
  {
    id: 'style', stage: 'design', label: 'Face artwork', showIf: facesShown,
    fields: [
      { key: 'theme', label: 'Suit and glyph set', type: 'toggle', options: Object.values(THEMES).map((t) => ({ value: t.id, label: t.label })) },
      { label: 'Corner indices', type: 'switches', items: [{ key: 'face.showIndices', label: 'Show indices' }] },
      { key: 'face.indexCorners', label: 'Index corners', type: 'toggle', showIf: s => s.face.showIndices, options: [{ value: 2, label: 'Two' }, { value: 4, label: 'Four' }] },
      { key: 'face.redTone', label: 'Red suit tone', type: 'number' },
      { type: 'hint', text: 'Hearts and diamonds engrave this many steps shallower than black. 0 makes all four suits the same depth.' }
    ]
  },
  {
    id: 'scale', stage: 'design', label: 'Artwork scale', showIf: facesShown, digest: (s) => percent(s.art.scale),
    fields: [
      { key: 'art.scale', label: 'Everything (%)', type: 'number', scale: 100 },
      { action: 'reset-scales', label: 'Reset to 100%', type: 'action' },
      { type: 'disclose', label: 'Per element', owns: 'scale' },
      { key: 'art.pip', label: 'Pips (%)', type: 'number', scale: 100, group: 'scale' },
      { key: 'art.ace', label: 'Ace pip (%)', type: 'number', scale: 100, group: 'scale' },
      { key: 'art.index', label: 'Corner indices (%)', type: 'number', scale: 100, group: 'scale', showIf: (s) => s.face.showIndices },
      { key: 'art.weight', label: 'Index weight (%)', type: 'number', scale: 100, group: 'scale', showIf: (s) => s.face.showIndices }
    ]
  },
  {
    id: 'back', stage: 'design', label: 'Back pattern', showIf: backShown, digest: (s) => titleCase(s.back.pattern),
    fields: [
      { key: 'back.pattern', label: 'Pattern', type: 'select', options: opts(PATTERNS) },
      { type: 'actions', items: [{ action: 'randomise', label: 'Randomise' }] },
      { key: 'back.rotation', label: 'Rotation (°)', type: 'number', showIf: s => s.back.pattern !== 'rings' },
      { label: 'Shape', type: 'switches', showIf: s => STRETCH_PATTERNS.includes(s.back.pattern), items: [{ key: 'back.stretch', label: 'Stretch to card' }] },
      { type: 'hint', showIf: s => STRETCH_PATTERNS.includes(s.back.pattern), text: 'Opens the figure out from a circle to an ellipse that fills the artwork frame. Spacing then holds on the short axis and opens out with the card on the long one.' },
      { key: 'back.guillLobes', label: 'Lobes', type: 'number', showIf: isPattern('guilloche'), effective: (s) => guillochePair(s.back).lobes },
      { key: 'back.guillTurns', label: 'Turns to close', type: 'number', showIf: isPattern('guilloche'), effective: (s) => guillochePair(s.back).turns },
      { key: 'back.guillDepth', label: 'Rosette depth (%)', type: 'number', scale: 100, showIf: isPattern('guilloche') },
      { key: 'back.guillLines', label: 'Curves', type: 'number', showIf: isPattern('guilloche') },
      { type: 'hint', showIf: isPattern('guilloche'), text: 'A pair sharing a factor draws reduced (12 and 4 as 3 and 1); the fields keep what you typed.' },
      { key: 'back.truchetTile', label: 'Tile size (mm)', type: 'number', showIf: isPattern('truchet') },
      { key: 'back.truchetProb', label: 'Flip probability (%)', type: 'number', scale: 100, showIf: isPattern('truchet') },
      // The only generator that reaches the PRNG at all.
      { key: 'back.seed', label: 'Seed', type: 'number', showIf: (s) => patternUsesSeed(s.back.pattern) },
      { key: 'back.ringSpacing', label: 'Ring spacing (mm)', type: 'number', showIf: isPattern('rings') },
      { key: 'back.latticeCell', label: 'Line spacing (mm)', type: 'number', showIf: isPattern('lattice') },
      { key: 'back.spiralPitch', label: 'Turn spacing (mm)', type: 'number', showIf: isPattern('spiral') },
      { key: 'back.spiralArms', label: 'Arms', type: 'number', showIf: isPattern('spiral') },
      { key: 'back.hexSize', label: 'Cell width (mm)', type: 'number', showIf: isPattern('hex') },
      { key: 'back.halftoneField', label: 'Gradient', type: 'select', options: opts(HALFTONE_FIELDS), showIf: isPattern('halftone') },
      { key: 'back.halftoneShape', label: 'Dot shape', type: 'toggle', options: opts(HALFTONE_SHAPES), showIf: isPattern('halftone') },
      { key: 'back.halftoneCell', label: 'Dot pitch (mm)', type: 'number', showIf: isPattern('halftone') },
      { key: 'back.halftoneGamma', label: 'Contrast', type: 'number', showIf: isPattern('halftone') },
      { label: 'Screen', type: 'switches', showIf: isPattern('halftone'), items: [{ key: 'back.halftoneStagger', label: 'Stagger rows' }, { key: 'back.halftoneInvert', label: 'Invert' }] }
    ]
  },
    {
    id: 'pass', stage: 'output', label: 'Pass', digest: jobDigest,
    fields: [
      SIDE_FIELD,
      { type: 'hint', showIf: (s) => facesShown(s) && s.view.scope !== 'card', text: 'Each sheet file is its own stock, origin at the stock corner. A short run is cut down to the cards it holds.' },
      { type: 'hint', showIf: (s) => backShown(s) && s.view.scope !== 'card', text: 'Turn each sheet over left to right and run its back file at the same machine origin.' }
    ]
  },
  {
    id: 'operations',
    stage: 'output',
    label: 'Operations',
    digest: s => {
      const ops = passOperations(s, s.view.side);
      return [ops.cut && 'cut', ops.score && 'score', ops.engrave && 'engrave'].filter(Boolean).join(' · ');
    },
    fields: [
      {
        label: 'Emit layers',
        type: 'switches',
        showIf: facesShown,
        items: [
          { key: 'output.face.cut', label: 'Cut cards' },
          { key: 'output.face.engrave', label: 'Engrave' }
        ]
      },
      {
        label: 'Emit layers',
        type: 'switches',
        showIf: backShown,
        items: [
          { key: 'output.back.cut', label: 'Cut cards' },
          { key: 'output.back.score', label: 'Score', pressed: s => passOperations(s, 'back').score, disabledIf: dotPattern },
          { key: 'output.back.engrave', label: 'Engrave', pressed: s => passOperations(s, 'back').engrave, disabledIf: s => !dotPattern(s) }
        ]
      },
      {
        type: 'hint',
        showIf: backShown,
        text: 'Cut cards here only if the face pass left them uncut.'
      },
      {
        label: 'Auxiliary files',
        type: 'switches',
        showIf: s => s.view.scope !== 'card',
        items: [
          { key: 'output.stockCut', label: 'Stock squaring file' },
          { key: 'output.backJig', label: 'Single-card back jig' }
        ]
      },
      {
        type: 'hint',
        showIf: s => s.output.stockCut && s.view.scope !== 'card',
        text: 'Exports an extra cut file to trim raw stock to help align back pattern engraving.'
      },
      {
        type: 'hint',
        showIf: s => s.output.backJig && s.view.scope !== 'card',
        text: 'Adds a 1-card back and pocket cut file to the ZIP for single-card repeater jigs.'
      },
      {
        key: 'output.target',
        label: 'Colour convention',
        type: 'select',
        options: Object.values(TARGETS).map(t => ({ value: t.id, label: t.label }))
      },
      {
        type: 'hint',
        showIf: s => Boolean(TARGETS[s.output.target].engrave),
        text: 'Each engrave depth lands on its own layer: 00 is the deepest, then 03 to 09. Set each to Fill with its own power.'
      },
      {
        type: 'hint',
        text: "Cut is the card outline, score is the back pattern's linework, engrave is everything filled: pips, indices, courts and halftone dots."
      }
    ]
  },
  {
    id: 'export',
    stage: 'output',
    label: 'Export',
    fields: [
      {
        action: 'export',
        label: 'Export',
        type: 'action',
        disabledIf: (s, c) => invalidLayout(s, c) || Boolean(emptyJobNote(s))
      },
      {
        type: 'hint',
        text: 'Exports all active files for this job (faces, backs, squaring and jigs) in a single ZIP.'
      }
    ]
  }
];

/* ── widget builders ──────────────────────────────────────────────────────── */

let uid = 0;
const nextId = () => `ctl-${++uid}`;
const round3 = (v) => Math.round(v * 1000) / 1000;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toggleButton(label) {
  const button = element('button', 'toggle', label);
  button.type = 'button';
  return button;
}

/* A caption for a group of controls; the group names itself after it. */
function caption(field) {
  const node = element('span', 'field-label', field.label);
  node.id = nextId();
  return node;
}

function namedGroup(className, labelledBy) {
  const group = element('div', className);
  group.setAttribute('role', 'group');
  if (labelledBy) group.setAttribute('aria-labelledby', labelledBy);
  return group;
}

/* Every numeric parameter is a typed value with its unit in the label. Sliders
cost two rows and a second control apiece to express a number the user usually
already knows, and a number input is what turns into a proper keypad on a
phone; the arrow keys still nudge it on a desktop.
`scale` renders a stored ratio as the integer percentage people actually think
in, so state keeps 1 while the box shows 100. */
function numberControl(key, spec, handlers) {
  const range = RANGES[key] || {};
  const factor = spec.scale || 1;
  const lo = range.min ?? -Infinity;
  const hi = range.max ?? Infinity;
  const input = document.createElement('input');
  input.type = 'number';
  if (Number.isFinite(lo)) input.min = String(round3(lo * factor));
  if (Number.isFinite(hi)) input.max = String(round3(hi * factor));
  input.step = String(round3((range.step ?? 1) * factor));
  const show = (v) => {
    input.value = String(round3(v * factor));
  };
  const push = (commit) => {
    const raw = parseFloat(input.value);
    if (!Number.isFinite(raw)) return;
    const v = raw / factor;
    // A half-typed number is out of range more often than not, and committing it
    // would clamp what the user is still writing.
    if (!commit && (v < lo || v > hi)) return;
    handlers.onChange(key, clamp(v, lo, hi));
  };
  input.addEventListener('input', () => push(false));
  input.addEventListener('change', () => {
    push(true);
    show(getPath(handlers.state(), key));
  });
  return {
    input,
    sync(state, context) {
      const value = getPath(state, key);
      if (document.activeElement !== input) show(value);
      // The typed value is kept; the outline says the drawing uses less of it.
      const limited = Boolean(spec.effective) && Math.abs(spec.effective(state, context) - value) > 1e-6;
      input.classList.toggle('limited', limited);
    },
  };
}

function buildNumber(field, handlers) {
  const wrap = element('div', 'field inline');
  const id = nextId();
  const label = element('label', 'field-label', field.label);
  label.htmlFor = id;
  const control = numberControl(field.key, field, handlers);
  control.input.id = id;
  wrap.append(label, control.input);
  return { wrap, field, sync: control.sync };
}

/* Two values that read as one measurement: width by height, columns by rows. */
function buildPair(field, handlers) {
  const wrap = element('div', 'field');
  const title = caption(field);
  const row = namedGroup('pair-row', title.id);
  const controls = field.keys.map((key, i) => {
    const control = numberControl(key, field, handlers);
    control.input.setAttribute('aria-label', (field.names && field.names[i]) || key);
    if (i) row.append(element('span', 'times', 'x'));
    row.append(control.input);
    return control;
  });
  wrap.append(title, row);
  return {
    wrap,
    field,
    sync(state, context) {
      for (const control of controls) control.sync(state, context);
    },
  };
}

function buildToggleGroup(field, handlers) {
  const wrap = element('div', 'field');
  const title = caption(field);
  const group = namedGroup('toggle-group', title.id);
  const buttons = field.options.map((option) => {
    const button = toggleButton(option.label);
    if (option.aria) button.setAttribute('aria-label', option.aria);
    button.addEventListener('click', () => handlers.onChange(field.key, option.value));
    group.append(button);
    return { button, option };
  });
  wrap.append(title, group);
  return {
    wrap,
    field,
    sync(state) {
      const value = getPath(state, field.key);
      for (const { button, option } of buttons) button.setAttribute('aria-pressed', String(option.value === value));
    },
  };
}

/* Boolean parameters as independent toggle buttons. An item may show a value
the pass derives (`pressed`) and lock while the pass overrides it (`disabledIf`). */
function buildSwitches(field, handlers) {
  const wrap = element('div', 'field');
  const title = caption(field);
  const group = namedGroup('toggle-group', title.id);
  const buttons = field.items.map((item) => {
    const button = toggleButton(item.label);
    button.addEventListener('click', () => handlers.onChange(item.key, !getPath(handlers.state(), item.key)));
    group.append(button);
    return { button, item };
  });
  wrap.append(title, group);
  return {
    wrap,
    field,
    sync(state) {
      for (const { button, item } of buttons) {
        const pressed = item.pressed ? item.pressed(state) : getPath(state, item.key);
        button.setAttribute('aria-pressed', String(Boolean(pressed)));
        button.disabled = Boolean(item.disabledIf && item.disabledIf(state));
      }
    },
  };
}

function buildSelect(field, handlers) {
  const wrap = element('div', 'field');
  const id = nextId();
  const label = element('label', 'field-label', field.label);
  label.htmlFor = id;
  const select = document.createElement('select');
  select.id = id;
  for (const option of field.options) {
    const node = element('option', null, option.label);
    node.value = String(option.value);
    select.append(node);
  }
  select.addEventListener('change', () => {
    const match = field.options.find((o) => String(o.value) === select.value);
    handlers.onChange(field.key, match ? match.value : select.value);
  });
  wrap.append(label, select);
  return {
    wrap,
    field,
    sync(state) {
      if (document.activeElement !== select) select.value = String(getPath(state, field.key));
    },
  };
}

function buildAction(field, handlers) {
  const wrap = element('div', 'field');
  const button = element('button', null, field.label);
  button.type = 'button';
  button.addEventListener('click', () => handlers.onAction(field.action));
  wrap.append(button);
  return {
    wrap,
    field,
    sync(state, context) {
      button.disabled = Boolean(field.disabledIf && field.disabledIf(state, context));
    },
  };
}

/* Related buttons on one line rather than a stack of rows. */
function buildActions(field, handlers) {
  const wrap = element('div', 'field');
  const row = element('div', 'toggle-group');
  for (const item of field.items) {
    const button = element('button', 'toggle', item.label);
    button.type = 'button';
    button.addEventListener('click', () => handlers.onAction(item.action));
    row.append(button);
  }
  wrap.append(row);
  return { wrap, field, sync() {} };
}

/* Standing explanation of a behaviour, not a warning about a value. */
function buildHint(field) {
  return { wrap: element('p', 'hint', field.text), field, sync() {} };
}

/* The one thing in the rail that folds: everything else is read at a glance.
Fields join it by naming its group; mountControls decides their visibility,
so a folded field still honours its own showIf once opened. */
function buildDisclose(field, handlers, shared) {
  const wrap = element('button', 'disclose', field.label);
  wrap.type = 'button';
  wrap.setAttribute('aria-expanded', 'false');
  const group = { open: false };
  // `owns`, not `group`: a field that named its own group was hidden with the
  // fields it controls, so the disclosure could never be opened again.
  shared.groups.set(field.owns, group);
  wrap.addEventListener('click', () => {
    group.open = !group.open;
    shared.refresh();
  });
  return {
    wrap,
    field,
    sync() {
      wrap.setAttribute('aria-expanded', String(group.open));
    },
  };
}

const BUILDERS = {
  toggle: buildToggleGroup,
  switches: buildSwitches,
  select: buildSelect,
  number: buildNumber,
  pair: buildPair,
  action: buildAction,
  actions: buildActions,
  hint: buildHint,
  disclose: buildDisclose
};

/* Builds the rail from PANELS. sync(state, context) shows each panel on its
stage, each field by its showIf and disclosure group, and refreshes values;
context carries derived values such as the resolved layout. */
export function mountControls(root, handlers) {
  let last = null;
  const shared = {
    groups: new Map(),
    refresh: () => {
      if (last) sync(last.state, last.context);
    },
  };
  const panels = [];
  for (const panel of PANELS) {
    const section = element('section', 'panel');
    const heading = element('h2', null, panel.label);
    const digest = panel.digest ? element('span', 'digest') : null;
    if (digest) heading.append(digest);
    section.append(heading);
    const entries = panel.fields.map((field) => {
      const entry = (BUILDERS[field.type] || buildNumber)(field, handlers, shared);
      section.append(entry.wrap);
      return entry;
    });
    root.append(section);
    panels.push({ panel, section, digest, entries });
  }

  function sync(state, context) {
    last = { state, context };
    for (const { panel, section, digest, entries } of panels) {
      const shown = state.view.stage === panel.stage && (!panel.showIf || panel.showIf(state));
      section.classList.toggle('hidden', !shown);
      if (!shown) continue;
      if (digest) digest.textContent = panel.digest(state, context);
      for (const entry of entries) {
        const { field } = entry;
        const group = shared.groups.get(field.group);
        const visible = (!field.showIf || field.showIf(state)) && (!group || group.open);
        entry.wrap.classList.toggle('hidden', !visible);
        if (visible) entry.sync(state, context);
      }
    }
  }

  return { sync };
}

/* ── viewport ─────────────────────────────────────────────────────────────── */

const KEY_ZOOM = 1.2;
const MIN_SPAN_MM = 1;
const MAX_SPAN_MM = 20000;
const CLICK_SLOP_PX = 4;
// Zoom per pixel of wheel travel; trackpad pinches arrive as small ctrl+wheel deltas.
const WHEEL_ZOOM = 0.0015;
const PINCH_WHEEL_ZOOM = 0.01;

/* Pans and zooms the preview by rewriting its viewBox. The canvas shows; it does
not select. Every press is captured at once, so a release outside the canvas
still ends it; CLICK_SLOP_PX only decides when a press becomes a pan. */
export function createViewport(container) {
  let svgEl = null;
  let view = null;
  let doc = { widthMm: 0, heightMm: 0, x: 0, y: 0 };
  let moved = false;
  const pointers = new Map();
  let gesture = null;
  const api = { refitOnNext: true };

  function applyView() {
    if (!svgEl || !view) return;
    svgEl.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  function fit(padding = 0.04) {
    if (!doc.widthMm || !doc.heightMm) return;
    const pad = Math.max(doc.widthMm, doc.heightMm) * padding;
    view = { x: doc.x - pad, y: doc.y - pad, w: doc.widthMm + pad * 2, h: doc.heightMm + pad * 2 };
    moved = false;
    applyView();
  }

  /* Accounts for the letterboxing introduced by preserveAspectRatio="xMidYMid meet". */
  function frame(v) {
    const rect = container.getBoundingClientRect();
    const scale = Math.min(rect.width / v.w, rect.height / v.h);
    return { rect, scale, offX: (rect.width - v.w * scale) / 2, offY: (rect.height - v.h * scale) / 2 };
  }

  function clientToDoc(clientX, clientY, v = view) {
    const { rect, scale, offX, offY } = frame(v);
    if (!rect.width || !rect.height) return { x: v.x, y: v.y };
    return { x: v.x + (clientX - rect.left - offX) / scale, y: v.y + (clientY - rect.top - offY) / scale };
  }

  /* A view of size w x h that puts document point `anchor` under the client point. */
  function anchored(anchor, clientX, clientY, w, h) {
    const { rect, scale, offX, offY } = frame({ w, h });
    return { x: anchor.x - (clientX - rect.left - offX) / scale, y: anchor.y - (clientY - rect.top - offY) / scale, w, h };
  }

  function zoomAt(factor, clientX, clientY) {
    if (!view) return;
    const w = clamp(view.w * factor, MIN_SPAN_MM, MAX_SPAN_MM);
    const h = view.h * (w / view.w);
    view = anchored(clientToDoc(clientX, clientY), clientX, clientY, w, h);
    moved = true;
    applyView();
  }

  function centreOfContainer() {
    const rect = container.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  }

  function capture(id) {
    try {
      container.setPointerCapture(id);
    } catch {
      // The pointer is already gone; its pointerup has been or will be handled.
    }
  }

  function pinchMetrics() {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function startPinch() {
    const p = pinchMetrics();
    gesture = { kind: 'pinch', dist: p.dist, view: { ...view }, anchor: clientToDoc(p.x, p.y) };
    container.classList.add('dragging');
  }

  function movePinch() {
    const p = pinchMetrics();
    const w = clamp(gesture.view.w * (gesture.dist / p.dist), MIN_SPAN_MM, MAX_SPAN_MM);
    const h = gesture.view.h * (w / gesture.view.w);
    view = anchored(gesture.anchor, p.x, p.y, w, h);
    moved = true;
    applyView();
  }

  container.addEventListener('wheel', (event) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1;
    const rate = event.ctrlKey ? PINCH_WHEEL_ZOOM : WHEEL_ZOOM;
    zoomAt(Math.exp(event.deltaY * unit * rate), event.clientX, event.clientY);
  }, { passive: false });

  container.addEventListener('pointerdown', (event) => {
    if (!view || (event.pointerType === 'mouse' && event.button !== 0)) return;
    // Keyboard pan and zoom are useless until something focuses the canvas.
    container.focus({ preventScroll: true });
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    capture(event.pointerId);
    if (pointers.size === 1) {
      gesture = { kind: 'press', id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...view } };
    } else if (pointers.size === 2) {
      startPinch();
    }
  });

  container.addEventListener('pointermove', (event) => {
    const p = pointers.get(event.pointerId);
    if (!p || !gesture) return;
    p.x = event.clientX;
    p.y = event.clientY;
    if (gesture.kind === 'pinch') {
      if (pointers.size >= 2) movePinch();
      return;
    }
    if (event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (gesture.kind === 'press') {
      if (Math.abs(dx) <= CLICK_SLOP_PX && Math.abs(dy) <= CLICK_SLOP_PX) return;
      gesture.kind = 'pan';
      container.classList.add('dragging');
    }
    const { scale } = frame(gesture.view);
    view = { ...gesture.view, x: gesture.view.x - dx / scale, y: gesture.view.y - dy / scale };
    moved = true;
    applyView();
  });

  const endPointer = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    if (!gesture) return;
    if (gesture.kind === 'pinch' && pointers.size === 1) {
      // One finger left: carry on panning from where it is now.
      const [[id, p]] = pointers;
      gesture = { kind: 'pan', id, x: p.x, y: p.y, view: { ...view } };
      return;
    }
    if (!pointers.size) {
      gesture = null;
      container.classList.remove('dragging');
    }
  };
  container.addEventListener('pointerup', endPointer);
  container.addEventListener('pointercancel', endPointer);

  container.addEventListener('keydown', (event) => {
    if (!view) return;
    const step = view.w * 0.08;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      view = { ...view, x: view.x + moves[event.key][0], y: view.y + moves[event.key][1] };
      moved = true;
      applyView();
    } else if (event.key === '+' || event.key === '=') {
      zoomAt(1 / KEY_ZOOM, ...centreOfContainer());
    } else if (event.key === '-') {
      zoomAt(KEY_ZOOM, ...centreOfContainer());
    } else if (event.key === '0') {
      fit();
    } else {
      return;
    }
    event.preventDefault();
  });

  /* The XML prolog parses as a comment under innerHTML, which is harmless and
  keeps the previewed string byte-identical to what the builder produced.
  The view refits when asked to, or when the document changes size while the
  user has not moved the view since the last fit. */
  api.setDocument = (svgString, widthMm, heightMm, originX = 0, originY = 0) => {
    const resized = widthMm !== doc.widthMm || heightMm !== doc.heightMm || originX !== doc.x || originY !== doc.y;
    doc = { widthMm, heightMm, x: originX, y: originY };
    container.innerHTML = svgString;
    svgEl = container.querySelector('svg');
    if (!svgEl) return;
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    if (!view || api.refitOnNext || (resized && !moved)) {
      api.refitOnNext = false;
      fit();
    } else {
      applyView();
    }
  };
  api.zoomIn = () => zoomAt(1 / KEY_ZOOM, ...centreOfContainer());
  api.zoomOut = () => zoomAt(KEY_ZOOM, ...centreOfContainer());
  api.fit = fit;
  return api;
}

/* ── status bar ───────────────────────────────────────────────────────────── */

const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const bytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`);
const metres = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} m` : `${Math.round(n)} mm`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const STAGE_LABELS = { layout: 'Stock', design: 'Design', output: 'Output' };

export function createStatusBar(hudRoot, notesRoot) {
  const slots = {};
  for (const node of hudRoot.querySelectorAll('[data-hud]')) slots[node.dataset.hud] = node;
  const set = (name, text) => {
    if (slots[name] && slots[name].textContent !== text) slots[name].textContent = text;
  };
  let warnings = '';
  let info = '';
  let painted = null;
  // The notes element is a live region: rewriting it with unchanged text would
  // have it announced again on every keystroke.
  const paint = () => {
    const key = `${warnings}\n${info}`;
    if (key === painted) return;
    painted = key;
    const nodes = [];
    if (warnings) nodes.push(element('span', 'note-warn', warnings));
    if (info) nodes.push(element('span', 'note-info', info));
    notesRoot.replaceChildren(...nodes);
  };
  return {
    update(stats) {
      const design = stats.stage === 'design';
      set('scope', `${STAGE_LABELS[stats.stage]} · ${plural(stats.tiles, design ? 'tile' : 'card')}`);
      let sheets = '';
      if (stats.sheets) {
        sheets = stats.side === 'back'
          ? `${plural(stats.backFiles, 'back file')} for ${plural(stats.sheets, 'sheet')}`
          : `${plural(stats.sheets, 'sheet')} · ${stats.per} up`;
      }
      set('sheets', sheets);
      // Proportion is a consequence of the division, so it is reported here and
      // authored nowhere.
      set('card', stats.valid
        ? `Card ${mm(stats.cardWidthMm)} x ${mm(stats.cardHeightMm)} mm · 1:${stats.ratio.toFixed(2)}`
        : 'No usable card');
      set('doc', design
        ? `View ${mm(stats.docWidthMm)} x ${mm(stats.docHeightMm)} mm`
        : `Stock ${mm(stats.stockWidthMm)} x ${mm(stats.stockHeightMm)} mm`);
      set('fit', !design && stats.valid ? `${Math.round(stats.utilization * 100)}% of stock` : '');
      set('cut', stats.cutMm ? `Cut ${metres(stats.cutMm)}` : '');
      set('score', stats.scoreMm ? `Score ${metres(stats.scoreMm)}` : '');
      // One sheet file, not the preview document, which is never exported.
      set('points', stats.filePoints ? `${compact(stats.filePoints)} points` : '');
      set('size', stats.fileBytes ? `${bytes(stats.fileBytes)} per ${stats.fileScope || 'sheet'}` : '');
    },
    notes(list) {
      warnings = list.join(' ');
      paint();
    },
    info(text) {
      info = text || '';
      paint();
    },
  };
}
