// Install the current build into the vault as a SEPARATE dev plugin
// ("skill-harness-manager-dev") so it can be tested side-by-side with the
// community install (enable only one at a time — they register the same views
// and commands). Copies main.js + styles.css, writes a manifest with the dev id
// and name, and seeds data.json from the community install on first run (or on
// every run with --sync-config).
//
//   npm run dev:install                 # build output → dev plugin folder
//   npm run dev:install -- --sync-config  # also re-copy the community data.json
//
// Override the vault with SHM_VAULT=/path/to/vault.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const vault =
  process.env.SHM_VAULT ?? path.join(os.homedir(), "Documents/Obsidian/Vault");
const plugins = path.join(vault, ".obsidian", "plugins");
const devDir = path.join(plugins, "skill-harness-manager-dev");
const prodDir = path.join(plugins, "skill-harness-manager");
const syncConfig = process.argv.includes("--sync-config");

if (!fs.existsSync("main.js")) {
  console.error("main.js not found — run `npm run build` first.");
  process.exit(1);
}
fs.mkdirSync(devDir, { recursive: true });
for (const f of ["main.js", "styles.css"]) fs.copyFileSync(f, path.join(devDir, f));

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
manifest.id = "skill-harness-manager-dev";
manifest.name = "Skill and Harness Manager (Dev)";
manifest.version = `${manifest.version}-dev`;
fs.writeFileSync(path.join(devDir, "manifest.json"), JSON.stringify(manifest, null, "\t") + "\n");

const devData = path.join(devDir, "data.json");
const prodData = path.join(prodDir, "data.json");
if (fs.existsSync(prodData) && (syncConfig || !fs.existsSync(devData))) {
  fs.copyFileSync(prodData, devData);
  console.log(`config: copied ${prodData}`);
} else {
  console.log("config: kept existing dev data.json");
}
console.log(`installed ${manifest.name} ${manifest.version} → ${devDir}`);
