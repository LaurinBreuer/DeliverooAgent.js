// Admin restart of the local server: removes all agents, parcels and crates.
// Env: PORT (default 8080), ADMIN_TOKEN
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect(`http://localhost:${process.env.PORT ?? 8080}`, process.env.ADMIN_TOKEN);
socket.on("restart:complete", () => process.exit(0));
socket.on("restart:error", (e) => {
  console.error(e);
  process.exit(1);
});
socket.onConnect(() => socket.emit("restart"));
setTimeout(() => process.exit(2), 5000);
