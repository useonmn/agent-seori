import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loaded before every test file (bunfig.toml): `seori up` / `seori down` write units to SEORI_SYSTEMD_DIR and run
// SEORI_SYSTEMCTL. A test that wants them sets its own; nothing else may reach ~/.config/systemd/user or real systemctl.
process.env["SEORI_SYSTEMD_DIR"] = mkdtempSync(join(tmpdir(), "seori-units-"));
process.env["SEORI_SYSTEMCTL"] = "false";
