# DeliverooAgent.js

To update `deliveroo-js-sdk` dependency run:

    $ npm install @unitn-asa/deliveroo-js-sdk@latest

## First challenge agent

The agent for the first challenge lives in [`challenge1/agent.js`](challenge1/agent.js).

```bash
# 1. Deliveroo.js server (separate clone), http://localhost:8080
npm install && npm run build && npm start

# 2. .env of this repo: HOST=http://localhost:8080 and the TOKEN of a *user* (not admin) from the web client
node challenge1/agent.js [revise|replace|queue]     # default: revise
```

On the university server use `HOST=https://deliveroojs.bears.disi.unitn.it/` (UniTN VPN needed) and your team token.
Open the web client with the same token to watch the agent.

Files:

| File | What it is |
|---|---|
| `challenge1/agent.js` | current agent (v2) |
| `challenge1/agent_v1_laurin.js` | frozen copy of the previous version (v1), the benchmark baseline |
| `challenge1/test/bench.mjs` | cross-platform benchmark (Windows, macOS, Linux), see below |
| `challenge1/test/*.sh` | Laurin's bash test scripts (macOS / Linux / Git Bash only) |
| `lab4-ControlLoopIntentionRevision/intention_revision.js` | the original course agent, the starting point of everything |

### Tunable parameters

All can be overridden by environment variables (the benchmark uses this to compare settings), defaults in brackets:
`SWITCH_MARGIN` (10), `AGENT_MEMORY_MS` (2000), `BLOCKED_WAIT_SENSINGS` (6), `COOLDOWN_MS` (5000),
`FAIL_PAUSE_MS` (250), `RIVAL_WIN_SHARE` (0.4), `CLUSTER_BONUS` (0.3), `CLUSTER_RADIUS` (3), `HEAT_WEIGHT` (0.5).

### Benchmarking

Needs a local Deliveroo.js server running (default password `admin`, no `.env` entry needed).
Every repetition restarts the server, loads the map, starts all the agents together, waits, and reads the scores.

```bash
# node challenge1/test/bench.mjs <game> <seconds> <reps> <label:script:count[:KEY=V,...]> ...
node challenge1/test/bench.mjs circuit 60 8 v1:challenge1/agent_v1_laurin.js:2 v2:challenge1/agent.js:2
node challenge1/test/bench.mjs circuit 60 8 a:challenge1/agent.js:2:SWITCH_MARGIN=5 b:challenge1/agent.js:2:SWITCH_MARGIN=20
```

The score of a label is the sum of its agents, specs in the same command play the same match against each other.
Rows are appended to `challenge1/test/results/bench.csv`; logs of every agent go to `challenge1/test/logs/`.
Spawns and parcels are random, so compare means over several repetitions, never single runs.

---

## Changelog

Newest first.

### v2 - 2026-11-26 - multi-agent robustness (`challenge1/agent.js`)

Goal: play better when many agents share the map (the first challenge is a multi-agent match) without leaving the
scope of the labs (beliefs, utility, BDI intention revision). No planner, no communication, no learning.

**Changes with respect to v1**

- Anti-deadlock. A target (delivery tile, parcel, explore tile) that blocked the agent, either "blocked by agents" or after 3 failed moves, goes on a cooldown (`COOLDOWN_MS`).
  Delivery picks the nearest delivery tile that is *not* cooling down, parcels and explore targets on cooldown are skipped.
  A failed intention is followed by a short pause (`FAIL_PAUSE_MS`) instead of being retried in a tight loop
  (seen in the logs: two agents spinning on the same delivery tile for minutes on `crates_maze`).
  The wait for a blocked path is shorter (6 sensing events instead of 10).
- Rival-aware utility. A parcel that a rival can reach at least as fast as me only counts for `RIVAL_WIN_SHARE` of its reward
  (before it was either fully valid or dropped only when the rival was clearly closer).
- Multi-pickup bonus. Parcels within `CLUSTER_RADIUS` tiles of a candidate add `CLUSTER_BONUS` of their reward to its utility,
  so the agent prefers parcels from which one trip collects several (only while there is capacity left).
- Smarter exploration. Spawner tiles where parcels recently appeared have a "heat" (decays by half every minute),
  and exploration targets are weighted by it, on top of "unseen for the longest time" and distance.
- Adaptive agent memory. In a crowded area (3 or more agents in sight) remembered positions of agents are forgotten twice as fast.
- Tunable constants through environment variables, plus `challenge1/test/bench.mjs` to measure the effect.

