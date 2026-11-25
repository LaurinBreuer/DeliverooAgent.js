#!/bin/bash
# Shared settings and helpers for the challenge1 test scripts (sourced, not run).
#   PORT             local Deliveroo.js server port (default 8080)
#   DELIVEROO_GAMES  folder with the game .json files (default: the Deliveroo.js checkout next to this repo)
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$TEST_DIR/../.." && pwd)"
PORT=${PORT:-8080}
GAMES=${DELIVEROO_GAMES:-"$REPO/../../Deliveroo.js/packages/@unitn-asa/deliveroo-js-assets/assets/games"}
ADMIN_TOKEN=$(grep ^ADMIN_TOKEN "$REPO/.env" | cut -d= -f2-)
LOGS="$TEST_DIR/logs"; RESULTS="$TEST_DIR/results"
mkdir -p "$LOGS" "$RESULTS"
export PORT ADMIN_TOKEN

# load_game <game>: restart the server (removes agents, parcels and crates left over
# from the previous map: loading a map alone keeps them), then load the game
load_game() {
  [ -f "$GAMES/$1.json" ] || { echo "unknown game: $GAMES/$1.json" >&2; return 1; }
  (cd "$REPO" && node "$TEST_DIR/restart.mjs" > /dev/null)
  python3 -c "import json,sys; print(json.dumps({'GAME': json.load(open(sys.argv[1]))}))" "$GAMES/$1.json" |
    curl -s -o /dev/null -X PATCH -H "x-token: $ADMIN_TOKEN" -H "Content-Type: application/json" -d @- "localhost:$PORT/api/configs"
  sleep 2
}

# play <script> <nAgents> <seconds> <tag>: run nAgents copies named <tag>_1..n, logs in $LOGS/<tag>-i.log,
# print the summed score of the team
play() {
  local script=$1 n=$2 secs=$3 tag=$4 pids="" i scores
  for i in $(seq 1 "$n"); do
    (cd "$REPO" && HOST="http://localhost:$PORT" TOKEN= NAME="${tag}_$i" exec node "$script") > "$LOGS/$tag-$i.log" 2>&1 &
    pids="$pids $!"
  done
  sleep "$secs"
  scores=$(curl -s "localhost:$PORT/api/agents")   # before killing: disconnected agents may disappear
  kill $pids 2>/dev/null; wait $pids 2>/dev/null
  echo "$scores" | python3 -c "import json,sys; print(sum(a['score'] for a in json.load(sys.stdin) if a['name'].startswith('${tag}_')))" 2>/dev/null || echo NA
}

# count <pattern> <tag>: matching lines in the logs of a run
count() { cat "$LOGS/$2"-*.log | grep -c -- "$1"; }
