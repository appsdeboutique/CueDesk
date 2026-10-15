"use strict";

/* ==========================================================================
 * CueDesk — backend/http/router.js
 * --------------------------------------------------------------------------
 * Enrutador mínimo del backend (cero dependencias).
 *
 * El servidor estático de server.js no tenía enrutador: una comparación de
 * cadena y a servir ficheros. Con la llegada del módulo GainGuard hacía falta
 * un sitio donde colgar rutas de API sin ensuciar el manejador de ficheros,
 * así que aquí está: una tabla de rutas con parámetros (`:id`), lectura de
 * cuerpo JSON y respuestas JSON. Nada más.
 *
 *   const router = createRouter();
 *   router.get("/api/gainguard", () => gg.status());
 *   router.post("/api/gainguard/channels/:id", (ctx) => gg.setChannel(...));
 *
 *   if (await router.handle(req, res)) return;   // atendido
 * ========================================================================== */

/** Error con código HTTP para cortar desde un handler. */
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.extra = extra || null;
  }
}

const MAX_BODY = 256 * 1024;   // 256 KB: de sobra para configuración

function toRegex(pattern) {
  const parts = pattern.split("/").filter(function (p) { return p !== ""; });
  let re = "^";
  parts.forEach(function (part) {
    if (part.startsWith(":")) re += "/([^/]+)";
    else re += "/" + part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(re + "/?$");
}

function paramNames(pattern) {
  return pattern
    .split("/")
    .filter(function (p) { return p.startsWith(":"); })
    .map(function (p) { return p.slice(1); });
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Cuerpo demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", function () {
      if (!chunks.length) return resolve(null);
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch (_) {
        reject(new HttpError(400, "JSON no válido"));
      }
    });
  });
}

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  const text = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    routes.push({
      method: method,
      pattern: pattern,
      handler: handler,
      re: toRegex(pattern),
      params: paramNames(pattern),
    });
    return routes[routes.length - 1];
  }

  const router = {
    get: function (p, h) { return add("GET", p, h); },
    post: function (p, h) { return add("POST", p, h); },
    put: function (p, h) { return add("PUT", p, h); },
    patch: function (p, h) { return add("PATCH", p, h); },
    delete: function (p, h) { return add("DELETE", p, h); },

    routes: function () {
      return routes.map(function (r) { return r.method + " " + r.pattern; });
    },

    /** @returns {{handler:Function, params:object, route:object}|null} */
    match: function (method, pathname) {
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.params.forEach(function (name, idx) { params[name] = decodeURIComponent(m[idx + 1]); });
        return { handler: r.handler, params: params, route: r };
      }
      return null;
    },

    /**
     * Atiende la petición si hay ruta. Nunca lanza: devuelve false si no
     * encaja (para que server.js siga con los ficheros estáticos).
     */
    handle: async function (req, res) {
      let url;
      try {
        url = new URL(req.url || "/", "http://127.0.0.1");
      } catch (_) {
        return false;
      }
      const hit = router.match(req.method, url.pathname);
      if (!hit) return false;

      try {
        const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
        const out = await hit.handler({
          req: req,
          res: res,
          url: url,
          query: url.searchParams,
          params: hit.params,
          body: body,
        });
        if (out !== undefined) sendJson(res, 200, out);
        else if (!res.writableEnded) sendJson(res, 204, null);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        const payload = { error: err && err.message ? err.message : "error interno" };
        if (err && err.extra) payload.detail = err.extra;
        sendJson(res, status, payload);
      }
      return true;
    },
  };

  return router;
}

module.exports = { createRouter, HttpError, sendJson, readBody };
