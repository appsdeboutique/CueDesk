# CueDesk — Análisis Arquitectónico y Diseño de Capas

> **Rol:** arquitectura de software para sistemas embebidos de audio profesional y protocolos de control.
> **Fecha:** 2026-10-08 · **Esquema propuesto:** `protocol v1` · **Objetivo:** appliance Raspberry Pi + frontend web desacoplado, multi-consola.
>
> **Nota de fuentes:** Mixing Station no publica su código. Lo que se describe de ella es **patrón observable** (comportamiento de la app, protocolos que soporta y formas habituales en este tipo de puentes) y va marcado como *[Inferido]*. Todo lo marcado **[Propio]** es diseño propuesto para CueDesk. Ninguna afirmación de este documento asume APIs internas de terceros.

---

## 0. Punto de partida: dónde está hoy CueDesk

| Preocupación | Fichero actual | Papel hoy | Deuda hacia multi-consola |
|---|---|---|---|
| Conversión fader↔dB (taper X32) | `js/osc.js` → `CueDesk.dB` | utilidades puras | taper incrustado: debe ir al driver |
| Bus de mensajes (pub/sub por ruta) | `js/osc.js` → `CueDesk.OSC` | transporte-agnóstico ✅ | bien: es ya el "canal canónico" |
| Transporte WebSocket JSON | `js/websocketClient.js` | backoff, cola, keepalive | sin dos planos ni snapshot/resync |
| Modelo de tiras/master | `js/mixer.js` → `pathsFor()` | **conoce las rutas X32** ❌ | único punto que rompe el desacoplamiento |
| UI (gestos, DOM, vúmetros) | `js/app.js`, `controls.js`, `meters.js` | agnóstica de red ✅ | — |

**Conclusión del diagnóstico:** el frontend ya está desacoplado de la red (logrado en el último bloque). El siguiente salto es que deje de estar acoplado *al protocolo*: `pathsFor(kind, n)` en `mixer.js` es, literalmente, un driver X32 incrustado en el modelo.

---

## 1. Capa de Abstracción de Hardware (Driver Pattern)

### 1.1 Qué resuelve y cómo lo resuelve Mixing Station *[Inferido]*

El problema de fondo: la misma pantalla debe controlar una X32 (OSC/UDP abierto), una Allen & Heath SQ (TCP con framing propietario), una Yamaha TF/DM o sistemas MIDI. La observación del patrón es:

1. **Modelo universal, traducción periférica.** La UI dibuja siempre el mismo objeto abstracto —*tira* (canal/AUX/FX/bloque/DCA/BUS) con `nivel, mute, solo, nombre, color, pan, sends`— y **jamás** contiene una ruta nativa. Cada marca aporta un traductor en el borde que convierte `canónico ↔ nativo` (OSC, TCP/ASCII, binario, MIDI).
2. **Capacidades explícitas, no pantallas copiadas.** La igualdad visual entre X32 y SQ no viene de duplicar vistas, sino de que ambas alimentan el mismo modelo *y* de que la UI pregunta qué existe: `¿hay pan? ¿cuántos sends? ¿cuántos bancos? ¿cuántos slots FX?` Lo que no existe **no se pinta** en vez de pintarse roto.
3. **La telemetría es un canal aparte** del comando: vúmetros con su propio rate, formato y tolerancia a pérdidas; los comandos de control nunca compiten con 18 medidores por segundo.
4. **Sesión con caché y reconciliación** *[Inferido]*: la app sigue siendo utilizable con el último estado conocido (modo offline) y, al reconectar, se pide *snapshot* y se reaplica delta — nunca se hace un "merge a ciegas".

> Regla de oro: **el transporte, la marca y el formato no son asuntos de la UI.** La UI publica *intención* ("nivel del canal 1 = −6 dB"); un driver traduce esa intención al cable.

### 1.2 Estructura modular propuesta (Node.js / TypeScript, monorepo)

