# GainGuard — motor y API

GainGuard es el control automático de ganancia de CueDesk sobre la consola X32
(OSC). Este documento describe el motor, sus cuatro guardas, la superficie HTTP
y las rutas OSC que usa.

## 1. Mapa del código

CueDesk está partido en tres capas que no se miran entre sí:

| Capa | Paquete | Responsabilidad |
| --- | --- | --- |
| **Motor** | `packages/core` | Guardas, estado por canal y decisiones (`tick` de 100 ms). |
| **Driver** | `packages/console-x32` | Traduce dominio ↔ OSC de la X32: rutas, *taper*, previo y ecos. |
| **Contrato** | `packages/console-adapter` | `ConsoleAdapter` / `ConsoleLink`: la frontera entre motor y driver. |
| **App** | `apps/cuebox` + `server.js` | Transporte UDP/OSC, enrutador HTTP, estáticos y cableado. |

| Fichero | Contenido |
| --- | --- |
| `packages/console-adapter/src/adapter.ts` | Contrato `ConsoleAdapter`: el único lenguaje del motor (canales, dB, previo). |
| `packages/console-adapter/src/link.ts` | Contrato `ConsoleLink`: el puerto de bajo nivel (`send` / `on` / `listen`). |
| `packages/console-x32/src/X32Adapter.ts` | Driver X32: conversión, rutas, descarte de ecos y banco de previo por canal. |
| `packages/console-x32/src/taper.ts` · `paths.ts` · `preamps.ts` | Taper de 4 tramos, rutas OSC y tabla de bancos de previo (Local / AES50 A / AES50 B). |
| `packages/core/src/gainGuardEngine.ts` | Motor: ciclo de 100 ms, pipeline, estado por canal. |
| `packages/core/src/guards.ts` | Decisiones puras (`baseVerdict`, `stageDecision`, `preDecision`, `busDelta`, `rmsOf`, `clamp`). |
| `packages/core/src/types.ts` | Tipos y valores por defecto de toda la configuración. |
| `packages/core/src/api.ts` | Rutas HTTP (`mountSuiteRoutes`): la frontera que recompone `source` / `headampIndex`. |
| `packages/core/src/analysis/rmsAnalyzer.ts` · `lufsAnalyzer.ts` | Medidores RMS y LUFS con filtro K. |
| `packages/core/test/*.test.ts` · `packages/console-x32/test/*.test.ts` | Pruebas del motor, de los analizadores y del driver. |
| `apps/cuebox/oscEngine.js` | Transporte UDP/OSC: implementa `ConsoleLink` sobre `dgram`. |
| `apps/cuebox/router.js` · `server.js` | Enrutador HTTP y composición raíz (estáticos + cableado). |

El motor **no conoce la consola**: sólo habla `ConsoleAdapter`, así que no ve
rutas, *taper* ni índices físicos de previo. El driver X32 es quien los posee y
quien descarta los ecos. La capa HTTP compone `source` / `headampIndex` desde el
driver para conservar el contrato que ya consume la interfaz.

El motor **nunca** reacciona a un paquete de forma aislada: la telemetría y los
ecos sólo actualizan el estado. Las decisiones se toman en el ciclo (`tick`).

## 2. El ciclo (tick de 100 ms)

En cada tick, por canal y en este orden:

1. **GainGuard base** — análisis cada 10 s sobre el **fader**; corrección con
   rampa de 2 s. Ignora desviaciones por debajo del umbral y descarta saltos
   anómalos (> 15 dB) bloqueando el canal tras 3 avisos.
2. **Stage Guard** — *ducking* sobre el **previo** (headamp): si el canal lleva
   en silencio el tiempo de *hold*, baja el previo `duckingDepth` dB. La señal
   nunca se corta.
3. **PreGuard** — protección preventiva del **previo**: con dinámica sostenida
   por encima del techo (por defecto **−3 dBFS**) baja el previo poco a poco y lo
   libera cuando el nivel cede. Con un **objetivo único** para el previo, Stage
   Guard y PreGuard componen sus desplazamientos sobre una misma referencia y
   no generan bucles entre ellos.
4. **BusGuard** — compensa en los **16 buses** la variación del **previo** (nunca
   el fader): baja el envío del canal a cada bus la misma cantidad que suba el
   previo, para que el IEM no note los ajustes de Stage Guard ni de PreGuard.
   Trabaja en **modo stealth**: no añade interfaz propia; sólo se ve reflejado en
   la mezcla de cada bus.

