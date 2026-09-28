/*!
 * @file        .github/scripts/build.js
 * @description Production build.
 *              Bundles the ES module graph with esbuild and writes one
 *              self-contained index.html, with the script, the stylesheets and
 *              the icon inlined. The CSP admits that script by its hash, so the
 *              build writes the hash into the shipped .htaccess.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/LaserCutCards}
 *
 * SPDX-FileCopyrightText: 2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    html: 'index.html',
    entry: 'src/app.js',

    // Files shipped beside the page. Anything not named here stays out, so
    // repository tooling and generated context files cannot ship by accident.
    include: ['.htaccess', 'LICENSE']
};

const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const BUILD_ID = (() => {
    if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
    try {
        return require('child_process')
            .execFileSync('git', ['rev-parse', '--short', 'HEAD'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .trim();
    } catch { return 'local'; }
})();

// ============================================================================
// UTILITIES
// ============================================================================

const log = (msg) => console.log(`[build] ${msg}`);

const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`;

/* A rewrite that stops matching would ship a page pointing at a file that is
not there, so a failed match is fatal rather than ignored. Replacements are
functions, so a `$&` or `$'` in inlined code is not read as a pattern. */
function mustReplace(content, pattern, replacement, what) {
    const out = content.replace(pattern, replacement);
    if (out === content) throw new Error(`${what}: pattern did not match`);
    return out;
}

function banner() {
    return [
        '<!--!',
        `  Laser Cut Cards - build ${BUILD_ID}`,
        '  Copyright (C) 2026 Eltryus - Ricardo Marques',
        '  Source: https://github.com/RicardoJCMarques/LaserCutCards',
        '  SPDX-License-Identifier: AGPL-3.0-or-later',
        '-->'
    ].join('\n');
}

// ============================================================================
// STEPS
// ============================================================================

function bundleJs(esbuild, srcDir, minify) {
    const entry = path.join(srcDir, CONFIG.entry);
    if (!fs.existsSync(entry)) throw new Error(`entry not found: ${CONFIG.entry}`);

    // A classic script, so the page also runs from file://. The source runs as
    // modules, which are strict; the directive keeps the bundle strict too.
    const { outputFiles } = esbuild.buildSync({
        entryPoints: [entry],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: ['es2020'],
        minify,
        legalComments: 'none',
        banner: { js: '"use strict";' },
        write: false
    });

    const js = outputFiles[0].text;
    if (/<\/script/i.test(js)) throw new Error('the bundle contains "</script", which would end the inline script early');
    return js;
}

function inlineStyles(esbuild, html, htmlDir, minify) {
    const linkRe = /[ \t]*<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>\r?\n?/gi;
    const links = [...html.matchAll(linkRe)];
    if (!links.length) throw new Error('no <link rel="stylesheet"> found');

    let css = '';
    for (const [tag, href] of links) {
        const file = path.resolve(htmlDir, href);
        if (!fs.existsSync(file)) throw new Error(`stylesheet not found: ${href}`);
        css += `${fs.readFileSync(file, 'utf8').trim()}\n`;
        html = html.replace(tag, '');
    }
    if (minify) css = esbuild.transformSync(css, { loader: 'css', minify: true }).code;

    html = mustReplace(html, '</head>', () => `<style>\n${css}</style>\n</head>`, 'inline css');
    return { html, css };
}

