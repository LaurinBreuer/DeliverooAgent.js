import "dotenv/config";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

/**
 * BDI agent for the first challenge.
 * Forked from lab4-ControlLoopIntentionRevision/intention_revision.js
 *
 * Usage: node challenge1/agent.js [revise|replace|queue]   (default: revise)
 *
 * Changes w.r.t. the lab4 agent:
 * - capacity -1 means infinite (it used to disable pickups)
 * - one-way tiles (↑ → ↓ ←): directed BFS, and a reverse BFS for distances to delivery
 * - parcels and agents are remembered when out of sight
 * - opportunistic pickup / putdown while walking
 * - explore prefers spawners not seen for the longest time (any tile if no spawner is reachable)
 * - crates are pushed: walking into a crate moves it one tile, if it can slide there.
 *   Paths are planned with pushes as costlier steps; pushes that would block a bottleneck
 *   (corridor, doorway) cost much more, and a crate is never left stuck on a bottleneck.
 *   Crates are assumed on their '5!' spawn tiles until seen otherwise.
 * - no blind (map-ignoring) fallback move
 */

const socket = DjsConnect();

/** @type { function ({x:number, y:number}, {x:number, y:number}): number } */
function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
  const dx = Math.abs(Math.round(x1) - Math.round(x2));
  const dy = Math.abs(Math.round(y1) - Math.round(y2));
  return dx + dy;
}

/** @type { function ({x:number, y:number}): string } */
const key = ({ x, y }) => `${Math.round(x)}_${Math.round(y)}`;

/** @typedef { 'up' | 'right' | 'left' | 'down' } Direction */
/** @type { {direction:Direction, dx:number, dy:number}[] } */
const MOVES = [
  { direction: "up", dx: 0, dy: 1 },
  { direction: "right", dx: 1, dy: 0 },
  { direction: "down", dx: 0, dy: -1 },
  { direction: "left", dx: -1, dy: 0 },
];

/** Numeric tunable, overridable with an environment variable (used by the benchmark to sweep values) */
const tunable = (/** @type {string} */ name, /** @type {number} */ fallback) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== "" && Number.isFinite(v) ? v : fallback;
};

/** Switch intention only if the new one is better by at least this many points */
const SWITCH_MARGIN = tunable("SWITCH_MARGIN", 10);
/** Remembered agents are forgotten after this many ms (halved when the area is crowded) */
const AGENT_MEMORY_MS = tunable("AGENT_MEMORY_MS", 2000);
/** Sensing events to wait when the only path is blocked by other agents */
const BLOCKED_WAIT_SENSINGS = tunable("BLOCKED_WAIT_SENSINGS", 6);
/** A target that blocked me is avoided for this many ms (anti-deadlock cooldown) */
const COOLDOWN_MS = tunable("COOLDOWN_MS", 5000);
/** Pause after a failed intention, so a hopeless one cannot spin the loop */
const FAIL_PAUSE_MS = tunable("FAIL_PAUSE_MS", 250);
/** Chance of winning a parcel when a rival is at least as close as me (reward is scaled by this) */
const RIVAL_WIN_SHARE = tunable("RIVAL_WIN_SHARE", 0.4);
/** Fraction of the reward of nearby parcels counted as bonus when choosing a parcel (multi-pickup) */
const CLUSTER_BONUS = tunable("CLUSTER_BONUS", 0.3);
/** Radius (manhattan) within which parcels count as a cluster */
const CLUSTER_RADIUS = tunable("CLUSTER_RADIUS", 3);
/** Weight of the recent-spawn heat of a spawner tile when choosing where to explore */
const HEAT_WEIGHT = tunable("HEAT_WEIGHT", 0.5);
/** Max steps backed out of a bottleneck to let another agent pass */
const MAKE_WAY_MAX_STEPS = 8;
/** Extra cost of pushing a crate: free paths are preferred, crates are moved only when it pays off */
const PUSH_COST = 2;
/** Extra cost of pushing a crate onto a bottleneck (corridor, doorway), where it blocks the way: a detour is usually better */
const BOTTLENECK_PUSH_COST = 15;

/**
 * Belief revision
 */

/**
 * @type { {id:string, name:string, x:number, y:number, score:number} }
 */
const me = { id: "", name: "", x: -1, y: -1, score: 0 };

socket.onSensing(({ self }) => {
  if (!self) return;
  const { id, name, x, y, score } = self;
  me.id = id;
  me.name = name;
  me.score = score;
  // While moving coordinates are fractional: keep the last integer tile.
  if (x !== undefined && y !== undefined && Number.isInteger(x) && Number.isInteger(y)) {
    me.x = x;
    me.y = y;
  }
});

/**
 * Game settings needed by the utility function
 */
const game = {
  /** ms for a parcel to lose 1 point */
  decayMs: 1000,
  /** max parcels I can carry */
  capacity: Infinity,
  observationDistance: 5,
  /** measured ms per step, including network latency (updated by move()) */
  stepMs: 500,
};

/** @type { Record<string, number> } */
const CLOCK_MS = { "1s": 1000, "2s": 2000, "5s": 5000, "10s": 10000, "1m": 60000, "1h": 3600000 };

