# CueDesk — GainGuard · Especificación Técnica

> **Rol:** Lead Systems Architect & Technical Writer (CueDesk).
> **Alcance:** motor `GainGuard` (`@cuedesk/core`), su interacción con `apps/cuebox` y su reflejo en la interfaz (`index.html` + `js/`).
> **Fecha:** 2026-10-31 · **Versión referenciada:** `v1.0.25` + pausa **REARM** (árbol de trabajo, ver §0.3).
>
> **Nota de idioma:** este documento se redacta en español por coherencia con el resto de
> la documentación del repositorio (`docs/ARQUITECTURA.md`, `docs/GAINGUARD.md`) y con los
> comentarios del código. Se puede traducir al inglés si se requiere una versión externa.

---

## 0. Control del documento

### 0.1 Fuente de verdad

Esta especificación **no describe un diseño propuesto**: describe el comportamiento del
código que hay en el repositorio. Cada valor numérico procede de una constante del fuente,
citada en la columna *Origen* de las tablas.

| Artefacto | Ruta | Papel |
| --- | --- | --- |
| Motor | `packages/core/src/gainGuardEngine.ts` | Ciclo de 100 ms, pipeline, estado por canal. |
| Decisiones puras | `packages/core/src/guards.ts` | `baseVerdict`, `stageDecision`, `preDecision`, `busDelta`, `rmsOf`. |
| Tipos y defaults | `packages/core/src/types.ts` | `EngineConfig`, `ChannelRuntime`, `DEFAULT_*`. |
| Frontera HTTP | `packages/core/src/api.ts` | `mountSuiteRoutes`: `/api/gainguard/*`, `/api/console/*`. |
| Analizadores | `packages/core/src/analysis/{rmsAnalyzer,lufsAnalyzer}.ts` | Medida RMS y LUFS (filtro K). |
| Contrato del driver | `packages/console-adapter/src/{adapter,types}.ts` | `ConsoleAdapter`, `ControlChange`, `LevelFrame`. |
| Driver X32 | `packages/console-x32/src/X32Adapter.ts` | Taper, rutas OSC **y supresión de eco**. |
| Composición | `apps/cuebox/{router,oscEngine,server}.js` | Enrutador, transporte UDP/OSC y cableado. |
| Interfaz | `js/app.js`, `js/mixer.js`, `index.html`, `css/strips.css` | Pantalla GainGuard, mixer, badges LOCK/BASE. |

### 0.2 Regla de oro arquitectónica

> **El motor no conoce la consola.** GainGuard habla exclusivamente `ConsoleAdapter` y en
> **dominio** (canales `ch.NN`, magnitudes en **dB**, `origin`). Ni una ruta OSC, ni un
> taper, ni un índice físico de previo entran en `packages/core`. El driver X32 es el
> único que los posee.

### 0.3 Nota de estado

El **REARM** (§4.5, §6, §7) está implementado en el árbol de trabajo sobre `v1.0.25`
(9 ficheros, **sin commitear** al sellar este documento). El resto de la especificación
refleja la implementación ya versionada. Distinguimos ambos casos donde importa.

---

## 0.4 Reconciliación con el encargo ⚠️

El encargo de esta especificación contenía varios parámetros y un sistema que **no
coinciden** con el código. Se listan aquí para que el documento no herede supuestos
erróneos. La columna *Realidad* es verificable en los ficheros citados.

| Punto del encargo | Lo que pedía el encargo | Lo que hay realmente en el código |
| --- | --- | --- |
| PreGuard · prioridad | "Prioridad absoluta sobre el resto de cálculos dinámicos" | **No existe prioridad absoluta.** Stage Guard y PreGuard mantienen un **objetivo único** de previo (`nominalGain + stageOffset − preOffset`). El orden del pipeline es Base → Stage → Pre → Bus (`tick`, `gainGuardEngine.ts`). |
| PreGuard · lockout | "Ventana de lockout dedicada de 1,5 s – 2,0 s" | `headampLockSettleMs = **1000 ms**` (1,0 s), y es **compartida** por Stage Guard y PreGuard, no exclusiva de PreGuard (`types.ts`). |
| PreGuard · escalón | "Safety gain step-downs" | `preStepDb = **0,5 dB**` por ciclo de cooldown (2,5 s); `preMaxOffsetDb = **18 dB**` (no 24); `preRestoreDb = **2 dB**/tick` (`types.ts`). |
| Stage Guard · tiempos | "**300 ms** Hold/Cooldown" | `holdMs = **1000 ms**`; `cooldownMs = **2500 ms**` (`types.ts`). No hay 300 ms en ninguna parte. |
| Stage Guard · ataque | "Ataque ultrarrápido de **10–30 ms**" | Detección con `windowMs = **100 ms**`; ataque de **1 dB/tick** (tick = 100 ms) = **10 dB/s** → 10 dB en ~1,0 s (`stageRampDb`). |
| Stage Guard · release | "400–600 ms hasta −6 / −10 dB" | Restauración de **5 dB/tick** = 50 dB/s → 10 dB en **~200 ms**; profundidad `duckingDepth = **10 dB**` (no −6) (`stageRestoreDb`). |
| Estabilidad | "Prevenir inestabilidad de fase" | GainGuard **no** hace tratamiento de fase ni notch; mitiga realimentación por **reducción de ganancia** y **ducking** de micrófonos en silencio. |
| Standby / Killswitch | "Detallar la interacción con los sistemas Global Standby / Killswitch" | **No existe ningún** Killswitch / panic / mute-all / standby global en el repositorio (verificado por búsqueda: 0 coincidencias). Ver §6.4. |
| Eco | Ventana de 500 ms · origen `console`/`self` | ✅ Correcto: `echoWindowMs = 500`; `ChangeOrigin = "console" | "self"`. |
| REARM | Cooldown de 20 s | ✅ Correcto: `rearmMs = 20000`. Articulado como **pausa con rearme automático**, no como "emergencia". |
| DTO de cambio | `{channel, kind, bus, db, on, origin}` | ✅ Correcto: cuerpo de `POST /api/gainguard/console` (§7.3). |

