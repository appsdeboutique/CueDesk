/* ==========================================================================
 * CueDesk — @cuedesk/hardware-mt7921 · runner.ts
 * --------------------------------------------------------------------------
 * Ejecutor de órdenes de sistema (iw, ip, ethtool, tc, iptables, bluetoothctl).
 * Se INJECTA en el driver: así las pruebas corren sin shell y el driver puede
 * sustituirse por un doble en el desarrollo.
 *
 * Contrato: `run` NUNCA lanza. Devuelve `code`, `stdout` y `stderr`; si el
 * binario no existe (p. ej. `iw` en Windows) devuelve 127 y el driver lo
 * traduce a "no disponible" en vez de romper.
 * ========================================================================== */

import { execFile } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<CommandResult>;
}

/** Código reservado para "el binario no existe / no es ejecutable". */
export const COMMAND_NOT_FOUND = 127;

export function createExecRunner(defaultTimeoutMs = 4000): CommandRunner {
  return {
    run(cmd: string, args: string[], opts?: { timeoutMs?: number }): Promise<CommandResult> {
      const timeout = opts && opts.timeoutMs !== undefined ? opts.timeoutMs : defaultTimeoutMs;
      return new Promise<CommandResult>(function (resolve) {
        execFile(
          cmd,
          args,
          { timeout: timeout, maxBuffer: 1024 * 1024, windowsHide: true },
          function (err: any, stdout: string, stderr: string) {
            let code = 0;
            if (err) code = typeof err.code === "number" ? err.code : COMMAND_NOT_FOUND;
            resolve({
              code: code,
              stdout: stdout || "",
              stderr: stderr || "",
              error: err ? String(err.message || err) : undefined,
            });
          },
        );
      });
    },
  };
}
