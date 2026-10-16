# CueDesk — Subsistema de Red del Appliance (MediaTek MT7921K)

> **Rol:** especificación técnica del módulo de red inalámbrica de CueBox® (contrato + driver + QoS + BLE + frontera con la UI).
> **Fecha:** 2026-10-16 · **Radio objetivo:** MediaTek **MT7921K** M.2 2230 (Wi-Fi 6 · BT 5.2) · **Esquema:** `net v1`.
> **Paquetes:** `@cuedesk/net-adapter` (contrato) · `@cuedesk/hardware-mt7921` (driver).
> **Fuente de verdad:** cuando este documento y el código discrepen, **manda el código** (ficheros citados al pie de cada sección).

---

## 0. Resumen y punto de partida

### 0.1 La decisión: de Intel BE200 a MediaTek MT7921K

El encargo inicial pedía una tarjeta Intel **BE200**. Se **descarta** y se sustituye por la MediaTek **MT7921K**. Motivo técnico, no de gusto:

| Criterio | Intel BE200 (descartada) | MediaTek MT7921K (elegida) |
|---|---|---|
| Interfaz | PCIe (`iwlwifi`) | PCIe 2230 (`mt7921e`, familia `mt76`) |
| Modo AP / SoftAP bajo Linux | Sin soporte práctico con `hostapd` | **Soportado** (el driver `mt76` lo anuncia en `Supported interface modes`) |
| Generación | Wi-Fi 7 (802.11be) | Wi-Fi 6 (802.11ax / HE) |
| MLO (Multi-Link Operation) | Capacidad *de estación*; no de AP | No aplica (MLO es Wi-Fi 7) |
| Bluetooth | BT 5.4, subsistema aparte | BT 5.2, subsistema aparte (`btusb`/`btmtk`) |
| Encaje en CueBox® | La Pi no puede *servir* AP con ella | La Pi **sí** puede servir el SSID a las tablets |

La consecuencia de diseño es importante: CueBox® es sobre todo un **punto de acceso** que sirve el SSID del recinto a las tablets de mezcla. La BE200 no permitía eso; la MT7921K sí.

### 0.2 Reconciliación con el encargo

Siguiendo la convención del repositorio (documentar la **implementación real**, no la premisa del encargo), se corrigen aquí las afirmaciones del brief que no resisten el contraste con la realidad del hardware y del código:

| Premisa del encargo | Realidad documentada | Dónde |
|---|---|---|
| «Wi-Fi 7 con MLO» | Es **Wi-Fi 6**: `mlo.supported` es siempre `false`; el campo MLO se conserva en el contrato como *forward-compatible* para una futura radio Wi-Fi 7 | §2.2, §10 |
| «Radio Intel BE200» | Radio MediaTek MT7921K (`mt7921e`) | §0.1 |
| «Estado de red como texto libre en la UI» | DTOs **tipados** (`NetworkSnapshot`) con unidades de dominio; la UI sólo pinta | §2, §7 |
| «Selección de banda como control de UI» | `setBand` es **best-effort** y de backend; en modo AP la banda la gobierna `hostapd` | §5 |
| «BLE como pila GATT completa» | Envoltorio **mínimo** sobre `bluetoothctl` (lectura + conexión); sin D-Bus nativo | §6 |
| «Prioridad Wi-Fi configurable desde la interfaz» | La política **QoS vive en el backend** (DSCP→WMM); la UI no la edita | §4, §7 |

### 0.3 Qué es exactamente la MT7921K, en términos del sistema

| Atributo | Valor real | Cómo lo ve CueDesk |
|---|---|---|
| Netdev típico | `wlan0` | `WifiInterface.name` |
| Driver de kernel | `mt7921e` (variante PCIe; `mt7921u` es la USB) | `WifiInterface.driver` |
| Vendor / modelo | MediaTek / MT7921K | `vendor`, `model` |
| Bandas | 2,4 + 5 GHz (doble banda; **no** 6 GHz) | `bands: ["2.4","5"]` |
| PHY | 802.11ax (HE) → **Wi-Fi 6** | `generation: "Wi-Fi 6"` |
| Modo AP | Soportado (`hostapd`) | `apSupported: true` |
| Bluetooth | 5.2, USB aparte (`btusb`/`btmtk` + BlueZ) | `bluetooth.version: "5.2"` |
| MLO | No existe en Wi-Fi 6 | `mlo: { supported:false, active:false, links:[] }` |