En los apartados que siguen se documenta **la realidad**, con los números del fuente.

---

## 1. Visión y misión

### 1.1 Misión

GainGuard es el **control automático de ganancia** de CueDesk sobre una consola X32/M32.
Su misión en un entorno de directo de baja latencia es triple:

1. **Normalizar el nivel por canal** para que una fuente mantenga su nivel de referencia
   entre canciones, temas o cambios de intérprete (normalización **base** sobre el fader).
2. **Proteger la cadena** antes de que el daño sea irreversible:
   - el **conversor A/D** (`PreGuard`, previo),
   - los **micrófonos abiertos** que amplifican el entorno (`Stage Guard`, previo),
   - la **suma acumulada** en buses e IEM (`BusGuard`, envíos).
3. **No pelear con el operador**: toda escritura automática es auditable, acotada y se
   retira sola; el control humano se recupera en cuanto la guarda deja de actuar.

### 1.2 Qué significa "prevenir realimentación y recorte" aquí

GainGuard **no es un supresor de realimentación espectral** ni un limitador de fase: no
analiza la onda, no busca frecuencias de acople y no aplica notches. Lo que hace es
**reducción de ganancia preventiva**:

| Riesgo | Mecanismo real en GainGuard |
| --- | --- |
| Recorte digital en el A/D | `PreGuard` baja el **previo** por pasos, antes de que el convertidor no pueda más. |
| Acumulación de ganancia por spill | `Stage Guard` baja el previo de un canal en silencio (`ducking`). |
| Inestabilidad de nivel (oscilación) | Objetivo único de previo + **banda muerta** (0,5 dB) + **histéresis** + **cooldown** + **lockout** del control manual. |
| Realimentación de control (bucle) | **Supresión de eco** en el driver (§5) y **un solo emisor** por magnitud. |

### 1.3 Por qué "baja latencia" condiciona el diseño

En directo, un valor que llega tarde es peor que no llegar. Por eso:

- El **tick es de 100 ms** (`tickMs`): suficientemente fino para no notar la corrección,
  suficientemente grueso para no saturar el enlace OSC.
- La decisión **nunca** se toma en el callback del paquete: la telemetría y los cambios
  sólo **actualizan estado**; la decisión vive en `tick()`.
- La **subida** del previo es rápida (5 dB/tick ≈ 200 ms por 10 dB) porque "la voz no
  puede esperar"; la **bajada** es suave (1 dB/tick) para no cortar la señal.

---

## 2. Arquitectura y límites

### 2.1 Capas

```
┌──────────────────────────────────────────────────────────────────────┐
│ Interfaz  (index.html · js/app.js · js/mixer.js · css/strips.css)      │
│  · Pantalla GainGuard (StageGuard/PreGuard/umbral por canal, REARM)    │
│  · Mixer: fader GAIN, badges LOCK/BASE, vúmetros por sondeo            │
└───────────────▲───────────────────────────────────────┬───────────────┘
                │ HTTP (JSON)                            │
┌───────────────┴───────────────────────────────────────▼───────────────┐
│ apps/cuebox  · router.js · server.js · oscEngine.js                    │
│  Enrutador HTTP ← mountSuiteRoutes()   +   transporte UDP/OSC (dgram)  │
└───────────────▲───────────────────────────────┬───────────────────────┘
                │ mountSuiteRoutes(router,       │ implementa ConsoleLink
                │   engine, adapter)             │
┌───────────────┴──────────────┐        ┌────────▼───────────────────────┐
│ @cuedesk/core                │        │ @cuedesk/console-x32           │
│  GainGuardEngine · guards    │◄──────►│  X32Adapter · taper · paths    │
│  tipos · api (frontera HTTP) │  habla │  preamps · supresión de eco    │
│                              │  sólo  │                                │
│                              │ Console│                                │
│                              │Adapter │                                │
└──────────────────────────────┘ (interfaz)└───────────────────────────────┘
```

La interfaz **no** habla OSC de control directamente: sus escrituras pasan por el driver
(`POST /api/console/osc` → `adapter.writeRaw`), de modo que el eco se descarta y no se lee
como gesto humano (§5.3).

### 2.2 El contrato `ConsoleAdapter`

El motor sólo ve estos métodos. Todo lo específico de la X32 queda por debajo.

```ts
export interface ConsoleAdapter {
  readonly info: ConsoleInfo | null;
  readonly capabilities: ConsoleCapabilities;

  connect(): Promise<ConsoleInfo>;
  disconnect(): Promise<void>;

  // --- previo ---
  setPreampGain(channel: ChannelId, db: number): void;
  assignPreampBank(channel: ChannelId, bankId: string): void;
  preampBankOf(channel: ChannelId): string;
  preampRoutingOf(channel: ChannelId): PreampRouting;

  // --- canal ---
  setChannelFader(channel: ChannelId, db: number): void;
  setChannelSend(channel: ChannelId, bus: BusId, db: number): void;

  // --- puente (pan, nombre, routing…): fuera del gobierno del motor ---
  writeRaw(path: string, args: unknown[], type?: string): void;

  // --- eventos ---
  onChanges(cb: (change: ControlChange) => void): Unsubscribe;
  onLevels(cb: (frame: LevelFrame) => void): Unsubscribe;
  linkStatus(): Record<string, unknown>;
}
```

Reglas del contrato: **valores siempre en dB**; canales por **id de dominio** (`ch.09`);
cambios entrantes **ya traducidos** y con `origin`.

### 2.3 La frontera HTTP recompone lo que el motor no conoce

`source` (banco de previo) y `headampIndex` son **del driver**, no del dominio. La capa
HTTP los recompone para no romper el contrato que ya consume la interfaz:

```ts
// api.ts — decorate()
Object.assign({}, ch, {
  source: adapter.preampBankOf(id),           // "local" | "aes50a" | "aes50b"
  headampIndex: adapter.preampRoutingOf(id).index, // índice físico /headamp/NNN
});
```

---

## 3. El ciclo (`tick` de 100 ms)