**Unchanged**: BDI loop, `revise` strategy, directed BFS with one-way tiles, crate pushing, opportunistic pickup/putdown, `makeWay`.

**Pros**: fewer livelocks with other agents, uses the free capacity better, explores where parcels actually spawn.
**Cons / limits**: heuristics with hand-set constants (not learned), rivals are only modelled by distance,
no coordination (one agent per team in the challenge anyway), crates are still not the focus.

**Benchmark v1 vs v2** (2 agents of each version in the same match, 60 s, sum of the team scores, mean +/- std over repetitions):

| Map | v1 (Laurin) | v2 | Repetitions |
|---|---|---|---|
| `circuit` (Simple) | 159.3 +/- 29.5 | 161.4 +/- 34.2 | 8 |
| `circuit_directional` (Medium) | 228.1 +/- 78.5 | 221.9 +/- 58.3 | 8 |

Honest reading: on these two maps, with 2 agents per version, **v2 is not measurably better than v1** (the differences are far below one standard deviation).
The anti-deadlock changes target crowded maps with narrow passages (e.g. `crates_maze`), which these maps are not,
and the other changes are small utility tweaks. Treat v2 as "not worse, safer against livelocks", not as a proven speed-up.

Parameter sweep, 3 teams of 2 v2 agents in the same match on `circuit_directional`, 60 s, 8 repetitions
(defaults 155.4 +/- 41.9; `SWITCH_MARGIN=5`: 172.3 +/- 57.3; `CLUSTER_BONUS=0.6`: 112.0 +/- 46.3).
`SWITCH_MARGIN=5` is within the noise, so defaults are unchanged; a bigger cluster bonus looks worse and was rejected.

Next steps worth measuring: smaller `CLUSTER_BONUS`, `RIVAL_WIN_SHARE`, and a narrow-corridor map where the livelock fix should show.

### v1 - 2026-11 - Laurin's agent (commits `376540e`, `7fb1732`, `5380601`, `challenge1/agent_v1_laurin.js`)

Forked from the lab4 agent and made ready for the challenge scenarios (Simple, Medium, Extreme).

**Changes with respect to the original lab4 agent**

- `capacity -1` means infinite capacity (before it disabled pickups).
- One-way tiles (arrows): directed shortest paths, and a reverse search for the distance of every tile to the nearest delivery tile.
- Beliefs with memory: parcels and agents are remembered when out of sight (agents for `AGENT_MEMORY_MS`), parcels get an estimated reward that keeps decaying,
  remembered free parcels whose tile was visited by another agent are dropped, tiles remember when they were last seen.
- Opportunistic actions: picks up a free parcel and puts down on a delivery tile whenever the path crosses one.
- Exploration prefers the spawners not seen for the longest time (any reachable tile if no spawner is reachable) instead of a random target.
- Crates: walking into a crate pushes it. Pushes are costlier steps in the path search, pushes onto bottlenecks (corridors, doorways,
  found with articulation points) cost much more, and a crate is never left stuck on a bottleneck. Crates are assumed on their `5!` tiles until seen otherwise.
- Collisions: waits a few sensing events when only agents block the path, and `makeWay()` makes one of two agents facing each other in a corridor back out (the smaller id gives way).
- Removed the blind (map-ignoring) fallback move, which breaks on one-way tiles.
- Test harness in `challenge1/test/` (bash scripts that restart the server, load a map, run N agents, collect CSV).

**Pros**: handles all the first challenge scenarios, robust path planning, remembers what it saw.
**Cons**: agents of the same team or rivals can livelock on a delivery tile or in a corridor, utility ignores rivals going for the same parcel,
tests need bash.

### v0 - original repo agent (`lab4-ControlLoopIntentionRevision/intention_revision.js`)

The course reference implementation of a BDI control loop with intention revision.

- Beliefs: me, perceived parcels and agents, map, game configuration. No memory of what is out of sight.
- Desires: `go_pick_up`, `go_deliver`, `explore` generated at every sensing event.
- Intention revision strategies: `queue` (commit in arrival order), `replace` (always switch to the newest option), `revise` (re-sort by utility, switch only if the gain is above `SWITCH_MARGIN`).
- Utility: reward expected at delivery, taking the decay of the carried parcels into account.
- Plan library tried in order (`GoPickUp`, `GoDeliver`, `Explore`, `PathMove` with BFS plus a blind move as a last resort).

**Limits**: `capacity -1` was treated as zero, no one-way tiles, no crates, no memory, no opportunistic pickup, random exploration.
