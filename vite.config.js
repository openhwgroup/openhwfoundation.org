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
 * Unified Hugo + Vite plugin. Handles both dev (proxy to Hugo dev server)
 * and build (run Hugo, then let Vite process HTML in-place).
 *
 * @param {{
 *   outDir?: string,
 *   hugoUrl?: string,
 *   sources?: string[],
 *   baseUrl?: string,
 * }} options
 *   outDir      – Hugo's output directory, relative to Vite root (default: 'public').
 *                 Hugo must have already built into this directory before `vite build`.
 *   hugoUrl     – Hugo dev server origin (default: 'http://localhost:1313')
 *   sources     – dirs to symlink into outDir so Vite can resolve imports
 *                 (also used to derive the dev proxy ignore list)
 *   baseUrl     – prepended to canonical/alternate href to prevent Vite asset errors
 */
function hugo({
  outDir = "public",
  hugoUrl = "http://localhost:1313",
  sources = ["node_modules"],
  baseUrl = "",
} = {}) {
  let viteRoot;
  let absOutDir;
  const wsUrl = hugoUrl.replace(/^http/, "ws") + "/livereload";

  // URL prefixes Vite must handle itself during dev:
  // - /@  → Vite internals (HMR, modules, etc.)
  // - sources dirs → served by Vite with transforms
  const ignore = ["/@", ...sources.map((d) => `/${d}/`)];

  return [
    // --- Dev: proxy to Hugo ---
    {
      name: "vite-plugin-hugo-proxy",
      apply: "serve",

      configureServer(server) {
        const connectToHugoLR = () => {
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
          ws.addEventListener("close", () =>
            setTimeout(connectToHugoLR, 1000),
          );
          ws.addEventListener("error", () => ws.close());
        };
        connectToHugoLR();

        server.middlewares.use(async (req, res, next) => {
          if (ignore.some((p) => req.url.startsWith(p))) return next();

          const url = `${hugoUrl}${req.url}`;

          if (req.headers.accept?.includes("text/html")) {
            try {
              const r = await fetch(url);
              if (!r.ok) return next();
              let html = await r.text();
              html = html.replace(
                /<script\s+src="\/livereload\.js[^"]*"[^>]*><\/script>/gi,
                "",
              );
              html = await server.transformIndexHtml(req.url, html);
              res.writeHead(200, { "Content-Type": "text/html" });
              return res.end(html);
            } catch {
              res.writeHead(502, { "Content-Type": "text/html" });
              return res.end("<h1>502 – Hugo not reachable</h1>");
            }
          }

          try {
            const r = await fetch(url);
            if (r.ok) {
              const ct = r.headers.get("content-type");
              if (ct) res.setHeader("Content-Type", ct);
              res.writeHead(200);
              return res.end(Buffer.from(await r.arrayBuffer()));
            }
          } catch {}

          next();
        });
      },
    },

    // --- Build: process Hugo output ---
    {
      name: "vite-plugin-hugo-build",
      apply: "build",

      config(userConfig) {
        viteRoot = userConfig.root || process.cwd();
        absOutDir = path.resolve(viteRoot, outDir);

        if (!fs.existsSync(absOutDir)) {
          throw new Error(
            `Hugo output directory "${absOutDir}" not found. ` +
            `Run hugo before vite build.`,
          );
        }

        for (const name of sources) {
          const link = path.join(absOutDir, name);
          if (!fs.existsSync(link)) {
            fs.symlinkSync(path.join(viteRoot, name), link);
          }
        }

        const htmlFiles = [];
        walkDir(absOutDir, (f) => {
          if (f.endsWith(".html"))
            htmlFiles.push(path.relative(absOutDir, f));
        });

        const input = Object.fromEntries(
          htmlFiles.map((f) => [
            f.replace(/\.html$/, "").replaceAll("/", "_") || "index",
            path.join(absOutDir, f),
          ]),
        );

        return {
          root: absOutDir,
          build: {
            outDir: absOutDir,
            emptyOutDir: false,
            rollupOptions: { input },
          },
        };
      },

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

      closeBundle() {
        for (const name of sources) {
          fs.rmSync(path.join(absOutDir, name), {
            recursive: true,
            force: true,
          });
        }
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

  publicDir: false,
  build: { outDir: "public" },
});
