#!/bin/bash

cd grinder
fnm use 24 2>/dev/null
npm run summarize > logs/summarize.log
echo "Summarize complete. Press Enter to continue..."
read