// Falsification: after the fix, (a) no libuv abort, (b) payload always present,
// (c) exit code still reflects result.ok, across all three scenarios.
import { spawn } from "node:child_process";
const script = "tests/fixtures/ui-server-harness-scenarios.mjs";
let aborts = 0, missing = 0, badCode = 0, n = 0;
for (const sc of ["run-history", "stop-run", "nudge-approval"]) {
  for (let i = 0; i < 8; i++) {
    const r = await new Promise((res) => {
      const c = spawn(process.execPath, [script, sc], { cwd: process.cwd() });
      let out = "", err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("close", (code, sig) => res({ code, sig, out, err }));
    });
    n++;
    if (/UV_HANDLE_CLOSING|Assertion failed/.test(r.err)) { aborts++; console.log("ABORT " + sc + "#" + i + " code=" + r.code); }
    const lines = r.out.trim().split("\n").filter(Boolean);
    let payload = {};
    try { payload = JSON.parse(lines.at(-1) || "{}"); } catch { payload = {}; }
    if (payload.ok !== true) { missing++; console.log("NO-PAYLOAD " + sc + "#" + i + " code=" + r.code + " out=" + JSON.stringify(r.out.slice(0,120))); }
    if (r.code !== 0) { badCode++; console.log("BAD-CODE " + sc + "#" + i + " code=" + r.code); }
  }
}
console.log(`RESULT runs=${n} aborts=${aborts} missingPayload=${missing} nonZeroExit=${badCode}`);
