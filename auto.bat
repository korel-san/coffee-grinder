@echo off
::git pull

cd grinder
FOR /f "tokens=*" %%i IN ('fnm env --use-on-cd') DO CALL %%i
fnm use 24 2>nul
call npm i --loglevel=error

powershell -NoProfile -Command "npm run cleanup auto 2>&1 | Tee-Object -FilePath 'logs/cleanup.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
del ..\audio\*.mp3 >nul 2>&1
del ..\img\*.jpg >nul 2>&1
del ..\img\screenshots.txt >nul 2>&1
del articles\*.txt >nul 2>&1
del articles\*.html >nul 2>&1


::call npm run load auto > logs/load.log
powershell -NoProfile -Command "npm run summarize auto 2>&1 | Tee-Object -FilePath 'logs/summarize.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
powershell -NoProfile -Command "npm run slides auto 2>&1 | Tee-Object -FilePath 'logs/slides.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"

powershell -NoProfile -Command "npm run screenshots 2>&1 | Tee-Object -FilePath 'logs/screenshots.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
powershell -NoProfile -Command "npm run upload-img 2>&1 | Tee-Object -FilePath 'logs/upload-img.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
powershell -NoProfile -Command "npm run audio auto 2>&1 | Tee-Object -FilePath 'logs/audio.log' -Append; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
