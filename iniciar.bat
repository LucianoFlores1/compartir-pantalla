@echo off
rem Doble clic para transmitir. Cerrar esta ventana apaga todo (ffmpeg y el control también).
chcp 65001 >nul
title Pantalla a la TV
cd /d "%~dp0"
node server.js
pause