socket.onConfig((config) => {
  const { parcels: parcelOptions, player } = config.GAME;
  const decay = parcelOptions?.decaying_event;
  game.decayMs =
    decay == "infinite" ? Infinity : decay == "frame" ? Number(config.CLOCK) : (CLOCK_MS[decay] ?? 1000);
  const capacity = player?.capacity;
  // -1 (or missing) means infinite
  game.capacity = capacity == null || capacity < 0 ? Infinity : capacity;
  game.observationDistance = player?.observation_distance ?? 5;
  if (player?.movement_duration) game.stepMs = player.movement_duration;
  console.log("config: player", JSON.stringify(player), "| decay every", game.decayMs, "ms");
});

/** Points lost by each carried parcel for every step I take */
const decayPerStep = () => game.stepMs / game.decayMs;

/**
 * Map
 */

/** @type { Map<string, string> } tile type by position */
const tiles = new Map();
/** @type { {x:number, y:number}[] } */
let deliveryTiles = [];
/** @type { {x:number, y:number}[] } */
let spawnerTiles = [];
/** Steps from every tile to its nearest delivery tile, and the first move to get there
 * @type { Map<string, {steps:number, first?:Direction}> } */
let toDelivery = new Map();

/**
 * Arrow tiles cannot be entered from the neighbour the arrow points to,
 * i.e. with the move opposite to the arrow. Leaving them is free.
 * @type { Record<string, Direction> }
 */
const FORBIDDEN_ENTRY = { "↑": "down", "↓": "up", "←": "right", "→": "left" };

/**
 * Can I step into `to` with move `direction`?
 * @param { {x:number, y:number} } to
 * @param { Direction } direction
 */
function canEnter(to, direction) {
  const type = tiles.get(key(to));
  if (type === undefined || type == "0") return false;
  return FORBIDDEN_ENTRY[type] != direction;
}

socket.onMap((width, height, mapTiles) => {
  tiles.clear();
  for (const t of mapTiles) tiles.set(key(t), String(t.type));
  deliveryTiles = mapTiles.filter((t) => ["2", "9"].includes(String(t.type))); // delivery, double delivery
  spawnerTiles = mapTiles.filter((t) => String(t.type) == "1");
  const arrows = mapTiles.filter((t) => FORBIDDEN_ENTRY[String(t.type)]).length;
  console.log("map", width, "x", height, "|", deliveryTiles.length, "delivery,", spawnerTiles.length, "spawners,", arrows, "arrows");
  // crates are created on '5!' tiles: assume they are still there until seen otherwise
  crates.clear();
  for (const t of mapTiles) if (String(t.type) == "5!") crates.add(key(t));
  recomputeCrateTiles();
  recomputeToDelivery();
  const unreachable = spawnerTiles.filter((t) => !toDelivery.has(key(t))).length;
  console.log(
    "steps to delivery from spawners:",
    spawnerTiles.map((t) => `${key(t)}=${toDelivery.get(key(t))?.steps ?? "∞"}`).join(" "),
    unreachable ? `(${unreachable} cannot reach a delivery tile)` : ""
  );
});

socket.onTile((t) => {
  if (t.x === undefined || t.y === undefined) return;
  tiles.set(key(t), String(t.type));
  deliveryTiles = Array.from(tiles).filter(([, type]) => ["2", "9"].includes(type)).map(([k]) => fromKey(k));
  spawnerTiles = Array.from(tiles).filter(([, type]) => type == "1").map(([k]) => fromKey(k));
  recomputeCrateTiles();
  recomputeToDelivery();
});

/** @type { function (string): {x:number, y:number} } */
const fromKey = (k) => {
  const [x, y] = k.split("_").map(Number);
  return { x, y };
};

/** Crates change delivery distances when they move */
let toDeliveryCrates = "";
function recomputeToDelivery() {
  toDeliveryCrates = Array.from(crates).sort().join(",");
  toDelivery = bfs(deliveryTiles, new Set(), true);
}

/**
 * Walking into a crate pushes it one tile further, but crates only slide onto
 * free crate tiles ('5' sliding, '5!' spawner): no other crate, no agent.
 * @param { {x:number, y:number} } crate
 * @param { Direction } direction
 * @param { Set<string> } blocked tiles occupied by agents
 * @returns { number } extra cost of the push, Infinity if not possible
 */
function pushCost(crate, direction, blocked) {
  const { dx, dy } = /** @type { {dx:number, dy:number} } */ (MOVES.find((m) => m.direction == direction));
  const k = key({ x: crate.x + dx, y: crate.y + dy });
  if (!isCrateTile(k) || crates.has(k) || blocked.has(k)) return Infinity;
  if (!bottlenecks.has(k)) return PUSH_COST;
  // a crate on a bottleneck cuts the map in two: never leave it there for good
  return stuckTiles.has(k) ? Infinity : BOTTLENECK_PUSH_COST;
}

/** @type { function (string): boolean } */
const isCrateTile = (k) => (tiles.get(k) ?? "").startsWith("5");
/** @type { function (string): boolean } */
const isWalkable = (k) => tiles.has(k) && tiles.get(k) != "0";

/**
 * Crate tiles a crate could never leave again (e.g. the dead end of a corridor):
 * every push from there, if any, only leads to another stuck tile.
 * A push needs a crate tile on one side and a walkable tile to push from on the other.
 * @type { Set<string> }
 */
let stuckTiles = new Set();
/**
 * Bottleneck tiles (articulation points of the walkable map, e.g. 1-wide corridors and doorways):
 * blocking one of them with a crate disconnects part of the map.
 * @type { Set<string> }
 */
