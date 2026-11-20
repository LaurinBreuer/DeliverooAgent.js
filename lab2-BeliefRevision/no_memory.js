import "dotenv/config";
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect();

const FORGET_AFTER_FRAMES = 100;

const beliefset = new Map();
let frame = 0;

socket.onConfig((config) => {
  console.log(
    "Agents observation distance:",
    config.GAME.player.observation_distance,
  );
});

socket.onMap((x, y, tiles) => {
  // console.log('Map:', x,y,tiles);
});

socket.onSensing((sensing) => {
  frame++;
  const { positions, agents } = sensing;
  console.log("Sensed tiles:", positions?.length);
  for (const a of agents) {
    const b = { ...a, lastSeenAtFrame: frame };
    console.log("Hi", a.name, "(", a.x, ",", a.y, ")");
    beliefset.set(a.id, b); // overwrite previous belief
  }

  for (const a of beliefset.values()) {
    if (frame - a.lastSeenAtFrame > FORGET_AFTER_FRAMES) {
      console.log("I have not seen", a.name, "for a long time");
      beliefset.delete(a.id);
    }
  }

  console.log(
    "My belief about other agents:",
    Array.from(beliefset.values())
      .map((a) => `${a.name}(${a.x},${a.y})@${frame - a.lastSeenAtFrame}`)
      .join(" "),
  );
});
