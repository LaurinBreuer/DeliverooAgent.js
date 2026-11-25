// Prints the current map as seen by a fresh agent (y up): C crate, A agent, @ the dumper itself.
// Only what is in the dumper's sight is shown (crates and agents).
// usage: node challenge1/test/dump.mjs     (env PORT, default 8080)
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect(`http://localhost:${process.env.PORT ?? 8080}`, "", "dumper");
/** @type { {x:number, y:number, type:string}[] | undefined } */
let tiles;
socket.onMap((w, h, t) => (tiles = t));
socket.onSensing((sensing) => {
  if (!tiles || !sensing.self) return;
  /** @type { Record<string, string> } */
  const grid = {};
  for (const t of tiles) grid[`${t.x}_${t.y}`] = String(t.type).padEnd(2);
  for (const c of sensing.crates ?? []) grid[`${c.x}_${c.y}`] = "C ";
  for (const a of sensing.agents ?? []) grid[`${Math.round(a.x)}_${Math.round(a.y)}`] = "A ";
  grid[`${sensing.self.x}_${sensing.self.y}`] = "@ ";
  const maxX = Math.max(...tiles.map((t) => t.x));
  const maxY = Math.max(...tiles.map((t) => t.y));
  for (let y = maxY; y >= 0; y--) {
    let row = String(y).padStart(2) + " ";
    for (let x = 0; x <= maxX; x++) row += (grid[`${x}_${y}`] ?? "  ") + " ";
    console.log(row);
  }
  console.log("   " + Array.from({ length: maxX + 1 }, (_, i) => String(i).padEnd(3)).join(""));
  process.exit(0);
});
