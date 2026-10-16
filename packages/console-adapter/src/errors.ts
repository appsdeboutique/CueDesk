/* ==========================================================================
 * CueDesk — @cuedesk/console-adapter · errors.ts
 * --------------------------------------------------------------------------
 * Error de dominio de un driver. Nunca lleva la sintaxis del protocolo: si
 * algo falla, quien lo lee sabe qué operación de negocio no se pudo hacer.
 * ========================================================================== */

export type AdapterErrorCode =
  | "bad-channel"
  | "bad-bank"
  | "bad-argument"
  | "not-connected"
  | "unsupported";

export class ConsoleAdapterError extends Error {
  code: AdapterErrorCode;

  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = "ConsoleAdapterError";
    this.code = code;
  }
}