Reglas transversales:

- Banda muerta de **0,5 dB**: no se emite un ajuste menor que eso.
- Cooldown de **2,5 s** por canal tras cada ajuste automático. Bloquea acciones
  nuevas, no una rampa en curso. La **restauración de Stage Guard no espera al
  cooldown**: la voz no puede esperar.
- El descarte del eco es **del driver**, no del motor: como el protocolo OSC no
  admite metadatos, el driver recuerda lo que escribió y descarta la devolución
  que coincida en ruta y valor dentro de una ventana de 500 ms (tolerancia de
  0,5 dB para el redondeo de la consola). Al motor sólo le llegan cambios de
  dominio con su origen (`console` o `self`).

### Criterio de actuación (acordado)

- El envío a bus es **post-EQ**: no ve el fader. Por eso **BusGuard compensa sólo
  el previo**.
- Stage Guard y PreGuard actúan sobre el previo → BusGuard los ve y los compensa.
- La normalización base actúa sobre el fader → no llega al IEM y no se compensa.
- BusGuard no necesita declarar qué buses alimenta cada canal: **por defecto los
  16** (el enlace por canal sólo sirve para restringir casos concretos).

## 3. Stage Guard (ducking)

Se activa **por canal** (el botón StageGuard de cada tira). Idea: un micro de corista que está en silencio
y amplifica la batería; en vez de cortar, se bajan 10 dB de previo.

| Parámetro | Defecto | Significado |
| --- | --- | --- |
| `enabled` | `false` | Botón StageGuard del canal. |
| `threshold` | `-50` | RMS (dBFS) por debajo del cual el canal está en silencio. |
| `duckingDepth` | `10` | dB de atenuación del previo mientras hay silencio. |
| `holdMs` | `1000` | Silencio sostenido antes de atenuar. |
| `windowMs` | `100` | Ventana de detección de la voz (baja latencia). |
| `hysteresisDb` | `3` | Margen sobre el umbral para dar la señal por recuperada. |

Bajada y subida:

- **Bajada**: 1 dB por tick (~1 s para 10 dB) y renueva el cooldown.
- **Subida**: 5 dB por tick (~200 ms para 10 dB), **sin hold** y sin esperar al
  cooldown. La histéresis de 3 dB evita que una señal en el límite oscile.
- Apagar el StageGuard de un canal atenuado **restaura** su previo; nunca se queda
  atenuado sin control.

## 4. PreGuard (protección del conversor A/D)

Se activa **por canal** (el botón PreGuard de cada tira, justo debajo de
StageGuard; se ilumina en verde). Idea: un canal con dinámica sostenida que roza
el techo del conversor A/D; en vez de recortar (el A/D ya no puede), se baja el
previo de forma preventiva y gradual.

| Parámetro | Defecto | Significado |
| --- | --- | --- |
| `enabled` | `false` | Botón PreGuard del canal. |
| `ceilingDb` | `-3` | Nivel sostenido (RMS de 1 s, dBFS) a partir del cual se protege. |
| `hysteresisDb` | `3` | Margen bajo el techo para dar el nivel por recuperado. |

Funcionamiento:

- **Referencia única**: el motor mantiene una `nominalGain` (valor del previo
  sin guardas). Stage Guard aplica un desplazamiento (0 o −10 dB) y PreGuard
  aplica un desplazamiento acumulado `preOffset` (≥ 0). El objetivo por tick es
  `nominalGain + stageOffset − preOffset`. Al haber un único emisor, **no se
  producen bucles** entre ambas guardas.
- Con el nivel sostenido por encima del techo, PreGuard acumula su
  desplazamiento (0,5 dB por ciclo de cooldown de 2,5 s) hasta un tope de
  seguridad. Cuando baja por debajo de `ceilingDb − hysteresisDb` lo va
  liberando (2 dB por tick, sin esperar al cooldown).
- Apagarlo estando con desplazamiento lo libera también.
- Un cambio manual del previo **reajusta la referencia** (se conserva lo que las
  guardas tenían aplicado en ese momento).

## 5. Bloqueo del control manual del previo

