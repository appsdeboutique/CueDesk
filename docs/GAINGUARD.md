# GainGuard — motor y API

GainGuard es el control automático de ganancia de CueDesk sobre la consola X32
(OSC). Este documento describe el motor, sus cuatro guardas, la superficie HTTP
y las rutas OSC que usa.

## 1. Mapa del código

| Fichero | Contenido |
| --- | --- |
| `backend/suite/gainGuardEngine.ts` | Motor: ciclo de 100 ms, pipeline, estado por canal. |
| `backend/suite/guards.ts` | Decisiones puras (`baseVerdict`, `stageDecision`, `preDecision`, `busDelta`, `rmsOf`, `clamp`). |
| `backend/suite/oscHandler.ts` | Marca de origen, conversión *taper* de la X32 y filtro de ecos. |
| `backend/suite/types.ts` | Tipos y valores por defecto de toda la configuración. |
| `backend/suite/api.ts` | Rutas HTTP colgadas del enrutador del backend. |
| `backend/gainGuard/analyzers/rmsAnalyzer.js` | Medidor RMS (CommonJS, reutilizado). |
| `backend/gainGuard/analyzers/lufsAnalyzer.js` | Medidor LUFS con filtro K (CommonJS, reutilizado). |
| `backend/suite/test/*.test.ts` | Pruebas del motor y del handler. |

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
- Todo mensaje saliente lleva la marca `cuedesk-internal` en el objeto. El
  protocolo OSC no admite metadatos, así que el filtro de entrada reconoce el
  eco comparando ruta y valor en una ventana de 500 ms (tolerancia de 0,5 dB para
  el redondeo de la consola).

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
- La **referencia única** del previo (`nominalGain`) se mantiene actualizada: un cambio manual reajusta la referencia teniendo en cuenta el desplazamiento que cada guarda aplicaba en ese instante, de modo que no se pierde la protección ni la atenuación por silencio.

## 6. Interfaz HTTP

Base: `http://127.0.0.1:8765/api/gainguard` (el puerto depende del arranque).

| Método y ruta | Cuerpo | Devuelve |
| --- | --- | --- |
| `GET /api/gainguard` | — | Estado completo (todos los canales). |
| `GET /api/gainguard/channels/:id` | — | Un canal (`ch.01` … `ch.32`). |
| `GET /api/gainguard/locks` | — | `{ locks: ["ch.01", …] }`: canales con el previo bloqueado. |
| `POST /api/gainguard/config` | Véase abajo | `{ status }`. |
| `POST /api/gainguard/meters` | `{ levels: number[32], ts? }` | `{ accepted }`. |
| `POST /api/gainguard/console` | `{ path, value }` | Resultado del eco. |
| `POST /api/gainguard/send/:id` | `{ bus: 1…16, db }` | Canal actualizado. |
| `POST /api/gainguard/channels/:id/arm` | — | `{ armed: true }` (levanta el bloqueo de la base). |

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
responde `409`. Es la vía fiable de telemetría; el *listener* de `/meters/1`
del servidor es un atajo.

### `POST /console`

Introduce un cambio leído de la consola (o un eco):

```json
{ "path": "/headamp/000/gain", "value": 20 }
```

Rutas reconocidas: `/ch/NN/mix/fader`, `/ch/NN/mix/YY/level`, `/headamp/NNN/gain`.
`value` va **en el valor de cable** de la X32; el handler aplica la conversión de
*taper* que corresponda. Devuelve si el mensaje se aceptó y con qué motivo
(por ejemplo, `echo` si coincide con algo escrito por CueDesk).

## 7. Rutas OSC

| Ruta | Tipo | Rango y paso |
| --- | --- | --- |
| `/headamp/NNN/gain` | lineal | −12 … +60 dB, paso 0,5 (`NNN` = canal − 1) |
| `/auxin/NN/preamp/trim` | lineal | −18 … +18 dB, paso 0,25 |
| `/ch/NN/mix/fader` | *taper* | −90 … +10 dB (4 tramos) |
| `/ch/NN/mix/YY/level` | *taper* | −90 … +10 dB (envío a bus) |

## 8. Arranque y pruebas

```
node server.js [--port 8765] [--console <ip>] [--no-gg]
```

- `--console <ip>`: motor OSC **real** contra esa consola.
- Sin `--console`: *dry-run* (misma lógica, sin tocar la red).
- `--no-gg`: desactiva la suite GainGuard.

```
npm start        # servidor
npm test         # analizadores (JS) + motor y handler (TS)
```

## 9. Pantalla GainGuard (frontend)

- El botón **GainGuard** de la barra global abre la pantalla de ajustes.
- **Cabecera en tres zonas**: «Channel Block» a la izquierda, el nombre
  «GainGuard®» centrado —un 30 % más grande que antes— y **BusGuard** con el
  botón de cerrar a la derecha.
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

## 10. Pendiente

- **BusGuard decidido**: compensa **sólo los envíos** (nunca el fader) y, en modo
  **stealth**, los **16 buses** por defecto, sin elegir buses por canal ni añadir
  vista nueva. El interruptor de cabecera enciende/apaga únicamente esa
  compensación: no activa la base, Stage Guard ni PreGuard.
- **Sin consola X32**: BusGuard sólo compensa los buses cuyo envío tenga un valor
  conocido (configurado o eco de la consola); los desconocidos se omiten. Siguen
  sin verificar el eco real, la ruta/tipo de `/ch/NN/mix/YY/level` y la
  correspondencia de `/meters/1`.
- Node elimina los tipos sin comprobarlos (no se usa `tsc`).
