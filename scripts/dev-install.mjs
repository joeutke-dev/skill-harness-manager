// Install the current build into the vault as a SEPARATE dev plugin
// ("skill-harness-manager-dev") so it can be tested side-by-side with the
// community install (enable only one at a time — they register the same views
// and commands). Copies main.js + styles.css and writes a manifest with the dev
// id and name. Settings are NOT copied: the dev build reads and writes the
// community install's data.json directly (see `sharedDataPath` in main.ts), so
// anything configured while testing is still there after switching back.
//
//   npm run dev:install                 # build output → dev plugin folder
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

console.log(
  fs.existsSync(path.join(prodDir, "manifest.json"))
    ? `config: shared with the community install (${path.join(prodDir, "data.json")})`
    : "config: no community install found — the dev build keeps its own data.json",
);
console.log(`installed ${manifest.name} ${manifest.version} → ${devDir}`);
