#!/bin/sh
# Stands in for omp in the e2e test: no model call, it plays a lane that reads its brief, reports and finishes.
set -eu
seori() { sh -c "$SEORI_E2E_CMD \"\$@\"" seori "$@"; }
brief=$(printf '%s' "$1" | sed -n 's/^Read your brief at \(.*\) and execute it\..*/\1/p')
test -f "$brief"
seori report "$SEORI_LANE" --text "read brief: $(head -n 1 "$brief")"
seori ready "$SEORI_LANE" --text "e2e lane finished" --evidence "file://$brief"