Como Stage Guard y PreGuard escriben en el previo, mientras una de ellas lo está
moviendo el motor **bloquea el control manual de ese canal** durante el tiempo
necesario para que el ajuste se asiente:

- Cada ajuste automático del previo abre una ventana de **1 s** (`headampLockSettleMs`).
- Si durante la ventana llega un cambio manual del previo (consola o cualquier otro
  cliente), el motor **lo descarta y reafirma su valor** en la consola: la mano
  humana y el automatismo no se pelean por el mismo mando, y la consola no se queda
  en un valor que el motor desconoce.
- Cuando la guarda deja de mover el previo, la ventana expira y el control vuelve
  al operador.
- El estado se expone por canal en `lock: { active, until }`.
- Aparte de esa ventana momentánea, el canal tiene un **bloqueo base**
  (`baseLocked`): si la normalización base descarta demasiados saltos anómalos,
  deja de corregir el canal y lo marca hasta que el operador lo re-arma
  (`POST /api/gainguard/channels/:id/arm`). Es persistente, no una ventana.
- La **referencia única** del previo (`nominalGain`) se mantiene actualizada: un cambio manual reajusta la referencia teniendo en cuenta el desplazamiento que cada guarda aplicaba en ese instante, de modo que no se pierde la protección ni la atenuación por silencio.

## 6. Interfaz HTTP

Base: `http://127.0.0.1:8765/api/gainguard` (el puerto depende del arranque).

| Método y ruta | Cuerpo | Devuelve |
| --- | --- | --- |
| `GET /api/gainguard` | — | Estado completo (todos los canales). |
| `GET /api/gainguard/channels/:id` | — | Un canal (`ch.01` … `ch.32`). |
| `GET /api/gainguard/locks` | — | `{ locks, baseLocked, sources }`: canales con el previo bloqueado ahora, canales con el **bloqueo base** persistente, y banco de previo de cada canal. |
| `GET /api/gainguard/meters` | — | `{ levels: [{ channel, db }], at }`: última lectura por canal. Es el sondeo de los vúmetros. |
| `POST /api/gainguard/config` | Véase abajo | `{ status }`. |
| `POST /api/gainguard/meters` | `{ levels: number[32], ts? }` | `{ accepted }`. |
| `POST /api/gainguard/console` | `{ channel, kind, db?, bus?, on?, origin? }` | Resultado de la ingesta. |
| `POST /api/gainguard/send/:id` | `{ bus: 1…16, db }` | Canal actualizado. |
| `POST /api/gainguard/channels/:id/arm` | — | `{ armed: true }` (levanta el bloqueo de la base). |
| `GET /api/gainguard/rearm` | — | `{ held, remainingMs, totalMs }`: estado de la pausa REARM. |
| `POST /api/gainguard/rearm` | `{ ms? }` | Estado de la pausa; sin `ms`, el plazo del motor (20 s). |

### `POST /config`

Acepta BusGuard, la base por canal y, por canal, Stage, PreGuard y bus
(enlaces opcionales; sin ellos, BusGuard usa los 16):

```json
{
  "bus": { "enabled": true },
  "channels": [
    {
      "id": "ch.01",
      "mode": "rms",
      "threshold": "±5 dB",
      "stage": { "enabled": true },
      "pre": { "enabled": true, "ceilingDb": -3, "hysteresisDb": 3 },
      "buses": [1, 2]
    }
  ]
}
```

- **BusGuard** es global (`bus.enabled`); `buses` sólo restringe los buses de ese
  canal. Omitirlo compensa los 16.

- **Forma de la pantalla**: `mode` (`off` | `rms` | `lufs`) y `threshold` juntos.
  Con `"Off"` en `threshold` la normalización base del canal queda apagada. El
  umbral admite número o texto (`"±5 dB"`, `"-18 LUFS"`).
- **Forma directa**: también se acepta `base: { mode, threshold }`.
- Un `id` desconocido responde `404`; un modo inválido, `400`.

### `POST /meters`

Array de exactamente 32 niveles en dBFS (uno por canal, en orden). Cualquier
valor no finito se ignora y no cuenta como aceptado; un array de otra longitud
responde `409`. Es la vía fiable de telemetría; además, el driver escucha
`/meters/1` por su cuenta (llega en lineal y lo pasa a dBFS).

### `POST /console`

