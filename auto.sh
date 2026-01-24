#!/bin/bash

# git pull

cd grinder
# FOR /f "tokens=*" %%i IN ('fnm env --use-on-cd') DO CALL %%i
fnm use 24 2>/dev/null
npm i --loglevel=error

npm run cleanup auto > logs/cleanup.log
rm ../audio/*.mp3 >/dev/null 2>&1
rm ../img/*.jpg >/dev/null 2>&1
rm ../img/screenshots.txt >/dev/null 2>&1
rm articles/*.txt >/dev/null 2>&1
rm articles/*.html >/dev/null 2>&1

# npm run load auto > logs/load.log
npm run summarize auto > logs/summarize.log
npm run slides auto > logs/slides.log

npm run screenshots > logs/screenshots.log
npm run upload-img > logs/upload-img.log
npm run audio auto > logs/audio.log

echo "Auto process complete."