function inlineIcon(html, htmlDir) {
    const iconRe = /(<link[^>]*rel=["']icon["'][^>]*href=["'])([^"']+)(["'])/i;
    return mustReplace(html, iconRe, (match, open, href, close) => {
        const file = path.resolve(htmlDir, href);
        const type = MIME[path.extname(file).toLowerCase()];
        if (!type || !fs.existsSync(file)) throw new Error(`icon cannot be inlined: ${href}`);
        return `${open}data:${type};base64,${fs.readFileSync(file).toString('base64')}${close}`;
    }, 'inline icon');
}

function inlineScript(html, js) {
    const scriptRe = /<script[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/i;
    const script = html.match(scriptRe);
    if (!script) throw new Error('no <script src> found');
    if (script[1].replace(/^\.\//, '') !== CONFIG.entry) {
        throw new Error(`expected <script src="${CONFIG.entry}">, found "${script[1]}"`);
    }
    return html.replace(script[0], () => `<script>${js}</script>`);
}

/* The CSP loads no script by address, only the inline one by its hash. The
hash covers every byte between <script> and </script>, so anything that
alters the page after the build - a minifier, an FTP transfer in ASCII mode
- blocks the script. */
function pinScript(distDir, js) {
    const file = path.join(distDir, '.htaccess');
    const hash = crypto.createHash('sha256').update(js, 'utf8').digest('base64');
    const conf = mustReplace(fs.readFileSync(file, 'utf8'), "script-src 'self'",
        () => `script-src 'sha256-${hash}'`, 'csp script hash');
    fs.writeFileSync(file, conf);
}

/* Every local reference left in the page must resolve inside dist. */
function verify(distDir) {
    const html = fs.readFileSync(path.join(distDir, CONFIG.html), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

    const missing = [];
    for (const [, ref] of html.matchAll(/(?:src|href)\s*=\s*["']([^"'>]+)["']/gi)) {
        const target = ref.split(/[?#]/)[0];
        if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
        if (!fs.existsSync(path.resolve(distDir, target))) missing.push(ref);
    }
    if (missing.length) throw new Error(`${CONFIG.html} references missing file(s): ${missing.join(', ')}`);
}

// ============================================================================
// CLI
// ============================================================================

function main() {
    const args = process.argv.slice(2);
    let srcDir = '.';
    let distDir = './dist';
    let minify = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--src' && args[i + 1]) srcDir = args[++i];
        else if (args[i] === '--dist' && args[i + 1]) distDir = args[++i];
        else if (args[i] === '--minify') minify = true;
        else if (args[i] === '--help' || args[i] === '-h') {
            console.log(`
Laser Cut Cards build

Usage: node .github/scripts/build.js [options]

Options:
    --minify        Minify the script and the stylesheets (deployment)
    --src <dir>     Source directory (default: .)
    --dist <dir>    Output directory (default: ./dist)
    --help, -h      Show this help

Needs esbuild: npm install
`);
            return;
        }
    }

    const htmlPath = path.join(srcDir, CONFIG.html);
    if (!fs.existsSync(htmlPath)) throw new Error(`no ${CONFIG.html} in '${srcDir}'`);

    let esbuild;
    try {
        esbuild = require('esbuild');
    } catch {
        throw new Error('bundling needs esbuild: run npm install');
    }

    log(`Building ${BUILD_ID}${minify ? ' (minified)' : ''}`);

    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });
    for (const rel of CONFIG.include) {
        const from = path.join(srcDir, rel);
        if (!fs.existsSync(from)) throw new Error(`${rel} not found in '${srcDir}'`);
        fs.copyFileSync(from, path.join(distDir, rel));
    }

    const htmlDir = path.dirname(htmlPath);
    const js = bundleJs(esbuild, srcDir, minify);
    const styled = inlineStyles(esbuild, fs.readFileSync(htmlPath, 'utf8'), htmlDir, minify);
    let html = inlineIcon(styled.html, htmlDir);
    html = inlineScript(html, js);
    html = mustReplace(html, /<!doctype html>/i, (doctype) => `${doctype}\n${banner()}`, 'html banner');

    fs.writeFileSync(path.join(distDir, CONFIG.html), html);
    pinScript(distDir, js);
    verify(distDir);

    log('');
    log('Build complete');
    log(`  Script:  ${kb(js)}`);
    log(`  Styles:  ${kb(styled.css)}`);
    log(`  Page:    ${kb(html)}`);
    log(`  Files:   ${fs.readdirSync(distDir).sort().join(', ')}`);
}

try {
    main();
} catch (err) {
    console.error(`[build] ${err.message}`);
    process.exit(1);
}