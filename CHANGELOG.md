# Changelog — CueDesk

Formato basado en [Keep a Changelog](https://keepachangelog.com/es/1.1.0/).
Versionado semántico (SemVer): `MAJOR.MINOR.PATCH`.

## [1.0.24] — 2026-10-15

### Added
- **Motor GainGuard** (`backend/suite`, TypeScript): control automático sobre OSC con un ciclo estricto de 100 ms y un pipeline en orden fijo —normalización base (fader), Stage Guard y PreGuard (previo) y BusGuard—. Banda muerta de 0,5 dB, cooldown de 2,5 s por canal y descarte de ecos de lo escrito por CueDesk.
- **Normalización base**: RMS cada 10 s en canales de micro/línea y objetivo fijo LUFS en pistas, con corrección por rampa de 2 s. Ignora desviaciones por debajo del umbral del selector (±3 dB, ±5 dB, −18 LUFS, −23 LUFS) y descarta saltos anómalos (> 15 dB) bloqueando el canal tras tres avisos, que se levantan desde la API.
- **Stage Guard** (*ducking*): con el canal en silencio el tiempo de *hold*, baja el previo 10 dB —la señal nunca se corta—. La restauración es inmediata (5 dB por ciclo, ~200 ms), no espera al cooldown, detecta la voz en 100 ms y usa una histéresis de 3 dB para no oscilar. Apagar el StageGuard de un canal atenuado le devuelve el previo.
- **PreGuard**: protección preventiva del previo. Con dinámica sostenida por encima del techo (−3 dBFS) baja el previo poco a poco (0,5 dB por ciclo de cooldown) y lo libera con una histéresis de 3 dB cuando el nivel cede. Con un **objetivo único** para el previo, Stage Guard y PreGuard componen sus desplazamientos sobre una misma referencia y conviven sin bucles. **BusGuard** (modo *stealth*): compensa en **los 16 buses** la variación del **previo** —nunca el fader— para que el IEM no note los ajustes; es el interruptor maestro de cabecera y no exige declarar qué buses alimenta cada canal.
- **Bloqueo del control manual del previo**: mientras Stage Guard o PreGuard están moviendo el previo de un canal, el motor descarta el cambio manual que llegue y **reafirma su valor** en la consola —hasta 1 s después del último ajuste— para que la mano humana y el automatismo no se peleen por el mismo mando. El estado se expone por canal en `lock`.
- **API REST de la suite** (`/api/gainguard`): estado completo, configuración de BusGuard y de cada canal, telemetría de 32 canales, entrada de consola, envío a bus, consulta de canales bloqueados y desbloqueo de canal. Documentada en `docs/GAINGUARD.md`.
- **Guardas por canal**: dos botones por tira en la pantalla GainGuard —**StageGuard** (cian apagado, ámbar encendido) y **PreGuard** justo debajo (cian apagado, verde encendido)— encima del selector RMS/LUFS, con un respiro rotulado **«GainGuard Select»** entre las guardas y el bloque de medida. Al cargar la página se sincronizan los 32 canales en una sola petición, con la pantalla como referencia.
- **Referencia única del previo**: el motor mantiene `nominalGain` (valor sin guardas) y acumula desplazamientos por Stage Guard y PreGuard. Los cambios manuales del previo reajustan esa referencia sin perder la protección ni la atenuación por silencio.
- **Bloqueo visible en el mixer**: mientras una guarda mueve el previo, el mixer consulta los canales bloqueados (`GET /locks`, una vez por segundo) y en **modo GAIN** deja el fader del previo inerte con un rótulo **LOCK** en ámbar. En modo nivel el fader sigue normal: no es el previo.

### Changed
- **Cabecera de GainGuard en tres zonas**: «Channel Block» —antes «Canal block»— a la izquierda, el nombre **GainGuard®** centrado y un 30 % más grande, y el rótulo **BusGuard** con su ON/OFF junto al botón de cerrar, a la derecha.
- **Monitor Guard pasa a llamarse BusGuard** en toda la interfaz.
- **Stage Guard · recuperación**: la subida deja de esperar al cooldown y sube en pasos rápidos, para no perder palabras de una frase.

### Removed
- **Módulo GainGuard antiguo en JavaScript** (`backend/gainGuard/*`: servicio, Monitor Guard, guarda de ecos, filtros, planificador de rampas y sus rutas y pruebas), sustituido por la suite TypeScript. Se conservan sus analizadores RMS y LUFS, que la suite reutiliza.

## [1.0.23] — 2026-10-14

### Added
- **GainGuard · Monitor Guard**: la cabecera de la pantalla añade, junto al selector de bloque, un conmutador de encendido (OFF | ON) para Monitor Guard.
- **GainGuard · «Off» en los umbrales**: las dos escalas del desplegable por canal empiezan por «Off» —RMS: Off · ±3 dB · ±5 dB; LUFS: Off · -18 LUFS · -23 LUFS—, de modo que el umbral puede quedar sin límite. Al cambiar de escala el umbral vuelve a «Off», porque el de la otra no existe.

### Changed
- **Ajustes de GainGuard**: el estado local guarda también Monitor Guard (`{ mon, ch: [{ mode, opt }] }`). Lo guardado por versiones anteriores se migra al cargarlo: como el desplegable ha ganado la opción «Off» delante, el umbral se desplaza una posición y cada canal conserva el que tenía.

## [1.0.22] — 2026-10-14

### Added
- **Pantalla GainGuard**: al pulsar el botón de la barra global se abre sobre el escenario una pantalla con el mismo esqueleto que Setup › Preamps —cuatro bloques de ocho canales, sin «Global options»—. Por canal, el sitio del 48V lo ocupa un **conmutador deslizante RMS / LUFS** y el del Ø un **desplegable de umbral**, con las opciones del modo vigente (±3 dB y ±5 dB en RMS, -18 LUFS y -23 LUFS en LUFS). Se cierra con ✕, con Esc, volviendo a pulsar el botón o cambiando de vista principal.
- **Tipografía de marca «Beyond The Mountains»**: viaja con el proyecto (`assets/fonts/beyond-the-mountains.otf`) con un `@font-face` que prefiere la copia instalada en el equipo, `preload` en el documento y los tipos MIME `.otf`/`.ttf` añadidos al servidor. La usan el rótulo del botón GainGuard y el título de su pantalla.
- Rúbrica **® StageNet Systems** junto al título de GainGuard.

### Changed
- **Barra global**: el bloque de automix (X · AUTOMIX · Y) cede su sitio al **botón GainGuard**, con el mismo lenguaje visual que los botones M/S de las tiras —celeste sin relleno y rótulo centrado— y encendido en cian mientras la pantalla está abierta.
- **Ajustes de GainGuard en local** (`localStorage`, 32 canales): el modo y el umbral de cada canal se recuerdan entre sesiones. Sin OSC por el momento.
- **Pie**: la rúbrica pasa a «© 2026 StageNet Systems. All rights reserved.», con la marca unificada.

### Removed
- **Automix**: se elimina por completo el bloque de la barra global —botones X/AUTOMIX/Y, su conmutación local y las rutas `/config/amixenable/X|Y`—, función que no se va a utilizar.

## [1.0.21] — 2026-10-14

### Added
- **Out 1-16 · leyenda de señal**: el pie dibuja los colores del punto de señal (`Xotpos`), con un anillo por tap y un círculo relleno para su variante "+ Mute". Post Fader sólo lleva anillo porque no existe "+ Mute".

### Changed
- **Out 1-16 · Output y Phase fijos**: ambas columnas viven en una tabla aparte, fuera del área que se desplaza, así que ya no desaparecen al desplazar en horizontal. El scroll lateral pasa a ser continuo: se elimina el anclaje por bloques.
- **Out 1-16 · alto de fila adaptativo**: la matriz se comprime al hueco disponible para no necesitar scroll vertical en PC (38 px en pantallas altas, hasta 22 px en portátiles de 768 px). En pantallas táctiles se mantiene un mínimo de 32 px.
- **Pie de Out 1-16**: el rótulo *Default Signal Tap* pasa a la derecha de su desplegable y la leyenda ocupa el hueco de la izquierda.
- **Setup y Routing, adaptación a tablet de 10"**: rejillas fluidas, objetivos táctiles de 36-44 px, barras de subpestañas con scroll lateral, celdas de rejilla compactas, `:hover` neutralizado en pantallas táctiles y limpieza de reglas muertas.

### Fixed
- **Out 1-16**: las dos tablas quedaban desalineadas 16,8 px porque la fila de cabecera vacía de la tabla fija medía 9 px en vez de 25,8.

## [1.0.20] — 2026-10-14

### Added
- **Vista Routing**: barra de once subpestañas (Inputs, AES50, Card, XLR, Out 1-16, Out Delay, Aux Out, Ultranet, iQ Setup, User In, User Out), con la distribución de X32-Edit.
- **Inputs**: rejilla de rutas de canal (`/config/routing/IN/…`), con grupos Local, AES50 A/B, Card y User In. Desplegables de Aux In Remap (`/config/routing/IN/AUX`) y Play remap (`/config/routing/PLAY/AUX`).
- **AES50**: salidas de las seis secciones de cada banco (`/config/routing/AES50A|B/…`).
- **Card**: cuatro filas de salidas (`/config/routing/CARD/…`).
- **XLR**: cuatro filas de salidas (`/config/routing/OUT/…`).
- **Out 1-16**: tabla continua de origen por salida física (`/outputs/main/NN/src`) con Phase (`/invert`), tap por fila (`/pos`) y desplegable **Default Signal Tap** guardado en local. El scroll lateral ancla al inicio de cada bloque (Off, Main, Mix Bus, Matrix, Dir Ch, Dir Aux, Dir FX, Monitor) para que ninguna sección quede cortada.
- Tap por botón derecho o pulsación larga sobre la celda activa; el color del anillo indica el punto de la señal (`Xotpos`), relleno en los modos "+ Mute".

### Changed
- **Fraguado de valores de `src`**: confirmados con `scene.scn` (Off 0, Main L/R 1/2, Mix 01-04 = 4-7, Dir Ch 01-16 = 26-41, Dir Aux 01-02 = 58-59, Dir FX 1L-3R = 66-71, Monitor L/R 74/75). El resto se deduce por secuencia y se marca "valor por verificar" en el tooltip.
- Las celdas de **User In** se habilitan siguiendo el patrón de Card (valores 20-23 y 13-15), pendientes de verificar en consola.

### Notes
- Out Delay, Aux Out, Ultranet, iQ Setup, User In y User Out quedan como pestañas con texto de pendiente hasta confirmar sus rutas OSC.

## [1.0.19] — 2026-10-14

### Added
- **Modo GAIN de canales**: el hueco del pan muestra **48V** (`/headamp/NNN/phantom`) y **Ø** (`/ch/NN/preamp/invert`). Aux muestra sólo **Ø** (`/auxin/NN/preamp/invert`).
- Botones 48V y Ø con el mismo aspecto que Mute y Solo: activo en **rojo** (48V) y **verde** (Ø).
- 48V pide confirmación al activarlo.

### Changed
- **Setup › Preamps**: se eliminan los faders de ganancia y la escala. Cada canal tiene 48V y Ø; la ganancia se controla desde Mixer en modo GAIN.
- Los cambios de 48V en Setup también piden confirmación.

### Removed
- En modo GAIN ya no aparece el pan en la tira de canal o aux.

## [1.0.18] — 2026-10-13

### Changed
- **Vúmetros de canal en GAIN**: muestran la señal IN del preamp, independiente del fader y del mute.
- **Vúmetros de canal en MIX**: siguen siendo OUT (post-fader); con mute bajan a -95 dB.
- **Master estéreo sólo en Main LR**: con M/C o un bus se muestra una sola barra.

### Fixed
- El master con destino bus mostraba el nivel de Main LR. Ahora el dato real de `/meters/1` sólo se usa con Main LR; M/C y buses usan la simulación de su propio fader y mute.

## [1.0.17] — 2026-10-13

### Added
- **Pestaña Setup** entre Mixer y Routing, con barra de seis subpestañas (Connection, Mixer, GUI Prefs, Midi Control, Preamps, Card) bajo la barra de vistas, con la distribución de X32-Edit.
- **Mixer**: todas las opciones de la pantalla de X32-Edit. Las que no tienen ruta OSC confirmada quedan deshabilitadas.
- **GUI Prefs**: preferencias locales guardadas en `localStorage` (`cuedesk.setup.local`). Todavía no cambian el comportamiento de la app.
- **Midi Control**: `/-prefs/remote/ioenable` como máscara de bits (MIDI In/Out, Card MIDI, Program change, Fader pos CC, Ch mute CC).
- **Preamps**: bloques de 8 canales con botón 48V, fader vertical de ganancia (-12 … +60 dB) y escala. Los bloques AES50 quedan deshabilitados.
- **Card**: sólo muestra sus opciones cuando `/-stat/xcardtype` es distinto de 0.
- **Detección de consola**: endpoint `/api/console` en `server.js` (envía `/info` por UDP a 192.168.1.10:10023) y tarjeta de detección en Connection.

### Changed
- Confirmación antes de enviar cambios de reloj, sincronización, tarjeta y máscara MIDI.
- Los valores de la consola se leen por suscripción OSC. No hay petición explícita al abrir Setup.
- Brillo, contraste y LED de pantalla con los rangos de los headers de Maillot (10–90 y 0–100).

### Fixed
- Al pulsar una subpestaña de Setup se ocultaban todos los paneles: `initTabs` sólo toma las pestañas con `data-view`.
- Con Setup activo, la barra de subpestañas ocupa su propia fila en la cuadrícula de `.app`.

## [1.0.16] — 2026-10-09

### Added
- Banco **Matrix** con seis tiras y rutas OSC `/mtx/NN/…`.

### Changed
- El botón "Bus Mtx" se separa en **Buses** (16 buses en dos bloques horizontales de 8 tiras, con desplazamiento) y **Matrix**. El master queda fijo.

## [1.0.15] — 2026-10-09

### Changed
- Selector de color de los canales: paleta de 8 colores al editar el nombre (mayor superficie táctil), ciclo completo X32 por la barra y persistencia en localStorage (cuedesk.ch.colors).
- Color de los buses y de las tiras de bus unificados con la fuente de verdad; la capa cian del master bus pasa de 0.25 a 0.15.

## [1.0.14] — 2026-10-09

### Added
- **Selector de BUS del master**: caja propia con cuadros generosos para **Main LR**, **M/C Mono** y **Bus 01–16** (18 destinos). Cada destino tiene su estado de fader/mute y sus rutas OSC (`/main/st|m/…` y `/bus/NN/…`).
- **Renombrar buses**: clic derecho o pulsación larga abre un editor inline (Enter confirma, Escape cancela). El nombre se guarda en `localStorage` (`cuedesk.bus.names`) y se envía por OSC a `/bus/NN/config/name`.
- **Color por bus**: paleta X32 completa (`off…white`); el botón del master hereda el color (borde, texto y flecha) y cada cuadro muestra un chip de color. Clic en el chip cicla el color, persiste en `cuedesk.bus.colors` y envía `/bus/NN/config/color`. **Main LR y M/C Mono son siempre blancos**.

### Changed
- **Se elimina la etiqueta redundante** del master (`.master__label`): el propio botón ya indica dónde estamos. El selector baja 18 px desde el borde de la tarjeta y crece a **62 px** de alto; la flecha pasa a un `::after`.
- La caja se cierra con clic fuera, Escape o al seleccionar; el activo se resalta.

### Verified
- 18 destinos con etiquetas `LR` / `M/C` / `01–16`; fader y mute apuntan a `/bus/NN/mix/{fader,on}`; readout por destino (mains `-6.0`, buses `+0.0`).
- Renombrar por clic derecho y por pulsación larga; nombre persistente tras recargar; Escape restaura.
- Color persistente tras recargar; el chip cicla sin seleccionar ni cerrar; mains en blanco.
- Núcleo del master alineado con los canales (top = 309), 9 faders, sin scroll y consola limpia.

## [1.0.13] — 2026-10-09

### Changed
- **Selector de bus del master**: sale de la cabecera (se elimina el `.strip__display` del master) y pasa a ser la **primera fila del cuerpo de la tarjeta** (hijo directo de `.strip--master`), sin fondo negro detrás.
- **Estilo de botón ámbar**: borde y texto en `--gold` (`#ffc12c`), `border-radius: 6px`, `font-weight: 800` y fondo transparente (al estilo de los botones M/S), con un **triángulo relleno ▼** a la derecha como indicación de selector.
- **Altura 26 → 45 px** (+50 %) y ancho al de la tarjeta con 8 px de margen lateral.
- Para no desplazar el núcleo, la fila de la etiqueta del master cede 1 px (**38 → 37**): `44 + 38 = 45 + 37`; fader y vúmetros del master siguen alineados con los 8 canales.

### Verified
- 1296×886: master sin `.strip__display` y con el `<select>` como primer hijo; botón de 45 px en ámbar `rgb(255,193,44)` con triángulo ▼; los 9 faders a la misma Y (313) y los 9 núcleos en 309; el selector sigue cambiando LR/M-C (etiqueta `LR`/`M/C` y ruta `/main/st|m/mix/fader`); sin scroll X/Y; 0 errores (salvo WebSocket sin X32).

## [1.0.12] — 2026-10-09

### Changed
- **Viewbar (pestañas)**: el contenedor pasa a `display: flex; width: 100%` (sin `justify-content` ni padding lateral) y la tira `.viewbar-tabs` lo llena (`flex: 1; width: 100%`). Cada **tab** es `flex: 1 1 0%`, de modo que las seis se reparten el ancho **a partes iguales**.
- **Divisor entre tabs**: el `border-left` de 1 px pasa a `box-shadow: inset 1px 0 0 #101014` para no alterar el reparto (las tabs quedan idénticas en ancho).

### Verified
- 1296×886: 6 tabs de **216.00 px exactos** (Mixer / Setup / Routing / Meter / Scenes / Queue) que van de 0 a 1296; sin scroll X/Y; 0 errores (salvo WebSocket sin X32).

## [1.0.11] — 2026-10-09

### Changed
- **Relleno del fader PAN**: el carril del panorama ahora **pinta desde el centro (C)** hacia el pomo cuando se sale del centro (comportamiento bipolar); en C no hay relleno. Usa el mismo cian que el resto de carriles.
- **Carril del PAN engrosado**: 10 → **19 px**, para igualar el **alto del pomo** (pomo 9 × 19 px). La fila del pan crece de 36 → 38 px (`.pan`, `--pan-h`) y en sintonía lo hacen el hueco de las tiras sin pan y la etiqueta del master, sin desalinear nada.
- **Doble clic / doble tap**: sobre cualquier fader/deslizador devuelve al valor de reposo (PAN → **C**, nivel → 0 dB). Se añade detección propia de **doble tap** para táctil (320 ms / 26 px); un arrastre la invalida para no confundirse con un toque.

### Verified
- PAN en 0.5 sin relleno; desplazado, relleno cian desde el centro (`left`/`width` correctos); pomo 9 × 19 dentro de un carril de 19 px. Doble tap → C (0.5) y doble clic nativo → C; un arrastre real no dispara el reset. 1296×886: 9 tiras alineadas (mismo top de fader y de vúmetro), sin scroll X/Y, 0 errores (salvo WebSocket sin X32).

## [1.0.10] — 2026-10-09

### Changed
- **Escalas (fader y vúmetros)**: el texto pasa de `--text-faint` a **blanco** (`--text`, `#ececf1`).
- **Escala del fader de mezcla**: se añaden las marcas **+5, -5 y -10** (antes `+10 / 0 / -20 / -40 / -60 / -∞`).
- **Escala de los vúmetros**: se añaden **-5 y -10** (antes `0 / -20 / -40 / -60 / -∞`).
- **Fader master**: el strip reparte ahora el **mismo ancho que los canales** (9 columnas iguales: `display: contents` en `.channels` y el master hereda `flex: 1 1 0`), y se le **añade escala** como a los canales (mismas marcas). Para compensar su columna extra de vúmetro, sus escalas de vúmetro se estrechan (20 → 14 px).

### Verified
- 1296×886: 9 tiras a ~120.9 px; escalas en blanco `rgb(236, 236, 241)`; fader con `+5 / -5 / -10` y el master con su escala; las marcas de 0 dB del fader y del vúmetro coinciden (ΔY = 0); sin solape entre escalas; sin scroll X; 0 errores (salvo WebSocket sin X32). El modo GAIN conserva su escala (headamp/trim) en blanco y el relleno dorado.

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
