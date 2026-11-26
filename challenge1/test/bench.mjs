// Cross-platform benchmark (Windows / macOS / Linux, no bash needed).
//
// usage: node challenge1/test/bench.mjs <game> <seconds> <reps> <label:script:count[:KEY=V,KEY=V]> ...
//
// Every <label:script:count> spec starts `count` copies of `script` (all in the same match).
// Results are the summed score of each label's agents, so specs compete against each other.
//
//   solo v2:           node challenge1/test/bench.mjs circuit 60 3 v2:challenge1/agent.js:1
//   v1 vs v2 (2 vs 2): node challenge1/test/bench.mjs circuit 60 3 v1:challenge1/agent_v1_laurin.js:2 v2:challenge1/agent.js:2
//   tuning:            ... a:challenge1/agent.js:2:SWITCH_MARGIN=5 b:challenge1/agent.js:2:SWITCH_MARGIN=20
//
// Env: PORT (default 8080), ADMIN_PASSWORD (default "admin"), DELIVEROO_GAMES (folder with the game .json files)
// Needs a local Deliveroo.js server running. Each rep restarts the server and loads the map from scratch.
// Logs go to challenge1/test/logs/, rows are appended to challenge1/test/results/bench.csv (both git-ignored).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync, createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(TEST_DIR, "../..");
const PORT = process.env.PORT ?? 8080;
const BASE = `http://localhost:${PORT}`;
const GAMES =
  process.env.DELIVEROO_GAMES ??
  resolve(REPO, "../Deliveroo.js/packages/@unitn-asa/deliveroo-js-assets/assets/games");
const LOGS = join(TEST_DIR, "logs");
const RESULTS = join(TEST_DIR, "results");
mkdirSync(LOGS, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

const [game, secsArg, repsArg, ...specArgs] = process.argv.slice(2);
if (!game || !secsArg || !repsArg || !specArgs.length) {
  console.error("usage: node challenge1/test/bench.mjs <game> <seconds> <reps> <label:script:count[:KEY=V,...]> ...");
  process.exit(1);
}
const SECS = Number(secsArg);
const REPS = Number(repsArg);
const specs = specArgs.map((s) => {
  const [label, script, count, env] = s.split(":");
  const extraEnv = Object.fromEntries((env ?? "").split(",").filter(Boolean).map((kv) => kv.split("=")));
  return { label, script, count: Number(count), extraEnv };
});

const gameFile = join(GAMES, `${game}.json`);
if (!existsSync(gameFile)) {
  console.error("unknown game:", gameFile);
  process.exit(1);
}

const sleep = (/** @type {number} */ ms) => new Promise((res) => setTimeout(res, ms));

async function adminToken() {
  const res = await fetch(`${BASE}/api/tokens?name=bench-admin`, {
    headers: { password: process.env.ADMIN_PASSWORD ?? "admin" },
  });
  if (!res.ok) throw new Error(`cannot get an admin token: HTTP ${res.status}`);
  const { token } = await res.json();
  return token;
}

/** Restart the server (removes agents, parcels and crates) and load the map */
async function loadGame(/** @type {string} */ token) {
  await new Promise((resolve, reject) => {
    const socket = DjsConnect(BASE, token);
    const timer = setTimeout(() => reject(new Error("restart timeout")), 8000);
    socket.on("restart:complete", () => (clearTimeout(timer), socket.disconnect?.(), resolve(undefined)));
    socket.on("restart:error", (e) => reject(new Error(JSON.stringify(e))));
    socket.onConnect(() => socket.emit("restart"));
  });
  const res = await fetch(`${BASE}/api/configs`, {
    method: "PATCH",
    headers: { "x-token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ GAME: JSON.parse(readFileSync(gameFile, "utf8")) }),
  });
  if (!res.ok) throw new Error(`cannot load game: HTTP ${res.status} ${await res.text()}`);
  await sleep(2000);
}

/** One match: start all the agents, wait, read the scores, stop everything */
async function match(/** @type {string} */ token, /** @type {number} */ rep) {
  const tag = `r${Date.now().toString(36)}`;
  await loadGame(token);
  /** @type {import("node:child_process").ChildProcess[]} */
  const procs = [];
  for (const spec of specs) {
    for (let i = 1; i <= spec.count; i++) {
      const name = `${tag}_${spec.label}_${i}`;
      const log = createWriteStream(join(LOGS, `${name}.log`));
      const p = spawn(process.execPath, [spec.script], {
        cwd: REPO,
        env: {
          ...process.env,
          ...spec.extraEnv,
          HOST: BASE,
          NAME: name,
          TOKEN: "",
          // an empty TOKEN may be dropped on Windows: make sure the agent does not read the shared .env
          DOTENV_CONFIG_PATH: join(TEST_DIR, ".no-env"),
        },
      });
      p.stdout?.pipe(log);
      p.stderr?.pipe(log);
      procs.push(p);
    }
  }
  await sleep(SECS * 1000);
  const agents = await (await fetch(`${BASE}/api/agents`)).json(); // before killing: disconnected agents may disappear
  for (const p of procs) p.kill();
  await sleep(500);

  /** @type {Record<string, number>} */
  const scores = {};
  for (const spec of specs) {
    scores[spec.label] = agents
      .filter((/** @type {{name:string}} */ a) => a.name.startsWith(`${tag}_${spec.label}_`))
      .reduce((/** @type {number} */ sum, /** @type {{score:number}} */ a) => sum + (a.score ?? 0), 0);
  }
  return scores;
}

const csv = join(RESULTS, "bench.csv");
if (!existsSync(csv)) appendFileSync(csv, "date,game,secs,rep,label,agents,env,score\n");

const token = await adminToken();
/** @type {Record<string, number[]>} */
const perLabel = Object.fromEntries(specs.map((s) => [s.label, []]));
for (let rep = 1; rep <= REPS; rep++) {
  const scores = await match(token, rep);
  console.log(`${game} rep ${rep}/${REPS}:`, JSON.stringify(scores));
  for (const spec of specs) {
    perLabel[spec.label].push(scores[spec.label]);
    const env = Object.entries(spec.extraEnv).map(([k, v]) => `${k}=${v}`).join(" ");
    appendFileSync(csv, `${new Date().toISOString()},${game},${SECS},${rep},${spec.label},${spec.count},${env},${scores[spec.label]}\n`);
  }
}

console.log(`\n${game}, ${SECS}s, ${REPS} reps (team score = sum of its agents)`);
for (const spec of specs) {
  const xs = perLabel[spec.label];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  console.log(`  ${spec.label.padEnd(10)} x${spec.count}  mean ${mean.toFixed(1)}  std ${std.toFixed(1)}  [${xs.join(", ")}]`);
}
process.exit(0);
