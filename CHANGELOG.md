# Changelog — CueDesk

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Versionado semántico (SemVer): `MAJOR.MINOR.PATCH`.

## [1.0.9] — 2026-10-09

### Changed
- **Escala del fader (canales)**: se separa del carril. Se elimina el hueco de 5 px a la derecha del carril (padding del fader `12px 5px 8px 0` → `12px 0 8px`), con lo que la escala pasa de **2 a 7 px de aire** respecto al carril y su banda crece de ~12.5 a ~16.5 px (todas las etiquetas caben dentro de la tira).
- **Vúmetros (≤1440 px)**: se reduce ligeramente su padding lateral (6 → 4 px) para ceder ancho a la columna del fader.

### Verified
- 1296 px: franja de escala 16.5 px con 7 px de aire al carril y sin desbordar la tira; pomo del master dentro de su carril; sin scroll X; 0 errores (salvo WebSocket sin X32).

## [1.0.8] — 2026-10-09

### Changed
- **Pomo del fader**: anchura 22 → 26 px para igualar el **ancho del relleno** (todo el carril), manteniendo la forma horizontal (26 × 12 px) y el centrado.

### Verified
- Navegador: pomo y relleno a 26 px (coinciden); pomo centrado dentro del carril; sin scroll X.

## [1.0.7] — 2026-10-09

### Changed
- **Pomo del fader en horizontal**: pill blanca 22 × 12 px (`border-radius: 999px`), sin marca, centrada y **dentro del carril** (2 px de margen a cada lado).
- **Carril del fader más ancho**: 16 → 26 px (ranura interior 5 → 8 px, radio 4 px).
- **Escala del fader**: margen derecho ajustado (23 → 33 px) a la nueva anchura del carril (2 px de aire).

### Verified
- Navegador: carril 26 px; pomo 22×12 px dentro del carril y centrado; `::after` = `none`; master con el mismo pomo; recorrido `rgb(0, 192, 206)` y `rgb(255, 193, 44)` en GAIN; 2 px escala↔carril; sin scroll X; 0 errores (salvo WebSocket sin X32).

## [1.0.6] — 2026-10-09

### Changed
- **Fader**: el pomo pasa a ser una **pill blanca sin marca** (`border-radius: 999px`, se elimina la línea indicadora `::after`) y queda **dentro del ancho del carril** (pomo y carril a 16 px, centrados).
- **Carril del fader +15 %**: ancho 14 → 16 px (y ranura interior 4 → 5 px).
- **Parte recorrida del fader pintada**: del fondo del carril al centro del pomo, en cian `#00C0CE` para todas las tiras de canal y el master, y en ámbar `#FFC12C` en el modo GAIN.
- **Escala del fader**: se ajusta el margen derecho (29 → 23 px) a la nueva geometría del carril/pomo (2 px de aire).

### Verified
- Navegador: carril 16 px, pomo 16×22 px `border-radius: 999px`, `::after` = `none`; recorrido computado `rgb(0, 192, 206)` (canal y master) y `rgb(255, 193, 44)` en GAIN; 0 dB de GAIN en 1/6 (24/144); 2 px entre escala y carril; sin scroll X.

## [1.0.5] — 2026-10-09

### Changed
- **Viewbar**: solapas +10 % en vertical (`height` 36 → 40 px) y +30 % en horizontal (`padding` 0 26 → 0 34 px).
- **Globalbar**: borde del mismo color que el fondo (invisible) y glow **exterior** (sin inset) en cian `#00C0CE`.
- **Bankrail**: botones sin fondo; borde y texto `#00C0CE` en reposo y `#FFC12C` cuando el banco está activo (incluye el botón GAIN y la pastilla lateral).
- **Botones M/S de tira**: sin fondo, borde y texto `#00C0CE` en reposo; Solo activo `#FFC12C` y Mute activo `#FF4D43`.
- **Strip master**: capa de color `#00C0CE` al 25 % de transparencia sobre el degradado base.

### Added
- Tokens `--gold: #ffc12c` (estado activo) y `--red-hi: #ff4d43` (mute activo).

### Verified
- Navegador a 1296×886: 0 errores de consola; sin scroll X/Y; glow del globalbar sólo exterior; colores computados `rgb(0, 192, 206)` / `rgb(255, 193, 44)` / `rgb(255, 77, 67)`.

## [1.0.4] — 2026-10-08