```
cuedesk/
├── packages/
│   ├── protocol/            ← esquema canónico: comandos, paths, validación, versionado
│   │     commands.ts · paths.ts · capabilities.ts · scene.ts (USF) · codec.ts
│   ├── driver-api/          ← contrato que debe cumplir CUALQUIER consola
│   │     driver.ts · transport.ts · events.ts
│   ├── drivers/
│   │   ├── x32/             ← OSC/UDP (taper, /xremote, /meters, polarity table)
│   │   ├── sq/              ← A&H, TCP con framing propio
│   │   ├── tf/              ← Yamaha, TCP/MIDI
│   │   └── fake/            ← consola sintética: demo, pruebas, CI sin hardware
│   ├── core/                ← store normalizado, dirty-set, reconciliación, planner de escenas
│   ├── bridge/              ← servidor WS de la Pi: sesiones, dos planos, backpressure, auth
│   ├── scene/               ← USF: import/export, equivalencias, informe de traducción
│   └── web/                 ← frontend CueDesk (ya existe: index.html + js/*)
├── fixtures/                ← mensajes golden por driver (contract tests por firmware)
└── tools/                   ← sniffers, cargadores de estrés, simulador de consola
```

**Contrato del driver (núcleo del patrón):**

```ts
// packages/driver-api/src/driver.ts
export interface ConsoleDriver {
  readonly meta: { id: string; brand: string; model: string; fw?: string };
  readonly caps: Capabilities;          // QUÉ existe en esta consola
  readonly io: Transport;               // udp | tcp | ws — inyectado, no conocido por el core

  open(cfg: ConnectConfig): Promise<void>;
  close(): Promise<void>;

  /** Salida: intención canónica → trama(s) nativa(s). */
  encode(cmd: Command): NativeFrame[];

  /** Entrada: trama(s) nativa(s) → comando(s) canónicos. */
  decode(frame: NativeFrame): Command[];

  /** Telemetría (vúmetros, CPU, clock) como flujo separado del control. */
  telemetry(): AsyncIterable<TelemetryFrame>;

  /** Ciclo de vida de la sesión remota (keep-alive, snapshot, resync). */
  session(): AsyncIterable<SessionEvent>;   // 'snapshot-needed' | 'stale' | 'resync'
}
```

**Capacidades (lo que la UI usa para decidir qué pintar):**

```ts
export interface Capabilities {
  channels: { count: number; pan: boolean; trim: RangeDb; hp: boolean;
              eq: "6band" | "4band" | "none"; sends: { bus: number; fx: number; prePost: boolean } };
  buses: { count: number; matrix: number };
  dcas: { count: number; assignable: boolean };
  fx: { slots: number; types: FxType[] };
  mains: Array<"st" | "m">;
  scenes: { max: number; macros: boolean };
  meters: { source: string; rateHz: number; format: "osc-block" | "binary" | "ascii" };
}
```

**Esquema de comandos canónico (el "idioma" del sistema):**

```ts
export interface Command {
  v: 1;                          // versión del esquema
  op: "set" | "get" | "sub" | "unsub" | "scene" | "sys";
  path?: string;                 // gramática canónica, NO ruta nativa
  value?: unknown;               // unidades físicas: dB, Hz, ms, ratio, bool
  id?: string;                   // idempotencia → dedup y reintento seguros
  seq?: number;                  // orden por sesión (detectar huecos)
  ts?: number;                   // timestamp del servidor (orden entre clientes)
}
```

**Gramática de path canónica** (independiente de OSC):

```
<capa>.<entidad>.<índice>.<sección>.<parámetro>
ch.01.mix.fader      ch.03.eq.band2.freq      bus.07.sends.ch02.level
dca.1.on             main.st.mix.pan          fx.2.return.level
aux.04.preamp.trim   cfg.ch01.name            sys.meters.rate
```

El **único** sitio donde `ch.01.mix.fader` se convierte en `/ch/01/mix/fader` (X32), `Ch 1 Level` (SQ) o `Ch01 Fader` (TF) es `drivers/<marca>/`.

**Flujo completo:**

```
SALIDA   gesto UI → bus (cuedesk:osc-out) → core (valida + eco optimista + dirty)
           → driver.encode() → UDP/TCP nativo
ENTRADA  UDP/TCP → driver.decode() → Command[] → core (reconcilia contra seq)
           → publicador coalescido → WS {control: JSON} {telemetría: binario} → UI
```

### 1.3 Dónde encaja en el código actual (migración sin reescribir)

