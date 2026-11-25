# challenge1 tests

Scripts to test `challenge1/agent.js` against a **local** Deliveroo.js server.
Run them from the repository root.

Requirements:
- a local server, by default on port 8080 (`PORT=8081 ...` to use another one)
- `ADMIN_TOKEN` in `.env`: the scripts restart the server and load maps
- the game files of the Deliveroo.js checkout next to this repository
  (`../../Deliveroo.js/packages/@unitn-asa/deliveroo-js-assets/assets/games`), or `DELIVEROO_GAMES=<folder>`

Every run first restarts the server: loading a map alone keeps the crates of the previous map.
Logs go to `logs/`, CSV results to `results/` (both git-ignored).

| Script | What it does |
|---|---|
| `run.sh <game> [secs] [agents] [script]` | one scenario, with per-agent diagnostics (deliveries, pushes, blocks) |
| `bench.sh <script> <label> [reps] [secs]` | a fixed set of maps, 1 and 3 agents, each `reps` times → `results/bench.csv` |
| `summary.py results/bench.csv [labels]` | mean ± std per config and label, to compare versions |
| `ab.sh <game> <agents> <reps> label:script ...` | alternates versions on one scenario → `results/ab.csv` |
| `node dump.mjs` | prints the live map with the crates and agents in sight |
| `node offline.mjs <game.json> <x> <y>` | prints the agent's path costs from a position on a map, no server needed |

Example, compare the last commit with the working copy:

```bash
git show HEAD:challenge1/agent.js > challenge1/_old.js
challenge1/test/bench.sh challenge1/_old.js old
challenge1/test/bench.sh challenge1/agent.js new
python3 challenge1/test/summary.py challenge1/test/results/bench.csv old new
```

Results vary a lot between runs (random spawns and parcels): compare means over several runs, not single runs.
