#!/bin/bash
# Benchmark: every config REPS times, one CSV row per run in results/bench.csv:
#   label,game,agents,rep,team_score,switches_per_agent_min,pushes,no_path,tag
# Summarise with: python3 challenge1/test/summary.py challenge1/test/results/bench.csv
# usage: challenge1/test/bench.sh <script> <label> [reps=3] [seconds=30]
source "$(dirname "$0")/common.sh"
SCRIPT=$1; LABEL=$2; REPS=${3:-3}; SECS=${4:-30}
[ -n "$LABEL" ] || { echo "usage: $0 <script> <label> [reps] [seconds]"; exit 1; }
CONFIGS=${CONFIGS:-"crates_maze:1 crates_one_way:1 chaotic_maze:1 circuit_directional:1 diagonals_oneway:1 comb:1 crates_maze:3 crates_one_way:3 small_two_wide:3"}
for rep in $(seq 1 "$REPS"); do
  for c in $CONFIGS; do
    GAME=${c%%:*}; N=${c##*:}
    load_game "$GAME" || continue
    TAG="b$(date +%s)$RANDOM"
    TEAM=$(play "$SCRIPT" "$N" "$SECS" "$TAG")
    SW=$(python3 -c "print(round($(count 'Revise: \(switching\|dropping\)' "$TAG") / $N / ($SECS / 60), 1))")
    echo "$LABEL,$GAME,$N,$rep,$TEAM,$SW,$(count 'pushed crate' "$TAG"),$(count "'no path to'" "$TAG"),$TAG" | tee -a "$RESULTS/bench.csv"
  done
done