| Hoy | Paso 0 (Fase F0) | Estado final |
|---|---|---|
| `mixer.js → pathsFor()` | se mueve a `drivers/x32/paths.ts` | `mixer.js` sólo lee `state.strips` |
| `CueDesk.dB` (taper X32) | pasa a `drivers/x32/taper.ts` | el core ve dB canónicos |
| `muted ? 0 : 1` en botones | `drivers/x32/polarity.ts` | UI emite `mute: true` (bool canónico) |
| `websocketClient.js` | sin cambios de API | transporte puro; el payload lo decide `protocol` |
| `meters.js` (sim) | igual | acepta además `TelemetryFrame` binario |

> **Punto crítico — polaridad:** en un puente multi-consola el bit de mute es la fuente nº 1 de errores (¿`1` = mudo o `1` = activo? varía entre fabricantes e incluso entre firmas). Nuestro proyecto fija por especificación `0 = Mute / 1 = Activo` en X32; eso debe vivir **una sola vez** en `drivers/x32/polarity.ts` y verificarse contra el firmware en F0. La UI y el modelo canónico usan siempre `mute: boolean = true → sin audio`.

### 1.4 Tabla de equivalencia de referencia (canónico → marcas)

| Concepto canónico | X32 (OSC/UDP) | A&H SQ (TCP) | Yamaha TF | Nota |
|---|---|---|---|---|
| `ch.NN.mix.fader` | `/ch/NN/mix/fader` float 0…1 (taper 4 tramos) | nivel en dB (0,1 dB) | nivel en dB | conversión a dB **en el driver** |
| `ch.NN.mix.mute` | `/ch/NN/mix/on` (enum, polaridad a verificar) | bit de mute en trama | bit de mute | bool canónico |
| `ch.NN.mix.pan` | `/ch/NN/mix/pan` −100…100 | −50…50 | −50…50 | canónico normalizado −1…1 |
| `ch.NN.sends.bus.MM` | `/ch/NN/mix/bus/MM/fader` + `type` pre/post | send slot + pre/post | send slot + pre/post | si destino sólo admite `post` → *approximated* |
| `ch.NN.eq` | 6 parámetros/banda (hasta 6 bandas) | 4 bandas PEQ + HPF | 4 bandas PEQ | subconjunto canónico de 4 bandas + HPF |
| `dca.N.*` | `/dca/N/{fader,on}` sin pan | grupos/DCA (modelo distinto) | DCA | capacidad `dcas` |
| `sys.meters` | suscripción `/meters/1` (bloques de float) | stream binario propio | stream propio | normalizado a dB → índice 8 bits |

---

## 2. Sincronización de Estado y Telemetría en Tiempo Real

### 2.1 Problema

Una X32 en modo remoto puede emitir cambios de parámetros continuamente y, si además suscribimos vúmetros, tenemos 18 medidores a 20–30 Hz (540 valores/s) conviviendo con gestos de fader que **no** pueden esperar. El fallo típico es un único canal donde los `mute` se ponen detrás de 4 KB de medidores: el usuario percibe latencia exactamente cuando más importa (durante un arreglo).

### 2.2 Diseño: dos planos con políticas distintas

```
                ┌─────────────────────────────┐
   Comando  ──► │ PLANO CONTROL (JSON)        │  confiable · prioridad alta · nunca se descarta
                │ set/get/sub · seq · id      │  rate bajo (< 50 msg/s por cliente)
                ├─────────────────────────────┤
   Telemetría─► │ PLANO TELEMETRÍA (binario)  │  descartable · last-value-wins · rate fijo/ adaptativo
                │ meters · clock · status     │  30 Hz · 1 byte/medidor
                └─────────────────────────────┘
```

- **Dos sockets WS** (o un multiplexado con byte de canal + colas independientes). Recomendación: dos; así el *parseo* y el *Nagle* de un frame grande nunca retrasan un `mute`.
- **Control en JSON** (legible, versionable, coincide con el formato que ya habemos definido: `{action, address, args}` → evolucionar a `{v, op, path, value, id, seq}`).
- **Telemetría en binario**: `ArrayBuffer` con cabecera fija.

```
byte 0      : tipo (0x01 = meters)
byte 1..4   : seq (u32)
byte 5..8   : ts ms (u32)
byte 9..    : payload — N × i8  (índice de nivel: 0 = −60 dB … 128 = +10 dB, paso 0,5 dB)
```