### 3.1 Pipeline, en orden

`GainGuardEngine.tick()` ejecuta, **por tick y por canal**, esta secuencia. No hay
concurrencia: cada etapa ve el estado que dejó la anterior.

```
tick(t = ahora)                                     gainGuardEngine.ts
│
├─ 0. ¿PAUSA REARM?  si  t < holdUntil ──────────────►  return (no decide nada)
│       (avanza lastBaseAt para que el análisis no se acumule)
│
├─ 1. Fijar base de BusGuard (compHead = headamp) si aún no existe
│
├─ 2. ¿Cada 10 s (baseCadenceMs)?  ──► analyzeBase() por canal
│       mide (RMS 10 s | LUFS 3 s) → baseVerdict() → arranca rampa de fader (2 s)
│
├─ 3. stepBaseRamp() por canal   ──► emite fader (interpolación de la rampa)
│
├─ 4. stepHeadamp() por canal    ──► Stage Guard + PreGuard → OBJETIVO ÚNICO → emite headamp
│
└─ 5. stepBus() por canal        ──► BusGuard → emite send (compensa el previo)
```

`start()` arma un `setInterval(() => this.tick(), tickMs)`; `stop()` lo cancela. En las
pruebas se llama a `tick(now)` con un reloj inyectado (`EngineOptions.now`) para ser
determinista.

### 3.2 Reglas transversales

| Regla | Valor | Efecto |
| --- | --- | --- |
| **Banda muerta** | `deadbandDb = 0,5 dB` | No se emite un ajuste menor; evita microcorrecciones y ruido OSC. |
| **Cooldown** | `cooldownMs = 2500 ms` | Tras una **bajada** automática de previo, se frenan nuevas bajadas ese tiempo. **No** frena una rampa en curso ni una restauración. |
| **Sólo baja renueva cooldown** | `automatic = down` en `emit` | Subir nunca queda "castigado": la voz no puede esperar. |
| **Objetivo único de previo** | `nominalGain + stageOffset − preOffset` | Al haber un solo emisor sobre el previo, Stage y Pre **no pueden** entrar en bucle. |
| **Lockout del control manual** | `headampLockSettleMs = 1000 ms` | Mientras una guarda mueve el previo, el cambio manual de ese canal se descarta y se reafirma el valor del motor (§5.2). |
| **Retención de nivel** | `levelRetainMs = 2000 ms` | `ingestLevel` purga lo más viejo; un canal sin datos deja de publicarse en `latestLevels()`. |
| **Anomalías de base** | `baseAnomalyLimit = 3` | Tras 3 saltos anómalos (> 15 dB) el canal se **bloquea** (`baseLocked`) hasta re-arme. |

### 3.3 Notación de acciones sobre la consola

Cada decisión se materializa en `emit()`, que **pide** al adaptador, **asume** el valor y
**registra** el ajuste (máx. 500 registros en `recentEmits()`):

```ts
private emit(ch, kind, bus, db, t, reason, automatic) {
  if (kind === "fader")   this.adapter.setChannelFader(ch.id, db);
  else if (kind === "headamp") this.adapter.setPreampGain(ch.id, db);
  else this.adapter.setChannelSend(ch.id, bus, db);

  // asunción de estado:
  if (kind === "headamp") {
    ch.headamp = db;
    ch.headampLockUntil = Math.max(ch.headampLockUntil, t + cfg.headampLockSettleMs);
  }
  if (automatic) ch.cooldownUntil = t + cfg.cooldownMs;   // sólo la bajada
  this.emitted.push({ t, kind, channel: ch.id, db, bus, reason });
}
```

---

## 4. Sub-módulos en profundidad

### 4.1 GainGuard Base — normalización sobre el fader

**Propósito.** Que una fuente conserve su nivel de referencia a lo largo del show. Trabaja
sobre el **fader** de canal; por ser el envío a bus **post-EQ**, este ajuste **no llega al
IEM** y por tanto **BusGuard no lo compensa** (criterio acordado).

**Análisis (cada 10 s, `baseCadenceMs`).**

| Modo | Ventana | Medida | Objetivo | Tolerancia |
| --- | --- | --- | --- | --- |
| `rms` | **10 000 ms** (`RMS_WINDOW_MS`) | media RMS de la envolvente (dBFS) | **referencia aprendida** (`baseRef`, el primer bloque usable) | `base.threshold` (3 ó 5 dB) |
| `lufs` | **3 000 ms** (`LUFS_WINDOW_MS`) | LUFS estimado (o real por onda) | `base.threshold` (−18 ó −23) | `deadbandDb` (0,5 dB) |
| `off` | — | — | — | — |

Nota de honestidad del propio analizador: la consola entrega **lecturas del vúmetro**, no
la onda. La media de esas lecturas es una media RMS de la **envolvente**; la vía A de LUFS
(filtro K real) exige un *tap* de audio que **hoy no existe**.

**Decisión (`baseVerdict`, `guards.ts`).**

```
si measured ≤ baseSilenceFloorDb (−70)     → "hold"  (silencio)
si samples < 8  ó  coverage < 0,5          → "hold"  (datos insuficientes)
si |delta| ≥ baseMaxCorrectionDb (15 dB)   → "manual" (salto anómalo)
si |delta| < tolerancia                     → "hold"  (dentro de tolerancia)
si no                                       → "act"   (deltaDb = delta)
```

- **Aprendizaje**: en `rms`, la primera lectura usable se convierte en `baseRef`
  (`lastBase = "learned"`); mientras no haya, `"learning"`.
- **Rampa**: una decisión `act` arranca una interpolación de **2 s** (`baseRampMs`) hacia
  el objetivo, `clamp`ed a `[FADER_MIN −90, FADER_MAX +10]`.
- **Bloqueo**: cada `manual` incrementa `baseAnomalies`; a las **3** se marca `baseLocked`
  y se deja de corregir (`lastBase = "locked"`) hasta `POST /channels/:id/arm`.
- **Corrección máxima**: `baseMaxCorrectionDb = 15 dB` (más que eso es un salto, no un
  desajuste).

