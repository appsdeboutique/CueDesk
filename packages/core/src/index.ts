/* ==========================================================================
 * CueDesk — @cuedesk/core
 * --------------------------------------------------------------------------
 * El motor de CueDesk, agnóstico de hardware: GainGuard, Stage Guard,
 * PreGuard y BusGuard. Habla exclusivamente con `ConsoleAdapter`.
 *
 *   const engine = new GainGuardEngine({ adapter });
 *   engine.addChannel("ch.01");
 *   engine.start();
 * ========================================================================== */

export * from "./types.ts";
export * from "./types/pa-alignment.ts";
export * from "./types/scene.ts";
export * from "./utils/acoustics.ts";
export * from "./guards.ts";
export * from "./httpError.ts";
export { GainGuardEngine } from "./gainGuardEngine.ts";
export type { EngineOptions, EmitRecord, IngestResult } from "./gainGuardEngine.ts";
export * from "./analysis/rmsAnalyzer.ts";
export * from "./analysis/lufsAnalyzer.ts";
export { mountSuiteRoutes } from "./api.ts";
