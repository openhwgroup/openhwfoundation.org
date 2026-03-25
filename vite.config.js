import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

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
 * Vite plugin that transforms .mustache files into ES modules.
 *
 * .partial.mustache → raw string export
 * .mustache         → callable function via Hogan.js
 *
 * @param {{ importPath?: string }} options
 *   importPath – the Hogan.js import specifier (default: 'hogan.js')
 */
function mustachePlugin({ importPath = "hogan.js" } = {}) {
  return {
    name: "vite-plugin-mustache",
    transform(src, id) {
      if (!id.endsWith(".mustache")) return null;

      if (id.endsWith(".partial.mustache")) {
        return { code: `export default ${JSON.stringify(src)};`, map: null };
      }

      return {
        code: [
          `import Hogan from ${JSON.stringify(importPath)};`,
          `var t = Hogan.compile(${JSON.stringify(src)});`,
          `export default function() { return t.render.apply(t, arguments); };`,
        ].join("\n"),
        map: null,
      };
    },
  };
}

/**
 * Hugo + Vite integration plugin.
 *
 * Dev:   Proxies requests to Hugo's dev server and relays its livereload
 *        events through Vite's HMR so Hugo content changes trigger a
 *        browser refresh.
 *
 * Build: Expects Hugo to have already built into `hugoOutDir` (e.g. .hugo/).
 *        Vite reads the HTML from there, bundles JS/CSS imports, and writes
 *        the final result to its own `build.outDir` (e.g. public/).
 *
 * @param {{
 *   hugoOutDir?: string,
 *   hugoUrl?: string,
 *   sources?: string[],
 *   baseUrl?: string,
 * }} options
 */
