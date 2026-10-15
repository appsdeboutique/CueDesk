"use strict";

/* ==========================================================================
 * CueDesk — servidor local (Node.js, cero dependencias)
 * --------------------------------------------------------------------------
 *  Arranque doble : doble clic en  CueDesk_Mixer.bat
 *  Arranque manual: node server.js [--port 8765] [--console <ip>] [--no-gg]
 *
 *  Sirve exactamente esta misma carpeta (index.html, css/, js/, assets/)
 *  sobre 127.0.0.1 para que la app corra con el mismo origen que en la
 *  Raspberry Pi: evita las restricciones de file:// y deja el puerto
 *  listo para el puente WebSocket de la consola.
 *
 *  Backend: motor OSC (backend/osc) + suite GainGuard (backend/suite, TypeScript
 *  que Node ejecuta directamente) + enrutador de API (backend/http).
 *
 *  Si el puerto ya está ocupado (la app ya se está sirviendo) termina con
 *  código 0 y sin tocar nada, para que el lanzador abra el navegador igual.
 * ========================================================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");
const dgram = require("dgram");

const oscEngine = require("./backend/osc/oscEngine");
const { createRouter } = require("./backend/http/router");

const ROOT = __dirname;

const CONSOLE_IP_DEFAULT = "192.168.1.10";
const CONSOLE_OSC_PORT = 10023;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Decodificador OSC compartido (backend/osc): sonda y telemetría. */
function parseOscArgs(buf) {
  return oscEngine.parseMessage(buf).args;
}

function probeConsole(ip, timeoutMs) {
  return new Promise(function (resolve) {
    const sock = dgram.createSocket("udp4");
    let done = false;
    const finish = function (result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(result);
    };
    const timer = setTimeout(function () {
      finish({ found: false, ip: ip, reason: "sin respuesta" });
    }, timeoutMs);
    sock.on("error", function (err) {
      finish({ found: false, ip: ip, reason: err.message });
    });
    sock.on("message", function (msg) {
      let args = [];
      try { args = parseOscArgs(msg); } catch (_) {}
      finish({
        found: true,
        ip: ip,
        model: typeof args[1] === "string" ? args[1] : null,
        name: typeof args[2] === "string" ? args[2] : null,
        version: typeof args[3] === "string" ? args[3] : null,
        args: args,
      });
    });
    // "/info" + type tag "," (notación OSC correcta, 8 + 4 bytes)
    const packet = Buffer.from("/info\0\0\0,\0\0\0", "latin1");
    sock.send(packet, CONSOLE_OSC_PORT, ip, function (err) {
      if (err) finish({ found: false, ip: ip, reason: err.message });
    });
  });
}

function handleConsoleProbe(req, res) {
  const query = new URLSearchParams((req.url || "").split("?")[1] || "");
  const ip = query.get("ip") || CONSOLE_IP_DEFAULT;
  const json = function (code, body) {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  if (!IPV4.test(ip)) return json(400, { found: false, ip: ip, reason: "IP no válida" });
  probeConsole(ip, 1500).then(function (result) {
    json(200, result);
  });
}

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
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/* ---------------------------------------------------------------------------
 * Backend: motor OSC + suite GainGuard + enrutador de API
 * ------------------------------------------------------------------------ */

const argConsole = argv.indexOf("--console");
const CONSOLE_IP =
  argConsole !== -1 && argv[argConsole + 1] && IPV4.test(argv[argConsole + 1])
    ? argv[argConsole + 1]
    : null;
const GG_ENABLED = argv.indexOf("--no-gg") === -1;

const router = createRouter();

/** Carga la suite (TypeScript, ESM) y la conecta al motor OSC. Sin consola
 *  (--console <ip>) el motor va en dry-run: misma lógica, sin tocar la red. */
async function startSuite() {
  const core = await import("./backend/suite/gainGuardEngine.ts");
  const api = await import("./backend/suite/api.ts");

  const osc = oscEngine.createOscEngine({
    mode: CONSOLE_IP ? "udp" : "dry-run",
    host: CONSOLE_IP || CONSOLE_IP_DEFAULT,
    port: CONSOLE_OSC_PORT,
    coalesceMs: 0,        // el motor ya pauta sus envíos (tick de 100 ms)
  });

  const engine = new core.GainGuardEngine({
    transport: {
      send: function (msg) {
        osc.send(msg.path, msg.value, "f");
      },
    },
  });
  for (let n = 1; n <= 32; n++) engine.addChannel("ch." + String(n).padStart(2, "0"));

  /* Ecos de la consola: el motor descarta los suyos y toma el resto como cambios. */
  osc.on("/ch/*", function (args, p) { engine.ingestConsole(p, Number(args[0])); });
  osc.on("/headamp/*", function (args, p) { engine.ingestConsole(p, Number(args[0])); });

  /* Telemetría. La correspondencia índice→canal de /meters/1 depende del banco
     de vúmetros activo en la consola; valor por verificar con hardware real.
     El camino fiable es POST /api/gainguard/meters. */
  osc.on("/meters/1", function (args) {
    const list = Array.isArray(args[0]) ? args[0] : args;
    if (list.length !== 32) return;
    list.forEach(function (v, i) {
      const db = Number(Array.isArray(v) ? v[0] : v);
      if (Number.isFinite(db)) engine.ingestLevel("ch." + String(i + 1).padStart(2, "0"), db);
    });
  });

  if (CONSOLE_IP) osc.listen(0);
  api.mountSuiteRoutes(router, engine);
  engine.start();
  return { engine: engine, osc: osc };
}

const server = http.createServer(async (req, res) => {
  // 1) API del backend (suite GainGuard y lo que venga después)
  if (await router.handle(req, res)) return;

  // 2) Sonda de consola
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath === "/api/console") {
    handleConsoleProbe(req, res);
    return;
  }
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

const suiteReady = GG_ENABLED
  ? startSuite().catch(function (err) {
      console.error("[GainGuard] no arranca: " + err.message);
      return null;
    })
  : Promise.resolve(null);

suiteReady.then(function (suite) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log("[CueDesk] Servidor local listo");
    console.log("  Vista mixer : http://127.0.0.1:" + PORT + "/?view=mixer");
    console.log("  GainGuard   : " + (suite
      ? (CONSOLE_IP ? "activo, OSC a " + CONSOLE_IP : "activo, motor OSC en dry-run (sin --console)")
      : "desactivado (--no-gg)"));
    if (suite) console.log("  API         : http://127.0.0.1:" + PORT + "/api/gainguard");
    console.log("  Carpeta     : " + ROOT);
    console.log("  Detener     : Ctrl+C (o cerrar esta ventana)");
  });
});
