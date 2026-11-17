@echo off
echo === Astral: building installer ===
call npm install
if errorlevel 1 goto fail
call npm run dist
if errorlevel 1 goto fail
echo.
echo Done! The installer is in the dist folder: Astral-Setup-0.1.0.exe
start "" dist
pause
exit /b 0
:fail
echo.
echo Something went wrong. Copy the error text above.
pause
exit /b 1
