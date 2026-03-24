import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const projectRoot = import.meta.dirname;
const resolve = (...segments) => path.resolve(projectRoot, ...segments);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively walk a directory, skipping symlinks. */
function walkDir(dir, callback) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, callback);
    else callback(full);
  }
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * Replicate the eclipsefdn-solstice-assets custom webpack mustache loader.
 * .partial.mustache → raw string export
 * .mustache         → callable function that compiles & renders via Hogan.js
 *
 * Matches the original loader (build/transform-mustache.js) which defers
 * Hogan.compile() to module-evaluation time in the browser, then returns a
 * callable `(...args) => compiled.render(...args)`.
 */
function mustachePlugin() {
  return {
    name: 'vite-plugin-mustache',
    transform(src, id) {
      if (!id.endsWith('.mustache')) return null;

      if (id.endsWith('.partial.mustache')) {
        return { code: `export default ${JSON.stringify(src)};`, map: null };
      }

      return {
        code: [
          `import Hogan from 'hogan.js';`,
          `var t = Hogan.compile(${JSON.stringify(src)});`,
          `export default function() { return t.render.apply(t, arguments); };`,
        ].join('\n'),
        map: null,
      };
    },
  };
}

/**
 * Proxy HTML requests to a running Hugo dev server (localhost:1313) so Vite
 * can inject its HMR client. Non-HTML assets (fonts, images …) are also
 * proxied as a fallback when Vite doesn't serve them itself.
 */
function hugoProxyPlugin() {
  const HUGO = 'http://localhost:1313';
  const VITE_OWNED = [
    '/@', '/src/', '/node_modules/', '/js/', '/less/',
  ];

  return {
    name: 'hugo-html-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (VITE_OWNED.some((p) => req.url.startsWith(p))) return next();

        const url = `${HUGO}${req.url}`;

        // HTML → fetch from Hugo, strip its livereload, let Vite inject HMR
        if (req.headers.accept?.includes('text/html')) {
          try {
            const r = await fetch(url);
            if (!r.ok) return next();
            let html = await r.text();
            html = html.replace(/<script\s+src="\/livereload\.js[^"]*"[^>]*><\/script>/gi, '');
            html = await server.transformIndexHtml(req.url, html);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(html);
          } catch {
            res.writeHead(502, { 'Content-Type': 'text/html' });
            return res.end('<h1>502 – Hugo not reachable</h1><p>Run <code>yarn hugo:dev</code> first.</p>');
          }
        }

        // Everything else → try Hugo, then fall through to Vite
        try {
          const r = await fetch(url);
          if (r.ok) {
            const ct = r.headers.get('content-type');
            if (ct) res.setHeader('Content-Type', ct);
            res.writeHead(200);
            return res.end(Buffer.from(await r.arrayBuffer()));
          }
        } catch { /* Hugo not running */ }

        next();
      });
    },
  };
}

/**
 * Build-only plugin: runs Hugo, then feeds its HTML output to Vite as MPA
 * entry points so the full Vite ecosystem (asset hashing, modulepreload,
 * image optimisation plugins, etc.) applies to the final site.
 */
function hugoBuildPlugin() {
  let tmpDir;
  let baseUrl;

  return {
    name: 'vite-plugin-hugo-build',
    apply: 'build',

    config() {
      // Read the baseurl from Hugo config so we can absolutize URLs below
      const configToml = fs.readFileSync(resolve('config.toml'), 'utf-8');
      const match = configToml.match(/^baseurl\s*=\s*"([^"]+)"/im);
      baseUrl = match?.[1]?.replace(/\/$/, '') || '';

      // 1. Build Hugo site to a temp directory
      tmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'hugo-vite-')),
      );
      execFileSync('hugo', ['--minify', '--destination', tmpDir], {
        cwd: projectRoot,
        stdio: 'inherit',
      });

      // 2. Symlink source dirs so Vite can resolve imports from the HTML
      for (const name of ['js', 'less', 'node_modules']) {
        const link = path.join(tmpDir, name);
        if (!fs.existsSync(link)) {
          fs.symlinkSync(path.join(projectRoot, name), link);
        }
      }

      // 3. Discover all HTML files as MPA entry points
      const htmlFiles = [];
      walkDir(tmpDir, (f) => {
        if (f.endsWith('.html')) htmlFiles.push(path.relative(tmpDir, f));
      });

      const input = Object.fromEntries(
        htmlFiles.map((f) => [
          f.replace(/\.html$/, '').replaceAll('/', '_') || 'index',
          path.join(tmpDir, f),
        ]),
      );

      // 4. Clean the output directory (outDir is outside root, so Vite
      //    won't empty it automatically)
      const outDir = resolve('public');
      fs.rmSync(outDir, { recursive: true, force: true });

      return {
        root: tmpDir,
        build: {
          outDir,
          emptyOutDir: false,
          rollupOptions: { input },
        },
      };
    },

    // Make canonical and alternate link URLs absolute to prevent Vite from
    // trying to read directory-pointing URLs (e.g. href="/") as asset files.
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html.replace(/<link\s[^>]*>/gi, (tag) => {
          if (!/rel=(?:"|)(?:canonical|alternate)(?:"|)/i.test(tag)) return tag;
          return tag.replace(
            /(href=(?:"|))(\/[^">\s]*)/,
            (_, pre, url) => pre + baseUrl + url,
          );
        });
      },
    },

    writeBundle() {
      // Copy non-HTML static assets (images, fonts, XML, etc.) from
      // Hugo's output to the final directory. HTML files are already
      // processed by Vite's build pipeline.
      const outDir = resolve('public');
      walkDir(tmpDir, (f) => {
        if (f.endsWith('.html')) return;
        const rel = path.relative(tmpDir, f);
        const dest = path.join(outDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(f, dest);
      });
    },

    closeBundle() {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export default defineConfig({
  plugins: [mustachePlugin(), hugoProxyPlugin(), hugoBuildPlugin()],

  // Shim Node globals used by CJS deps (parse-link-header reads process.env)
  define: { 'process.env': '{}' },

  resolve: {
    // LESS files use the webpack `~` prefix for bare imports
    alias: [{ find: /^~/, replacement: '' }],
  },

  css: {
    preprocessorOptions: {
      less: {
        math: 'always',
        modifyVars: {
          'fa-font-path':  `"${resolve('node_modules/@fortawesome/fontawesome-free/webfonts')}"`,
          'icon-font-path': `"${resolve('node_modules/bootstrap/fonts')}/"`,
        },
      },
    },
  },

  // eclipsefdn-solstice-assets must be excluded (it contains .mustache files
  // that need the custom plugin), but that hides all its CJS deps from Vite's
  // automatic dependency discovery — so we list them explicitly.
  optimizeDeps: {
    exclude: ['eclipsefdn-solstice-assets'],
    include: [
      'jquery',
      'bootstrap',
      'cookieconsent',
      'element-closest-polyfill',
      'ellipsize',
      'feather-icons',
      'hogan.js',
      'isomorphic-fetch',
      'jquery-match-height',
      'mustache',
      'numeral',
      'owl.carousel',
      'parse-link-header',
    ],
  },

  // Disable Vite's default public directory copying — Hugo's output lives in
  // public/ and we don't want it served as static files in dev.
  publicDir: false,

  // Used by `vite preview` to know where the build output lives.
  // During `vite build`, the hugoBuildPlugin overrides this with an absolute path.
  build: {
    outDir: 'public',
  },
});
