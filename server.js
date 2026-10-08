"use strict";

/* ==========================================================================
 * CueDesk — servidor estático local (Node.js, cero dependencias)
 * --------------------------------------------------------------------------
 *  Arranque doble : doble clic en  CueDesk_Mixer.bat
 *  Arranque manual: node server.js [--port 8765]
 *
 *  Sirve exactamente esta misma carpeta (index.html, css/, js/, assets/)
 *  sobre 127.0.0.1 para que la app corra con el mismo origen que en la
 *  Raspberry Pi: evita las restricciones de file:// y deja el puerto
 *  listo para el puente WebSocket de la consola.
 *
 *  Si el puerto ya está ocupado (la app ya se está sirviendo) termina con
 *  código 0 y sin tocar nada, para que el lanzador abra el navegador igual.
 * ========================================================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

const argv = process.argv.slice(2);
const argPort = argv.indexOf("--port");
const PORT =
  argPort !== -1 && argv[argPort + 1]
    ? Number.parseInt(argv[argPort + 1], 10)
    : Number.parseInt(process.env.PORT || "8765", 10);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^[/\\]+/, "");
  const file = path.resolve(ROOT, rel);

  // Sin salida de la raíz del proyecto (path traversal)
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden");
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found: " + rel);
      return;
    }

    const etag = '"' + stat.size + "-" + Number(stat.mtimeMs).toString(36) + '"';
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag }).end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      ETag: etag,
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });

    const stream = fs.createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("[CueDesk] Puerto " + PORT + " ya en uso: la app ya se esta sirviendo.");
    process.exit(0);
  }
  console.error("[CueDesk] Error del servidor: " + err.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[CueDesk] Servidor local listo");
  console.log("  Vista mixer : http://127.0.0.1:" + PORT + "/?view=mixer");
  console.log("  Carpeta     : " + ROOT);
  console.log("  Detener     : Ctrl+C (o cerrar esta ventana)");
});
