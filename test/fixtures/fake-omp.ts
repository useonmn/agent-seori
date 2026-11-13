#!/usr/bin/env bun
// Portions adapted from dori-superagent (commits after ba96abf) under the Sustainable Use License; see THIRD_PARTY_NOTICES.md.
// A fake omp on hc: no model call, it reports its status the way omp does to hc (OSC 7501, app "omp") and echoes input.
// Record: ESC ] 7501 ; state=<word>:app=omp ESC \  (fields joined by ':'). Idle at start; working for 2 s after each line
// it reads (the line is echoed), then idle again: that working report is what seori reads as omp taking a lane's
// `/goal ...` kickoff. `/goal pause` and `/goal resume` print omp's own confirmation lines. Arguments are echoed once as
// `kickoff: ...`.
// A Bun script, not sh: seori types SEORI_AGENT_CMD into the terminal as one word, and a shell running a script file in
// front of the terminal is held as an interactive shell (nothing is delivered to it).
export {}; // a module, so top-level await type-checks
const report = (state: string) => void process.stdout.write(`\x1b]7501;state=${state}:app=omp\x1b\\`);
const args = process.argv.slice(2);
if (args.length > 0) process.stdout.write(`kickoff: ${args.join(" ")}\n`);
report("idle");
for await (const line of console) {
  report("working");
  process.stdout.write(`echo: ${line}\n`);
  if (line.trim() === "/goal pause") process.stdout.write("Goal mode paused.\n");
  else if (line.trim() === "/goal resume") process.stdout.write("Goal mode resumed.\n");
  await Bun.sleep(2000);
  report("idle");
}
