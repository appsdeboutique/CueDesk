# Changelog — CueDesk

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Versionado semántico (SemVer): `MAJOR.MINOR.PATCH`.

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