> El driver no puede distinguir por software una MT7921 de una MT7921K (comparten `mt7921e`); el nombre comercial se publica desde configuración (`model`, por defecto `"MT7921K"`).

---

## 1. Dónde vive el módulo

Se aplica el **mismo patrón que la consola** (`@cuedesk/console-adapter` + `@cuedesk/console-x32`): un **contrato hardware-agnóstico** y un **driver por radio**. Así el día que cambie la tarjeta, sólo se reescribe el driver; el contrato y la UI no se tocan.

```
                        ┌───────────────────────────────────────────────┐
   UI (js/network.js)   │  SÓLO lee GET /api/network y pinta            │
        ▲               └───────────────────────────────────────────────┘
        │  JSON (DTOs tipados)                     ▲  frontera HTTP
        │                                          │  mountNetworkRoutes()
   ┌────┴──────────────────────────────────────────┴───────────────────┐
   │  apps/cuebox · router.js  (enrutador de la app)                    │
   └────┬───────────────────────────────────────────────┬──────────────┘
        │  NetworkAdapter (interfaz)                     │
   ┌────┴───────────────────────┐          ┌─────────────┴───────────────┐
   │ @cuedesk/net-adapter       │  usa     │ @cuedesk/hardware-mt7921    │
   │  · types.ts   (DTOs)       │ ◄────────│  · Mt7921Adapter.ts         │
   │  · adapter.ts (contrato)   │          │  · parsers.ts   (iw/ip/…)   │
   │  · qos.ts     (DSCP/WMM)   │          │  · bluetooth.ts (BlueZ)     │
   │  · errors.ts  · api.ts     │          │  · SimNetwork.ts (demo/CI)  │
   └────────────────────────────┘          └─────────────┬───────────────┘
                                                          │ CommandRunner (inyectado)
                                                          ▼
                                              iw · ip · ethtool · tc/iptables · bluetoothctl
```

Regla de oro: **el único sitio del sistema que conoce `mt7921e`, `phy0` o «Band 4» es el driver.** Hacia arriba todo habla en dominio (bandas `"2.4"|"5"|"6"`, dBm, Mbps, ms).

| Capa | Fichero | Responsabilidad |
|---|---|---|
| Contrato | `packages/net-adapter/src/types.ts` | DTOs de dominio |
| Contrato | `packages/net-adapter/src/adapter.ts` | Interfaz `NetworkAdapter` |
| Contrato | `packages/net-adapter/src/qos.ts` | Política DSCP/WMM + construcción de órdenes |
| Contrato | `packages/net-adapter/src/api.ts` | Rutas HTTP (`mountNetworkRoutes`) |
| Driver | `packages/hardware-mt7921/src/Mt7921Adapter.ts` | Implementación real |
| Driver | `packages/hardware-mt7921/src/parsers.ts` | Traducción pura `iw`/`ip`/`ethtool` |
| Driver | `packages/hardware-mt7921/src/bluetooth.ts` | Envoltorio BlueZ |
| Driver | `packages/hardware-mt7921/src/SimNetwork.ts` | Driver simulado (Windows/CI/demo) |

---

## 2. El contrato: `@cuedesk/net-adapter`

### 2.1 La interfaz `NetworkAdapter`

```ts
export interface NetworkAdapter {
  readonly id: string;              // "mt7921" | "sim"
  readonly simulated: boolean;      // honestidad: ¿es hardware real?

  start(): Promise<void>;           // descubre la radio (no destructivo)
  stop(): Promise<void>;

  collect(): Promise<NetworkSnapshot>;          // foto de sólo lectura
  setBand(iface: string, band: WifiBand): Promise<void>;   // best-effort
  applyQos(policy: QosPolicy[]): Promise<QosResult>;       // devuelve lo que hizo
  status(): Record<string, unknown>;            // diagnóstico para /api/network/status

  readonly bluetooth: BluetoothService;         // segundo subsistema del combo
}
```