Introduce un cambio de **dominio** leído de la consola (o su eco). Nada del
frontend lo usa: el camino real es el driver, que engancha
`ConsoleAdapter.onChanges`.

```json
{ "channel": "ch.01", "kind": "fader", "db": -5, "origin": "console" }
```

`kind` es `fader`, `send` o `preamp` (alias `headamp`); con `send` hace falta
`bus`. `origin: "self"` marca un mensaje emitido por CueDesk (se descarta como
eco); cualquier otro valor es la consola. Devuelve si se aceptó y con qué motivo
(`external`, `own-echo`, `guard-locked`, `unknown-channel`, `not-a-level`).

### `GET /meters`

Devuelve `{ levels: [{ channel, db }], at }` con la **última lectura** de cada
canal con telemetría. Es el sondeo que usa la interfaz mientras no existe el
canal en tiempo real: `ingestLevel` purga lo más viejo que `levelRetainMs`, así
que un canal sin datos deja de publicarse y su vúmetro cae a la simulación.

### Pausa REARM (`GET` y `POST /rearm`)

Pausa temporal de la automatización (botón **REARM** de la pantalla). El motor
deja de decidir durante `ms` (por defecto `rearmMs`, 20 s) y se **rearma solo**
al agotarse el plazo: ni fader, ni previo, ni buses reciben un ajuste mientras
`held` es `true`. **La configuración no se toca**: guardas, umbrales, referencias
y desplazamientos quedan intactos, y la telemetría y los cambios de la consola
se siguen registrando para que el motor conozca el estado real al volver.

```json
{ "ms": 20000 }
```

`GET /rearm` publica el mismo estado (`held`, `remainingMs`, `totalMs`) para que
la interfaz resincronice su cuenta atrás tras una recarga. `ms` fuera del rango
`0…3600000` responde `400`; `0` equivale a un rearme inmediato.

### Rutas de consola (transporte y puente)

| Método y ruta | Cuerpo | Devuelve |
| --- | --- | --- |
| `GET /api/console/status` | — | Diagnóstico del driver: `connected`, `sent`, `echoesDropped`, `pending`, `echoWindowMs` y `transport`. |
| `POST /api/console/osc` | `{ address, args?, value?, type? }` | `{ ok, address }`. |

`POST /api/console/osc` es el **puente** de la interfaz para lo que el motor no
gobierna (pan, nombre, color, routing…): escribe una ruta OSC cruda **a través
del driver** (`ConsoleAdapter.writeRaw`) para que su eco se registre y se
descarte, en vez de leerse como un gesto humano. Quien la use asume el mapeo
ruta → dominio: si toca una magnitud de GainGuard (fader, previo, envío), además
hay que informar al motor por su superficie de dominio.

## 7. Rutas OSC (del driver)

Estas rutas las conoce **sólo** el driver X32 (`packages/console-x32`); el motor
no ve ninguna. Le llegan ya convertidas a dB.

| Ruta | Tipo | Rango y paso |
| --- | --- | --- |
| `/headamp/NNN/gain` | dB | −12 … +60 dB, paso 0,5 |
| `/headamp/NNN/phantom` | bool | — |
| `/ch/NN/preamp/invert` | bool | — |
| `/ch/NN/mix/fader` | *taper* | −90 … +10 dB (4 tramos) |
| `/ch/NN/mix/YY/level` | *taper* | −90 … +10 dB (envío a bus) |
| `/meters/1` | lineal | 0…1 (1,0 = 0 dBFS); 32 valores |

El índice `NNN` del previo depende del banco —Local `000…031`, AES50 A
`032…063`, AES50 B `080…111`—. El *taper* y la conversión lineal ↔ dB viven en
`packages/console-x32/src/taper.ts`.

Además de las escrituras de dominio, el driver expone `writeRaw(path, args, type?)`
para el puente de la interfaz: pasa por el mismo camino, registra el eco con la
tolerancia del control correspondiente (el previo admite el redondeo de 0,5 dB) y
deduce el tipo OSC de la ruta cuando no se indica (`i` para el phantom, `f` para
el resto).

## 8. Arranque y pruebas

```
node server.js [--port 8765] [--console <ip>] [--no-gg]
```

