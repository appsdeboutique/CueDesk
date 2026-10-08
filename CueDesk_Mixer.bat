@echo off
setlocal
rem ==========================================================================
rem  CueDesk - Lanzador en modo MIXER  (doble clic para arrancar la app)
rem --------------------------------------------------------------------------
rem  1. Levanta el servidor local  server.js  en 127.0.0.1:8765
rem  2. Abre el navegador en la vista Mixer (?view=mixer)
rem
rem  Uso:
rem    CueDesk_Mixer.bat              vista previa local  (?view=mixer&ws=off)
rem    CueDesk_Mixer.bat --bridge     con puente WebSocket (?view=mixer)
rem    CueDesk_Mixer.bat --port 9000  otro puerto
rem    CueDesk_Mixer.bat --port 9000 --bridge
rem
rem  Para detener: cerrar la ventana "CueDesk Server".
rem ==========================================================================

cd /d "%~dp0"

set "PORT=8765"
set "QS=view=mixer&ws=off"

:parse
if "%~1"=="" goto ready
if /i "%~1"=="--bridge" set "QS=view=mixer"
if /i "%~1"=="--port" set "PORT=%~2"
shift
goto parse

:ready

where node >nul 2>&1
if errorlevel 1 (
  echo [CueDesk] No se encontro Node.js en el PATH.
  echo           Instalalo desde https://nodejs.org y vuelve a intentarlo.
  start "" "https://nodejs.org"
  exit /b 1
)

echo [CueDesk] Arrancando servidor local en 127.0.0.1:%PORT% ...
start "CueDesk Server (puerto %PORT%)" /min node "%~dp0server.js" --port %PORT%

rem Espera corta a que el puerto quede disponible
ping -n 2 127.0.0.1 >nul 2>&1

set "URL=http://127.0.0.1:%PORT%/?%QS%"
echo [CueDesk] Abriendo la app en modo MIXER: "%URL%"
start "" "%URL%"
exit /b 0
