# Changelog — CueDesk

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Versionado semántico (SemVer): `MAJOR.MINOR.PATCH`.

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
