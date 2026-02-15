@echo off
::git pull

cd grinder
FOR /f "tokens=*" %%i IN ('fnm env --use-on-cd') DO CALL %%i
fnm use 24 2>nul
call npm i --loglevel=error

call npm run cleanup auto > logs/cleanup.log
del ..\audio\*.mp3 >nul 2>&1
del ..\img\*.jpg >nul 2>&1
del ..\img\screenshots.txt >nul 2>&1
del articles\*.txt >nul 2>&1
del articles\*.html >nul 2>&1


::call npm run load auto > logs/load.log
call npm run summarize auto > logs/summarize.log
call npm run slides auto > logs/slides.log

call npm run screenshots > logs/screenshots.log
call npm run upload-img > logs/upload-img.log
call npm run audio auto > logs/audio.log