### 2.2 DTOs (resumen; tipos completos en `types.ts`)

```ts
export type WifiBand = "2.4" | "5" | "6";
export type WifiRole = "ap" | "station";
export type WifiGeneration = "Wi-Fi 4" | "Wi-Fi 5" | "Wi-Fi 6" | "Wi-Fi 6E" | "Wi-Fi 7";
export type LinkQuality = "excellent" | "good" | "fair" | "poor" | "dead";
export type NetStatus = "up" | "degraded" | "down" | "absent";

export interface NetworkSnapshot {
  at: number;
  source: { id: string; simulated: boolean };   // ← la UI NUNCA confunde real con demo
  interfaces: WifiInterface[];
  health: NetworkHealth;
  qos: QosPolicy[];
  bluetooth: BluetoothSummary;
}
```

`WifiInterface` (por radio) publica: `name`, `driver`, `vendor`, `model`, `mac`, `phy`, `role`, `up`, `bands`, **`generation`**, **`apSupported`**, `mlo` (`{supported,active,links}`), `link` (la BSS observada o servida) y **`stations`** (clientes asociados al AP).

`NetworkHealth` agrega: `status`, `rssiDbm`, `snrDb`, `latencyMs`, `jitterMs`, `packetLossPct`, `mloActive`, `bands` y **`clients`** (nº de clientes del AP).

> **`mlo` en Wi-Fi 6.** El campo existe por contrato, pero una MT7921K siempre lo publica `supported:false / active:false / links:[]`. No es un olvido: es la representación honesta de que MLO es una capacidad de Wi-Fi 7 (802.11be) y esta radio no la tiene.

### 2.3 Frontera HTTP

| Método | Ruta | Devuelve | Valida |
|---|---|---|---|
| `GET` | `/api/network` | `NetworkSnapshot` completo | — |
| `GET` | `/api/network/status` | diagnóstico del driver | — |
| `GET` | `/api/network/bluetooth` | `BluetoothSummary` | — |
| `POST` | `/api/network/band` | `status()` tras aplicar | `iface` presente; `band ∈ {"2.4","5","6"}` |
| `POST` | `/api/network/qos` | `QosResult` | `policy`, si viene, debe ser array |

---

## 3. El driver: `@cuedesk/hardware-mt7921`

Sin dependencias nativas: habla con las **utilidades estándar de Linux** a través de un `CommandRunner` **inyectado** (en pruebas, un doble sin shell; ver §9).

| Fuente | Orden | Se traduce a |
|---|---|---|
| Lista de interfaces | `iw dev` | `WifiInterface.name`, `phy`, `mac`, `type` |
| Driver | `ethtool -i <if>` | `driver` (⇒ `vendor`/`model` si es `mt79*`) |
| Estado del netdev | `ip -o link show <if>` | `up`, `mac` |
| Enlace (estación) | `iw dev <if> link` | `link.*` (SSID, BSSID, banda, canal, señal, tasas) |
| Capacidades del PHY | `iw phy <phy> info` | `bands`, `generation`, `apSupported` |
| Clientes (modo AP) | `iw dev <if> station dump` | `stations[]` |
| Bluetooth | `bluetoothctl` | `BluetoothSummary` |

Los **parsers son puros** (reciben texto, devuelven dominio) y absorben la fragilidad de formato. Detalle deliberado: `iw dev <if> link` imprime `signal: -42 dBm`, pero `station dump` imprime `signal:  -42 [-45, -48] dBm`; un **único** patrón tolerante lee ambos.

`Mt7921Adapter`:
- `id = "mt7921"`, `simulated = false`.
- `role` por defecto `"ap"` (CueBox® sirve el SSID); con `"station"` se une a la red del recinto.
- Si `iw` no existe (p. ej. Windows) no revienta: `status()` reporta `available:false` y la foto sale como `"absent"`.

`SimNetwork` (`id = "sim"`, `simulated = true`) implementa el mismo contrato con datos sintéticos (banda 5 GHz, 3 clientes, 2 periféricos BT). Es la prueba viva de que el contrato aguanta sin tocar la interfaz.

---

## 4. QoS para OSC y WebSocket