let bottlenecks = new Set();
function recomputeCrateTiles() {
  bottlenecks = articulationPoints();
  const crateTiles = Array.from(tiles.keys()).filter(isCrateTile);
  stuckTiles = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const k of crateTiles) {
      if (stuckTiles.has(k)) continue;
      const { x, y } = fromKey(k);
      const movable = MOVES.some(({ dx, dy }) => {
        const to = key({ x: x + dx, y: y + dy });
        return isCrateTile(to) && !stuckTiles.has(to) && isWalkable(key({ x: x - dx, y: y - dy }));
      });
      if (!movable) {
        stuckTiles.add(k);
        changed = true;
      }
    }
  }
}

/**
 * Articulation points of the undirected graph of walkable tiles (Tarjan's algorithm)
 * @returns { Set<string> }
 */
function articulationPoints() {
  /** @type { Map<string, number> } */ const depth = new Map();
  /** @type { Map<string, number> } */ const low = new Map();
  const points = new Set();
  /** @type { function (string, string | undefined): void } */
  const visit = (k, parent) => {
    depth.set(k, depth.size);
    low.set(k, /** @type {number} */ (depth.get(k)));
    const { x, y } = fromKey(k);
    let children = 0;
    for (const { dx, dy } of MOVES) {
      const n = key({ x: x + dx, y: y + dy });
      if (!isWalkable(n) || n == parent) continue;
      if (depth.has(n)) {
        low.set(k, Math.min(/** @type {number} */ (low.get(k)), /** @type {number} */ (depth.get(n))));
        continue;
      }
      children++;
      visit(n, k);
      low.set(k, Math.min(/** @type {number} */ (low.get(k)), /** @type {number} */ (low.get(n))));
      if (parent !== undefined && /** @type {number} */ (low.get(n)) >= /** @type {number} */ (depth.get(k))) points.add(k);
    }
    if (parent === undefined && children > 1) points.add(k);
  };
  for (const k of tiles.keys()) if (isWalkable(k) && !depth.has(k)) visit(k, undefined);
  return points;
}

/**
 * Cost of stepping into `to` with move `direction`: 1, plus the push cost if a crate is there,
 * Infinity if not possible.
 * @param { {x:number, y:number} } to
 * @param { Direction } direction
 * @param { Set<string> } blocked tiles occupied by agents
 * @param { boolean } crateThere
 */
function stepCost(to, direction, blocked, crateThere = crates.has(key(to))) {
  if (blocked.has(key(to)) || !canEnter(to, direction)) return Infinity;
  return 1 + (crateThere ? pushCost(to, direction, blocked) : 0);
}

/**
 * Shortest paths on the directed tile graph (Dijkstra with integer-cost buckets).
 * Crates are not walls: they can be pushed, at an extra cost. Going forward, a crate pushed
 * on the way is still ahead: the next step in the same direction pushes it again.
 * - forward (default): cost from the nearest source to every tile, and the first move from the source
 * - reverse: cost from every tile to the nearest source, and the first move from that tile
 * @param { {x:number, y:number}[] } sources
 * @param { Set<string> } blocked tiles occupied by agents
 * @param { boolean } reverse
 * @returns { Map< string, {steps:number, first?:Direction, pushed?:Direction} > }
 */
function bfs(sources, blocked = new Set(), reverse = false) {
  /** @type { Map< string, {steps:number, first?:Direction, pushed?:Direction} > } */
  const found = new Map();
  /** @type { {x:number, y:number}[][] } tiles to expand, by cost */
  const buckets = [[]];
  for (const s of sources) {
    const k = key(s);
    if (found.has(k)) continue;
    found.set(k, { steps: 0 });
    buckets[0].push({ x: Math.round(s.x), y: Math.round(s.y) });
  }
  for (let cost = 0; cost < buckets.length; cost++) {
    for (const tile of buckets[cost] ?? []) {
      const here = /** @type { {steps:number, first?:Direction, pushed?:Direction} } */ (found.get(key(tile)));
      if (here.steps < cost) continue; // already expanded with a lower cost
      for (const { direction, dx, dy } of MOVES) {
        // forward: tile --direction--> next.  reverse: next --direction--> tile
        const next = reverse ? { x: tile.x - dx, y: tile.y - dy } : { x: tile.x + dx, y: tile.y + dy };
        const k = key(next);
        const nextType = tiles.get(k);
        if (nextType === undefined || nextType == "0" || blocked.has(k)) continue;
        const crateThere = !reverse && (crates.has(k) || here.pushed == direction);
        const step = reverse ? stepCost(tile, direction, blocked) : stepCost(next, direction, blocked, crateThere);
        const total = cost + step;
        if (total >= (found.get(k)?.steps ?? Infinity)) continue;
        found.set(k, {
          steps: total,
          first: reverse ? direction : here.first ?? direction,
          pushed: crateThere ? direction : undefined,
        });
        (buckets[total] ??= []).push(next);
      }
    }
  }
  return found;
}

/**
 * Parcels, agents and crates, remembered when out of sight
 */

/**
 * @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number, seenAt:number} > }
 */
const parcels = new Map();

/** @type { Map< string, {id:string, x:number, y:number, seenAt:number} > } */
const agents = new Map();

/** @type { Set<string> } tiles with a crate (last seen position) */
const crates = new Set();

/** @type { Map<string, number> } last time each tile was in sight */
const tileSeenAt = new Map();

/** @type { Map<string, number> } tile -> time until which it is avoided (it blocked me recently) */
const cooldownUntil = new Map();
/** Avoid a tile as a target for a while */
const coolDown = (/** @type {string} */ k) => cooldownUntil.set(k, Date.now() + COOLDOWN_MS);
/** Is a tile still cooling down? */
const isCoolingDown = (/** @type {string} */ k) => (cooldownUntil.get(k) ?? 0) > Date.now();