### 4.2 Stage Guard — gestión de voz y micrófonos abiertos

**Propósito.** Un micro de corista en silencio amplifica la batería. En vez de cortar
(imposible en un previo A/D), **se baja el previo** mientras no hay voz.

**Detección (por canal).**

```
rms = rmsOf(ch.levels, t, windowMs=100)     // media RMS de la envolvente, ventana 100 ms
```

| Parámetro | Defecto | Significado |
| --- | --- | --- |
| `enabled` | `false` | Botón StageGuard de la tira. |
| `threshold` | `−50 dBFS` | Por debajo → "silencio". |
| `duckingDepth` | `10 dB` | Atenuación del previo mientras dura el silencio. |
| `holdMs` | `1000 ms` | Silencio **sostenido** exigido antes de atenuar. |
| `windowMs` | `100 ms` | Ventana de detección (baja latencia). |
| `hysteresisDb` | `3 dB` | Margen para dar la señal por recuperada. |

**Máquina de estados (`stageDecision`).**

```
        señal ≥ threshold + hysteresis
   ┌──────────────────────────────────────────┐
   ▼                                          │
[NO DUCKED] ──silencio < holdMs──► (espera)    │
   │ silencio ≥ holdMs                        │
   ▼                                          │
[DUCKED] ── señal recuperada ─────────────────┘   (restore: inmediato, sin hold)
```

**Diferenciación pausa natural vs. spill sostenido.** No hay clasificación espectral ni
VAD; la distinción es **temporal y de nivel**:

- Una **pausa natural** de voz (< `holdMs`) no dispara nada: hace falta silencio
  **sostenido 1000 ms**.
- Un **spill de fondo sostenido** por encima del umbral mantiene el canal "con señal":
  `stageDecision` devuelve `null` y **no se atenúa**. Sólo un canal realmente frío cae en
  `duck`.
- La **histéresis** (3 dB) evita que una señal que ronda el umbral oscile entre atacar y
  restaurar.

**Rampas (ver §4.3 para la composición).**

- **Atenuar**: `stageRampDb = 1 dB/tick` (10 dB/s → 10 dB en ~1,0 s), suave, sin cortar.
- **Restaurar**: `stageRestoreDb = 5 dB/tick` (50 dB/s → ~200 ms por 10 dB), **sin hold**
  y **sin esperar al cooldown**: `stageChanged = decision === "restore" || t >= cooldownUntil`.
- Apagar el botón de un canal atenuado **restaura** su previo: nunca se queda atenuado sin
  control.

### 4.3 PreGuard — protección del conversor A/D

**Propósito.** Un canal con dinámica sostenida que roza el techo del A/D. El convertidor ya
no puede recortar hacia arriba, así que se baja el previo de forma **preventiva y gradual**.

**No hay prioridad absoluta.** PreGuard no fija un valor absoluto del previo: calcula
**cuánto** quiere atenuarlo (`preOffset ≥ 0`) y el motor lo compone con Stage Guard en un
**objetivo único**:

```
preOffsets (PreGuard)  ─┐
                        ├─►  headamp = clamp(nominalGain + stageOffset − preOffset, −12, +60)
stageOffset (Stage)    ─┘                    0 | −duckingDepth
```

Al existir **un solo emisor** sobre el previo, las dos guardas no pueden entablar un bucle
de ajustes.

| Parámetro | Defecto | Significado |
| --- | --- | --- |
| `enabled` | `false` | Botón PreGuard de la tira (verde). |
| `ceilingDb` | `−3 dBFS` | Nivel sostenido desde el que se protege. |
| `hysteresisDb` | `3 dB` | Margen por debajo del techo para dar el nivel por recuperado. |

**Nivel sostenido** para PreGuard: `rmsOf(ch.levels, t, 1000)` — una ventana de **1 s**.

**Acumulación / liberación (`preDecision`).**

- Nivel sostenido **> techo** → `preOffset += preStepDb (0,5)`, tope `preMaxOffsetDb (18)`.
  Es un ajuste **automático**: respeta el **cooldown** de 2,5 s → 18 dB tardan ~18 ciclos
  ≈ **45 s**.
- Nivel **< techo − histéresis** → `preOffset -= preRestoreDb (2)`, sin esperar cooldown →
  liberar los 18 dB en ~0,9 s.
- La **banda muerta** (0,5 dB) descarta pasos que no llegarían a notarse.
- Apagar el botón con desplazamiento lo **libera** igual que una restauración.

> **Sobre el "lockout de 1,5–2,0 s" del encargo:** el código no tiene una ventana dedicada
> de PreGuard. Existe **una** ventana de asentamiento de **1000 ms** (`headampLockSettleMs`)
> que **comparten** Stage Guard y PreGuard y que protege el mando del previo del control
> manual (§5.2). Esa es la cifra real.

### 4.4 BusGuard — subgrupos, matrices y master

**Problema.** Stage Guard y PreGuard ajustan el **previo**. Ese cambio llega también al
envío a bus, así que el **IEM notaría** cada ajuste. La normalización base, en cambio,
actúa sobre el fader y **no** llega al IEM (envío post-EQ).

**Solución.** Por cada canal, BusGuard mide cuánto se ha movido el previo desde su última
compensación y **resta esa misma cantidad** al envío a cada bus afectado:

```
delta  = headamp − compHead                       // busDelta()
target = clamp(knownSend − ratio × delta, sendMin −90, sendMax +10)   // ratio = 1
```

- **Modo stealth**: no añade interfaz nueva; sólo se ve reflejado en la mezcla de cada bus.
- **Cobertura**: sin enlaces declarados, compensa **los 16 buses** (`ALL_BUSES`). El enlace
  por canal (`linkBuses`) sólo sirve para restringir casos concretos.
- **Sin valor conocido no se toca**: sólo compensa buses cuyo envío tenga un valor conocido
  (configurado por `setBusSend` o proveniente de un cambio de la consola). Los desconocidos
  se **omiten** (no se inventan).
- **Sólo el previo**: la base (fader) no se compensa porque no llega al bus.

