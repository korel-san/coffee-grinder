#!/bin/bash

cd grinder
fnm use 24 2>/dev/null
npm run slides > logs/slides.log

cd ../img
# start /wait ScreenShotMaker_2.0.ahk - AutoHotkey script (not compatible with macOS)
echo "AutoHotkey script not available on macOS. Skipping screenshots..."

cd ../grinder
npm run audio > logs/audio.log
echo "Output complete. Press Enter to continue..."
read