/*!
 * @file        src/app.js
 * @description Application entry point and file delivery.
 *              Wires state, controls, viewport and status bar together; owns the
 *              render loop and its adaptive scheduling, the pattern cache,
 *              persistence in the URL and local storage, the toolbar and the
 *              downloads.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/LaserCutCards}
 *
 * SPDX-FileCopyrightText: 2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { defaultState, clampState, encodeState, decodeState, setPath, randomisePattern, resolveLayout } from './core.js';
import { THEMES } from './art.js';
import { buildPreview, generateJob, zipStore } from './output.js';
import { mountControls, createViewport, createStatusBar, STAGE_TABS } from './ui.js';

const STORAGE_KEY = 'card-generator-state';
const CACHE_LIMIT = 24;
const SLOW_FRAME_MS = 25;
const SLOW_DEBOUNCE_MS = 120;
const PERSIST_MS = 400;
const CLAMP = { themes: Object.keys(THEMES) };

// Pattern geometry is cached under a key covering every parameter that affects it,
// so the cache is its own invalidation: no dirty flags are needed.
const cache = new Map();
const panelRoot = document.getElementById('panels');
const previewRoot = document.getElementById('preview');
const stageRoot = document.getElementById('stages');
const toolbar = document.getElementById('toolbar');
const status = createStatusBar(document.getElementById('hud'), document.getElementById('notes'));

// Set by loadState during the initialisation below, so it is declared first.
let firstRun = false;
let state = loadState();
let lastCost = 0;
let pendingFrame = false;
let debounceTimer = null;
let persistTimer = null;

const viewport = createViewport(previewRoot);
const controls = mountControls(panelRoot, { onChange, onAction, state: () => state });

// These swap in a different document rather than resize the current one, so the
// view is refitted even if the user has zoomed or panned.
const REFIT_KEYS = new Set(['view.stage', 'view.side', 'view.scope']);

const stageButtons = STAGE_TABS.map((tab) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'stage';
  button.dataset.stage = tab.id;
  button.textContent = tab.label;
  button.addEventListener('click', () => onChange('view.stage', tab.id));
  stageRoot.append(button);
  return button;
});

/* First run only: a link or a stored design means the user came for that design,
not for the introduction. */
function loadState() {
  const hash = location.hash.slice(1);
  if (hash) return decodeState(hash, CLAMP);
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return decodeState(stored, CLAMP);
  } catch {
    // Storage unavailable or unreadable.
  }
  firstRun = true;
  return defaultState();
}

function onChange(key, value) {
  setPath(state, key, value);
  if (REFIT_KEYS.has(key)) viewport.refitOnNext = true;
  clampState(state, CLAMP);
  status.info('');
  schedule();
}

function onAction(action) {
  switch (action) {
    case 'randomise':
      randomisePattern(state);
      break;
    case 'reset-scales':
      state.art = defaultState().art;
      break;
    case 'transpose':
      // Swapping the division and the sheet together is an exact rotation of the card.
      state.grid = { cols: state.grid.rows, rows: state.grid.cols };
      state.stock = { ...state.stock, widthMm: state.stock.heightMm, heightMm: state.stock.widthMm };
      break;
    case 'export':
      guard(exportJob);
      return;
    default:
      return;
  }
  clampState(state, CLAMP);
  status.info('');
  schedule();
}

/* Falls back to a trailing debounce once a render stops fitting in a frame. */
function schedule() {
  if (lastCost > SLOW_FRAME_MS) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(render, SLOW_DEBOUNCE_MS);
    return;
  }
  if (pendingFrame) return;
  pendingFrame = true;
  requestAnimationFrame(() => {
    pendingFrame = false;
    render();
  });
}

function syncChrome() {
  for (const button of stageButtons) {
    if (button.dataset.stage === state.view.stage) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
}

function render() {
  const started = performance.now();
  controls.sync(state, { layout: resolveLayout(state) });
  syncChrome();
  let preview;
  try {
    const viewportPx = { w: previewRoot.clientWidth, h: previewRoot.clientHeight };
    preview = buildPreview(state, { cache, aspect: viewportPx.w / (viewportPx.h || 1), viewportPx });
  } catch (error) {
    status.notes([`Render failed: ${error.message}`]);
    lastCost = performance.now() - started;
    return;
  }
  viewport.setDocument(preview.svg, preview.stats.docWidthMm, preview.stats.docHeightMm);
  status.update(preview.stats);
  status.notes(preview.notes);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  lastCost = performance.now() - started;
  persist();
}

function writeState() {
  const encoded = encodeState(state);
  history.replaceState(null, '', encoded ? `#${encoded}` : location.pathname + location.search);
  try {
    localStorage.setItem(STORAGE_KEY, encoded);
  } catch {
    // Storage unavailable.
  }
}

function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writeState, PERSIST_MS);
}

