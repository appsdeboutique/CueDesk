/* ==========================================================================
 * CueDesk — @cuedesk/core · httpError.ts
 * --------------------------------------------------------------------------
 * Error con código HTTP para cortar desde un handler de la API.
 *
 * Vive en el core (y no en el enrutador) para que la superficie de la suite
 * pueda lanzarlo sin depender del backend HTTP. El enrutador lo reconoce por
 * «duck typing» (mira `.status`), no por `instanceof`: así el core y el
 * enrutador no se conocen.
 * ========================================================================== */

export class HttpError extends Error {
  readonly status: number;
  readonly extra: unknown;

  constructor(status: number, message: string, extra?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.extra = extra !== undefined ? extra : null;
  }
}