Cuentas (8 tiras + master L/R = 18 medidores):
* JSON plano hoy: ≈ 300–400 B/frame → 9–12 kB/s a 30 Hz, con `JSON.parse` + GC por frame.
* Binario: 9 + 18 = 27 B/frame → **< 1 kB/s**, cero asignaciones de texto.

### 2.3 Reglas del bridge (servidor de la Pi)

1. **Coalescing por dirección y ventana**: dentro de una ventana de 16–33 ms sólo se envía el **último** valor de cada path (last-value-wins). Un fader arrastrado a 100 Hz genera 1 mensaje/ventana, no 100.
2. **Snapshot + delta + `seq`**: al suscribirse llega el estado completo (`op:"sub"` → respuesta con snapshot); después sólo deltas. Si el cliente detecta hueco en `seq` → pide resync explícito (`op:"get"` masivo).
3. **Cuantización agresiva**: fader a 10 bits (1024 pasos, el mismo grid que X32 → el cliente no puede pedir más resolución de la que existe), pan a 1 %, vúmetros a 0,5 dB, dB de lectura a 0,1 dB.
4. **Fan-out de un solo Buffer**: serializar **una** vez y enviar el mismo `Buffer` a los N clientes (evitar `JSON.stringify` por cliente por mensaje).
5. **Backpressure explícito**: si `bufferedAmount > 256 kB` → descartar frames de telemetría (nunca de control); si supera 2 MB de forma sostenida → cerrar la sesión y forzar resync. Medir y publicar el contador de descartes.
6. **Ventana de vida de los valores**: un fader de hace 8 segundos **no debe aplicarse** al reconectar. Regla: al reconectar se descarta la cola de `set` antiguos salvo los explícitos del usuario, y se sustituye por snapshot.

### 2.4 Keep-alives y reconexión (directo con Wi-Fi saturado)

| Nivel | Mecanismo | Propuesta | Estado en CueDesk |
|---|---|---|---|
| Consola X32 → bridge (UDP) | `/xremote` (modo push) + vida de la sesión OSC | reenviar cada 5 s y **sonda** con `/xinfo`; si no llega telemetría > 2 s → re-suscribir `/meters/1` y pedir snapshot. *Cadencia a validar en banco de pruebas con el firmware real.* | pendiente (driver) |
| Bridge ↔ consola TCP (SQ/TF) | ping de aplicación `seq/ack` + TCP keepalive de SO | timeout 1,5 s × 3 intentos → `SessionEvent 'stale'` | pendiente (driver) |
| Navegador ↔ bridge (WS) | ping/pong de aplicación | **5 s ping / 15 s muerto** en modo directo (hoy 15/35 s: demasiado holgado para directo) | `websocketClient.js` (ajustable) |
| Navegador ↔ red | backoff exponencial con jitter, reintento al volver `online`, cola con dedupe | 600 ms → 30 s con ±25 % jitter; primer reintento inmediato | ✅ implementado |
| **Resync** | al pasar a `online`: pedir snapshot y tirar la cola vieja | **pendiente** — es lo que separa "se reconecta" de "se recupera" | pendiente |

**Adaptación al enlace** (Wi-Fi saturado = RTT errático):
- Medir RTT con el ping de aplicación y *jitter* de la telemetría.
- Umbral `RTT p95 > 100 ms` o `> 3 frames perdidos/s` → bajar telemetría a 15 Hz; si mejora, subir a 30 Hz (solo el bridge decide, los clientes no).
- Reconexiones > 5/min → entrar en "modo directo": eco local inmediato, control en cola con *staleness* marcada en UI (`chip Offline` ya lo tenemos) y prioridad absoluta a `mute/solo/fader` por encima de nombres/colores/escenas.

### 2.5 Consideraciones específicas de la Raspberry Pi