### 4.4b Coordinación con BusGuard (por qué "no se suman distorsiones")

El criterio acordado (repetido en `types.ts` y el contrato) es:

1. El envío a bus es **post-EQ**: no ve el fader → **BusGuard compensa sólo el previo**.
2. Stage Guard y PreGuard actúan sobre el previo → **BusGuard los ve y los compensa**.
3. La normalización base actúa sobre el fader → **no se compensa**.

Como la compensación de BusGuard se calcula sobre `headamp − compHead` (la variación
**real y observada** del previo, no un valor teórico), absorbe por igual los cambios de
Stage Guard y de PreGuard sin duplicar correcciones.

### 4.5 REARM — pausa con rearme automático

**Propósito.** Dar al operador un botón de "aparta las manos": pausar **toda** la
automatización un plazo fijo, sin perder nada de configuración, y que **vuelva sola**.

**No es un Killswitch.** No corta audio, no silencia nada y no es un estado de emergencia:
es una **pausa del motor** con retorno automático.

**Ciclo de vida.**

```
      clic REARM (POST /rearm {ms?})           plazo agotado (reloj del motor)
IDLE ─────────────────────────────────► HELD ─────────────────────────────► IDLE
  ▲   hold(ms): holdUntil = clock()+ms     tick() hace early-return           (rearme
  │   holdMs = ms                          · NO decide fader/previo/buses       automático)
  │                                        · SÍ ingiere telemetría y cambios
  │                                            (el motor conoce el estado real)
  └──────────────────────────────────────────────────────────────────────────┘
                                             rearm() → holdUntil = 0 (rearme manual)
```

- **Reloj autoritativo: el motor.** `hold()` usa `this.clock()` internamente; la interfaz
  sólo **pinta** la cuenta atrás y se **resincroniza** con `GET /rearm` al abrir el panel,
  por si la página se recargó a mitad de la pausa.
- **Congelación de estado.** Mientras `t < holdUntil`, `tick()` retorna antes de decidir.
  Avanza `lastBaseAt` para que, al rearmar, el análisis de base no vea un "retraso" de 20 s
  acumulado.
- **Conservación total.** `hold()` no toca `ch.base`, ni `stageCfg`, ni `preCfg`, ni
  `nominalGain`, ni `preOffset`, ni `busSends`: sólo el reloj de pausa.
- **Conocimiento real.** Telemetría (`ingestLevels`) y cambios (`ingestChange`) siguen
  entrando durante la pausa, de modo que al rearmar el motor parte del estado real de la
  consola, no de una foto congelada.
- **Valores**: `rearmMs = 20000` (plazo por defecto). `hold(0)` o no finito = rearme
  inmediato. La frontera acepta `0…3600000` (`REARM_MAX_MS`, una hora) y responde `400`
  fuera de rango.

```ts
hold(ms?: number): RearmState {
  const dur = ms === undefined ? this.cfg.rearmMs : ms;
  if (!Number.isFinite(dur) || dur <= 0) return this.rearm();  // 0 = rearme inmediato
  this.holdMs = dur;
  this.holdUntil = this.clock() + dur;
  return this.rearmState();
}

rearm(): RearmState { this.holdMs = 0; this.holdUntil = 0; return this.rearmState(); }

rearmState(): RearmState {
  const t = this.clock();
  const held = t < this.holdUntil;
  return { held, remainingMs: held ? this.holdUntil - t : 0, totalMs: held ? this.holdMs : 0 };
}
```

---

## 5. Supresión de eco y aislamiento de estado

### 5.1 El bucle de control y por qué hay que romperlo

```
   GainGuard ──escribe──► consola X32 ──devuelve el valor──► ¿"cambio humano"?
        ▲                                                        │
        │  si se toma como humano, la guarda reacciona a su eco   │
        └──────────────────── BUCLE DE CONTROL ◄─────────────────┘
```

El protocolo OSC no admite metadatos que digan "esto lo escribió CueDesk". La solución
**no** vive en el motor: vive en el **driver**.

### 5.2 Origen y lockout (dos protecciones complementarias)

1. **Eco (`origin`)**: el driver recuerda lo que escribió y marca su devolución como
   `origin: "self"`. El motor, en `ingestChange`, **descarta** ese cambio:
   `reason: "own-echo"`. (Existe además la vía HTTP `POST /api/gainguard/console` con
   `origin: "self"`, por completitud; el camino real es el driver.)
2. **Lockout del control manual** (`headampLockSettleMs = 1000 ms`): mientras una guarda
   está moviendo el **previo**, si llega un cambio **humano** del mismo canal dentro de la
   ventana, el motor **descarta el valor humano y reafirma el suyo** en la consola
   (`reason: "guard-locked"`, con un `emit` `"guard-lock"`). Así el operador y el
   automatismo no se pelean por el mismo mando y la consola no se queda en un valor que el
   motor desconoce.

### 5.3 La ventana de 500 ms (en el driver)

```ts
const DEFAULT_ECHO_WINDOW_MS = 500;

private write(path, wire, type, tol) {
  const at = this.clock();
  this.prune(at);                                       // olvida > echoWindowMs
  this.pending.push({ path, wire, at, tol });           // recuerda lo escrito
  this.link.send(path, wire, type);
  this.sentCount++;
}

private consumeEcho(path, wire, at) {
  this.prune(at);
  const i = this.pending.findIndex(p =>
    p.path === path && Math.abs(p.wire - wire) <= p.tol);   // ruta + valor (±tol)
  if (i < 0) return false;
  this.pending.splice(i, 1);
  this.echoCount++;
  return true;                                          // es eco → se descarta
}
```

- **Ventana**: 500 ms (`echoWindowMs`). Fuera de ella, una devolución es un gesto humano.
- **Tolerancia**: `WIRE_TOLERANCE.headamp` para el previo (admite el **redondeo de 0,5 dB**
  de la consola) y `WIRE_TOLERANCE.fader` para faders/envíos.