### 4.1 Por qué DSCP y no «prioridad Wi-Fi»

En Linux la prioridad del aire la decide el mapeo **802.11e (WMM)** del driver a partir del **DSCP** del paquete (campo de servicio IP). Marcar el paquete en el host es lo que hace que `mt76` lo ponga en la cola correcta. Sin marca, todo va a *best effort* y un bloque de telemetría puede retrasar un `mute`.

### 4.2 Política de CueDesk

| Clase | Tráfico | DSCP | Code point | Cola WMM | Puerto |
|---|---|---|---|---|---|
| `control` | OSC de control (fader/mute) | 46 | **EF** (Expedited Forwarding) | `voice` | UDP 10023 |
| `telemetry` | vúmetros / estado | 34 | **AF41** | `video` | — |
| `bulk` | escenas, ficheros | 10 | **AF11** | `best-effort` | — |
| `default` | resto | 0 | CS0 | `best-effort` | — |

### 4.3 Órdenes que genera el backend

```
iptables -t mangle -A OUTPUT -p udp --dport 10023 -o wlan0 -j DSCP --set-dscp 46
tc qdisc replace dev wlan0 root handle 1: prio bands 4 priomap 1 1 1 1 …
```

`buildQosCommands()` es **dato puro**: no ejecuta nada; describe qué marcar y encolar. El driver lo lleva al sistema y devuelve `QosResult { applied, commands, errors }` para que el operador pueda **auditar** lo que se hizo. El encolado es **por interfaz y global**: se emite **una** vez, no una por clase.

---

## 5. Modo AP y modo estación

```
   MODO AP (por defecto)                      MODO ESTACIÓN
   ┌──────────┐   SSID del recinto            ┌──────────┐
   │  CueBox® │ ◄──── tablets ────┐           │  CueBox® │ ─── red del recinto
   │  (AP)    │                  │           │ (station)│      (switch/router)
   └────┬─────┘                  │           └────┬─────┘
        │  iw dev wlan0 station dump        │  iw dev wlan0 link
        ▼                                   ▼
   stations[] (por cliente):              link: SSID, BSSID, banda,
   mac · banda · señal · tasas ·          canal, señal, tasas
   tiempo conectado · calidad
```

- En **AP**, `link.connected` refleja que el netdev está `up`, y el interés está en `stations[]` y en `health.clients`. Un AP **sin clientes sigue `up`**: no depende de una asociación propia.
- En **estación**, `health.status` pasa a `degraded` si la calidad cae a `poor`/`dead`, y `down` si no hay enlace.
- **`setBand` es best-effort.** En estación hace `iw dev <if> set freq <MHz>`; en AP la banda la gobierna `hostapd` (su `hw_mode`/`channel`), así que el intento se registra pero no debe esperarse que surta efecto.

---

## 6. Bluetooth 5.2 (envoltorio mínimo)

`bluetooth.ts` envuelve **`bluetoothctl`** (BlueZ) sin D-Bus nativo. Alcance **honesto**: lectura + conexión básica, **no** una pila GATT completa.

| Operación | Orden | Uso |
|---|---|---|
| Disponibilidad | `bluetoothctl --version` | `available` |
| Estado | `bluetoothctl show` | `powered`, `adapter`, `version` |
| Periféricos | `bluetoothctl devices` + `devices Connected/Paired` | `devices[]` |
| Descubrimiento | `bluetoothctl --timeout N scan on` | `scan()` |
| Conexión | `bluetoothctl connect/disconnect <addr>` | `connect()` / `disconnect()` |

Sin controlador o sin BlueZ el servicio se declara `available:false` y **no rompe nada**. Casos de uso previstos: mandos de escena, sondas de diagnóstico, etiquetas de inventario.

---

## 7. Frontera estricta con la UI

> **Regla:** `js/network.js` **sólo** lee `GET /api/network` y **pinta**. No habla con `iw`, ni con BlueZ, ni con el kernel: todo lo que muestra viene ya interpretado por el backend.

