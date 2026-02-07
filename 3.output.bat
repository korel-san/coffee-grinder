@echo off
cd grinder
fnm use 24 2>nul
call npm run slides > logs/slides.log

cd ../img
start /wait ScreenShotMaker_2.0.ahk

cd ../grinder
call npm run audio > logs/audio.log
pause