/** @type { Map<string, {n:number, at:number}> } tile -> number of parcels first seen there (decaying "heat") */
const spawnHeat = new Map();
/** Spawn heat of a tile: every sighting counts, halved every minute */
function heatOf(/** @type {string} */ k) {
  const h = spawnHeat.get(k);
  return h ? h.n * Math.pow(0.5, (Date.now() - h.at) / 60000) : 0;
}

/** Incremented at every sensing event, used to cache path computations */
let sensingCount = 0;
let lastSensingAt = 0;

/**
 * Is a tile currently in my sight?
 * @type { function ({x:number, y:number}): boolean }
 */
let inSight = (t) => distance(me, t) < game.observationDistance;

socket.onSensing((sensing) => {
  sensingCount++;
  const now = Date.now();
  lastSensingAt = now;

  if (sensing.positions) {
    const visible = new Set(sensing.positions.map(key));
    inSight = (t) => visible.has(key(t));
  } else {
    inSight = (t) => distance(me, t) < game.observationDistance;
  }

  // parcels
  const sensedParcels = new Set();
  for (const p of sensing.parcels) {
    sensedParcels.add(p.id);
    if (!parcels.has(p.id) && !p.carriedBy) {
      // a new parcel: remember where parcels show up, to explore the hot spawners first
      const k = key(p);
      spawnHeat.set(k, { n: heatOf(k) + 1, at: now });
    }
    parcels.set(p.id, { ...p, seenAt: now });
  }
  for (const [id, p] of parcels) {
    if (sensedParcels.has(id)) continue;
    if (p.carriedBy) parcels.delete(id); // carried by someone out of sight (or delivered by me)
    else if (inSight(p)) parcels.delete(id); // should be visible but it is not
    else if (rewardOf(p) <= 0) parcels.delete(id); // expired
  }

  // agents
  for (const a of sensing.agents) {
    if (a.id == me.id || a.x === undefined || a.y === undefined) continue;
    agents.set(a.id, { id: a.id, x: a.x, y: a.y, seenAt: now });
  }
  // crowded area: positions go stale faster, so forget them sooner
  const memoryMs = sensing.agents.length >= 3 ? AGENT_MEMORY_MS / 2 : AGENT_MEMORY_MS;
  for (const [id, a] of agents) {
    if (a.seenAt == now) continue;
    if (now - a.seenAt > memoryMs || inSight(a)) agents.delete(id);
  }

  // remembered free parcels whose tile was visited by another agent are probably gone
  for (const [id, p] of parcels) {
    if (p.seenAt == now || p.carriedBy) continue;
    for (const a of agents.values()) if (key(a) == key(p)) parcels.delete(id);
  }

  // crates: remembered where last seen, forgotten when their tile is in sight and empty
  const sensedCrates = new Set((sensing.crates ?? []).map(key));
  for (const k of crates) if (!sensedCrates.has(k) && inSight(fromKey(k))) crates.delete(k);
  for (const k of sensedCrates) crates.add(k);
  if (Array.from(crates).sort().join(",") != toDeliveryCrates) recomputeToDelivery();

  // tiles in sight
  for (const k of tiles.keys()) if (inSight(fromKey(k))) tileSeenAt.set(k, now);
});

/**
 * Estimated current reward of a parcel, accounting for the time since it was seen
 * @type { function ({reward:number, seenAt:number}): number }
 */
const rewardOf = (p) => p.reward - (Date.now() - p.seenAt) / game.decayMs;

/** @returns parcels I am carrying */
const carried = () => Array.from(parcels.values()).filter((p) => p.carriedBy == me.id);

/** @returns free parcels */
const freeParcels = () => Array.from(parcels.values()).filter((p) => !p.carriedBy);

/** @returns { Set<string> } tiles occupied by agents currently in sight (both tiles if moving) */
function obstacles() {
  const blocked = new Set();
  for (const a of agents.values()) {
    if (a.seenAt != lastSensingAt) continue;
    blocked.add(key({ x: Math.floor(a.x), y: Math.floor(a.y) }));
    blocked.add(key({ x: Math.ceil(a.x), y: Math.ceil(a.y) }));
  }
  return blocked;
}

/** Paths from my position, avoiding agents in sight (or not). Cached until I move or sense again. */
let pathsCache = { at: "", paths: new Map(), ignoringAgents: new Map() };
function pathsFromMe(ignoreAgents = false) {
  const at = `${me.x}_${me.y}_${sensingCount}`;
  if (pathsCache.at != at) pathsCache = { at, paths: bfs([me], obstacles()), ignoringAgents: bfs([me]) };
  return ignoreAgents ? pathsCache.ignoringAgents : pathsCache.paths;
}

/** @type { function ({x:number, y:number}): number } steps from me, Infinity if unreachable */
const steps = (tile) => pathsFromMe().get(key(tile))?.steps ?? Infinity;

/** Paths from other agents (ignoring agents), cached per sensing event */
let agentPathsCache = { at: -1, paths: new Map() };
/** @type { function ({id:string, x:number, y:number}, {x:number, y:number}): number } */
function agentSteps(agent, tile) {
  if (agentPathsCache.at != sensingCount) agentPathsCache = { at: sensingCount, paths: new Map() };
  let paths = agentPathsCache.paths.get(agent.id);
  if (!paths) {
    paths = bfs([agent]);
    agentPathsCache.paths.set(agent.id, paths);
  }
  return paths.get(key(tile))?.steps ?? Infinity;
}

