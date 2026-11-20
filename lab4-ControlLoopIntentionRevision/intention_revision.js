import "dotenv/config";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

/**
 * BDI agent with intention revision.
 *
 * Usage: node intention_revision.js [revise|replace|queue]   (default: revise)
 *
 * - Beliefs:    me, perceived parcels and agents, map, game config
 * - Desires:    options generated at every sensing event
 *               (go_pick_up a parcel, go_deliver what I carry, explore)
 * - Intentions: the revision strategy decides which option to commit to
 * - Plans:      plan library, tried in order until one succeeds
 *
 * Utility of an option = reward I expect to bank once I reach a delivery tile,
 * taking into account that every carried parcel decays while I walk.
 */

const socket = DjsConnect();

/** @type { function ({x:number, y:number}, {x:number, y:number}): number } */
function distance({ x: x1, y: y1 }, { x: x2, y: y2 }) {
  const dx = Math.abs(Math.round(x1) - Math.round(x2));
  const dy = Math.abs(Math.round(y1) - Math.round(y2));
  return dx + dy;
}

/** @type { function ({x:number, y:number}): string } */
const key = ({ x, y }) => `${x}_${y}`;

/** @typedef { 'up' | 'right' | 'left' | 'down' } Direction */
/** @type { {direction:Direction, dx:number, dy:number}[] } */
const MOVES = [
  { direction: "up", dx: 0, dy: 1 },
  { direction: "right", dx: 1, dy: 0 },
  { direction: "down", dx: 0, dy: -1 },
  { direction: "left", dx: -1, dy: 0 },
];

/** Switch intention only if the new one is better by at least this many points */
const SWITCH_MARGIN = 10;

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
  // compare with undefined, not truthiness: 0 is a valid coordinate.
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
  game.capacity = player?.capacity ?? Infinity;
  game.observationDistance = player?.observation_distance ?? 5;
  console.log("config: decay every", game.decayMs, "ms, capacity", game.capacity);
});

/** Points lost by each carried parcel for every step I take */
const decayPerStep = () => game.stepMs / game.decayMs;

/** @type { Set<string> } walkable tiles */
const walkable = new Set();
/** @type { {x:number, y:number}[] } */
let deliveryTiles = [];
/** @type { {x:number, y:number}[] } */
let spawnerTiles = [];
/** Steps from every tile to its nearest delivery tile
 * @type { Map<string, {steps:number}> } */
let toDelivery = new Map();

socket.onMap((width, height, tiles) => {
  walkable.clear();
  for (const t of tiles) if (String(t.type) != "0") walkable.add(key(t)); // '0' is a wall
  deliveryTiles = tiles.filter((t) => ["2", "9"].includes(String(t.type))); // delivery, double delivery
  spawnerTiles = tiles.filter((t) => String(t.type) == "1");
  toDelivery = bfs(deliveryTiles);
  console.log("map", width, "x", height, deliveryTiles.length, "delivery tiles");
});

/**
 * @type { Map< string, {id: string, carriedBy?: string, x:number, y:number, reward:number} > }
 */
const parcels = new Map();

/** Other agents currently perceived
 * @type { Map< string, {id:string, x:number, y:number} > } */
const agents = new Map();

/** Incremented at every sensing event, used to cache path computations */
let sensingCount = 0;

socket.onSensing((sensing) => {
  sensingCount++;
  // beliefs about parcels and agents are only what is currently perceived
  parcels.clear();
  for (const p of sensing.parcels) parcels.set(p.id, p);
  agents.clear();
  for (const a of sensing.agents) {
    if (a.id == me.id || a.x === undefined || a.y === undefined) continue;
    agents.set(a.id, { id: a.id, x: a.x, y: a.y });
  }
});

/** @returns parcels I am carrying */
const carried = () => Array.from(parcels.values()).filter((p) => p.carriedBy == me.id);

/** @returns { Set<string> } tiles occupied by other agents (both tiles if moving) */
function occupied() {
  const tiles = new Set();
  for (const a of agents.values()) {
    tiles.add(key({ x: Math.floor(a.x), y: Math.floor(a.y) }));
    tiles.add(key({ x: Math.ceil(a.x), y: Math.ceil(a.y) }));
  }
  return tiles;
}

/**
 * Breadth-first search over walkable tiles.
 * For every reachable tile: number of steps from the nearest source,
 * and the first move of a shortest path.
 * @param { {x:number, y:number}[] } sources
 * @param { Set<string> } blocked
 * @returns { Map< string, {steps:number, first?:Direction} > }
 */
