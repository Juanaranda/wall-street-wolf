#!/bin/bash
# Daily signal run, designed to be launched by macOS launchd (or cron).
# Runs `npm run signal` (which auto-refreshes data + notifies) and logs output.
# If email (SMTP) is configured in .env it emails you; otherwise it logs here.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
PROJECT_DIR="/Users/juanarandaappelgren/Documents/Juan/AI_projects/wall-street-wolf"

cd "$PROJECT_DIR" || exit 1
mkdir -p data
{
  echo ""
  echo "════════ $(date '+%Y-%m-%d %H:%M:%S') ════════"
  echo "--- import-fintual (sincroniza tus compras/ventas desde el correo) ---"
  npm run import-fintual
  echo "--- signal (genera plan + lo envía por correo) ---"
  npm run signal
} >> data/signal.log 2>&1