/** @type { function ({x:number, y:number}): number } steps from a tile to the nearest delivery */
const stepsToDelivery = (tile) => toDelivery.get(key(tile))?.steps ?? Infinity;

/** @returns nearest delivery tile reachable from me (if needed, once agents in the way move), with its distance */
function nearestDelivery() {
  let best = { tile: /** @type { {x:number, y:number} | undefined } */ (undefined), steps: Infinity };
  // delivery tiles that blocked me recently are tried last (another one may be free)
  const candidates = deliveryTiles.filter((t) => !isCoolingDown(key(t)));
  for (const tiles of candidates.length ? [candidates, deliveryTiles] : [deliveryTiles]) {
    for (const paths of [pathsFromMe(), pathsFromMe(true)]) {
      for (const t of tiles) {
        const s = paths.get(key(t))?.steps ?? Infinity;
        if (s < best.steps) best = { tile: t, steps: s };
      }
      if (best.tile) break;
    }
    if (best.tile) break;
  }
  return best;
}

/**
 * Utility of an option: reward I expect to bank at the delivery tile
 * @param { [string, ...any] } predicate
 * @returns { number }
 */
function utility(predicate) {
  const [type, x, y, id] = predicate;
  const bag = carried();
  const bagReward = bag.reduce((sum, p) => sum + rewardOf(p), 0);

  if (type == "go_pick_up") {
    const p = parcels.get(id);
    if (!p) return -Infinity;
    const mine = steps({ x, y });
    const trip = mine + stepsToDelivery({ x, y });

    // a rival at least as close as me may well take it: only count a share of its reward
    let share = 1;
    for (const a of agents.values()) if (agentSteps(a, p) <= mine) share = Math.min(share, RIVAL_WIN_SHARE);

    // multi-pickup: parcels near this one are likely collected in the same trip
    let cluster = 0;
    if (bag.length + 1 < game.capacity) {
      for (const q of freeParcels()) {
        if (q.id != p.id && distance(p, q) <= CLUSTER_RADIUS && !isCoolingDown(key(q))) cluster += rewardOf(q);
      }
    }

    return bagReward + share * rewardOf(p) + CLUSTER_BONUS * cluster - (bag.length + 1) * decayPerStep() * trip;
  }

  if (type == "go_deliver") {
    const full = bag.length >= game.capacity;
    return bagReward - bag.length * decayPerStep() * nearestDelivery().steps + (full ? 1000 : 0);
  }

  if (type == "explore") return 0;

  return -Infinity;
}

/**
 * Is the intention still worth pursuing?
 * @param { [string, ...any] } predicate
 * @returns { boolean }
 */
function valid(predicate) {
  const [type, x, y, id] = predicate;

  if (type == "go_pick_up") {
    const p = parcels.get(id);
    if (!p || p.carriedBy) return false; // gone, or someone took it
    if (carried().length >= game.capacity) return false; // I am full
    if (isCoolingDown(key(p))) return false; // it blocked me a moment ago: try elsewhere first
    const mine = pathsFromMe(true).get(key(p))?.steps ?? Infinity; // agents in the way move on
    if (mine == Infinity) return false; // unreachable
    // someone is clearly closer (positions of moving agents are rounded: a 1-step lead is noise)
    for (const a of agents.values()) if (agentSteps(a, p) + 1 < mine) return false;
    const trip = mine + stepsToDelivery(p);
    return rewardOf(p) - decayPerStep() * trip > 0; // it would not expire before delivery
  }

  if (type == "go_deliver") {
    // agents move away: a delivery tile blocked only by agents is still worth heading to
    return carried().length > 0 && deliveryTiles.some((t) => pathsFromMe(true).has(key(t)));
  }

  if (type == "explore") {
    // also when carrying but no delivery tile is reachable (e.g. crates in the way): look around
    if (carried().length && valid(["go_deliver"])) return false;
    return !freeParcels().some((p) => valid(["go_pick_up", p.x, p.y, p.id]));
  }

  return true;
}

/** @type { function ([string, ...any], [string, ...any]): boolean } */
const same = (a, b) => a.join(" ") == b.join(" ");

/**
 * Options generation and filtering function
 */
function optionsGeneration() {
  if (!me.id || me.x < 0 || !tiles.size) return;

  /**
   * Options generation
   * @type { Array< [string, ...any] > }
   */
  const options = [];
  for (const parcel of freeParcels()) options.push(["go_pick_up", parcel.x, parcel.y, parcel.id]);
  if (carried().length) options.push(["go_deliver"]);

  /**
   * Options filtering: best valid option by utility
   */
  const best = options.filter(valid).sort((a, b) => utility(b) - utility(a))[0];

  /**
   * Best option is selected
   */
  if (best) myAgent.push(best);
  else if (valid(["explore"])) myAgent.push(["explore"]);
}

/**
 * Generate options at every sensing event
 */
socket.onSensing(optionsGeneration);

/**
 * Intention revision loop
 */
class IntentionRevision {
  /** @type {IntentionDeliberation[]} */
  #intention_queue = new Array();
  get intention_queue() {
    return this.#intention_queue;
  }