function flushPersist() {
  clearTimeout(persistTimer);
  writeState();
}

function guard(work) {
  try {
    work();
  } catch (error) {
    status.notes([`Export failed: ${error.message}`]);
  }
}

/* ── file delivery ────────────────────────────────────────────────────────── */

function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Safari reads the URL only once the user confirms its download sheet, so an
  // early revoke fails the download. 40 s is the delay FileSaver.js settled on.
  setTimeout(() => URL.revokeObjectURL(url), 40000); // If exporting multiple files as a .zip becomes optional, saferi needs delays between downloads to avoid spam safeguards.
}

function svgBlob(text) {
  return new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
}

/* One file downloads as itself. More ship as one archive, because browsers
throttle long runs of sequential downloads. */
function exportJob() {
  const { files, stem, notes } = generateJob(state, { cache });
  if (files.length === 1) {
    download(files[0].name, svgBlob(files[0].svg));
    status.info(`Exported ${files[0].name}.`);
  } else {
    const card = resolveLayout(state).card;
    const name = `${stem}-${Math.round(card.widthMm)}x${Math.round(card.heightMm)}mm.zip`;
    const archive = zipStore(files.map((f) => ({ name: f.name, text: f.svg })));
    download(name, new Blob([archive], { type: 'application/zip' }));
    status.info(`Exported ${name}, ${files.length} files.`);
  }
  if (notes.length) status.notes(notes);
}

/* ── toolbar ──────────────────────────────────────────────────────────────── */

/* The link is built from state, so it never trails the debounced address bar. */
function shareUrl() {
  const url = new URL(location.href);
  url.hash = encodeState(state);
  return url.href;
}

function copyLink() {
  const link = shareUrl();
  const pending = navigator.clipboard && navigator.clipboard.writeText(link);
  if (pending) {
    pending.then(
      () => status.info('Link copied.'),
      () => status.info('Copy the address bar to share this design.'),
    );
  } else {
    status.info('Copy the address bar to share this design.');
  }
}

const welcome = document.getElementById('welcome');
function toggleWelcome() {
  if (welcome.open) welcome.close();
  else welcome.showModal();
}

/* Reset opens a new history entry, so Back restores the design it replaced. */
function resetState() {
  flushPersist();
  history.pushState(null, '', location.pathname + location.search);
  state = defaultState();
  viewport.refitOnNext = true;
  status.info('Reset to defaults. Back restores the previous design.');
  schedule();
}

toolbar.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  switch (button.dataset.action) {
    case 'fit':
      viewport.fit();
      break;
    case 'zoom-in':
      viewport.zoomIn();
      break;
    case 'zoom-out':
      viewport.zoomOut();
      break;
    case 'help':
      toggleWelcome();
      break;
    case 'copy-link':
      copyLink();
      break;
    case 'reset':
      resetState();
      break;
    default:
      break;
  }
});

// The output stage packs its sheets to the viewport's aspect, so a resize
// changes the layout and not only its scale.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(schedule, 150);
});

/* Global keys, as opposed to the viewport's own: those need the canvas focused,
which a user reaching for help or a refit has no reason to have done. */
const TEXT_ENTRY = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
window.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'F1') { event.preventDefault(); toggleWelcome(); return; }
  if (event.key !== 'f' && event.key !== 'F') return;
  const node = document.activeElement;
  if (node && (node.isContentEditable || TEXT_ENTRY.has(node.tagName))) return;
  event.preventDefault();
  viewport.fit();
});

window.addEventListener('hashchange', () => {
  const hash = location.hash.slice(1);
  if (hash === encodeState(state)) return;
  state = decodeState(hash, CLAMP);
  viewport.refitOnNext = true;
  status.info('');
  schedule();
});

render();
if (firstRun) welcome.showModal();