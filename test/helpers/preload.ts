import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One scratch root per test run: every mkdtemp a test makes lands under it, and the whole tree goes when the run ends.
// Set before anything else reads tmpdir(), so the unit dir below is under it too.
const runTmp = mkdtempSync(join(tmpdir(), "seori-run-"));
process.env["TMPDIR"] = runTmp;
afterAll(() => {
  rmSync(runTmp, { recursive: true, force: true });
});

// Loaded before every test file (bunfig.toml): `seori up` / `seori down` write units to SEORI_SYSTEMD_DIR and run
// SEORI_SYSTEMCTL. A test that wants them sets its own; nothing else may reach ~/.config/systemd/user or real systemctl.
process.env["SEORI_SYSTEMD_DIR"] = mkdtempSync(join(tmpdir(), "seori-units-"));
process.env["SEORI_SYSTEMCTL"] = "false";
