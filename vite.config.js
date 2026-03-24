import { defineConfig } from 'vite';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const resolve = (...segments) => path.resolve(import.meta.dirname, ...segments);

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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export default defineConfig(({ command }) => ({
  plugins: [mustachePlugin(), hugoProxyPlugin()],

  // In production, assets live under /dist/ (Hugo copies static/dist → public/dist).
  // In dev, the Vite dev server serves from root.
  base: command === 'build' ? '/dist/' : '/',

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
  // public/ and we don't want it duplicated into static/dist/ on build.
  publicDir: false,

  build: {
    outDir: 'static/dist',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: {
        main:   resolve('js/vite-entry.js'),
        styles: resolve('less/styles.less'),
      },
    },
  },
}));