- **Event loop:** nunca parsear/serializar en el hilo principal bajo carga. OSC de entrada en *worker thread* o addon nativo; servidor WS con uWebSockets/Deno si el fan-out crece. Objetivo: bucle < 5 ms en p99.
- **UDP silencioso:** si la telemetría llega por OSC/UDP, el kernel **descarta paquetes sin avisar** si `SO_RCVBUF` es pequeño → ampliar buffer y **contar descartes**; si nadie lo mide, aparece como "vúmetros que traban".
- **Almacenamiento:** logs rotados y en `tmpfs`; la SD se gasta con escrituras constantes de estado.
- **Térmica/CPU:** bajo carga sostenida el Pi hace *throttling* → el primer efecto es latencia de red; vigilar temperatura como métrica de salud del appliance.
- **Wi-Fi 7** reduce RTT pero **no** elimina el solapamiento de canales ni los clientes saturados: el bridge debe ir **cableado** y tratar el Wi-Fi como *enlace no fiable por diseño*, no como excepción.
- **Orden entre clientes:** timestamp del servidor (`ts`) en todo mensaje; el navegador no es reloj fiable.

### 2.6 Estado actual y siguiente paso en código

Ya existe y funciona: throttle de 40 ms en `OSC.send`, **coalescing por dirección en el cliente** (`Map` dedupe), cola al perder enlace, backoff con jitter, keepalive con detección de enlace muerto, LED de estado sincronizado y panel de endpoint dinámico.
**Siguiente paso concreto:** (1) paquete binario de `meters` + `seq`, (2) `op:"sub"` con snapshot y resync al reconectar, (3) `/xremote` dentro del driver X32, (4) ping 5 s/15 s en modo directo.

---

## 3. Estrategia para el Traductor Multi-Plataforma de Escenas (USF)

### 3.1 Principios

1. **Modelo canónico ≠ común denominador pobre.** Se modela lo que las tres marcas comparten *más* una capacidad explícita de lo que cada una aporta de exclusivo. Lo no representado se **declara**, no se pierde en silencio.
2. **Unidades físicas, nunca floats de consola.** `dB`, `Hz`, `ms`, `ratio`, `%`. Cada traductor aplica su taper en su borde (la X32 usa el taper oficial de 4 tramos; otras marcas trabajan en dB directo).
3. **Toda pérdida es auditable.** La carga produce un *informe de traducción* que la UI muestra: en directo hay que saber **qué NO se cargó**.
4. **Round-trip seguro:** los parámetros sin equivalencia se conservan en `vendor.<marca>.*` para que una escena de la X32 vuelva a la X32 sin pérdidas.
5. **Versionado + hash** del esquema y de la escena origen.

### 3.2 Estructura propuesta del objeto intermedio (USF)

```jsonc
{
  "usf": { "schema": "1.0", "name": "Sala A · Preparado", "hash": "sha1:…",
           "source": { "brand": "behringer", "model": "x32", "fw": "4.0.9" },
           "created": "2026-10-08T10:00:00Z" },

  "caps": { "channels": 32, "buses": 16, "matrix": 6, "dca": 8, "fx": 8, "mains": ["st","m"] },

  "channels": [ {
      "id": "ch.01", "name": "KICK", "color": "green", "icon": "drum",
      "source": { "input": 1, "socket": "local" },
      "gain":   { "trimDb": 0.0, "hp": { "hz": 80, "slope": 12, "on": true } },
      "eq":     { "type": "peq4",
                  "bands": [ { "type":"bell","hz":120,"q":1.4,"gainDb":-3.0}, … ] },
      "dyn":    { "gate": { "on":false, "thrDb":-42, "ratio":2.5, "attackMs":5, "holdMs":100, "releaseMs":200 },
                  "comp": { "on":true,  "thrDb":-18, "ratio":3.0, "attackMs":10, "releaseMs":120,
                            "kneeDb":6, "makeupDb":0 } },
      "mix":    { "levelDb": -6.0, "mute": false, "pan": -0.24,     // pan normalizado −1…1
                  "sends": { "bus.01": { "db": -12.0, "post": true },
                             "fx.01":  { "db":  -8.5, "post": false } } },
      "vendor": { "behringer": { "mix/on": 0, "color": 2, "eq.band6": { … } } }   // reserva round-trip
  } ],

  "buses":  [ … ], "dcas": [ … ], "mains": { "st": { … }, "m": { … } },
  "fx":     [ { "slot": 1, "type": "reverb-hall", "params": { "time": 2.4, "damp": 0.5, "preDelayMs": 40 } } ],
  "routing": null,     // fase tardía: sólo si ambos lados modelan el mismo árbol de rutas
  "notes": [ … ]
}
```

### 3.3 Reglas de equivalencia y descarte elegante

