import { defineConfig, type Connect, type Plugin, type ViteDevServer } from "vite";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively walk a directory, skipping symlinks. */
function walkDir(dir: string, callback: (filePath: string) => void): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full, callback);
    else callback(full);
  }
}

/**
 * Relay Hugo's livereload events through Vite's HMR WebSocket.
 * Auto-reconnects when Hugo restarts.
 */
function relayHugoLivereload(
  hugoUrl: string,
  viteWs: ViteDevServer["ws"],
): void {
  const wsUrl = hugoUrl.replace(/^http/, "ws") + "/livereload";

  function connect(): void {
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
        if (JSON.parse(event.data as string).command === "reload") {
          viteWs.send({ type: "full-reload" });
        }
      } catch {}
    });
    ws.addEventListener("close", () => setTimeout(connect, 1000));
    ws.addEventListener("error", () => {});
  }

  connect();
}

/**
 * Symlink directories from the project root into Hugo's output
 * so Vite can resolve the imports referenced in Hugo's HTML.
 */
function symlinkSources(
  sources: string[],
  viteRoot: string,
  absHugoDir: string,
): void {
  for (const name of sources) {
    const link = path.join(absHugoDir, name);
    if (!fs.existsSync(link)) {
      fs.symlinkSync(path.join(viteRoot, name), link);
    }
  }
}

/**
 * Discover all HTML files Hugo generated.
 * Returns a Rollup `input` object mapping entry names to absolute paths.
 * walkDir skips symlinks, so symlinked source dirs won't be scanned.
 */
function discoverHtmlEntries(
  absHugoDir: string,
): Record<string, string> {
  const htmlFiles: string[] = [];
  walkDir(absHugoDir, (f) => {
    if (f.endsWith(".html")) htmlFiles.push(path.relative(absHugoDir, f));
  });

  return Object.fromEntries(
    htmlFiles.map((f) => [
      f.replace(/\.html$/, "").replaceAll("/", "_") || "index",
      path.join(absHugoDir, f),
    ]),
  );
}

/**
 * Re-resolve publicDir to an absolute path.
 * Needed because the plugin changes root to Hugo's output dir,
 * which would break Vite's relative resolution of publicDir.
 */
function resolvePublicDir(
  userPublicDir: string | false | undefined,
  viteRoot: string,
): string | false {
  if (userPublicDir === false) return false;
  return path.resolve(viteRoot, userPublicDir || "public");
}

/**
 * Copy Hugo's generated files (HTML, sitemap, RSS, images…) into outDir.
 * Vite will overwrite the HTML with processed versions.
 * Symlinked source dirs are skipped — they're not part of the output.
 */
