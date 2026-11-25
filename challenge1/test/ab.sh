#!/bin/bash
# A/B test: alternates agent versions on the same scenario, one CSV row per run in results/ab.csv:
#   label,game,agents,rep,team_score,tag
# usage: challenge1/test/ab.sh <game> <agents> <reps> <label>:<script> <label>:<script> ...
#   e.g. git show HEAD:challenge1/agent.js > challenge1/_old.js
#        challenge1/test/ab.sh crates_one_way 3 4 old:challenge1/_old.js new:challenge1/agent.js
source "$(dirname "$0")/common.sh"
GAME=$1; N=$2; REPS=$3; shift 3
[ $# -ge 1 ] || { echo "usage: $0 <game> <agents> <reps> <label>:<script>..."; exit 1; }
for rep in $(seq 1 "$REPS"); do
  for v in "$@"; do
    load_game "$GAME" || exit 1
    TAG="a$(date +%s)$RANDOM"
    echo "${v%%:*},$GAME,$N,$rep,$(play "${v#*:}" "$N" "${SECS:-30}" "$TAG"),$TAG" | tee -a "$RESULTS/ab.csv"
  done
done
python3 - "$RESULTS/ab.csv" "$GAME" "$N" <<'EOF'
import csv, statistics as st, sys
rows = [r for r in csv.reader(open(sys.argv[1])) if r[1] == sys.argv[2] and r[2] == sys.argv[3] and r[4] != "NA"]
for label in dict.fromkeys(r[0] for r in rows):
    s = [float(r[4]) for r in rows if r[0] == label]
    print(f"{label}: mean {st.mean(s):.0f}  ±{st.stdev(s) if len(s) > 1 else 0:.0f}  over {len(s)} runs")
EOF