### Added
- **Viewbar como tab-bar continua**: la barra de vistas pasa a ser una tira unida de solapas `.tab` (gap 0, radio sólo arriba `4px 4px 0 0`, sin box-shadow); la solapa activa se funde con el panel y se remata con una pastilla superior. Orden: Mixer · Setup · Routing · Meter · Scenes · Queue (`disabled`).
- **Escala impresa del fader de mezcla** (`+10 / 0 / -20 / -40 / -60 / -∞`), derivada del taper X32.
- **Escala del modo GAIN** con marcas cada 12 dB.

### Changed
- **Modo GAIN en canales = ganancia de entrada (headamp)**: el fader controla `/headamp/NNN/gain` con recorrido lineal **-12 … +60 dB** y paso de 0.5 dB (Maillot: `linf [-12, 60, 0.5]`; `NNN` = nº de canal − 1, 3 dígitos), con escala `+60 / +48 / +36 / +24 / +12 / 0 / -12`. En el banco **AUX** se conserva el trim digital (`/auxin/NN/preamp/trim`, -18…+18 dB, paso 0.25) porque las entradas aux no exponen headamp.
- **Escala GAIN en el mismo color que las demás**: se elimina el tinte ámbar de `.fader__scale.is-gain` (ahora `--text-faint`); el readout numérico sigue en ámbar.
- **Cian unificado `#00C0CE`** (rgb 0,192,206): tokens (`--cyan`, `--cyan-bright`, `--cyan-glow`, `--cyan-tint`, `--glow-cyan`) y todos los literales hex/`rgba` de la interfaz, incluida la página suelta `Access.html`.
- **Núcleo de tira**: vúmetro (mono en canales, dual en master) y fader en paralelo; el vúmetro recorre -∞…0 dB (0 dB = tope, 75 % del carril del fader) y su escala impresa ya no incluye `+10`.
- **Niveles de vúmetro lineal→dB** (Maillot: float lineal 0…1, 1.0 = 0 dBFS).

### Verified
- Navegador a 1296×886 con `?view=mixer&ws=off`: 0 errores de consola; cian computado `rgb(0, 192, 206)`; escala headamp `+60 … -12` con `0` en norm 1/6; teclado/rueda → `cuedesk:osc-out` con `/headamp/000/gain` en saltos de 0.5 dB; AUX → `/auxin/01/preamp/trim`; FX sin modo GAIN.

## [1.0.3] — 2026-10-08

### Added
- **Arquitectura desacoplada por WebSocket**: nuevo `js/websocketClient.js` como único módulo de red (JSON de ida y vuelta, backoff exponencial 600 ms → 30 s con jitter del 25 %, heartbeat 15 s, detección de enlace muerto a 35 s y cola deduplicada por dirección). Endpoint por prioridad `?ws=…` → `localStorage["cuedesk.ws.url"]` → `window.CUEDESK_WS_URL` → `ws://localhost:8080`; `?ws=off` lo desactiva.
- **Bus OSC puro**: `js/osc.js` deja de hacer red — publica `cuedesk:osc-out` con payload `{ "action": "osc_send", "address": "/ch/01/mix/fader", "args": [0.75] }` y expone `CueDesk.OSC.receive(ruta, valor)` para la entrada genérica.
- **Chip de enlace Online/Offline** en el header con panel `#conn-panel` (endpoint editable), pintado con el evento `cuedesk:link`.
- **Logotipo oficial** en la esquina superior izquierda: `assets/CueDesk_logo.png` (469×104, fondo transparente, tinta cian) con precarga en el `<head>`, sustituyendo al SVG + wordmark.
- **Lanzador local**: `CueDesk_Mixer.bat` + `server.js` (servidor estático Node sin dependencias, puerto 8765, `no-cache`, defensa contra *path traversal*) para arrancar la app en modo Mixer; opciones `--bridge` y `--port`.
- **Vista inicial por URL**: `?view=mixer | queue | routing | scenes`.
- `docs/ARQUITECTURA.md`: análisis de arquitectura en 4 bloques (Driver Pattern, optimización del puente en la Raspberry Pi, escenas multi-marca en USF, hoja de ruta F0–F5 y top-3 de riesgos).

