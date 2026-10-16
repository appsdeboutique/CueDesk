/* ==========================================================================
 * CueDesk — @cuedesk/net-adapter · errors.ts
 * --------------------------------------------------------------------------
 * Error con código HTTP para la superficie de red. Igual que `HttpError` del
 * core: el enrutador de la app lo reconoce por «duck typing» (mira `.status`)
 * sin que la red dependa del backend HTTP.
 * ========================================================================== */

export class NetworkError extends Error {
  readonly status: number;
  readonly extra: unknown;

  constructor(status: number, message: string, extra?: unknown) {
    super(message);
    this.name = "NetworkError";
    this.status = status;
    this.extra = extra !== undefined ? extra : null;
  }
}