function bfs(sources, blocked = new Set()) {
  /** @type { Map< string, {steps:number, first?:Direction} > } */
  const found = new Map();
  const queue = [];
  for (const s of sources) {
    found.set(key(s), { steps: 0 });
    queue.push({ x: s.x, y: s.y });
  }
  while (queue.length) {
    const tile = /** @type { {x:number, y:number} } */ (queue.shift());
    const here = /** @type { {steps:number, first?:Direction} } */ (found.get(key(tile)));
    for (const { direction, dx, dy } of MOVES) {
      const next = { x: tile.x + dx, y: tile.y + dy };
      const k = key(next);
      if (found.has(k) || !walkable.has(k) || blocked.has(k)) continue;
      found.set(k, { steps: here.steps + 1, first: here.first ?? direction });
      queue.push(next);
    }
  }
  return found;
}

/** Paths from my position, avoiding other agents. Cached until I move or sense again. */
let pathsCache = { at: "", paths: new Map() };
function pathsFromMe() {
  const at = `${me.x}_${me.y}_${sensingCount}`;
  if (pathsCache.at != at) pathsCache = { at, paths: bfs([me], occupied()) };
  return pathsCache.paths;
}

/** @type { function ({x:number, y:number}): number } steps from me, Infinity if unreachable */
const steps = (tile) => pathsFromMe().get(key(tile))?.steps ?? Infinity;

/** @returns nearest delivery tile reachable from me, with its distance */
function nearestDelivery() {
  let best = { tile: /** @type { {x:number, y:number} | undefined } */ (undefined), steps: Infinity };
  for (const t of deliveryTiles) if (steps(t) < best.steps) best = { tile: t, steps: steps(t) };
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
  const bagReward = bag.reduce((sum, p) => sum + p.reward, 0);

  if (type == "go_pick_up") {
    const p = parcels.get(id);
    if (!p) return -Infinity;
    const trip = steps({ x, y }) + (toDelivery.get(key({ x, y }))?.steps ?? Infinity);
    return bagReward + p.reward - (bag.length + 1) * decayPerStep() * trip;
  }

  if (type == "go_deliver") {
    return bagReward - bag.length * decayPerStep() * nearestDelivery().steps;
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
    const mine = steps(p);
    if (mine == Infinity) return false; // unreachable
    for (const a of agents.values()) if (distance(a, p) < mine) return false; // someone is closer
    const trip = mine + (toDelivery.get(key(p))?.steps ?? Infinity);
    return p.reward - decayPerStep() * trip > 0; // it would not expire before delivery
  }

  if (type == "go_deliver") return carried().length > 0 && nearestDelivery().steps < Infinity;

  if (type == "explore") {
    const nothingToDo = !carried().length && !Array.from(parcels.values()).some((p) => !p.carriedBy);
    return nothingToDo;
  }

  return true;
}

/** @type { function ([string, ...any], [string, ...any]): boolean } */
const same = (a, b) => a.join(" ") == b.join(" ");

/**
 * Options generation and filtering function
 */
function optionsGeneration() {
  if (!me.id || me.x < 0 || !walkable.size) return;

  // TODO revisit beliefset revision so to trigger option generation only in the case a new parcel is observed

  /**
   * Options generation
   * @type { Array< [string, ...any] > }
   */
  const options = [];
  for (const parcel of parcels.values())
    if (!parcel.carriedBy) options.push(["go_pick_up", parcel.x, parcel.y, parcel.id]);
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
        if (!valid(intention.predicate)) {
          console.log("Skipping intention because no more valid", ...intention.predicate);
        } else {
          console.log("intentionRevision.loop", this.intention_queue.map((i) => i.predicate.join(" ")));
          // Start achieving intention
          await intention
            .achieve()
            // Catch eventual error and continue
            .catch((error) => {
              // console.log( 'Failed intention', ...intention.predicate, 'with error:', ...error )
            });
        }

        // Remove from the queue (also when skipped, otherwise the loop spins forever on it)
        this.intention_queue.shift();
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
   * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
   */
  async push(predicate) {
    // Check if already queued
    if (this.intention_queue.find((i) => same(i.predicate, predicate))) return; // intention is already queued

    console.log("IntentionRevisionQueue.push", ...predicate);
    const intention = new IntentionDeliberation(this, predicate);
    this.intention_queue.push(intention);
  }
}

/**
 * Replace: always drop the current intention for the newest best option
 * @extends { IntentionRevision }
 */