function syncHugoOutput(absHugoDir: string, absOutDir: string): void {
  fs.rmSync(absOutDir, { recursive: true, force: true });
  fs.mkdirSync(absOutDir, { recursive: true });
  for (const entry of fs.readdirSync(absHugoDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    fs.cpSync(
      path.join(absHugoDir, entry.name),
      path.join(absOutDir, entry.name),
      { recursive: true },
    );
  }
}

/**
 * Absolutize canonical/alternate <link> hrefs so Vite doesn't try
 * to resolve them as local file paths (which would fail).
 */
function absolutizeLinkHrefs(html: string, baseUrl: string): string {
  return html.replaceAll(/<link\s[^>]*>/gi, (tag) => {
    if (!/rel=(?:"|)(?:canonical|alternate)(?:"|)/i.test(tag)) return tag;
    return tag.replace(
      /(href=(?:"|))(\/[^">\s]*)/,
      (_, pre: string, url: string) => pre + baseUrl + url,
    );
  });
}

/**
 * Proxy a request to Hugo's dev server.
 * HTML responses have Hugo's livereload script stripped and are piped
 * through Vite's transform pipeline for HMR injection.
 * Non-HTML responses are forwarded as-is.
 */
async function proxyToHugo(
  req: Connect.IncomingMessage,
  res: ServerResponse,
  next: Connect.NextFunction,
  { hugoUrl, server }: { hugoUrl: string; server: ViteDevServer },
): Promise<void> {
  const isHTML = req.headers.accept?.includes("text/html");

  try {
    const r = await fetch(`${hugoUrl}${req.url}`);
    if (!r.ok) return next();

    if (isHTML) {
      let html = await r.text();
      // Strip Hugo's livereload script — Vite handles reloading now
      html = html.replaceAll(
        /<script\s+src="\/livereload\.js[^"]*"[^>]*><\/script>/gi,
        "",
      );
      html = await server.transformIndexHtml(req.url ?? "/", html);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    const ct = r.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.writeHead(200);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    if (isHTML) {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<h1>502 – Hugo not reachable</h1>");
      return;
    }
    next();
  }
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

interface MustachePluginOptions {
  importPath?: string;
}

/**
 * Vite plugin that transforms .mustache files into ES modules.
 *
 * .partial.mustache → raw string export
 * .mustache         → callable function via Hogan.js
 */
function mustachePlugin({ importPath = "hogan.js" }: MustachePluginOptions = {}): Plugin {
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

interface HugoPluginOptions {
  hugoOutDir?: string;
  hugoUrl?: string;
  sources?: string[];
  baseUrl?: string;
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
 */
function hugo({
  hugoOutDir = ".hugo",
  hugoUrl = "http://localhost:1313",
  sources = ["node_modules"],
  baseUrl = "",
}: HugoPluginOptions = {}): Plugin[] {
  let viteRoot: string;
  let absHugoDir: string;
  let absOutDir: string;

  // Requests matching these prefixes stay in Vite (not proxied to Hugo)
  const viteOwned = ["/@", ...sources.map((d) => `/${d}/`)];

  return [
    // ── Dev: proxy to Hugo ────────────────────────────────────────────
    {
      name: "vite-plugin-hugo-proxy",
      apply: "serve",

      configureServer(server) {
        relayHugoLivereload(hugoUrl, server.ws);

        server.middlewares.use(async (req, res, next) => {
          if (viteOwned.some((p) => req.url!.startsWith(p))) return next();
          return proxyToHugo(req, res, next, { hugoUrl, server });
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

        symlinkSources(sources, viteRoot, absHugoDir);

        return {
          root: absHugoDir,
          publicDir: resolvePublicDir(userConfig.publicDir, viteRoot),
          build: {
            outDir: absOutDir,
            // We handle cleanup ourselves in buildStart — Vite must NOT
            // empty outDir or it would delete our pre-copied Hugo files.
            emptyOutDir: false,
            rollupOptions: { input: discoverHtmlEntries(absHugoDir) },
          },
        };
      },

      buildStart() {
        syncHugoOutput(absHugoDir, absOutDir);
      },

      transformIndexHtml: {
        order: "pre",
        handler(html) {
          if (!baseUrl) return html;
          return absolutizeLinkHrefs(html, baseUrl);
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

const rel = (...segments: string[]) =>
  path.resolve(import.meta.dirname, ...segments);

const hugoConfig = parseToml(fs.readFileSync(rel("config.toml"), "utf-8"));
const baseUrl =
  (hugoConfig.baseurl as string | undefined)?.replace(/\/$/, "") || "";

export default defineConfig({
  plugins: [
    mustachePlugin(),
    hugo({
      hugoOutDir: rel(".hugo"),
      baseUrl,
      // Dirs containing source files that Hugo's HTML references via
      // <script>/<link> tags. They are symlinked into Hugo's output so
      // Vite can resolve and bundle them, and excluded from the Hugo
      // proxy during dev so Vite serves them with transforms instead.
      sources: ["js", "less", "node_modules"],
    }),
  ],

  // Hugo static folder has been disabled in favor of Vite's publicDir
  publicDir: "static",

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

  build: { outDir: "public" },
});
