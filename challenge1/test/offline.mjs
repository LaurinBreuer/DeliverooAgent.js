// Offline check of the agent's planner, without a server: loads agent.js with a stub socket,
// feeds it a game map and prints the path costs from a position.
// Legend: @ me, C crate, B crate on a bottleneck, X crate on a stuck tile; the number is the path cost.
// usage: node challenge1/test/offline.mjs <game.json> <x> <y> [agent.js]
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const [, , gameFile, mx, my, agentFile = fileURLToPath(new URL("../agent.js", import.meta.url))] = process.argv;
if (!gameFile) {
  console.log("usage: node challenge1/test/offline.mjs <game.json> <x> <y> [agent.js]");
  process.exit(1);
}

// agent source without connection and control loop, with its internals exposed
const src =
  readFileSync(agentFile, "utf8")
    .replace('import "dotenv/config";', "")
    .replace(/import \{ DjsConnect \}.*\n/, "")
    .replace("const socket = DjsConnect();", "const socket = globalThis.__stub;")
    .replace("myAgent.loop();", "")
    .replace("process.argv[2] ??", "") +
  "\nglobalThis.__api = { me, crates, stuckTiles: () => stuckTiles, bottlenecks: () => bottlenecks, key, pathsFromMe, nearestDelivery, tiles };";
/** @type { Record<string, Function[]> } */
const handlers = {};
// every socket.onX(fn) registers fn under 'onX'
// @ts-ignore
globalThis.__stub = new Proxy({}, { get: (_, name) => (/** @type {Function} */ fn) => (handlers[String(name)] ??= []).push(fn) });
await import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
// @ts-ignore
const api = globalThis.__api;

// map rows are stored top to bottom, 2 characters per tile
const rows = JSON.parse(readFileSync(gameFile, "utf8")).map.tiles;
const H = rows.length;
const W = rows[0].length / 2;
const tiles = [];
rows.forEach((/** @type {string} */ r, /** @type {number} */ i) => {
  for (let x = 0; x < W; x++) tiles.push({ x, y: H - 1 - i, type: r.slice(2 * x, 2 * x + 2).trim() });
});
handlers.onMap.forEach((f) => f(W, H, tiles));

Object.assign(api.me, { x: Number(mx), y: Number(my), id: "me" });
const paths = api.pathsFromMe();
console.log("nearest delivery", JSON.stringify(api.nearestDelivery()));
for (let y = H - 1; y >= 0; y--) {
  let row = "";
  for (let x = 0; x < W; x++) {
    const k = api.key({ x, y });
    const crate = api.stuckTiles().has(k) ? "X" : api.bottlenecks().has(k) ? "B" : "C";
    const symbol = k == api.key(api.me) ? "@" : api.crates.has(k) ? crate : (api.tiles.get(k) ?? " ")[0];
    row += symbol + (paths.has(k) ? String(paths.get(k).steps).padStart(3) : "   ") + " ";
  }
  console.log(row);
}