class IntentionRevisionReplace extends IntentionRevision {
  /**
   * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
   */
  async push(predicate) {
    // Check if already queued
    const last = this.intention_queue.at(this.intention_queue.length - 1);
    if (last && same(last.predicate, predicate)) {
      return; // intention is already being achieved
    }

    console.log("IntentionRevisionReplace.push", ...predicate);
    const intention = new IntentionDeliberation(this, predicate);
    this.intention_queue.push(intention);

    // Force current intention stop
    if (last) {
      last.stop();
    }
  }
}

/**
 * Revise: keep waiting intentions ordered by utility, and stop the current one
 * only if it became invalid or a waiting one is clearly better (commitment)
 * @extends { IntentionRevision }
 */
class IntentionRevisionRevise extends IntentionRevision {
  /**
   * @param { [string, ...any] } predicate is in the form ['go_to', x, y]
   */
  async push(predicate) {
    const queue = this.intention_queue;
    if (!queue.some((i) => same(i.predicate, predicate))) {
      queue.push(new IntentionDeliberation(this, predicate));
    }

    // re-score waiting intentions: distances and rewards changed since last time,
    // drop the ones no longer valid, keep the best first
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
  console.error("Usage: node intention_revision.js [revise|replace|queue]");
  process.exit(1);
}
console.log("intention revision strategy:", strategy);
const myAgent = new STRATEGIES[strategy]();
myAgent.loop();

/**
 * IntentionDeliberation
 */
class IntentionDeliberation {
  // Plan currently used for achieving the desire
  /** @type { Plan | undefined } */
  #current_plan;

