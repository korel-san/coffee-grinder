@echo off
::git pull

cd grinder
fnm use 24 2>nul
call npm i --loglevel=error
call npm run cleanup > logs/cleanup.log

del ..\audio\*.mp3 >nul 2>&1
del ..\img\*.jpg >nul 2>&1
del ..\img\screenshots.txt >nul 2>&1
del articles\*.txt >nul 2>&1
del articles\*.html >nul 2>&1

pause