  async loop() {
    while (true) {
      // Consumes intention_queue if not empty
      if (this.intention_queue.length > 0) {
        // Current intention
        const intention = this.intention_queue[0];

        // Is queued intention still valid? Do I still want to achieve it?
        let failed = false;
        if (!valid(intention.predicate)) {
          console.log("Skipping intention because no more valid", ...intention.predicate);
        } else {
          console.log("intentionRevision.loop", this.intention_queue.map((i) => i.predicate.join(" ")));
          // Start achieving intention
          await intention
            .achieve()
            // Catch eventual error and continue
            .catch(() => {
              // stopped on purpose by revision: not a failure. Otherwise (blocked, no path): breathe a bit
              failed = !intention.stopped;
            });
        }

        // Remove from the queue (also when skipped, otherwise the loop spins forever on it)
        this.intention_queue.shift();
        // a failed intention is not retried in a tight loop
        if (failed) await new Promise((res) => setTimeout(res, FAIL_PAUSE_MS));
      }
      // Postpone next iteration at setImmediate
      await new Promise((res) => setImmediate(res));
    }
  }

  /** @type { function(...any): void } */
  log(...args) {
    console.log(...args);
  }

  /**
   * @abstract
   * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
   */
  async push(predicate) {}
}

/**
 * Queue: commit to every intention in arrival order
 * @extends { IntentionRevision }
 */
class IntentionRevisionQueue extends IntentionRevision {
  /**
   * @param { [string, ...any] } predicate
   */
  async push(predicate) {
    if (this.intention_queue.find((i) => same(i.predicate, predicate))) return; // already queued
    console.log("IntentionRevisionQueue.push", ...predicate);
    this.intention_queue.push(new IntentionDeliberation(this, predicate));
  }
}

/**
 * Replace: always drop the current intention for the newest best option
 * @extends { IntentionRevision }
 */
class IntentionRevisionReplace extends IntentionRevision {
  /**
   * @param { [string, ...any] } predicate
   */
  async push(predicate) {
    const last = this.intention_queue.at(this.intention_queue.length - 1);
    if (last && same(last.predicate, predicate)) return; // already being achieved
    console.log("IntentionRevisionReplace.push", ...predicate);
    this.intention_queue.push(new IntentionDeliberation(this, predicate));
    if (last) last.stop(); // force current intention stop
  }
}

/**
 * Revise: keep waiting intentions ordered by utility, and stop the current one
 * only if it became invalid or a waiting one is clearly better (commitment)
 * @extends { IntentionRevision }
 */
class IntentionRevisionRevise extends IntentionRevision {
  /**
   * @param { [string, ...any] } predicate
   */
  async push(predicate) {
    const queue = this.intention_queue;
    if (!queue.some((i) => same(i.predicate, predicate))) {
      queue.push(new IntentionDeliberation(this, predicate));
    }

    // re-score waiting intentions: drop the ones no longer valid, keep the best first
    const [current, ...rest] = queue;
    const waiting = rest.filter((i) => valid(i.predicate)).sort((a, b) => utility(b.predicate) - utility(a.predicate));
    queue.splice(1, rest.length, ...waiting);

    const best = waiting[0];
    if (!best || current.stopped) return;

    if (!valid(current.predicate)) {
      console.log("Revise: dropping", ...current.predicate, "(no more valid) for", ...best.predicate);
      current.stop(); // the loop's catch + shift() moves on to `best`
      return;
    }

    const gain = utility(best.predicate) - utility(current.predicate);
    if (gain > SWITCH_MARGIN) {
      console.log("Revise: switching from", ...current.predicate, "to", ...best.predicate, "gain", gain.toFixed(1));
      current.stop();
    }
  }
}

/**
 * Start intention revision loop
 */

/** @type { Record<string, new () => IntentionRevision> } */
const STRATEGIES = {
  queue: IntentionRevisionQueue,
  replace: IntentionRevisionReplace,
  revise: IntentionRevisionRevise,
};
const strategy = process.argv[2] ?? "revise";
if (!STRATEGIES[strategy]) {
  console.error("Usage: node challenge1/agent.js [revise|replace|queue]");
  process.exit(1);
}
console.log("intention revision strategy:", strategy);
const myAgent = new STRATEGIES[strategy]();
myAgent.loop();

/**
 * IntentionDeliberation
 */
class IntentionDeliberation {
  /** @type { Plan | undefined } */
  #current_plan;

