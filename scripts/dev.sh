#!/bin/bash
# Helper script to start/restart the Tauri dev server

# Kill existing processes if they exist
pgrep -f "stalagmight" > /dev/null && pkill -f "stalagmight"
pgrep -f "vite.*1420" > /dev/null && pkill -f "vite.*1420"

sleep 1

# Start the dev server
exec pnpm tauri dev