- **Coincidencia por (ruta, valor)**, no por tiempo exacto: robusto al jitter de la red.
- **Métricas**: `linkStatus()` expone `sent`, `echoesDropped`, `pending`, `echoWindowMs`.

### 5.4 Aislamiento de estado: cada valor tiene un dueño

| Magnitud | Dónde vive | Quién manda |
| --- | --- | --- |
| Fader | `ch.fader` | Base (rampa) · cambio humano si no hay lockout. |
| Previo (valor actual) | `ch.headamp` | Objetivo único (Stage+Pre) · cambio humano si no hay lockout. |
| Referencia del operador (sin guardas) | `ch.nominalGain` | Se **reajusta** con cada cambio humano, descontando lo que las guardas tenían aplicado. |
| Desplazamiento PreGuard | `ch.preOffset` | PreGuard (acumulado ≥ 0). |
| Estado de ducking | `ch.stage.ducked` | Stage Guard. |
| Base de BusGuard | `ch.compHead` | BusGuard (última compensación). |
| Envío conocido por bus | `ch.busSends` | Configuración · cambio humano. |

Un cambio manual del previo, al llegar, **reencuadra la referencia** para no deshacer lo que
las guardas tenían aplicado:

```ts
const stageOff = ch.stage.ducked ? -ch.stageCfg.duckingDepth : 0;
ch.nominalGain = change.db - stageOff + ch.preOffset;   // conserva el desplazamiento vigente
ch.headamp = change.db;
```

---

## 6. Interfaz de usuario (`apps/cuebox` + front)

### 6.1 Pantalla GainGuard (`js/app.js`, `#gg-panel`)

- Cabecera en tres zonas: **Preamp Block** (izq.), título **GainGuard®** (centro),
  **BusGuard + REARM** (der.).
- Por canal: botón **StageGuard** (cian apagado / ámbar encendido) sobre el conmutador
  **RMS/LUFS**; botón **PreGuard** (cian apagado / verde encendido) y desplegable de
  **umbral** (Off · ±3/±5 dB · −18/−23 LUFS).
- Al cargar, los 32 canales se sincronizan en una petición (`POST /config`), con la
  pantalla como referencia.

### 6.2 Botón REARM (front)

- El reloj **vive en el motor**; el frontend sólo pinta. `ggRearmStart()` hace
  `POST /rearm {ms: 20000}` y `ggRearmCountdown(state.remainingMs)`.
- Etiqueta `REARM (20s)`… `REARM (0s)` mientras `held`; al volver a 0, **no envía nada**
  (el motor ya se rearmó solo).
- `setOpen(true)` → `ggRearmSync()` (`GET /rearm`) para continuar una pausa viva tras una
  recarga.
- Estilo: rojo `var(--red)` con `is-held`; punto pulsante (`@keyframes gg-rearm-pulse`);
  `aria-pressed` para accesibilidad.

### 6.3 Fader lockout transparente en el mixer (`js/mixer.js`)

El mixer **no** decide: pregunta quién está bloqueado y lo refleja.

- `pollGainLocks()` · cada **1 s** → `GET /api/gainguard/locks` →
  `{ locks, baseLocked, sources }`.
- En **modo GAIN** (el fader es el previo), un canal con `lock.active` recibe la clase
  `is-guardlocked`: `pointer-events: none` + `aria-disabled="true"` y un rótulo **LOCK** en
  ámbar. En modo nivel el fader no se toca (no es el previo).
- Un canal con **bloqueo base** (`baseLocked`) recibe el rótulo **BASE** (ámbar) con una
  **×** que dispara `POST /api/gainguard/channels/:id/arm`. Persistente hasta que el
  operador lo levante.
- `applyPreampSources()` fija el banco de previo de cada bloque (Local / AES50 A / AES50 B)
  para que la vista GAIN apunte al mismo `/headamp`.
- **Vúmetros**: `pollEngineMeters()` (~8 Hz) → `GET /api/gainguard/meters`; en modo GAIN el
  vúmetro muestra la **entrada del previo**, no el nivel de mezcla.

### 6.4 Global Standby / Killswitch — **no existen**

Búsqueda en `index.html`, `js/*.js`, `css/*.css`, `docs/*.md` y `packages/**/*.ts` de
`killswitch|kill switch|panic|standby|mute.?all|muteAll`: **0 coincidencias**.

Por tanto **no hay** un Killswitch global, un "mute-all" ni un estado de standby con el que
GainGuard interactúe. Los **únicos** controles de alcance global hoy son:

| Control | Alcance | Efecto |
| --- | --- | --- |
| **BusGuard** (OFF/ON en la cabecera) | global | Enciende/apaga la compensación de buses. **No** activa base, Stage ni Pre. |
| **REARM** | global (pausa) | Detiene las decisiones 20 s y se rearma solo. **No** corta audio. |

Si se quisiera un Killswitch real (silenciar todas las salidas / congelar la consola), sería
un módulo **nuevo** con su propio contrato en el driver; no debe confundirse con REARM.
**Recomendación:** mantener REARM como pausa y, si se añade Killswitch, exponerlo como un
`ControlChange` de dominio (una nueva `kind`) para no romper la abstracción.

---

## 7. Estructuras de datos, DTOs y ciclo de eventos

### 7.1 Tipos de dominio (`@cuedesk/console-adapter`)

```ts
export type ChannelId = string;                 // "ch.01" … "ch.32"
export type BusId = number;                     // 1…16

export type PreampKind = "headamp" | "trim" | "none";
export type ChangeOrigin = "console" | "self";  // humano vs. eco de CueDesk

export type ControlTarget =
  | { kind: "preamp"; channel: ChannelId }
  | { kind: "fader";  channel: ChannelId }
  | { kind: "send";   channel: ChannelId; bus: BusId };

/** Cambio observado en la consola, ya traducido a dominio. */
export interface ControlChange {
  target: ControlTarget;
  db?: number;      // dB para previo, fader y envío
  on?: boolean;     // phantom (+48 V) cuando el objetivo es el previo
  origin: ChangeOrigin;
}

export interface LevelReading { channel: ChannelId; db: number; }
export interface LevelFrame   { levels: LevelReading[]; at?: number; }

export interface PreampBank { id: string; label: string; firstIndex: number; count: number }

export interface ConsoleCapabilities {
  channels: number;
  buses: number;
  preamp: PreampKind;
  sendsArePostEq: boolean;   // criterio de BusGuard
  preampBanks: PreampBank[];
}
```

