# Laser Cut Cards

![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)
![Status: Active](https://img.shields.io/badge/status-active-success.svg)
![Tech: VanillaJS](https://img.shields.io/badge/tech-Vanilla_JS-yellow.svg)

A parametric SVG playing card generator for laser cutters. You give it a sheet of stock and how you want it divided; it gives you cut, score and engrave geometry.

Built for beginner laser cutting workshops.

## Running it

The deployed build is a single page and it opens from anywhere, including a USB stick.

The source does not, because browsers refuse to load ES modules over `file://`.
Serve the folder instead:

    npm run dev          # five-server on :5500, fetched on demand
    python3 -m http.server 5500

To produce the deployed build:

    npm ci
    npm run build:min    # -> dist/index.html, dist/app.js, dist/assets/, and friends

## What it produces

Plain SVG, sized in real millimetres, with three operations separated by colour:

- **Cut** — card outlines, and the stock outline when you ask for it
- **Score** — the back pattern's linework, as a hairline
- **Engrave** — everything filled: pips, corner indices, court figures, halftone dots

Colour conventions are selectable for LightBurn/RDWorks and Trotec JobControl. For LightBurn/RDWorks, cut is layer 02, score layer 01, and each engrave depth gets its own layer: 00 for the deepest, then 03 to 09. Set those to Fill, each with its own power. Trotec gets depth as grey.

Files are laid out the way the machine wants them. Nothing needs re-scaling, re-nesting, un-grouping or welding after import.

## Export requirements

Six rules for consistent files that look right on screen and can be cut predictably:

- Physical `width`/`height` in millimetres pinned against a matching `viewBox`, so there is no DPI to guess at import.
- No `transform=` attributes anywhere — every placement is baked into absolute path coordinates. Nested transforms are what importers mishandle most.
- No `<clipPath>`, `<use>`, `<text>` or gradients. Boundaries are computed and trimmed; tone comes from quantised engrave levels and halftone dots.
- No overlapping shapes within a fill. LightBurn fills even-odd whatever the file says, so an overlap would engrave as a hole: stroked numerals are welded into single outlines and the club suit is one contour.
- Presentation attributes rather than inline styles, so the on-screen preview can restyle the markup without altering a byte of what exports.
- One `<path>` per operation and fill, so a card with three hundred halftone dots is still three elements.

## Using it

**1 · Stock.** Enter the sheet size, how much edge to leave uncut, and the gap between cards. Pick columns and rows. The card is the cell, so the division is also the shape control — `2 x 3` gives portrait cards, `3 x 2` landscape ones. Set the gap to zero and neighbours share a cut edge, cut once. "Rotate stock" swaps the division and the sheet's dimensions together, which rotates the card exactly.

The corner radius and the artwork margin stack: the margin is the air between the corner arc and the nearest ink, on every side. Faces and backs share that frame.

**2 · Design.** Preview a side, how many cards: one, a suit, or the deck. Faces get a glyph set, corner indices and artwork scale; the back gets a pattern, its own parameters and one rotation. What you see here is what Export produces.

**3 · Output.** Each side carries its own operations, so a pass can engrave only, cut only, or both. A back pattern is either linework, which is scored, or dots, which are engraved, so the switch it can't use is locked. A pass with nothing to emit says so, and Export stays off. A face pass can also cut the stock outline, which squares an uneven sheet so it can be turned over. Export produces an SVG for a single card and a ZIP above that.

The complete design lives in the URL. Copy the address bar to share it or to reproduce it exactly.

## Cutting both sides

A single-card file has its origin at the card corner, with nothing around it. A sheet file **is** that page of stock: the origin is the stock corner and the cards sit one margin in.

A run pages as full sheets, then whatever complete rows are left, then one short row. Every page is a filled rectangle of cards, so a page turned over left to right lands on its own frame and nothing needs mirroring. Backs are identical on every card, so one back file serves every page of the same shape and its name carries the run count.

A workable two-sided order:

1. Face pass with **Cut stock outline** on and the card cut off: engrave the faces and square the sheet. Set the job origin a few millimetres inside the rough edge.
2. Turn the sheet over left to right, run the back file at the same origin.
3. Cut, from whichever pass you left the card cut enabled on.

## Project layout

    index.html          application shell
    src/core.js         constants, state, layout resolver, pages, URL codec
    src/svg.js          path emit, transforms, operation layers, stroke welding, clipping
    src/art-data.js     glyph and court literals — data only
    src/art.js          theme registry, card faces, back patterns
    src/output.js       cut geometry, documents, pages, previews
    src/ui.js           control rail, viewport, status bar
    src/app.js          wiring, render loop, file delivery
    styles/             tokens, page shell, controls, preview

`core.js` and `art-data.js` import nothing. Dependencies run one way down that list, so the whole authoring model and every generator can be exercised without a browser.

## Adding artwork

Themes bind a suit set and a rank font, and are added by editing the registry in `src/art.js`. A candidate is validated against the authoring contract before it can reach a cut file, so a relative or arc command in a pasted path fails immediately with a message rather than silently mid-render. A set missing a suit, a rank character or a court is rejected the same way, and the built-in themes go through the same gate on load.

Glyphs live in a normalised unit box, use only absolute `M L C S Q T Z`, and are filled with `fill-rule="nonzero"`. Subpaths must never overlap, because LightBurn fills even-odd whatever the file says; a counter is a subpath inside the outline, wound against it.

Rank characters are monolinear centrelines, given real weight at render time and welded into one outline per label, so adding a typeface means supplying polylines rather than outlines. Authored outlines are still honoured per character if you have them.

Court figures are facet meshes drawn in a fixed-aspect frame, fitted uniformly and cloned by point reflection, so card shape never stretches them and all three figures share one size. Two properties make them cut correctly, and a hand edit has to preserve both: no two facets overlap, so nothing can hide a detail and no importer can engrave a region twice; and facets meant to read apart differ by at least one engrave step, which is what gives the figure its edges without a stroked outline. The meshes in `art-data.js` were produced by flattening a layered drawing rather than drawn as they stand.

## Browser support

Any current browser with ES modules and pointer events. The bundler is only for shipping a single file.

## Licence

GNU Affero General Public License, version 3 or later. See `LICENSE`.

Copyright © 2026 Eltryus — Ricardo Marques.