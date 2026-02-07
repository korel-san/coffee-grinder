@echo off
cd grinder
fnm use 24 2>nul
call npm run summarize > logs/summarize.log
pause