- `--console <ip>`: motor OSC **real** contra esa consola.
- Sin `--console`: *dry-run* (misma lógica, sin tocar la red).
- `--no-gg`: desactiva la suite GainGuard.

```
npm start        # servidor
npm test         # motor, analizadores y driver (TS)
```

## 9. Pantalla GainGuard (frontend)

- El botón **GainGuard** de la barra global abre la pantalla de ajustes.
- **Cabecera en tres zonas**: «Channel Block» a la izquierda, el nombre
  «GainGuard®» centrado —un 30 % más grande que antes— y **BusGuard** con el
  botón **REARM** a la derecha.
- **REARM** (rojo): un clic pausa la automatización 20 s (`POST /rearm`) y el
  botón muestra la cuenta atrás —`REARM (20s)`… `REARM (0s)`—; al agotarse el
  plazo el motor se rearma solo. Durante la pausa el fondo pasa a rojo oscuro y
  el punto late. La configuración no se toca. Cerrar la pantalla sigue
  disponible con `Esc` o cambiando de vista principal.
- **BusGuard** es el único interruptor de cabecera (global, todos los canales).
- **StageGuard** es el nombre del botón por canal, encima del selector RMS/LUFS:
  cian apagado, ámbar encendido.
- **PreGuard** va justo debajo de StageGuard: cian apagado, verde encendido.
- Entre las guardas y el selector RMS/LUFS hay un respiro con la rúbrica
  **«GainGuard Select»**, para que el bloque de medida no se amontone.
- Al cargar la página se **sincronizan los 32 canales** (StageGuard y PreGuard) en
  una sola petición, con la pantalla como referencia (el motor arranca todo
  apagado y no persiste).
- Modo y umbral por canal se guardan en `localStorage`; su envío al backend está
  pendiente de definir.
- **Bloqueo en el mixer**: mientras una guarda mueve el previo de un canal, el
  mixer lo consulta (`GET /locks`, una vez por segundo) y en **modo GAIN** —el
  fader del previo— lo deja inerte (`pointer-events: none`, `aria-disabled`) con
  un rótulo **LOCK** en ámbar. En modo nivel el fader no se toca: no es el previo.
- **Bloqueo base**: si GainGuard deja de corregir un canal por anomalías
  sostenidas, el mixer lo rotula **BASE** en ámbar (también en modo GAIN), con una
  «×» que re-arma el canal (`POST /api/gainguard/channels/:id/arm`). A diferencia
  de **LOCK**, que dura lo que la guarda está moviendo el previo, **BASE** es
  persistente hasta que el operador lo levanta.
- **Vúmetros**: la interfaz sondea `GET /api/gainguard/meters` (~8 veces por
  segundo) y vuelca el dB de cada canal directo a su vúmetro. Los canales sin dato
  —aux, fx, bus…— siguen con la simulación, y en **modo GAIN** el vúmetro muestra
  la señal de entrada del previo, no el nivel de mezcla.

## 10. Pendiente

- **Puente en tiempo real**: hoy la interfaz ya puede escribir por
  `POST /api/console/osc` y sondea los vúmetros por HTTP, pero falta el canal en
  tiempo real (WebSocket/SSE) que empuje los vúmetros y los cambios que llegan de
  la consola. La interfaz heredada todavía intenta hablar por
  `ws://localhost:8080`, un servidor que no existe: es la deuda principal del
  reparto de capas.
- **`/meters/1` de la consola**: el driver ya lo escucha (el puerto local se abre
  siempre) y lo convierte a dBFS, pero la interfaz aún no lo recibe; llega al
  motor, no al vúmetro. Cuando exista el puente, se enganchará a `adapter.onLevels`.
- **BusGuard decidido**: compensa **sólo los envíos** (nunca el fader) y, en modo
  **stealth**, los **16 buses** por defecto, sin elegir buses por canal ni añadir
  vista nueva. El interruptor de cabecera enciende/apaga únicamente esa
  compensación: no activa la base, Stage Guard ni PreGuard.
- **Sin consola X32**: BusGuard sólo compensa los buses cuyo envío tenga un valor
  conocido (configurado o eco de la consola); los desconocidos se omiten. Siguen
  sin verificar el eco real, la ruta/tipo de `/ch/NN/mix/YY/level` y la
  correspondencia de `/meters/1`.
- Node elimina los tipos sin comprobarlos (no se usa `tsc`).