function hugo({
  hugoOutDir = ".hugo",
  hugoUrl = "http://localhost:1313",
  sources = ["node_modules"],
  baseUrl = "",
} = {}) {
  let viteRoot, absHugoDir, absOutDir;

  // Requests matching these prefixes stay in Vite (not proxied to Hugo)
  const viteOwned = ["/@", ...sources.map((d) => `/${d}/`)];

  return [
    // ── Dev: proxy to Hugo ────────────────────────────────────────────
    {
      name: "vite-plugin-hugo-proxy",
      apply: "serve",

      configureServer(server) {
        // Relay Hugo's livereload events through Vite's HMR WebSocket.
        // Auto-reconnects if Hugo restarts.
        const wsUrl = hugoUrl.replace(/^http/, "ws") + "/livereload";
        function connectToHugoLR() {
          const ws = new WebSocket(wsUrl);
          ws.addEventListener("open", () => {
            ws.send(
              JSON.stringify({
                command: "hello",
                protocols: ["http://livereload.com/protocols/official-7"],
              }),
            );
          });
          ws.addEventListener("message", (event) => {
            try {
              if (JSON.parse(event.data).command === "reload") {
                server.ws.send({ type: "full-reload" });
              }
            } catch {}
          });
          ws.addEventListener("close", () => setTimeout(connectToHugoLR, 1000));
          ws.addEventListener("error", () => ws.close());
        }
        connectToHugoLR();

        // Proxy everything to Hugo except Vite-owned paths.
        // HTML goes through Vite's transform pipeline for HMR injection.
        server.middlewares.use(async (req, res, next) => {
          if (viteOwned.some((p) => req.url.startsWith(p))) return next();

          const isHTML = req.headers.accept?.includes("text/html");

          try {
            const r = await fetch(`${hugoUrl}${req.url}`);
            if (!r.ok) return next();

            if (isHTML) {
              let html = await r.text();
              // Strip Hugo's livereload script — Vite handles reloading now
              html = html.replace(
                /<script\s+src="\/livereload\.js[^"]*"[^>]*><\/script>/gi,
                "",
              );
              html = await server.transformIndexHtml(req.url, html);
              res.writeHead(200, { "Content-Type": "text/html" });
              return res.end(html);
            }

            const ct = r.headers.get("content-type");
            if (ct) res.setHeader("Content-Type", ct);
            res.writeHead(200);
            return res.end(Buffer.from(await r.arrayBuffer()));
          } catch {
            if (isHTML) {
              res.writeHead(502, { "Content-Type": "text/html" });
              return res.end("<h1>502 – Hugo not reachable</h1>");
            }
            next();
          }
        });
      },
    },

    // ── Build: process Hugo's pre-built output ────────────────────────
    {
      name: "vite-plugin-hugo-build",
      apply: "build",

      config(userConfig) {
        viteRoot = userConfig.root || process.cwd();
        absHugoDir = path.resolve(viteRoot, hugoOutDir);
        absOutDir = path.resolve(viteRoot, userConfig.build?.outDir || "dist");

        if (!fs.existsSync(absHugoDir)) {
          throw new Error(
            `Hugo output "${absHugoDir}" not found. ` +
              `Run hugo before vite build.`,
          );
        }

        // Symlink source dirs (js/, node_modules/, etc.) into Hugo's output
        // so Vite can resolve the imports referenced in Hugo's HTML.
        for (const name of sources) {
          const link = path.join(absHugoDir, name);
          if (!fs.existsSync(link)) {
            fs.symlinkSync(path.join(viteRoot, name), link);
          }
        }

        // Discover all HTML files Hugo generated (walkDir skips symlinks,
        // so the source dirs we just linked won't be scanned).
        const htmlFiles = [];
        walkDir(absHugoDir, (f) => {
          if (f.endsWith(".html")) htmlFiles.push(path.relative(absHugoDir, f));
        });

        const input = Object.fromEntries(
          htmlFiles.map((f) => [
            f.replace(/\.html$/, "").replaceAll("/", "_") || "index",
            path.join(absHugoDir, f),
          ]),
        );

        // We change root to Hugo's output, so publicDir must be re-resolved
        // back to the project root to keep Vite's static-file copy working.
        const userPublicDir = userConfig.publicDir;
        const publicDir =
          userPublicDir === false
            ? false
            : path.resolve(viteRoot, userPublicDir || "public");

        return {
          root: absHugoDir,
          publicDir,
          build: {
            outDir: absOutDir,
            // We handle cleanup ourselves in buildStart — Vite must NOT
            // empty outDir or it would delete our pre-copied Hugo files.
            emptyOutDir: false,
            rollupOptions: { input },
          },
        };
      },

      // Copy Hugo's generated files (HTML, sitemap, RSS, images…) into
      // Vite's outDir. Vite will overwrite the HTML with processed versions.
      // Symlinked source dirs are skipped — they're not part of the output.
      buildStart() {
        fs.rmSync(absOutDir, { recursive: true, force: true });
        fs.mkdirSync(absOutDir, { recursive: true });
        for (const entry of fs.readdirSync(absHugoDir, {
          withFileTypes: true,
        })) {
          if (entry.isSymbolicLink()) continue;
          fs.cpSync(
            path.join(absHugoDir, entry.name),
            path.join(absOutDir, entry.name),
            { recursive: true },
          );
        }
      },

      // Absolutize canonical/alternate <link> hrefs so Vite doesn't try
      // to resolve them as local file paths (which would fail).
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          if (!baseUrl) return html;
          return html.replaceAll(/<link\s[^>]*>/gi, (tag) => {
            if (!/rel=(?:"|)(?:canonical|alternate)(?:"|)/i.test(tag))
              return tag;
            return tag.replace(
              /(href=(?:"|))(\/[^">\s]*)/,
              (_, pre, url) => pre + baseUrl + url,
            );
          });
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

const rel = (...segments) => path.resolve(import.meta.dirname, ...segments);

const configToml = fs.readFileSync(rel("config.toml"), "utf-8");
const baseUrlMatch = configToml.match(/^baseurl\s*=\s*"([^"]+)"/im);
const baseUrl = baseUrlMatch?.[1]?.replace(/\/$/, "") || "";

export default defineConfig({
  plugins: [
    mustachePlugin(),
    hugo({
      baseUrl,
      // Dirs containing source files that Hugo's HTML references via
      // <script>/<link> tags. They are symlinked into Hugo's output so
      // Vite can resolve and bundle them, and excluded from the Hugo
      // proxy during dev so Vite serves them with transforms instead.
      sources: ["js", "less", "node_modules"],
    }),
  ],

  define: { "process.env": "{}" },

  resolve: {
    alias: [{ find: /^~/, replacement: "" }],
  },

  css: {
    preprocessorOptions: {
      less: {
        math: "always",
        modifyVars: {
          "fa-font-path": `"${rel("node_modules/@fortawesome/fontawesome-free/webfonts")}"`,
          "icon-font-path": `"${rel("node_modules/bootstrap/fonts")}/"`,
        },
      },
    },
  },

  optimizeDeps: {
    exclude: ["eclipsefdn-solstice-assets"],
    include: [
      "jquery",
      "bootstrap",
      "cookieconsent",
      "element-closest-polyfill",
      "ellipsize",
      "feather-icons",
      "hogan.js",
      "isomorphic-fetch",
      "jquery-match-height",
      "mustache",
      "numeral",
      "owl.carousel",
      "parse-link-header",
    ],
  },

  publicDir: "static",
  build: { outDir: "public" },
});