### 7.2 Estado del motor (`@cuedesk/core`)

```ts
export type ControlKind = "fader" | "headamp" | "send";
export type BaseMode    = "off" | "rms" | "lufs";

export interface RearmState { held: boolean; remainingMs: number; totalMs: number; }

export interface BaseConfig     { mode: BaseMode; threshold: number; }
export interface StageGuardConfig {
  enabled: boolean; threshold: number; duckingDepth: number;
  holdMs: number; windowMs: number; hysteresisDb: number;
}
export interface PreGuardConfig { enabled: boolean; ceilingDb: number; hysteresisDb: number; }
export interface BusGuardConfig { enabled: boolean; ratio: number; }   // ratio 0…1

export interface EngineConfig { /* todos los valores de §8 */ }

export interface ChannelRuntime {
  id: string; num: number;

  // base (fader)
  base: BaseConfig; baseAnalyzer: unknown; baseRef: number | null;
  baseRamp: BaseRamp | null; baseAnomalies: number; baseLocked: boolean; lastBase: string | null;

  // último valor conocido
  fader: number | null; headamp: number | null;

  // guardas sobre el previo
  nominalGain: number | null;               // referencia del operador (sin guardas)
  stageCfg: StageGuardConfig; preCfg: PreGuardConfig;
  stage: { silentSince: number | null; ducked: boolean; target: number | null };
  preOffset: number;                        // atenuación acumulada ≥ 0

  // BusGuard
  busLinks: number[]; busSends: Map<number, number>; compHead: number | null;

  cooldownUntil: number; headampLockUntil: number; levels: LevelSample[];
}
```

### 7.2b Definiciones de umbral (configuración)

```ts
export interface BaseConfig     { mode: "off" | "rms" | "lufs"; threshold: number; }
export interface StageGuardConfig { enabled: boolean; threshold: number; duckingDepth: number;
                                    holdMs: number; windowMs: number; hysteresisDb: number; }
export interface PreGuardConfig { enabled: boolean; ceilingDb: number; hysteresisDb: number; }
export interface BusGuardConfig { enabled: boolean; ratio: number; }
```

`threshold` en `rms` = tolerancia (3/5 dB, se toma valor absoluto); en `lufs` = objetivo
(−18/−23). `ceilingDb` = techo de PreGuard. Cambiar de modo resetea analizador, referencia,
anomalías y rampa (`configureBase`).

### 7.3 DTOs de la frontera HTTP (`packages/core/src/api.ts`)

```ts
// POST /api/gainguard/rearm — tipo REAL exportado por el motor.
interface RearmRequest { ms?: number; }             // omitido → motor usa rearmMs (20 s)
const REARM_MAX_MS = 3600000;                        // 0…1 h; fuera de rango → 400

// POST /api/gainguard/console — forma del cuerpo (documentada, no tipo exportado).
interface ConsoleChangeRequest {
  channel: string;                         // "ch.01"
  kind: "fader" | "send" | "preamp" | "headamp";
  bus?: number;                            // exigido si kind === "send" (1…16)
  db?: number;
  on?: boolean;                            // phantom
  origin?: "console" | "self";             // "self" → se descarta como eco
}

// POST /api/gainguard/meters
interface MetersRequest { levels: number[];  ts?: number; }   // exactamente 32 valores (dB)

// POST /api/gainguard/config — forma de la pantalla
interface ConfigRequest {
  bus?: Partial<BusGuardConfig>;
  channels?: Array<{
    id: string;
    mode?: "off" | "rms" | "lufs";
    threshold?: number | string;           // "±5 dB" | "off" | -18 …
    stage?: Partial<StageGuardConfig>;
    pre?: Partial<PreGuardConfig>;
    source?: string;                       // banco de previo (driver): "local" | "aes50a" | "aes50b"
    buses?: number[];
  }>;
}

// Respuestas notables
interface LocksResponse   { locks: string[]; baseLocked: string[]; sources: Record<string, string>; }
interface MetersResponse  { levels: Array<{ channel: string; db: number }>; at: number; }
interface IngestResult    { accepted: boolean;
                            reason: "external" | "own-echo" | "guard-locked"
                                  | "unknown-channel" | "not-a-level"; }
```

### 7.4 Ciclo de eventos

```
consola X32 ──OSC──► oscEngine (ConsoleLink) ──► X32Adapter
                                                   │  consumeEcho? ──sí──► descarta (eco)
                                                   │  no
                                                   ▼
                          ControlChange { target, db?, on?, origin:"console" }
                                                   │
                                                   ▼
                     GainGuardEngine.ingestChange()  ──►  ACTUALIZA ESTADO
                                                   │      (no decide)
   telemetría /meters/1 ──► ingestLevels() ────────┘

   ... 100 ms ...   GainGuardEngine.tick()
        └─ (REARM held? return) → base → stage+pre(objetivo único) → bus
                                      │
                                      ▼
                            emit() ──► adapter.setPreampGain / setChannelFader / setChannelSend
                                      │        (el driver registra el eco)
                                      └─► recentEmits() (auditoría, máx. 500)
```

---

## 8. Referencia de constantes

### 8.1 `EngineConfig` (`DEFAULT_ENGINE`, `types.ts`)

