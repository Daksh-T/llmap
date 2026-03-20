/**
 * Local dev server — mimics Vercel routing
 * Run: bun dev.ts [port]
 *
 * Routes:
 *   /api/legacies  → api/legacies.ts handler
 *   /*             → public/ static files
 */

import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import handler from "./api/legacies.ts";

const PORT = Number(process.argv[2]) || 3001;
const PUBLIC = join(import.meta.dir, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff2":"font/woff2",
};

Bun.serve({
  port: PORT,
  idleTimeout: 120, // seconds — API paginates multiple upstream requests

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── API route ──────────────────────────────────────────
    if (path === "/api/legacies") {
      try {
        return await handler.fetch(req);
      } catch (err) {
        console.error("[api] error:", err);
        return new Response(JSON.stringify({ error: "API error" }), {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // ── Static files ───────────────────────────────────────
    // Clean URLs: strip trailing slash, try .html fallback
    let filePath = join(PUBLIC, path);

    // Resolve index.html for directory-like paths
    if (path === "/" || path === "") {
      filePath = join(PUBLIC, "index.html");
    }

    try {
      const info = await stat(filePath);
      if (info.isDirectory()) {
        filePath = join(filePath, "index.html");
      }
    } catch {
      // Try appending .html (clean URLs)
      try {
        await stat(filePath + ".html");
        filePath = filePath + ".html";
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }

    try {
      const body = await readFile(filePath);
      const ext  = extname(filePath);
      const mime = MIME[ext] ?? "application/octet-stream";
      return new Response(body, { headers: { "content-type": mime } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
});

console.log(`\n  ◆ Locating Legacies Atlas — dev server`);
console.log(`  ◆ http://localhost:${PORT}\n`);
