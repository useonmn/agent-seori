#!/bin/bash
# Prints "MAIN-MOVED <old> -> <new>" when origin/main moves; silent otherwise. Watch filter: MAIN-MOVED
cd /home/jinsung/src/progress-off || exit 1
last=$(git rev-parse --short origin/main)
while true; do
  git fetch origin --quiet 2>/dev/null
  cur=$(git rev-parse --short origin/main)
  if [ "$cur" != "$last" ]; then
    echo "MAIN-MOVED $last -> $cur"
    last=$cur
  fi
  sleep 60
done
