/* ==========================================================================
 * CueDesk — @cuedesk/net-adapter · qos.ts
 * --------------------------------------------------------------------------
 * Política de calidad de servicio para el tráfico de CueDesk. Todo lo de este
 * fichero es DATO PURO: no ejecuta nada, sólo describe qué hay que marcar y
 * encolar. El driver (@cuedesk/hardware-mt7921) es quien lo lleva al sistema
 * operativo (`iptables`/`nft` + `tc`) y devuelve lo que hizo.
 *
 * Por qué DSCP y no "prioridad Wi-Fi": en Linux, la prioridad del aire la
 * decide el mapeo 802.11e (WMM). El estándar mapea DSCP → acceso WMM en el
 * driver; marcar el paquete en el host (IP_TOS/DSCP) es lo que hace que el
 * driver lo ponga en la cola correcta. Sin marca, todo va a "best effort" y
 * un bloque de telemetría puede retrasar un mute. Ver docs/NETWORK-MT7921.md.
 * ========================================================================== */

import type { QosPolicy, TrafficClass } from "./types.ts";

/* Códigos DSCP (RFC 2474/2597). Se usan nombres estándar, no números mágicos. */
export const DSCP = {
  CS0: 0,     // best effort
  AF11: 10,   // bulk con descarte bajo
  AF41: 34,   // telemetría (streaming interactivo)
  EF: 46,     // control (Expedited Forwarding: la menor latencia)
} as const;

/** Acceso WMM (802.11e) equivalente a cada clase de CueDesk. */
export const WMM_OF: Record<TrafficClass, QosPolicy["wmm"]> = {
  control: "voice",
  telemetry: "video",
  bulk: "best-effort",
  default: "best-effort",
};

/**
 * Política por defecto de CueDesk, alineada con los SLO del blueprint:
 *   · CONTROL  (OSC a consola + WS de control): EF / voice. Nunca se descarta.
 *   · TELEMETRÍA (vúmetros por WS): AF41 / video. Descartable, last-value-wins.
 *   · BULK (escenas, logs, OTA): AF11 / best-effort.
 */
export const DEFAULT_QOS: QosPolicy[] = [
  {
    class: "control",
    dscp: DSCP.EF,
    wmm: WMM_OF.control,
    udpPort: 10023,
    description: "OSC de control a la consola (X32) y WS de control del bridge.",
  },
  {
    class: "telemetry",
    dscp: DSCP.AF41,
    wmm: WMM_OF.telemetry,
    udpPort: null,
    description: "Vúmetros/telemetría del bridge (descartable, last-value-wins).",
  },
  {
    class: "bulk",
    dscp: DSCP.AF11,
    wmm: WMM_OF.bulk,
    udpPort: null,
    description: "Escenas, logs y actualizaciones OTA.",
  },
];

/** DSCP → octeto TOS (IP_TOS = DSCP << 2). */
export function dscpToTos(dscp: number): number {
  return (clampDscp(dscp) << 2) & 0xff;
}

export function clampDscp(dscp: number): number {
  if (!Number.isFinite(dscp)) return 0;
  return Math.max(0, Math.min(63, Math.round(dscp)));
}

/** Una orden de sistema a ejecutar, como dato (para auditar y para el driver). */
export interface SystemCommand {
  cmd: string;
  args: string[];
  /** Requiere privilegios de root (el driver puede simularlas). */
  privileged: boolean;
  note: string;
}

/**
 * Construye el marcado DSCP del tráfico saliente. Es el mecanismo PORTABLE
 * en Linux: `iptables -t mangle ... -j DSCP --set-dscp N`. (Node no expone
 * IP_TOS de forma estándar en `dgram`, así que la marca se hace en el host.)
 *
 * `multicast`/`iface` son opcionales: sin interfaz, la regla es global.
 */
export function buildQosCommands(policy: QosPolicy[], opts?: { iface?: string }): SystemCommand[] {
  const out: SystemCommand[] = [];
  const iface = opts && opts.iface ? opts.iface : null;
  let queued = false;
  for (const p of policy) {
    const dscp = clampDscp(p.dscp);
    if (p.udpPort !== null) {
      const args = ["-t", "mangle", "-A", "OUTPUT", "-p", "udp", "--dport", String(p.udpPort)];
      if (iface) args.push("-o", iface);
      args.push("-j", "DSCP", "--set-dscp", String(dscp));
      out.push({ cmd: "iptables", args, privileged: true, note: p.description });
    }
    /* El encolado egress (WMM-like) es POR INTERFAZ y global: se emite UNA vez,
       no una por clase. */
    if (iface && p.class !== "default" && !queued) {
      queued = true;
      out.push({
        cmd: "tc",
        args: ["qdisc", "replace", "dev", iface, "root", "handle", "1:", "prio", "bands", "4", "priomap", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1"],
        privileged: true,
        note: "Cola egress de 4 bandas (WMM-like) en " + iface,
      });
    }
  }
  return out;
}