### Changed
- **Barra global (subheader)**: flex sin posicionamiento absoluto, `.gb-center` centrado con auto-margins, gaps independientes por grupo (14 px base; 10/8/6/8 internos) y `white-space: nowrap` en píldoras, sync, AUTOMIX y CLEAR SOLO.
- **Panorama minimalista**: desaparece la cabecera con la etiqueta estática "PAN" y su lectura; sólo queda el slider horizontal compacto con la marca "C" centrada debajo (el valor sigue disponible en `aria-valuetext`).
- **Espaciado vertical**: `--pan-h` de 46 a 36 px; las 10 px liberadas las absorben vúmetros y fader (recorrido de fader +10 px).
- Cabeceras de tira uniformes con `--head-h: 44px` y `.strip--master .strip__display` centrado.

### Fixed
- **Solape talkback ↔ AUTOMIX**: holgura medida de 234 px y huecos laterales simétricos de 140 px en la barra global (antes el deslizador pisaba la etiqueta).
- **"AUTOMIX" partida o recortada**: `scrollWidth == clientWidth` en todos los grupos de la barra global y scroll horizontal oculto.
- **Alineación entre tarjetas**: vúmetros, recorrido del fader, readout y botones M/S arrancan a la misma Y en las 9 tiras (canales, master y huecos `.strip__gap`), incluidos los bancos sin panorama.
- Desfase de 0 px entre el recorrido del panorama y la marca "C" en los 8 canales.

### Verified
- Consola con 0 errores y 0 avisos en Mixer, Queue, Routing y Scenes.
- Medición en navegador a 1296×886: logo 126,3×28 px con 342,8 px de holgura hasta las pestañas; sin scroll X/Y; estilos base `#121214` / `#1e1e24` / `#26262e` / radio 10 px.

## [1.0.2] — 2026-10-07

### Added
- Insignia de versión **v1.0.2** en el pie de página de la interfaz (junto al texto literal de copyright).
- Regla CSS `.segmented.is-live` para el grupo de talkback cuando el destino es A o B (antes la clase la aplicaba JS sin estilo asociado).
- `CHANGELOG.md` como registro histórico de versiones.

### Changed
- **Fader de ganancia (modo GAIN)**: recorrido con pasos de 0.5 dB (`snap: 1/72`) y valor OSC redondeado a 0.5 dB en `/ch|/auxin/NN/preamp/trim`.
- **Panorama**: valor OSC redondeado a paso entero (`Math.round`) — el protocolo X32 define `linf [-100 … +100, 2]`.
- **Datos de demostración**: mudo/solo de ejemplo únicamente en el banco *Ch 1-8*; el resto de bancos (Ch 9-32, AUX, FX, DCA, Bus Mtx) arrancan limpios.

### Fixed
- **Vúmetros fantasma en el master**: `Meters.register()` limpia ahora los segmentos encendidos de registros anteriores; el master no se reconstruye al cambiar de banco y conservaba LEDs activos.
- **Atributos OSC**: los botones de talkback declaraban `data-osc-value` en lugar del atributo documentado `data-state-value`.
- Revisado y corregido el redondeo de conversión de pan y trim en `js/mixer.js`.

### Verified
- Verificación automatizada en navegador: 0 errores / 0 warnings de consola.
- Auditoría de atributos: los 41 controles de consola declaran `data-osc-path` + `data-osc-address` + `data-osc-type`.
- Layout sin desbordes ni scroll a 1000×700 y 1296×886; interacción probada (faders, rueda, teclado, mute/solo, bancos, GAIN, master, talkback, automix, tabs, CLEAR SOLO).

## [1.0.1] — 2026-10-03

### Added
- Versión inicial del proyecto: consola FOH dark-mode estilo X32-Edit / Mixing Station.
- Estructura multi-fichero: 5 CSS (`tokens`, `base`, `header`, `banks`, `strips`) + 5 JS (`osc`, `controls`, `meters`, `mixer`, `app`) con namespace `window.CueDesk`.
- Rack de 8 tiras de canal con capas de banco (Ch 1-8 / 9-16 / 17-24 / 25-32, AUX, FX, DCA, Bus Mtx), master Main LR y modo GAIN.
- Bus OSC con throttle/commit y rutas semánticas X32 (`/ch/NN/mix/fader`, `/ch/NN/mix/on`, `/ch/NN/mix/pan`, `/main/st/mix/fader`, `/-stat/solosw/<id>`, `/config/talk/…`, `/config/amixenable/…`).
- Taper oficial fader↔dB del apéndice X32 (4 tramos) y vúmetros LED duales con ballistics y peak hold.
- Header fijo con tabs, badge X32, LED Online; barra global con LOCAL PREVIEW, sync, talkback, AUTOMIX y CLEAR SOLO.