- La telemetría se renderiza como **filas de sólo lectura** (`span`, no `input`) dentro de la tarjeta «CueBox® & Network» de Setup: no compite con los controles ni puede escribir en la red.
- La pastilla de estado (`up`/`degraded`/`down`/`absent`) la **decide el backend** vía `health.status`; la UI no recalcula calidad a partir de la señal.
- Si el servidor arranca con `--no-net` (endpoint ausente) el módulo **calla**; si los datos son de demostración, el rótulo añade «· demo» porque `source.simulated` viaja en la foto.

---

## 8. Operación

### 8.1 Arranque

```
node server.js [--port 8765] [--console <ip>] [--no-gg] [--net <iface|sim>] [--no-net]
```

| Flag | Efecto |
|---|---|
| *(ninguno)* | Red **real** en Linux (con `iw`); **simulada** en cualquier otro sistema (desarrollo/CI) |
| `--net sim` | Fuerza el driver simulado |
| `--net wlan0` | Fuerza la interfaz del driver real |
| `--no-net` | Desactiva el subsistema y sus rutas |

Al arrancar se registra el estado de la red:

```
  Red         : MT7921K real, iface wlan0      (o)   MT7921K SIMULADO (demo/CI)
  API red     : http://127.0.0.1:8765/api/network
```

### 8.2 Requisitos en el appliance (Linux)

| Requisito | Comprobación | Nota |
|---|---|---|
| Driver `mt7921e` cargado | `lsmod \| grep mt7921e` · `ethtool -i wlan0` | familia `mt76` |
| Utilidades | `command -v iw ip ethtool tc iptables` | `bluetoothctl` opcional |
| AP | `iw phy phy0 info` incluye `AP` en *Supported interface modes* | `hostapd` para servir el SSID |
| Permisos | `CAP_NET_ADMIN` para `tc`/`iptables` | el appliance corre como servicio |

### 8.3 Diagnóstico rápido

| Síntoma | Mirada | Causa probable |
|---|---|---|
| `health.status: "absent"` | `status().available` | falta `iw` o no hay radio (¿Windows?) |
| `apSupported: false` | `iw phy <phy> info` | modo AP no anunciado por el firmware/driver |
| `stations: []` con clientes reales | `iw dev wlan0 station dump` | `hostapd` no levantó el AP |
| `applyQos.applied: false` | `QosResult.errors` | sin `CAP_NET_ADMIN` o `iptables`/`tc` ausentes |

---

## 9. Pruebas

Ejecutar: `npm test` (workspaces del monorepo).

| Fichero | Qué fija |
|---|---|
| `packages/hardware-mt7921/test/parsers.test.ts` | Fixtures reales de `iw`/`ip`/`ethtool`: Wi-Fi 6, 2,4+5 GHz, modo AP, `signal:` con corchetes, `Not connected` |
| `packages/hardware-mt7921/test/adapter.test.ts` | Modo AP con clientes · modo estación · `present`/`absent` · `setBand` · `applyQos` — con ejecutor **falso**, sin shell |
| `packages/net-adapter/test/qos.test.ts` | Code points DSCP, mapeo WMM, marca de OSC (EF/10023), encolado **único** |
| `packages/net-adapter/test/api.test.ts` | Frontera HTTP: foto, validación de banda/política, delegación al driver |

---

## 10. Límites conocidos y hoja de ruta

| Límite | Estado | Nota |
|---|---|---|
| MLO | **No aplica** (Wi-Fi 6) | El campo se conserva para una futura radio Wi-Fi 7 |
| 6 GHz | **No soportada** por la MT7921K | `bands` real: `["2.4","5"]` |
| Cambio de banda en AP | Best-effort | lo gobierna `hostapd` |
| BLE | Envoltorio mínimo | sólo lectura + conexión; sin GATT completo |
| `vendor`/`model` | Desde configuración | el driver `mt7921e` no distingue MT7921 de MT7921K |
| Latencia/jitter del aire | `null` en la foto | requieren sondas activas; hoy sólo se miden en el plano de la app |

**Siguiente paso sugerido:** sonda de latencia/jitter por `ping` al cliente AP o al gateway (rellenaría `health.latencyMs`/`jitterMs` con datos reales en lugar de `null`), y un `hostapd` gestionado por el backend para que CueBox® levante el AP sin intervención manual.
