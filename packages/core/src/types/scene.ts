/* ==========================================================================
 * CueDesk — @cuedesk/core · types/scene.ts
 * --------------------------------------------------------------------------
 * Contrato de escena para el enrutamiento y la alineación de PA (v1.0.28).
 *
 * `ActiveRoute` es la fila viva de Outputs tal y como se persiste: la salida
 * lógica, la fuente que la alimenta, su slot User Out, el modo de toma y —si
 * existe— el procesado de su zona de altavoz. Es deliberadamente PLANO: el
 * JSON de escena se lee y se escribe sin ceremonia, y un equipo sin PA deja
 * `speakerZone` fuera sin romper nada.
 *
 * Los enteros `source`, `userOut` y `mode` son los valores de los enums OSC
 * (`/outputs/main/NN/src`, `/config/userrout/out/NN` y `/outputs/main/NN/pos`);
 * el core no los interpreta, sólo los conserva.
 * ========================================================================== */

import type { SpeakerZoneProcessing } from "./pa-alignment.ts";

/** Una salida lógica con su enrutamiento y, opcionalmente, su zona de PA. */
export interface ActiveRoute {
  /** Salida lógica 1-16. */
  outputId: number;
  /** Fuente de la salida (enum `/outputs/main/NN/src`). */
  source: number;
  /** Slot User Out 1-16 asociado (enum `/config/userrout/out/NN`). */
  userOut?: number;
  /** Modo de toma (enum `/outputs/main/NN/pos`). */
  mode?: number;
  /**
   * Alineación de la zona de altavoz. Ausente = salida sin procesado de PA.
   * Opcional para que las escenas anteriores a v1.0.28 sigan cargando.
   */
  speakerZone?: SpeakerZoneProcessing;
}

/**
 * Bloque de escena que este módulo posee. Una escena completa lo compondrá
 * con el resto de bloques (inputs, preamps…) sin tocar este contrato.
 */
export interface SceneRouting {
  routes: ActiveRoute[];
}