| Constante | Valor | Uso |
| --- | --- | --- |
| `tickMs` | 100 ms | Periodo del ciclo. |
| `deadbandDb` | 0,5 dB | Ajuste mínimo emitible. |
| `cooldownMs` | 2500 ms | Frenado tras una bajada automática de previo. |
| `rearmMs` | 20000 ms | Plazo por defecto de la pausa REARM. |
| `stageRampDb` | 1 dB/tick | Ataque de Stage Guard (≈10 dB/s). |
| `stageRestoreDb` | 5 dB/tick | Restauración de Stage Guard (≈50 dB/s). |
| `preStepDb` | 0,5 dB/ciclo | Paso de PreGuard al proteger. |
| `preRestoreDb` | 2 dB/tick | Paso de PreGuard al liberar. |
| `preMaxOffsetDb` | 18 dB | Tope del desplazamiento de PreGuard. |
| `headampLockSettleMs` | 1000 ms | Lockout del control manual del previo. |
| `headampMin` | −12 dB | Suelo del previo. |
| `sendMin` / `sendMax` | −90 / +10 dB | Rango del envío a bus. |
| `levelRetainMs` | 2000 ms | Retención de telemetría. |
| `baseCadenceMs` | 10000 ms | Cadencia del análisis de base. |
| `baseRampMs` | 2000 ms | Duración de la rampa de fader. |
| `baseMaxCorrectionDb` | 15 dB | Salto considerado anómalo. |
| `baseAnomalyLimit` | 3 | Anomalías para bloquear la base. |
| `baseSilenceFloorDb` | −70 dBFS | Suelo de silencio. |
| `baseMinSamples` / `baseMinCoverage` | 8 / 0,5 | Datos mínimos para decidir. |

### 8.2 Constantes de módulo (`gainGuardEngine.ts`) y defaults

| Constante | Valor | Nota |
| --- | --- | --- |
| `RMS_WINDOW_MS` | 10000 ms | Ventana del analizador RMS. |
| `LUFS_WINDOW_MS` | 3000 ms | Ventana del analizador LUFS (short-term R128). |
| `FADER_MIN` / `FADER_MAX` | −90 / +10 dB | Rango de fader. |
| `HEADAMP_MAX` | +60 dB | Techo del previo (con `headampMin`). |
| `ALL_BUSES` | 1…16 | Buses por defecto de BusGuard. |
| `DEFAULT_BASE` | `{ off, 5 }` | Base por defecto. |
| `DEFAULT_STAGE` | `{ false, −50, 10, 1000, 100, 3 }` | Stage por defecto. |
| `DEFAULT_PRE` | `{ false, −3, 3 }` | PreGuard por defecto. |
| BusGuard default | `{ enabled:false, ratio:1 }` | — |
| `DEFAULT_ECHO_WINDOW_MS` (driver) | 500 ms | Ventana de supresión de eco. |

### 8.3 Rutas HTTP

| Método y ruta | Cuerpo | Devuelve |
| --- | --- | --- |
| `GET /api/gainguard` | — | Estado completo decorado (`source`, `headampIndex`). |
| `GET /api/gainguard/channels/:id` | — | Un canal. |
| `GET /api/gainguard/locks` | — | `{ locks, baseLocked, sources }`. |
| `GET /api/gainguard/meters` | — | `{ levels:[{channel,db}], at }` (sondeo). |
| `POST /api/gainguard/config` | ConfigRequest | `{ status }`. |
| `POST /api/gainguard/meters` | `{ levels:[32], ts? }` | `{ accepted }` (409 si ≠ 32). |
| `POST /api/gainguard/console` | ConsoleChangeRequest | `IngestResult`. |
| `POST /api/gainguard/send/:id` | `{ bus, db }` | Canal actualizado. |
| `POST /api/gainguard/channels/:id/arm` | — | `{ armed: true }`. |
| `GET /api/gainguard/rearm` | — | `RearmState`. |
| `POST /api/gainguard/rearm` | `{ ms? }` | `RearmState` (400 fuera de `0…3600000`). |
| `GET /api/console/status` | — | `linkStatus()` del driver. |
| `POST /api/console/osc` | `{ address, args?, value?, type? }` | `{ ok, address }` (puente del front). |

---

## 9. Cobertura de pruebas

Runner: `npm test` → `node --test "packages/*/test/*.test.ts"`. Estado actual: **90/90**.

| Área | Fichero | Qué cubre |
| --- | --- | --- |
| Motor | `packages/core/test/engine.test.ts` | Pipeline, rampas, cooldown, banda muerta, anomalías/bloqueo base, single-target de previo, REARM (pausa, auto-rearme, config intacta). |
| API | `packages/core/test/api.test.ts` | `mountSuiteRoutes`: todas las rutas, validación y errores (incl. `/rearm` GET/POST). |
| Driver | `packages/console-x32/test/*.test.ts` | Taper, rutas, bancos de previo, **supresión de eco**. |

Las pruebas del motor usan un reloj inyectado (`EngineOptions.now`) y un adaptador espía,
de modo que el REARM y las rampas son **deterministas** (sin `setTimeout` real).

---

## 10. Lagunas conocidas y hoja de ruta

| # | Laguna | Impacto | Dirección |
| --- | --- | --- | --- |
| 1 | **Puente en tiempo real ausente** | Los vúmetros se **sondean** por HTTP; el front viejo intenta `ws://localhost:8080`, que **no existe**. | Empujar `adapter.onLevels` + cambios de consola a la interfaz por WebSocket/SSE; enrutar las escrituras del front legado por `POST /api/console/osc`. |
| 2 | **`/meters/1`: lineal/dB** | El driver convierte correctamente, pero el envío de 32 valores y la correspondencia con canales están **sin verificar con hardware**. | Probar con X32 real; fijar contrato de la trama. |
| 3 | **Sin Killswitch/Standby** | No existe el sistema que pedía el encargo. | Diseñarlo como nuevo `ControlChange` de dominio si se requiere (§6.4). |
| 4 | **Eco real sin verificar** | La longitud de la ventana (500 ms) y la tolerancia son valores de diseño. | Medir latencia de eco real en hardware. |
| 5 | **PreGuard cadencia larga** | 18 dB de protección tardan ~45 s (0,5 dB por cooldown de 2,5 s). | Revisar si el caso de uso exige una rampa de protección más rápida. |

---

*Fin de la especificación. Todos los parámetros son trazables a constantes del código fuente
citadas; donde el encargo difería de la implementación, se ha documentado la implementación
(§0.4).*