  #stopped = false;
  get stopped() {
    return this.#stopped;
  }
  stop() {
    this.#stopped = true;
    if (this.#current_plan) this.#current_plan.stop();
  }

  #parent;

  /** @type { [string, ...any] } */
  #predicate;
  get predicate() {
    return this.#predicate;
  }

  /**
   * @param { any } parent
   * @param { [string, ...any] } predicate
   */
  constructor(parent, predicate) {
    this.#parent = parent;
    this.#predicate = predicate;
  }

  /** @type { function(...any): void } */
  log(...args) {
    if (this.#parent && this.#parent.log) this.#parent.log("\t", ...args);
    else console.log(...args);
  }

  #started = false;
  /**
   * Using the plan library to achieve an intention
   * @returns { Promise<boolean> } the result of the plan execution
   */
  async achieve() {
    if (this.#started) return false;
    else this.#started = true;

    for (const planClass of planLibrary) {
      if (this.stopped) throw ["stopped intention", ...this.predicate];
      if (planClass.isApplicableTo(...this.predicate)) {
        this.#current_plan = new planClass(this.#parent);
        this.log("achieving intention", ...this.predicate, "with plan", planClass.name);
        try {
          const plan_res = await this.#current_plan?.execute(...this.predicate);
          this.log("succesful intention", ...this.predicate, "with plan", planClass.name, "with result:", plan_res);
          return plan_res || false;
        } catch (error) {
          this.log("failed intention", ...this.predicate, "with plan", planClass.name, "with error:", error);
        }
      }
    }

    if (this.stopped) throw ["stopped intention", ...this.predicate];
    throw ["no plan satisfied the intention ", ...this.predicate];
  }
}

/**
 * @typedef { {
 *      stop: ()=>void,
 *      stopped: boolean,
 *      log: (...arg0: any[])=>void,
 *      subIntention: (predicate: any) => Promise<any>,
 *      execute: function (string, ...any) : Promise<boolean>
 * } } Plan
 */

/**
 * @typedef { {
 *      name: string,
 *      isApplicableTo: function (string, ...any) : boolean,
 *      prototype: Plan
 * } } PlanClass
 */

/**
 * Plan library
 * @type { PlanClass [] }
 */
const planLibrary = [];

/**
 * Resolves at the next sensing event, or after maxMs: the server only sends sensing
 * when something in sight changes, so waiting for it alone may never end.
 * @returns { Promise<void> }
 */
function nextSensing(maxMs = 1000) {
  return new Promise((res) => {
    const done = () => {
      clearTimeout(timer);
      socket.off("sensing", done);
      res();
    };
    const timer = setTimeout(done, maxMs);
    socket.onSensing(done);
  });
}

/**
 * Move one step, update my position and the measured step duration.
 * Failed moves are logged with the target tile type, to verify the arrow semantics.
 * @param { Direction } direction
 * @returns { Promise< {x:number, y:number} | false > }
 */
async function move(direction) {
  const start = Date.now();
  const { dx, dy } = /** @type { {dx:number, dy:number} } */ (MOVES.find((m) => m.direction == direction));
  const target = { x: me.x + dx, y: me.y + dy };
  const pushing = crates.has(key(target));
  try {
    const moved = await socket.emitMove(direction);
    if (moved) {
      me.x = moved.x;
      me.y = moved.y;
      game.stepMs = 0.8 * game.stepMs + 0.2 * (Date.now() - start);
      if (pushing) {
        // the crate slid one tile further: update beliefs now (sensing may have done it already)
        const slid = { x: target.x + dx, y: target.y + dy };
        crates.delete(key(target));
        crates.add(key(slid));
        recomputeToDelivery();
        console.log("pushed crate", direction, "from", key(target), "to", key(slid));
      }
    } else {
      const blockedBy = obstacles().has(key(target)) ? "agent" : crates.has(key(target)) ? "crate" : "?";
      console.log("move rejected:", direction, "into", key(target), "tile", tiles.get(key(target)), "blocked by", blockedBy);
    }
    return moved;
  } catch (e) {
    // no acknowledgement within the timeout: wait for a fresh perception of my position
    await nextSensing();
    return false;
  }
}

/**
 * When agents block each other on bottlenecks (e.g. head-on in a 1-wide corridor), the one with
 * the smaller id gives way: it backs out to the nearest tile off the bottlenecks, so the other can pass.
 * A fixed priority makes sure that exactly one of two such agents moves.
 */
async function makeWay() {
  const near = Array.from(agents.values()).filter((a) => a.seenAt == lastSensingAt); // the ones in sight
  if (!near.some((a) => a.id > me.id)) return; // I have priority (or nobody is in sight): the others move
  const from = key(me);
  for (let i = 0; i < MAKE_WAY_MAX_STEPS && bottlenecks.has(key(me)); i++) {
    let best = { steps: Infinity, first: /** @type { Direction | undefined } */ (undefined) };
    for (const [k, p] of pathsFromMe()) if (!bottlenecks.has(k) && !crates.has(k) && p.steps < best.steps) best = p;
    if (!best.first || !(await move(best.first))) break;
  }
  if (key(me) != from) console.log("made way from", from, "to", key(me));
}

/**
 * Pick up free parcels on my tile and/or put down on a delivery tile, if worth it
 */
async function opportunisticActions() {
  const here = key(me);
  if (freeParcels().some((p) => key(p) == here) && carried().length < game.capacity) {
    const picked = await socket.emitPickup();
    for (const { id } of picked ?? []) {
      const p = parcels.get(id);
      if (p) p.carriedBy = me.id;
    }
  }
  if (carried().length && deliveryTiles.some((t) => key(t) == here)) {
    const dropped = await socket.emitPutdown();
    for (const { id } of dropped ?? []) parcels.delete(id);
    if (dropped?.length) console.log("delivered", dropped.length, "parcels on the way, score", me.score);
  }
}

/**
 * @abstract
 */
class PlanBase {
  #stopped = false;
  stop() {
    this.#stopped = true;
    for (const i of this.#sub_intentions) i.stop();
  }
  get stopped() {
    return this.#stopped;
  }

  #parent;

  /**
   * @param { any } parent
   */
  constructor(parent) {
    this.#parent = parent;
  }

  /** @type { function(...any): void } */
  log(...args) {
    if (this.#parent && this.#parent.log) this.#parent.log("\t", ...args);
    else console.log(...args);
  }

  /** @type { IntentionDeliberation [] } */
  #sub_intentions = [];

  /**
   * @param { [string, ...any] } predicate
   * @returns { Promise<boolean> }
   */
  async subIntention(predicate) {
    const sub_intention = new IntentionDeliberation(this, predicate);
    this.#sub_intentions.push(sub_intention);
    return sub_intention.achieve();
  }
}

/**
 * @implements { Plan }
 */
class GoPickUp extends PlanBase {
  /** @type { function( string, ...any ) : boolean } */
  static isApplicableTo(go_pick_up) {
    return go_pick_up == "go_pick_up";
  }

  /** @type { function( string, ...any ) : Promise<boolean> } */
  async execute(go_pick_up, x, y) {
    if (this.stopped) throw ["stopped"];
    await this.subIntention(["go_to", x, y]);
    if (this.stopped) throw ["stopped"];
    await opportunisticActions(); // picks up (already done on arrival by PathMove, harmless)
    if (this.stopped) throw ["stopped"];
    return true;
  }
}

/**
 * @implements { Plan }
 */
class GoDeliver extends PlanBase {
  /** @type { function( string, ...any ) : boolean } */
  static isApplicableTo(go_deliver) {
    return go_deliver == "go_deliver";
  }

  /** @type { function( string, ...any ) : Promise<boolean> } */
  async execute(go_deliver) {
    if (this.stopped) throw ["stopped"];
    const { tile } = nearestDelivery();
    if (!tile) throw ["no reachable delivery tile"];
    await this.subIntention(["go_to", tile.x, tile.y]);
    if (this.stopped) throw ["stopped"];
    if (carried().length) {
      const dropped = await socket.emitPutdown();
      for (const { id } of dropped ?? []) parcels.delete(id);
      this.log("delivered", dropped?.length ?? 0, "parcels, score", me.score);
    }
    return true;
  }
}

/**
 * @implements { Plan }
 */
class Explore extends PlanBase {
  /** @type { function( string, ...any ) : boolean } */
  static isApplicableTo(explore) {
    return explore == "explore";
  }

  /**
   * Go to the reachable spawner not seen for the longest time (penalised by distance).
   * If no spawner is reachable (e.g. walled in by crates), look around the rest of the map.
   * @type { function( string, ...any ) : Promise<boolean> }
   */
  async execute(explore) {
    if (this.stopped) throw ["stopped"];
    // reachable once agents in the way move on: wandering around because of them would block them in turn
    const cost = (/** @type {{x:number, y:number}} */ t) => pathsFromMe(true).get(key(t))?.steps ?? Infinity;
    const isTarget = (/** @type {{x:number, y:number}} */ t) => key(t) != key(me) && cost(t) < Infinity;
    const isFresh = (/** @type {{x:number, y:number}} */ t) => isTarget(t) && !isCoolingDown(key(t));
    let reachable = spawnerTiles.filter(isFresh);
    if (!reachable.length) reachable = spawnerTiles.filter(isTarget);
    if (!reachable.length) reachable = Array.from(tiles.keys()).map(fromKey).filter(isTarget);
    if (!reachable.length) {
      // e.g. standing on the only spawner, or everything blocked: wait instead of spinning
      await nextSensing();
      return true;
    }
    const now = Date.now();
    const score = (/** @type {{x:number, y:number}} */ t) => {
      const unseenMs = now - (tileSeenAt.get(key(t)) ?? 0);
      // unseen for long, close, and where parcels recently showed up
      return (Math.min(unseenMs, 60000) * (1 + HEAT_WEIGHT * heatOf(key(t)))) / (1 + cost(t)) + Math.random(); // random tie-break
    };
    const target = reachable.reduce((best, t) => (score(t) > score(best) ? t : best));
    await this.subIntention(["go_to", target.x, target.y]);
    return true;
  }
}

/**
 * Move along a shortest path on the directed map, avoiding perceived agents and crates.
 * The path is recomputed after every step, so it adapts to moving agents.
 * Free parcels on the way are picked up, and carried ones delivered when crossing a delivery tile.
 * @implements { Plan }
 * @extends { PlanBase }
 */
class PathMove extends PlanBase {
  /** @type { function( string, ...any ) : boolean } */
  static isApplicableTo(go_to) {
    return go_to == "go_to";
  }

  /** @type { function( string, ...any ) : Promise<boolean> } */
  async execute(go_to, x, y) {
    let failures = 0;
    let waits = 0;
    while (me.x != x || me.y != y) {
      if (this.stopped) throw ["stopped"];

      const first = pathsFromMe().get(key({ x, y }))?.first;
      if (!first) {
        // blocked only by agents (e.g. a narrow corridor)? wait for them to move away
        const reachableIgnoringAgents = pathsFromMe(true).has(key({ x, y }));
        if (reachableIgnoringAgents && ++waits < BLOCKED_WAIT_SENSINGS) {
          await makeWay(); // face-off in a corridor: one of the two backs out
          await nextSensing();
          continue;
        }
        // anti-deadlock: avoid this target for a while, so the next intention picks another one
        if (reachableIgnoringAgents) coolDown(key({ x, y }));
        throw [reachableIgnoringAgents ? "blocked by agents to" : "no path to", x, y];
      }

      if (await move(first)) {
        failures = 0;
        await opportunisticActions();
      } else if (++failures >= 3) {
        coolDown(key({ x, y }));
        throw ["stucked"];
      }
      else await nextSensing(); // blocked: wait for fresh beliefs and re-plan
    }
    return true;
  }
}

// plan classes are added to plan library, tried in this order.
// No blind fallback: moving while ignoring the map does not respect the arrows.
planLibrary.push(GoPickUp);
planLibrary.push(GoDeliver);
planLibrary.push(Explore);
planLibrary.push(PathMove);