  // This is used to stop the intentionDeliberation
  #stopped = false;
  get stopped() {
    return this.#stopped;
  }
  stop() {
    // this.log( 'stop intentionDeliberation', ...this.#predicate );
    this.#stopped = true;
    if (this.#current_plan) this.#current_plan.stop();
  }

  /**
   * #parent refers to caller
   */
  #parent;

  /**
   * Desire to be achieved, for example ['go_to', x, y]
   * @type { [string, ...any] } predicate is in the form ['go_to', x, y]
   */
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
    // Cannot start twice
    if (this.#started) return false;
    else this.#started = true;

    // Trying all plans in the library
    for (const planClass of planLibrary) {
      // if stopped then quit
      if (this.stopped) throw ["stopped intention", ...this.predicate];

      // if plan is 'statically' applicable
      if (planClass.isApplicableTo(...this.predicate)) {
        // plan is instantiated
        this.#current_plan = new planClass(this.#parent);
        this.log("achieving intention", ...this.predicate, "with plan", planClass.name);
        // and plan is executed and result returned
        try {
          const plan_res = await this.#current_plan?.execute(...this.predicate);
          this.log("succesful intention", ...this.predicate, "with plan", planClass.name, "with result:", plan_res);
          return plan_res || false;
          // or errors are caught so to continue with next plan
        } catch (error) {
          this.log("failed intention", ...this.predicate, "with plan", planClass.name, "with error:", error);
        }
      }
    }

    // if stopped then quit
    if (this.stopped) throw ["stopped intention", ...this.predicate];

    // no plans have been found to satisfy the intention
    // this.log( 'no plan satisfied the intention ', ...this.predicate );
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
 * Resolves at the next sensing event
 * @returns { Promise<void> }
 */
function nextSensing() {
  return new Promise((res) => {
    const listener = () => {
      socket.off("sensing", listener);
      res();
    };
    socket.onSensing(listener);
  });
}

/**
 * Move one step, update my position and the measured step duration
 * @param { Direction } direction
 * @returns { Promise< {x:number, y:number} | false > }
 */
async function move(direction) {
  const start = Date.now();
  try {
    const moved = await socket.emitMove(direction);
    if (moved) {
      me.x = moved.x;
      me.y = moved.y;
      game.stepMs = 0.8 * game.stepMs + 0.2 * (Date.now() - start);
    }
    return moved;
  } catch (e) {
    // no acknowledgement within the timeout: wait for a fresh perception of my position
    await nextSensing();
    return false;
  }
}

/**
 * @abstract
 */
class PlanBase {
  // This is used to stop the plan
  #stopped = false;
  stop() {
    // this.log( 'stop plan' );
    this.#stopped = true;
    for (const i of this.#sub_intentions) {
      i.stop();
    }
  }
  get stopped() {
    return this.#stopped;
  }

  /**
   * #parent refers to caller
   */
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

  // this is an array of sub intention. Multiple ones could eventually being achieved in parallel.
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
  /**
   * @type { function( string, ...any ) : boolean }
   */
  static isApplicableTo(go_pick_up, x, y, id) {
    return go_pick_up == "go_pick_up";
  }

  /**
   * @type { function( string, ...any ) : Promise<boolean> }
   */
  async execute(go_pick_up, x, y) {
    if (this.stopped) throw ["stopped"]; // if stopped then quit
    await this.subIntention(["go_to", x, y]);
    if (this.stopped) throw ["stopped"]; // if stopped then quit
    await socket.emitPickup();
    if (this.stopped) throw ["stopped"]; // if stopped then quit
    return true;
  }
}

/**
 * @implements { Plan }
 */
class GoDeliver extends PlanBase {
  /**
   * @type { function( string, ...any ) : boolean }
   */
  static isApplicableTo(go_deliver) {
    return go_deliver == "go_deliver";
  }

  /**
   * @type { function( string, ...any ) : Promise<boolean> }
   */
  async execute(go_deliver) {
    if (this.stopped) throw ["stopped"]; // if stopped then quit
    const { tile } = nearestDelivery();
    if (!tile) throw ["no reachable delivery tile"];
    await this.subIntention(["go_to", tile.x, tile.y]);
    if (this.stopped) throw ["stopped"]; // if stopped then quit
    const dropped = await socket.emitPutdown();
    this.log("delivered", dropped.length, "parcels, score", me.score);
    return true;
  }
}

/**
 * @implements { Plan }
 */
class Explore extends PlanBase {
  /**
   * @type { function( string, ...any ) : boolean }
   */
  static isApplicableTo(explore) {
    return explore == "explore";
  }

  /**
   * Go to a random reachable parcel spawner (or any tile) out of my sight
   * @type { function( string, ...any ) : Promise<boolean> }
   */
  async execute(explore) {
    if (this.stopped) throw ["stopped"]; // if stopped then quit
    const candidates = spawnerTiles.length
      ? spawnerTiles
      : Array.from(walkable).map((k) => ({ x: Number(k.split("_")[0]), y: Number(k.split("_")[1]) }));
    const reachable = candidates.filter((t) => steps(t) < Infinity);
    const far = reachable.filter((t) => distance(me, t) > game.observationDistance);
    const pool = far.length ? far : reachable;
    if (!pool.length) throw ["nowhere to explore"];
    const target = pool[Math.floor(Math.random() * pool.length)];
    await this.subIntention(["go_to", target.x, target.y]);
    return true;
  }
}

/**
 * Move along a shortest path on the map, avoiding perceived agents.
 * The path is recomputed after every step, so it adapts to moving agents.
 * @implements { Plan }
 * @extends { PlanBase }
 */
class PathMove extends PlanBase {
  /**
   * @type { function( string, ...any ) : boolean }
   */
  static isApplicableTo(go_to, x, y) {
    return go_to == "go_to";
  }

  /**
   * @type { function( string, ...any ) : Promise<boolean> }
   */
  async execute(go_to, x, y) {
    let failures = 0;
    while (me.x != x || me.y != y) {
      if (this.stopped) throw ["stopped"]; // if stopped then quit

      const first = pathsFromMe().get(key({ x, y }))?.first;
      if (!first) throw ["no path to", x, y];

      if (await move(first)) failures = 0;
      else if (++failures >= 3) throw ["stucked"];
      else await nextSensing(); // blocked: wait for fresh beliefs and re-plan
    }
    return true;
  }
}

/**
 * Fallback: move toward the target ignoring the map
 * @implements { Plan }
 * @extends { PlanBase }
 */
class BlindMove extends PlanBase {
  /**
   * @type { function( string, ...any ) : boolean }
   */
  static isApplicableTo(go_to, x, y) {
    return go_to == "go_to";
  }

  /**
   * @type { function( string, ...any ) : Promise<boolean> }
   */
  async execute(go_to, x, y) {
    while (me.x != x || me.y != y) {
      if (this.stopped) throw ["stopped"]; // if stopped then quit

      let moved_horizontally;
      let moved_vertically;

      // no `me.x &&` guard: it made the agent unable to move when standing on x == 0
      if (x > me.x) moved_horizontally = await move("right");
      else if (x < me.x) moved_horizontally = await move("left");

      if (this.stopped) throw ["stopped"]; // if stopped then quit

      if (y > me.y) moved_vertically = await move("up");
      else if (y < me.y) moved_vertically = await move("down");

      if (!moved_horizontally && !moved_vertically) {
        this.log("stucked");
        throw "stucked";
      }
    }

    return true;
  }
}

// plan classes are added to plan library, tried in this order
planLibrary.push(GoPickUp);
planLibrary.push(GoDeliver);
planLibrary.push(Explore);
planLibrary.push(PathMove);
planLibrary.push(BlindMove);
