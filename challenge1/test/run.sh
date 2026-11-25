#!/bin/bash
# One scenario, with diagnostics per agent.
# usage: challenge1/test/run.sh <game> [seconds=60] [agents=1] [script=challenge1/agent.js]
source "$(dirname "$0")/common.sh"
GAME=$1; SECS=${2:-60}; N=${3:-1}; SCRIPT=${4:-challenge1/agent.js}
[ -n "$GAME" ] || { echo "usage: $0 <game> [seconds] [agents] [script]"; ls "$GAMES" | sed -n 's/\.json$//p' | tr '\n' ' '; echo; exit 1; }
load_game "$GAME" || exit 1
TAG="r$(date +%s)"
echo "$GAME x$N: team score $(play "$SCRIPT" "$N" "$SECS" "$TAG")"
for i in $(seq 1 "$N"); do
  L="$LOGS/$TAG-$i.log"
  echo "  agent $i: delivered $(grep -c 'delivered' "$L"), pushes $(grep -c 'pushed crate' "$L"), made way $(grep -c 'made way' "$L")," \
    "blocked by agents $(grep -c 'blocked by agents' "$L"), no path $(grep -c "'no path to'" "$L"), errors $(grep -c 'Error' "$L")   ($L)"
done