| Dato | Política | Clasificación |
|---|---|---|
| Nivel / fade | equivalencia directa en dB; si el fondo de escala difiere (`−∞` vs `−90 dB`) → clamp y avisar | `applied` / `approximated` |
| Mute / Solo | `bool` canónico; **el driver aplica la polaridad**; verificar en banco de pruebas | `applied` |
| Pan | normalizado −1…1; si el destino no tiene pan (DCA) → se omite por `caps.pan=false` | `applied` / `skipped` |
| Nombre / color / icono | string 12–16 s, paleta común (RD/GN/YE/BL/MG/CY/WH); color fuera de paleta → equivalente más cercano | `approximated` |
| EQ | subconjunto **4 bandas PEQ + HPF** con `hz, q, gainDb, type`. X32 con 6 bandas → 2 extra se **pliegan** (si no caben: `skipped` con razón). Frecuencia fuera de rango destino → clamp + informe | `applied` / `approximated` / `skipped` |
| Dinámica (gate/comp) | parámetros comunes: thr, ratio, attack, release, knee, makeup, hold. Parámetros exclusivos (enhancer, modo *piano*, etc.) → `vendor.*` y `skipped` en destino | mixto |
| Sends pre/post | si el destino sólo permite `post` → `approximated` | mixto |
| FX | **tipo canónico** (reverb/delay/chorus/flanger/phaser/…) + 3–5 parámetros básicos. Tipo inexistente o sin hueco libre → `skipped` y la escena sigue cargando | `skipped` |
| Routing / matriz / mute-groups / macros | modelo no común → `null` en Fase 1 y `skipped` con razón explícita | `skipped` |
| Automix (X/Y) | patrón propio de X32 → `vendor` salvo que el destino lo tenga | `skipped` |

**Nunca** se lanza una excepción global por un parámetro no traducible: la escena se carga **parcialmente** y se emite el informe.

### 3.4 Planificador de escritura + informe

```ts
const plan = compile(usfScene, targetCaps);
// → ops ordenadas, progreso y cancelación para la UI
```

Orden de escritura (importa en directo): `identidad (nombre/color) → ganas/HPF → niveles → mute → pan → sends → EQ → dinámica → FX → routing`. Escribir **mutes al principio** evita destellos de audio mientras se rellena el estado.

```jsonc
// Informe devuelto tras la carga (y pintado en la UI)
{ "applied": 412,
  "approximated": [
    { "path": "ch.03.eq", "reason": "6band→4band", "action": "fold" },
    { "path": "ch.07.sends.bus.02", "reason": "target-only-post", "action": "post" }
  ],
  "skipped": [
    { "path": "fx.2.type", "value": "tape-delay", "reason": "fx-type-not-in-target" },
    { "path": "ch.01.automix", "reason": "vendor-feature-x32" }
  ] }
```

### 3.5 Identidad y desalineación de canales

X32 (32 ch + 8 aux + 8 fxrtn) ≠ SQ (48) ≠ TF (40). Política explícita:

- `align: "index"` (por defecto), `"byName"` o `"explicit"` (mapa manual en la escena).
- Sobra material → `skipped` con `reason:"no-slot-in-target"`; faltan canales → `applied` parcial + aviso.
- FX: se mapea por **rol** (reverb principal → hueco de reverb), no por índice.

---

## 4. Conclusiones y Hoja de Ruta

### 4.1 Los 3 mayores riesgos técnicos (y su mitigación concreta)

**Riesgo 1 — Divergencia de estado (split-brain) entre consola, bridge y N navegadores.**
*Síntomas:* faders que "pelean" al soltar, mute que revienta tras una reconexión, dos tablets mostrando cosas distintas.
*Mitigación:* la **consola es la única fuente de verdad**; el bridge es una *caché con `seq`*; snapshot al suscribir; resync obligatorio tras cada `online`; comandos con `id` idempotente; eco optimista local con **rollback** si llega un estado contradictorio; nunca *merge* ciego de dos snapshots.
*Métrica:* `resync_time < 500 ms` tras reconexión; contador de resyncs por hora.

