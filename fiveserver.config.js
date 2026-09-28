/*!
 * @file        fiveserver.config.js
 * @description Local development server
 * @author      Eltryus - Ricardo Marques
 * @copyright   2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/LaserCutCards}
 *
 * SPDX-FileCopyrightText: 2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

module.exports = {
  port: 5500,
  root: '.',
  open: '/index.html',

  ignore: ['dist', 'node_modules', '.git', '.github'],

  middleware: [
    (req, res, next) => {
      const url = req.url.split('?')[0].toLowerCase();

      if (url.endsWith('.js') || url.endsWith('.mjs')) {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      } else if (url.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css; charset=utf-8');
      } else if (url.endsWith('.json') || url.endsWith('.webmanifest')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      } else if (url.endsWith('.svg')) {
        res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      }

      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

      next();
    }
  ]
};