**Riesgo 2 — Inundación de telemetría y bloqueo del event loop del Pi.**
*Síntomas:* la latencia de control sube con el nº de clientes, la UI baja a 12 fps, picos de GC, vúmetros que "traban" (descartes UDP silenciosos).
*Mitigación:* dos planos (§2.2), coalescing en servidor, binario + cuantización, fan-out de `Buffer` compartido, límite y *backpressure* por cliente, workers para parseo. **Cargar con 10 clientes × 30 Hz en CI** antes de tocar el firmware.
*Métrica:* p99 `gesto→LED < 50 ms` con 10 clientes; CPU Pi < 60 %; descartes UDP = 0 en carga nominal.

**Riesgo 3 — Enlace Wi-Fi no fiable y recuperación durante el directo.**
*Síntomas:* reconexiones enlazadas, mensajes viejos aplicados al volver (un fader de hace 8 segundos), "mute fantasma" por comandos perdidos.
*Mitigación:* keepalive agresivo en los tres niveles (§2.4), backoff con jitter ✅, **cola con TTL corto y descarte de `set` antiguos al reconectar**, resync con snapshot, adaptación de rate de telemetría según RTT, marcado visual de *stale* en la UI, y pruebas de estrés con apagón deliberado del AP.
*Métrica:* edad máxima de un valor aplicado < 1 s; tasa de reconexiones < 5/h en la instalación de referencia.

*Riesgos adicionales (no top-3 pero reales):* deriva de firmware/protocolo → **contract tests con fixtures golden por versión**; seguridad (el bridge será un servidor WS en una red de directo) → token/TLS y red aislada **antes** de exponerlo.

### 4.2 Hoja de ruta por fases

| Fase | Entregable | Criterio de aceptación |
|---|---|---|
| **F0** (1–2 d) | Extraer `protocol` + `drivers/x32` del código actual (`pathsFor`, taper, **tabla de polaridad**, `/xremote`) sin cambiar comportamiento | tests de conversión idénticos a los valores actuales; `mixer.js` ya no cita rutas OSC |
| **F1** (1 sem) | Bridge Node en la Pi: dos planos, `seq`+snapshot, `/xremote`, métricas (RTT, descartes, cola) | p99 < 50 ms con 10 clientes simulados |
| **F2** (1 sem) | Store canónico en el cliente + capabilities → UI que se adapta (`caps.pan`, nº de sends, bancos) | demo con `drivers/fake` sin tocar la UI |
| **F3** (1–2 sem) | USF: export/import de escena X32 + informe de traducción en la UI | ida y vuelta X32→USF→X32 **sin pérdidas** |
| **F4** (2 sem) | **Driver nº 2 (SQ o TF)** — la prueba real de la abstracción | misma UI, cero cambios en `web/` salvo capabilities |
| **F5** (1 sem) | Hardening: auth/WSS, watchdog, OTA, escenas en SD con retención, pruebas de apagón de AP | checklist de directo superada |

### 4.3 SLO del producto (definirlos ahora, medirlos desde F1)

- Latencia `gesto → LED local`: **p99 < 16 ms** (una rAF).
- Latencia `gesto → consola`: **p99 < 50 ms** en LAN cableada, **< 100 ms** sobre Wi-Fi.
- Telemetría: **30 Hz** nominal, degradable a 15 Hz, nunca bloquea el control.
- Recuperación tras pérdida de enlace: **< 1,5 s** hasta estado fiable (reconexión + snapshot).
- Carga sostenida: **10 clientes**, CPU Pi < 60 %, 0 descartes UDP en nominal.

---

## Anexo A — Mensajería WS propuesta (evolución del formato actual)

```jsonc
// Control (texto JSON) — sustituye/extend el formato {action, address, args}
{ "v":1, "op":"sub",  "path":"ch.*", "id":"s1" }              → respuesta: snapshot + deltas
{ "v":1, "op":"set",  "path":"ch.01.mix.fader", "value":-6.0, "id":"k7", "seq":118 }
{ "v":1, "op":"get",  "path":"sys.state" }                     → resync
{ "v":1, "op":"evt",  "path":"sys.online", "value":true }      → estado del enlace

// Telemetría (binario, ArrayBuffer)
[0x01][seq u32][ts u32][i8 × N]   // niveles en índice 0…128 (−60…+10 dB, paso 0,5)
```

Compatibilidad: mantener durante F1–F2 el formato actual `{action:"osc_send", address, args:[v]}` como **alias** del `op:"set"` para no romper el frontend ya entregado; el traductor de formato vive, como todo lo demás, en el bridge.
