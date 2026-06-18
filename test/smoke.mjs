// Pure-logic smoke tests for the Skill Layer launch/menu builders.
//
// These exercise ONLY the side-effect-free helpers in src/launch.ts (no
// Obsidian, no spawn, no filesystem mutation). launch.ts is transpiled on the
// fly with esbuild (a devDependency) so a single `node test/smoke.mjs` runs the
// whole suite with no separate build step.
//
// Coverage:
//   M1 invariants (must stay green): prompt forms, argv shape, binary
//     allowlist + fail-closed resolution, PATH augmentation.
//   M3 additions: right-click prompt (Context line), inert-path argv shape under
//     hostile paths, non-context prompt unchanged, menu gating by enablement.
//   M8 per-skill AGENT selector (replaces the harness selector): fail-closed
//     resolveAgentLaunch for each kind, built-in allowlist + custom-path
//     containment gates, YAML scalar reader, custom-agent discovery (incl.
//     missing-dir → zero), encode/decode, argv shape per launch form, and the
//     migration that strips every legacy harness key.

import esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join, relative, isAbsolute, sep } from "path";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  statSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";

const here = dirname(fileURLToPath(import.meta.url));
const builtDir = join(here, ".built");
mkdirSync(builtDir, { recursive: true });
const outfile = join(builtDir, "launch.mjs");

await esbuild.build({
  entryPoints: [join(here, "..", "src", "launch.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "silent",
});

const {
  buildLaunchPrompt,
  buildOmnigentArgv,
  buildRightClickMenuItems,
  isAllowedOmnigentPath,
  resolveOmnigentBinary,
  resolveAgentLaunch,
  isAllowedBuiltinAgent,
  isValidCustomAgentPath,
  safeCustomAgentRealPath,
  parseAgentConfigYaml,
  discoverCustomAgents,
  encodeAgentChoice,
  decodeAgentChoice,
  BUILTIN_AGENTS,
  AGENT_DEFAULT_VALUE,
  AGENT_SESSION_PROMPT,
  AGENT_INVOCATION_PLACEHOLDER,
  buildAgentInvocation,
  buildSkillInvocation,
  shellSingleQuote,
  augmentPath,
} = await import(pathToFileURL(outfile).href);

// M10: pure tab-state + Agents-tab render-model helpers (no Obsidian).
const tabsOut = join(builtDir, "tabs.mjs");
await esbuild.build({
  entryPoints: [join(here, "..", "src", "tabs.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: tabsOut,
  logLevel: "silent",
});
const {
  DEFAULT_TAB,
  TABS,
  AGENTS_EMPTY_TEXT,
  buildAgentsTabModel,
} = await import(pathToFileURL(tabsOut).href);

// M5: the pure ribbon-toggle decision helper (no Obsidian, no side effects).
const toggleOut = join(builtDir, "viewToggle.mjs");
await esbuild.build({
  entryPoints: [join(here, "..", "src", "viewToggle.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: toggleOut,
  logLevel: "silent",
});
const { decideToggleAction } = await import(pathToFileURL(toggleOut).href);

// M13: pure YAML-Viewer routing helpers (no Obsidian — deps are injected).
const yamlOut = join(builtDir, "yamlViewer.mjs");
await esbuild.build({
  entryPoints: [join(here, "..", "src", "yamlViewer.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: yamlOut,
  logLevel: "silent",
});
const {
  detectYamlViewerEnabled,
  resolveVaultTFile,
  canOpenInYamlViewer,
  isYamlFile,
  YAML_VIEWER_PLUGIN_ID,
} = await import(pathToFileURL(yamlOut).href);

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}
function eq(name, actual, expected) {
  check(
    name,
    actual === expected,
    actual === expected
      ? ""
      : `expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`,
  );
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const BIN = "/opt/homebrew/bin/omnigent";
const VAULT = "/Users/joe.utke/Documents/Obsidian/Vault";

// =====================================================================
// (c) M1 prompt forms are UNCHANGED (no Context line on the ribbon path).
// =====================================================================
console.log("\n[c] M1 ribbon/Launch prompt is unchanged (no Context line)");
{
  const anchored = buildLaunchPrompt("transcribe-meeting", VAULT, true);
  eq(
    "anchor=true → exact M1 anchored prompt",
    anchored,
    `Use the transcribe-meeting skill. Operate in this vault: ${VAULT}.` +
      " Write any files into this vault directory only." +
      " Do not create a git worktree or delegate the final file write.",
  );
  check("anchored M1 prompt has NO Context line", !anchored.includes("Context file:"));
  check("M1 prompt has no leading slash", !anchored.startsWith("/"));

  const plain = buildLaunchPrompt("transcribe-meeting", VAULT, false);
  eq("anchor=false → exact bare M1 prompt", plain, "Use the transcribe-meeting skill.");
  check("bare M1 prompt has NO Context line", !plain.includes("Context file:"));
}

// =====================================================================
// (a) Right-click prompt builder: includes `Context file: <path>`,
//     still starts with `Use the <name> skill.`, no leading slash,
//     contains the vault anchor.
// =====================================================================
console.log("\n[a] Right-click prompt builder (Context line + anchor)");
{
  const ctx = `${VAULT}/Daily/2026-06-16.md`;
  const p = buildLaunchPrompt("transcribe-meeting", VAULT, true, ctx);
  check("starts with `Use the <name> skill.`", p.startsWith("Use the transcribe-meeting skill."));
  check("includes `Context file: <path>`", p.includes(`Context file: ${ctx}.`));
  check("no leading slash", !p.startsWith("/"));
  check(
    "contains vault-anchor (operate-in / write-into)",
    p.includes(`Operate in this vault: ${VAULT}.`) &&
      p.includes("Write any files into this vault directory only.") &&
      p.includes("Do not create a git worktree or delegate the final file write."),
  );
  // The anchor must be present on the context path EVEN IF appendAnchor=false,
  // so right-click writes are always vault-scoped.
  const pNoAnchorSetting = buildLaunchPrompt("transcribe-meeting", VAULT, false, ctx);
  check(
    "context path forces vault-anchor regardless of appendAnchor",
    pNoAnchorSetting.includes(`Operate in this vault: ${VAULT}.`) &&
      pNoAnchorSetting.includes(`Context file: ${ctx}.`),
  );
}

// =====================================================================
// (b) Hostile context path stays a SINGLE inert text fragment inside the
//     one `-p` string: NO extra argv elements, no flag-like token, argv
//     shape unchanged regardless of path content.
// =====================================================================
console.log("\n[b] Hostile path stays inert inside the single -p element");
{
  // Spaces, double + single quotes, shell metachars, command substitution,
  // a leading-dash segment, and an embedded flag-like token.
  const hostile =
    `${VAULT}/-rf "; rm -rf ~"  $(whoami) \`id\` ' || curl evil ' --server http://evil --harness pwn`;
  const benign = `${VAULT}/Daily/2026-06-16.md`;

  const argvHostile = buildOmnigentArgv({
    binaryPath: BIN,
    prompt: buildLaunchPrompt("transcribe-meeting", VAULT, true, hostile),
  });
  const argvBenign = buildOmnigentArgv({
    binaryPath: BIN,
    prompt: buildLaunchPrompt("transcribe-meeting", VAULT, true, benign),
  });

  eq("hostile argv length == 4", argvHostile.length, 4);
  eq("benign argv length == 4", argvBenign.length, 4);
  eq("argv length is identical regardless of path content", argvHostile.length, argvBenign.length);
  check(
    "argv prefix [bin, run, -p] is identical (only the prompt differs)",
    deepEq(argvHostile.slice(0, 3), argvBenign.slice(0, 3)),
  );
  eq("argv[0] is the resolved binary", argvHostile[0], BIN);
  eq("argv[1] is `run`", argvHostile[1], "run");
  eq("argv[2] is the lone `-p` flag", argvHostile[2], "-p");

  // The hostile path lives ENTIRELY inside the single prompt element...
  check("hostile path is fully contained in argv[3] (the -p prompt)", argvHostile[3].includes(hostile));
  // ...and appears in NO other argv element.
  check(
    "hostile path does NOT leak into bin/run/-p elements",
    !argvHostile.slice(0, 3).some((x) => x.includes(hostile)),
  );
  // The embedded `--server` / `--harness` / `-rf` text never became its own argv token.
  check("no standalone `--server` token", argvHostile.indexOf("--server") === -1);
  check("no standalone `--harness` token", argvHostile.indexOf("--harness") === -1);
  check("no standalone `-rf` token", argvHostile.indexOf("-rf") === -1);
  // The ONLY argv element that is a bare flag is `-p` itself.
  const flagLike = argvHostile.filter((x) => /^-/.test(x));
  check("the only flag-like argv element is `-p`", flagLike.length === 1 && flagLike[0] === "-p");

  // With a custom agent configured, the config path is its OWN element, but the
  // hostile CONTEXT path STILL stays contained in the prompt only (the custom
  // config path is a separate, distinct inert element). M11: a stale
  // `serverUrl` property is IGNORED — no `--server` token is ever emitted.
  const cfg = `${VAULT}/.omnigent/agent-configs/my-agent.yaml`;
  const argvWithFlags = buildOmnigentArgv({
    binaryPath: BIN,
    prompt: buildLaunchPrompt("transcribe-meeting", VAULT, true, hostile),
    serverUrl: "https://omni.example", // stale field — must be ignored
    agent: { mode: "custom", path: cfg },
  });
  check(
    "configured shape: [bin, run, <config>, -p, prompt] (no --server)",
    deepEq(argvWithFlags.slice(0, 3), [BIN, "run", cfg]) &&
      argvWithFlags[3] === "-p" &&
      argvWithFlags.length === 5,
  );
  check("stale serverUrl never emits a --server token", argvWithFlags.indexOf("--server") === -1);
  check(
    "hostile context path still contained ONLY in the prompt element when config set",
    argvWithFlags[4].includes(hostile) && !argvWithFlags.slice(0, 4).some((x) => x.includes(hostile)),
  );
}

// =====================================================================
// (d) Menu-item construction is GATED by rightClickEnabled.
// =====================================================================
console.log("\n[d] Right-click menu items gated by enablement");
{
  const skills = [
    { id: "/v/a/SKILL.md", name: "transcribe-meeting" },
    { id: "/v/b/SKILL.md", name: "summarize-transcript" },
    { id: "/v/c/SKILL.md", name: "daily-note" },
  ];
  const enabled = new Set(["/v/a/SKILL.md", "/v/c/SKILL.md"]);
  const ctxPath = `${VAULT}/Daily/2026-06-16.md`;
  const items = buildRightClickMenuItems(skills, (id) => enabled.has(id), ctxPath);

  eq("only enabled skills produce items", items.length, 2);
  check(
    "items are exactly the enabled skills in order",
    deepEq(items.map((i) => i.skillId), ["/v/a/SKILL.md", "/v/c/SKILL.md"]),
  );
  eq("item title format", items[0].title, 'Run "transcribe-meeting" here');
  check("disabled skill (summarize-transcript) is absent", !items.some((i) => i.title.includes("summarize-transcript")));
  check("every item carries the clicked context path", items.every((i) => i.contextPath === ctxPath));

  const none = buildRightClickMenuItems(skills, () => false, ctxPath);
  eq("all-disabled → zero items", none.length, 0);
  const all = buildRightClickMenuItems(skills, () => true, ctxPath);
  eq("all-enabled → all items", all.length, 3);
}

// =====================================================================
// M1 invariants: binary allowlist + fail-closed resolution, PATH augment.
// =====================================================================
console.log("\n[M1] Binary allowlist + fail-closed resolution + PATH augment");
{
  check("allow absolute path named omnigent", isAllowedOmnigentPath("/opt/homebrew/bin/omnigent"));
  check("reject relative path", !isAllowedOmnigentPath("omnigent"));
  check("reject wrong basename", !isAllowedOmnigentPath("/usr/local/bin/not-omnigent"));
  check("reject empty", !isAllowedOmnigentPath(""));

  const exists = (p) => p === "/opt/homebrew/bin/omnigent";
  const ok = resolveOmnigentBinary({ override: "", homedir: "/Users/x", exists });
  check("auto-detect resolves a default candidate", ok.status === "ok" && ok.path === "/opt/homebrew/bin/omnigent");

  const bad = resolveOmnigentBinary({ override: "rm", homedir: "/Users/x", exists: () => true });
  check("invalid override fails closed (no fallback to defaults)", bad.status === "invalid-override");

  const missing = resolveOmnigentBinary({ override: "", homedir: "/Users/x", exists: () => false });
  check("no candidate present → not-found", missing.status === "not-found");

  const augmented = augmentPath("/usr/bin:/opt/homebrew/bin", ["/usr/local/bin", "/opt/homebrew/bin"]);
  eq("augmentPath appends new + de-dupes existing", augmented, "/usr/bin:/opt/homebrew/bin:/usr/local/bin");
}

// Shared fixtures for the per-skill AGENT selector tests.
const SCAN_DIR = `${VAULT}/.omnigent/agent-configs`;
const GOOD_YAML = `${SCAN_DIR}/my-agent.yaml`;
const GOOD_YML = `${SCAN_DIR}/other.yml`;

// =====================================================================
// (e) resolveAgentLaunch fail-closed resolution for each kind.
// =====================================================================
console.log("\n[e] Per-skill agent resolution (fail-closed for each kind)");
{
  const no = () => false;
  // Inject fs mocks: identity realpath (lexical path === real path) + isFile so
  // the fake fixture paths resolve without touching the real filesystem. (The
  // real-fs / symlink behavior is exercised with on-disk fixtures in [l].)
  const r = (stored, opts = {}) =>
    resolveAgentLaunch(stored, {
      scanDir: SCAN_DIR,
      exists: opts.exists ?? (() => true),
      isFile: opts.isFile ?? (() => true),
      realpath: opts.realpath ?? ((p) => p),
    });

  // default / absent / unknown → default.
  check("{kind:'default'} → mode default", deepEq(r({ kind: "default" }), { mode: "default" }));
  check("undefined → mode default", deepEq(r(undefined), { mode: "default" }));
  check("null → mode default", deepEq(r(null), { mode: "default" }));
  check("unknown kind → mode default", deepEq(r({ kind: "bogus" }), { mode: "default" }));
  check("non-object → mode default", deepEq(r("default"), { mode: "default" }));

  // builtin: only the hardcoded allowlist resolves; everything else fails closed.
  check("builtin polly → mode builtin polly", deepEq(r({ kind: "builtin", name: "polly" }), { mode: "builtin", name: "polly" }));
  check("builtin debby → mode builtin debby", deepEq(r({ kind: "builtin", name: "debby" }), { mode: "builtin", name: "debby" }));
  check("builtin bad name 'evil' → default (fail-closed)", deepEq(r({ kind: "builtin", name: "evil" }), { mode: "default" }));
  check("builtin 'run' (not an agent) → default", deepEq(r({ kind: "builtin", name: "run" }), { mode: "default" }));
  check("builtin metachar name → default", deepEq(r({ kind: "builtin", name: "polly; rm -rf" }), { mode: "default" }));
  check("builtin case-mismatch 'Polly' → default", deepEq(r({ kind: "builtin", name: "Polly" }), { mode: "default" }));
  check("builtin missing name → default", deepEq(r({ kind: "builtin" }), { mode: "default" }));

  // custom: must validate against the scan dir AND exist as a regular file.
  check("custom good .yaml + exists → mode custom", deepEq(r({ kind: "custom", path: GOOD_YAML }), { mode: "custom", path: GOOD_YAML }));
  check("custom good .yml + exists → mode custom", deepEq(r({ kind: "custom", path: GOOD_YML }), { mode: "custom", path: GOOD_YML }));
  check("custom good path but NOT a regular file → default (fail-closed)", deepEq(r({ kind: "custom", path: GOOD_YAML }, { isFile: no }), { mode: "default" }));
  check("custom good path but NOT exists → default (fail-closed)", deepEq(r({ kind: "custom", path: GOOD_YAML }, { exists: no }), { mode: "default" }));
  check("custom realpath escapes scan dir → default (symlink gap closed)", deepEq(r({ kind: "custom", path: GOOD_YAML }, { realpath: (p) => (p === SCAN_DIR ? SCAN_DIR : `${VAULT}/evil/secret.yaml`) }), { mode: "default" }));
  check("custom realpath throws → default (broken symlink)", deepEq(r({ kind: "custom", path: GOOD_YAML }, { realpath: () => { throw new Error("ENOENT"); } }), { mode: "default" }));
  check("custom path OUTSIDE scan dir → default", deepEq(r({ kind: "custom", path: `${VAULT}/elsewhere/x.yaml` }), { mode: "default" }));
  check("custom path traversal escape → default", deepEq(r({ kind: "custom", path: `${SCAN_DIR}/../../etc/x.yaml` }), { mode: "default" }));
  check("custom path '..' that lexically lands in-dir → default", deepEq(r({ kind: "custom", path: `${SCAN_DIR}/sub/../evil.yaml` }), { mode: "default" }));
  check("custom relative path → default", deepEq(r({ kind: "custom", path: "x.yaml" }), { mode: "default" }));
  check("custom wrong extension → default", deepEq(r({ kind: "custom", path: `${SCAN_DIR}/x.txt` }), { mode: "default" }));
  check("custom nested subdir (not direct child) → default", deepEq(r({ kind: "custom", path: `${SCAN_DIR}/sub/x.yaml` }), { mode: "default" }));
  check("custom empty path → default", deepEq(r({ kind: "custom", path: "" }), { mode: "default" }));
}

// =====================================================================
// (f) argv shape for each launch form (Default / builtin / custom); the prompt
//     stays a single inert `-p` element and `--server` is NEVER emitted (M11).
// =====================================================================
console.log("\n[f] argv shape for each launch form (Default / polly / custom)");
{
  const prompt = buildLaunchPrompt("transcribe-meeting", VAULT, true);

  // Default → `omnigent run -p <prompt>` (also the no-agent fallback).
  const argvDefault = buildOmnigentArgv({ binaryPath: BIN, prompt, agent: { mode: "default" } });
  check("Default shape: [bin, run, -p, prompt]", deepEq(argvDefault, [BIN, "run", "-p", prompt]));
  check("omitting agent == Default shape", deepEq(buildOmnigentArgv({ binaryPath: BIN, prompt }), [BIN, "run", "-p", prompt]));

  // Built-in → `omnigent <name> -p <prompt>` (subcommand form, NOT run).
  const argvPolly = buildOmnigentArgv({ binaryPath: BIN, prompt, agent: { mode: "builtin", name: "polly" } });
  check("polly shape: [bin, polly, -p, prompt]", deepEq(argvPolly, [BIN, "polly", "-p", prompt]));
  check("built-in form does NOT contain `run`", argvPolly.indexOf("run") === -1);
  const argvDebby = buildOmnigentArgv({ binaryPath: BIN, prompt, agent: { mode: "builtin", name: "debby" } });
  check("debby shape: [bin, debby, -p, prompt]", deepEq(argvDebby, [BIN, "debby", "-p", prompt]));

  // Custom → `omnigent run <config> -p <prompt>`; config is a single inert element.
  const argvCustom = buildOmnigentArgv({ binaryPath: BIN, prompt, agent: { mode: "custom", path: GOOD_YAML } });
  check("custom shape: [bin, run, <config>, -p, prompt]", deepEq(argvCustom, [BIN, "run", GOOD_YAML, "-p", prompt]));
  eq("custom config is a single argv element after run", argvCustom[2], GOOD_YAML);
  check("custom config never becomes a flag (absolute path)", !/^-/.test(argvCustom[2]));

  // No `--harness` is EVER emitted (omnigent picks the harness).
  check("no --harness token in any form", ![argvDefault, argvPolly, argvCustom].some((a) => a.includes("--harness")));

  // M11: `--server` is NEVER emitted — omnigent's own config.yaml decides server
  // routing. Even a stale `serverUrl` property (from an old data.json) is ignored
  // by the builder, in EVERY launch form. The prompt stays the final `-p` element.
  const url = "https://omni.example";
  const sd = buildOmnigentArgv({ binaryPath: BIN, prompt, serverUrl: url, agent: { mode: "default" } });
  const sp = buildOmnigentArgv({ binaryPath: BIN, prompt, serverUrl: url, agent: { mode: "builtin", name: "polly" } });
  const sc = buildOmnigentArgv({ binaryPath: BIN, prompt, serverUrl: url, agent: { mode: "custom", path: GOOD_YAML } });
  check("Default ignores stale serverUrl: [bin, run, -p, prompt]", deepEq(sd, [BIN, "run", "-p", prompt]));
  check("polly ignores stale serverUrl: [bin, polly, -p, prompt]", deepEq(sp, [BIN, "polly", "-p", prompt]));
  check("custom ignores stale serverUrl: [bin, run, <config>, -p, prompt]", deepEq(sc, [BIN, "run", GOOD_YAML, "-p", prompt]));
  for (const [n, a] of [["Default", sd], ["polly", sp], ["custom", sc]]) {
    check(`${n}: NO --server token even with a stale serverUrl`, a.indexOf("--server") === -1);
    eq(`${n}: prompt is the final element`, a[a.length - 1], prompt);
    eq(`${n}: the lone -p precedes the prompt`, a[a.length - 2], "-p");
  }
}

// =====================================================================
// (h) Allowlist + custom-path validity gates.
// =====================================================================
console.log("\n[h] isAllowedBuiltinAgent + isValidCustomAgentPath gates");
{
  check("BUILTIN_AGENTS == [polly, debby]", deepEq([...BUILTIN_AGENTS], ["polly", "debby"]));
  check("allow polly", isAllowedBuiltinAgent("polly"));
  check("allow debby", isAllowedBuiltinAgent("debby"));
  check("reject 'run'", !isAllowedBuiltinAgent("run"));
  check("reject 'evil'", !isAllowedBuiltinAgent("evil"));
  check("reject '' (empty)", !isAllowedBuiltinAgent(""));
  check("reject case-variant 'Polly'", !isAllowedBuiltinAgent("Polly"));
  check("reject non-string", !isAllowedBuiltinAgent(123) && !isAllowedBuiltinAgent(undefined));

  check("accept good .yaml direct child", isValidCustomAgentPath(GOOD_YAML, SCAN_DIR));
  check("accept good .yml direct child", isValidCustomAgentPath(GOOD_YML, SCAN_DIR));
  check("accept .YAML (case-insensitive ext)", isValidCustomAgentPath(`${SCAN_DIR}/A.YAML`, SCAN_DIR));
  check("reject path OUTSIDE scan dir", !isValidCustomAgentPath(`${VAULT}/x.yaml`, SCAN_DIR));
  check("reject traversal escape", !isValidCustomAgentPath(`${SCAN_DIR}/../../etc/x.yaml`, SCAN_DIR));
  // Raw `..` syntax is rejected BEFORE resolve() can lexically collapse it back
  // into the scan dir — even when the collapse would land in-dir.
  check("reject `..` that lexically lands in-dir (sub/../evil.yaml)", !isValidCustomAgentPath(`${SCAN_DIR}/sub/../evil.yaml`, SCAN_DIR));
  check("reject `../agent-configs/evil.yaml` re-entry syntax", !isValidCustomAgentPath(`${SCAN_DIR}/../agent-configs/evil.yaml`, SCAN_DIR));
  check("reject leading `..` segment", !isValidCustomAgentPath(`${SCAN_DIR}/../evil.yaml`, SCAN_DIR));
  check("reject nested subdir (direct child only)", !isValidCustomAgentPath(`${SCAN_DIR}/sub/x.yaml`, SCAN_DIR));
  check("reject relative path", !isValidCustomAgentPath("x.yaml", SCAN_DIR));
  check("reject wrong extension", !isValidCustomAgentPath(`${SCAN_DIR}/x.txt`, SCAN_DIR));
  check("reject empty path", !isValidCustomAgentPath("", SCAN_DIR));
  check("reject empty scan dir", !isValidCustomAgentPath(GOOD_YAML, ""));
  check("reject non-string path", !isValidCustomAgentPath(undefined, SCAN_DIR));

  // safeCustomAgentRealPath (full gate, fs ops injected) — never throws.
  const id = (p) => p;
  eq("safe: accept → returns real path", safeCustomAgentRealPath(GOOD_YAML, SCAN_DIR, { realpath: id, isFile: () => true }), GOOD_YAML);
  eq("safe: not a regular file → null", safeCustomAgentRealPath(GOOD_YAML, SCAN_DIR, { realpath: id, isFile: () => false }), null);
  eq("safe: exists=false → null", safeCustomAgentRealPath(GOOD_YAML, SCAN_DIR, { exists: () => false, realpath: id, isFile: () => true }), null);
  eq("safe: real dirname escapes → null", safeCustomAgentRealPath(GOOD_YAML, SCAN_DIR, { realpath: (p) => (p === SCAN_DIR ? SCAN_DIR : `${VAULT}/evil/x.yaml`), isFile: () => true }), null);
  eq("safe: realpath throws → null (no throw escapes)", safeCustomAgentRealPath(GOOD_YAML, SCAN_DIR, { realpath: () => { throw new Error("ENOENT"); }, isFile: () => true }), null);
  eq("safe: lexical-invalid (raw ..) → null without touching fs", safeCustomAgentRealPath(`${SCAN_DIR}/sub/../evil.yaml`, SCAN_DIR, { realpath: () => { throw new Error("should not be called"); }, isFile: () => { throw new Error("should not be called"); } }), null);
  // Symlink within the scan dir → emit the resolved (real) in-dir target.
  eq("safe: in-dir symlink → returns resolved target", safeCustomAgentRealPath(`${SCAN_DIR}/alias.yaml`, SCAN_DIR, { realpath: (p) => (p === `${SCAN_DIR}/alias.yaml` ? GOOD_YAML : p), isFile: () => true }), GOOD_YAML);
}

// =====================================================================
// (i) parseAgentConfigYaml: top-level name/description only, safe scalars.
// =====================================================================
console.log("\n[i] parseAgentConfigYaml top-level scalar reader");
{
  const basic = parseAgentConfigYaml("name: my-agent\ndescription: Does things\n");
  check("reads name + description", deepEq(basic, { name: "my-agent", description: "Does things" }));

  const quoted = parseAgentConfigYaml(`name: "quoted name"\ndescription: 'single q'\n`);
  check("strips double + single quotes", deepEq(quoted, { name: "quoted name", description: "single q" }));

  const commented = parseAgentConfigYaml("name: agent # trailing comment\n");
  eq("drops inline comment on unquoted scalar", commented.name, "agent");

  const nested = parseAgentConfigYaml("tools:\n  name: nested-ignored\nfoo: bar\n");
  check("ignores nested (indented) keys", deepEq(nested, { name: null, description: null }));

  const firstWins = parseAgentConfigYaml("name: first\nname: second\n");
  eq("first top-level name wins", firstWins.name, "first");

  const missingName = parseAgentConfigYaml("description: only a description\n");
  check("missing name → null (caller falls back to filename stem)", missingName.name === null && missingName.description === "only a description");

  check("empty text → both null", deepEq(parseAgentConfigYaml(""), { name: null, description: null }));
  check("non-string → both null", deepEq(parseAgentConfigYaml(undefined), { name: null, description: null }));
}

// =====================================================================
// (j) discoverCustomAgents: extension filter, name fallback, sorting,
//     missing dir → zero agents, isFile gating. (fs callbacks injected.)
// =====================================================================
console.log("\n[j] discoverCustomAgents (injected fs)");
{
  const files = {
    [`${SCAN_DIR}/b.yaml`]: "name: Beta\ndescription: the beta\n",
    [`${SCAN_DIR}/a.yml`]: "name: Alpha\n",
    [`${SCAN_DIR}/c.yaml`]: "description: no name here\n", // → stem fallback
    [`${SCAN_DIR}/notes.txt`]: "name: ignored\n", // wrong ext → skipped
  };
  const readdir = (dir) => {
    if (dir !== SCAN_DIR) throw new Error("ENOENT");
    return ["b.yaml", "a.yml", "c.yaml", "notes.txt"];
  };
  const readFile = (p) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  };

  const agents = discoverCustomAgents({ dir: SCAN_DIR, readdir, readFile });
  check(
    "sorted by filename, .txt filtered out",
    deepEq(agents.map((a) => a.path), [`${SCAN_DIR}/a.yml`, `${SCAN_DIR}/b.yaml`, `${SCAN_DIR}/c.yaml`]),
  );
  check("name from yaml", agents.find((a) => a.path.endsWith("a.yml")).name === "Alpha");
  check("description carried through", agents.find((a) => a.path.endsWith("b.yaml")).description === "the beta");
  check("missing name → filename stem fallback", agents.find((a) => a.path.endsWith("c.yaml")).name === "c");
  check("agent with no description omits the field", agents.find((a) => a.path.endsWith("a.yml")).description === undefined);

  // Missing directory → zero agents (readdir throws), never an error.
  const missing = discoverCustomAgents({ dir: `${VAULT}/.omnigent/does-not-exist`, readdir, readFile });
  eq("missing dir → zero agents", missing.length, 0);
  // Null dir (no vault base) → zero agents.
  eq("null dir → zero agents", discoverCustomAgents({ dir: null, readdir, readFile }).length, 0);

  // isFile gate: a directory entry that is not a file is skipped.
  const isFile = (p) => !p.endsWith("a.yml");
  const filtered = discoverCustomAgents({ dir: SCAN_DIR, readdir, readFile, isFile });
  check("isFile=false entries are skipped", !filtered.some((a) => a.path.endsWith("a.yml")) && filtered.length === 2);
}

// =====================================================================
// (k) encode/decode round-trip + migration strips ALL old harness keys.
// =====================================================================
console.log("\n[k] agent encode/decode + migration strips legacy harness keys");
{
  // Encode / decode the flat <select> value.
  eq("encode null → default", encodeAgentChoice(null), AGENT_DEFAULT_VALUE);
  eq("encode {default} → default", encodeAgentChoice({ kind: "default" }), AGENT_DEFAULT_VALUE);
  eq("encode builtin", encodeAgentChoice({ kind: "builtin", name: "polly" }), "builtin:polly");
  eq("encode custom", encodeAgentChoice({ kind: "custom", path: GOOD_YAML }), `custom:${GOOD_YAML}`);
  check("decode default", deepEq(decodeAgentChoice("default"), { kind: "default" }));
  check("decode builtin", deepEq(decodeAgentChoice("builtin:polly"), { kind: "builtin", name: "polly" }));
  check("decode custom (path with no truncation)", deepEq(decodeAgentChoice(`custom:${GOOD_YAML}`), { kind: "custom", path: GOOD_YAML }));
  check("decode unknown → default", deepEq(decodeAgentChoice("garbage"), { kind: "default" }));
  // Round-trip every kind.
  for (const v of [{ kind: "default" }, { kind: "builtin", name: "debby" }, { kind: "custom", path: GOOD_YML }]) {
    check(`round-trip ${JSON.stringify(v)}`, deepEq(decodeAgentChoice(encodeAgentChoice(v)), v));
  }

  // Mirror main.ts loadSettings migration: a stale data.json carrying every
  // legacy harness key (global + per-skill machinery) AND the M11-removed fields
  // (invocationTemplate + omnigentServerUrl) gets them ALL stripped, while every
  // other setting — including the new skillAgent map — is preserved.
  // This is the EXACT key list main.ts deletes.
  const M11_STRIP_KEYS = [
    "skillHarness",
    "discoveredHarnesses",
    "customHarnesses",
    "omnigentHarness",
    "invocationTemplate",
    "omnigentServerUrl",
  ];
  const persisted = {
    skillHarness: { "/abs/skill.md": "codex" },
    discoveredHarnesses: ["newharness"],
    customHarnesses: ["mything"],
    omnigentHarness: "claude",
    invocationTemplate: "/{name}", // M11-removed
    omnigentServerUrl: "https://stale.example", // M11-removed
    skillAgent: { "/abs/skill.md": { kind: "builtin", name: "polly" } },
    pinnedSkillIds: ["/abs/skill.md"],
    rightClickSkillIds: ["/abs/skill.md"],
    skillIcons: { "/abs/skill.md": "wand" },
    scanRoots: [{ path: "", kind: "vault", enabled: true }],
    omnigentBinaryPath: "/opt/homebrew/bin/omnigent",
    appendVaultAnchor: true,
  };
  const merged = Object.assign({}, persisted);
  for (const key of M11_STRIP_KEYS) {
    delete merged[key];
  }
  check("skillHarness stripped", merged.skillHarness === undefined);
  check("discoveredHarnesses stripped", merged.discoveredHarnesses === undefined);
  check("customHarnesses stripped", merged.customHarnesses === undefined);
  check("omnigentHarness stripped", merged.omnigentHarness === undefined);
  // M11: the two removed fields are stripped fail-closed.
  check("invocationTemplate stripped (M11)", merged.invocationTemplate === undefined);
  check("omnigentServerUrl stripped (M11)", merged.omnigentServerUrl === undefined);
  // Every other setting survives untouched.
  check("skillAgent preserved", deepEq(merged.skillAgent, { "/abs/skill.md": { kind: "builtin", name: "polly" } }));
  check("scanRoots preserved", deepEq(merged.scanRoots, [{ path: "", kind: "vault", enabled: true }]));
  check("pinnedSkillIds preserved", deepEq(merged.pinnedSkillIds, ["/abs/skill.md"]));
  check("rightClickSkillIds preserved", deepEq(merged.rightClickSkillIds, ["/abs/skill.md"]));
  check("skillIcons preserved", deepEq(merged.skillIcons, { "/abs/skill.md": "wand" }));
  check("omnigentBinaryPath preserved", merged.omnigentBinaryPath === "/opt/homebrew/bin/omnigent");
  check("appendVaultAnchor preserved", merged.appendVaultAnchor === true);

  // The migration must NOT throw on an absent / odd-shaped data.json: deleting a
  // missing key is a no-op; an empty object survives cleanly.
  const emptyMerged = {};
  for (const key of M11_STRIP_KEYS) delete emptyMerged[key]; // no throw
  check("migration on empty data.json is a clean no-op", deepEq(emptyMerged, {}));

  // A skill that previously had a harness selected reverts to the Default agent
  // (it has no skillAgent entry → resolveAgentLaunch yields mode default).
  const reverted = Object.assign({}, persisted);
  for (const key of [...M11_STRIP_KEYS, "skillAgent"]) {
    delete reverted[key];
  }
  check(
    "former harness skill with no agent entry → Default",
    deepEq(resolveAgentLaunch(reverted.skillAgent?.["/abs/skill.md"], { scanDir: SCAN_DIR, exists: () => true }), { mode: "default" }),
  );
}

// =====================================================================
// (g) M5 ribbon toggle decision: open / reveal / close.
// =====================================================================
console.log("\n[g] Ribbon toggle decision (open / reveal / close)");
{
  // No leaf open → always open (the second arg is irrelevant).
  eq("no leaf → open", decideToggleAction(false, false), "open");
  eq("no leaf (active flag ignored) → open", decideToggleAction(false, true), "open");
  // Open + active/visible → close.
  eq("open & active/visible → close", decideToggleAction(true, true), "close");
  // Open but not the active/visible leaf → reveal (bring to front).
  eq("open but not active → reveal", decideToggleAction(true, false), "reveal");
  // The toggle never returns anything other than the three known actions.
  const all = [
    decideToggleAction(false, false),
    decideToggleAction(false, true),
    decideToggleAction(true, false),
    decideToggleAction(true, true),
  ];
  check(
    "every outcome is one of open/reveal/close",
    all.every((a) => a === "open" || a === "reveal" || a === "close"),
  );
  // Closing is reachable ONLY when the leaf both exists and is active/visible.
  check(
    "close requires exists && active/visible",
    decideToggleAction(true, true) === "close" &&
      decideToggleAction(true, false) !== "close" &&
      decideToggleAction(false, true) !== "close",
  );
}

// =====================================================================
// (l) REAL on-disk symlink fixtures: resolveAgentLaunch with the DEFAULT fs
//     (no injected realpath/isFile) — proves the symlink gap is closed end to
//     end and that broken/escaping links fall back to Default; never throws.
// =====================================================================
console.log("\n[l] real-fs symlink fixtures (default fs path)");
{
  const tmp = mkdtempSync(join(tmpdir(), "skill-layer-agents-"));
  const scan = join(tmp, "agent-configs");
  mkdirSync(scan, { recursive: true });
  // A real, plain config file (the no-regression acceptance case).
  const realFile = join(scan, "agent.yaml");
  writeFileSync(realFile, "name: Real\n");
  // A directory outside the scan dir holding a secret config.
  const outside = join(tmp, "outside");
  mkdirSync(outside, { recursive: true });
  const secret = join(outside, "secret.yaml");
  writeFileSync(secret, "name: Secret\n");
  // A direct-child symlink whose real target escapes the scan dir.
  const escapeLink = join(scan, "escape.yaml");
  symlinkSync(secret, escapeLink);
  // A direct-child broken symlink (target does not exist).
  const brokenLink = join(scan, "broken.yaml");
  symlinkSync(join(tmp, "nope.yaml"), brokenLink);
  // A direct-child symlink to the real in-dir file (legitimate).
  const aliasLink = join(scan, "alias.yaml");
  symlinkSync(realFile, aliasLink);

  // Use the DEFAULT fs ops (no realpath/isFile injection); exists = real fs.
  const rr = (p) =>
    resolveAgentLaunch(
      { kind: "custom", path: p },
      { scanDir: scan, exists: (q) => existsSync(q) },
    );

  // macOS tmpdir is itself a symlink (/var → /private/var); the gate realpaths
  // BOTH sides, so a legitimate real child still matches.
  check("real plain file → ACCEPTED (no regression)", deepEq(rr(realFile), { mode: "custom", path: realpathSync(realFile) }));
  check("in-dir symlink → ACCEPTED, emits resolved in-dir target", deepEq(rr(aliasLink), { mode: "custom", path: realpathSync(realFile) }));
  check("symlink whose realpath ESCAPES scan dir → default", deepEq(rr(escapeLink), { mode: "default" }));
  check("broken symlink → default (fail-closed, no throw)", deepEq(rr(brokenLink), { mode: "default" }));
  check("(fixture sanity) escape link realpath is outside scan dir", dirname(realpathSync(escapeLink)) !== realpathSync(scan));

  // statSync follows symlinks, so confirm a real escaping target is a regular
  // file — i.e. it is the realpath gate (not the isFile gate) that rejects it.
  check("(fixture sanity) escape target is a regular file", statSync(escapeLink).isFile());

  rmSync(tmp, { recursive: true, force: true });
}

// =====================================================================
// (m) BUNDLE-directory discovery + validation + argv (injected fs). A full
//     omnigent spec must live as a bundle dir `<name>/config.yaml` (not a loose
//     yaml); discovery, the path gate, and argv must handle BOTH forms.
// =====================================================================
console.log("\n[m] bundle-directory discovery + validation + argv (injected fs)");
{
  const BUNDLE_DIR = `${SCAN_DIR}/vault-agent`;
  const BUNDLE_CONFIG = `${BUNDLE_DIR}/config.yaml`;
  const LOOSE = `${SCAN_DIR}/loose.yaml`;
  const LOOSE2 = `${SCAN_DIR}/other.yml`;
  const NOCONFIG_DIR = `${SCAN_DIR}/not-an-agent`; // dir, no config.yaml → ignored

  const dirs = new Set([SCAN_DIR, BUNDLE_DIR, NOCONFIG_DIR]);
  const files = {
    [LOOSE]: "name: Loose One\n",
    [LOOSE2]: "name: Loose Two\n",
    [BUNDLE_CONFIG]: "name: Vault Agent\ndescription: bundle agent\n",
  };
  const readdir = (d) => {
    if (d !== SCAN_DIR) throw new Error("ENOENT");
    return ["vault-agent", "loose.yaml", "other.yml", "not-an-agent"];
  };
  const readFile = (p) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p];
  };
  const isFile = (p) => p in files;
  const isDirectory = (p) => dirs.has(p);
  // No symlinks in this fake fs, so a regular-file (no-follow) check is the same
  // as `isFile` here. The symlinked/directory config.yaml rejections are proven
  // with real on-disk fixtures in section [o].
  const isRegularFileNoFollow = isFile;

  // Discovery enumerates the bundle dir AND both loose files; ignores the
  // config-less subdir.
  const agents = discoverCustomAgents({ dir: SCAN_DIR, readdir, readFile, isFile, isDirectory });
  const byPath = (p) => agents.find((a) => a.path === p);
  eq("discovery yields exactly 3 agents (1 bundle + 2 loose)", agents.length, 3);
  check("bundle dir discovered; launch path IS the directory", !!byPath(BUNDLE_DIR));
  check("loose .yaml discovered", !!byPath(LOOSE));
  check("loose .yml discovered (not just .yaml)", !!byPath(LOOSE2));
  check("config-less subdir is NOT an agent", !byPath(NOCONFIG_DIR));
  check("bundle name read from <dir>/config.yaml", byPath(BUNDLE_DIR)?.name === "Vault Agent");
  check("bundle description read from <dir>/config.yaml", byPath(BUNDLE_DIR)?.description === "bundle agent");
  check("bundle launch path is the dir, NOT the config.yaml inside it", byPath(BUNDLE_DIR)?.path === BUNDLE_DIR && !byPath(BUNDLE_DIR)?.path.endsWith("config.yaml"));

  // Bundle directory-name fallback when config.yaml has no `name:`.
  const NAMELESS = `${SCAN_DIR}/named-by-dir`;
  const files2 = { [`${NAMELESS}/config.yaml`]: "description: no name\n" };
  const agents2 = discoverCustomAgents({
    dir: SCAN_DIR,
    readdir: (d) => (d === SCAN_DIR ? ["named-by-dir"] : ((_) => { throw new Error("ENOENT"); })(d)),
    readFile: (p) => { if (!(p in files2)) throw new Error("ENOENT"); return files2[p]; },
    isFile: (p) => p in files2,
    isDirectory: (p) => p === NAMELESS,
  });
  check("bundle name falls back to directory name when name: missing", agents2.length === 1 && agents2[0].name === "named-by-dir" && agents2[0].path === NAMELESS);

  // argv: bundle launches `omnigent run <dir>`; loose launches `omnigent run <file>`.
  const prompt = buildLaunchPrompt("transcribe-meeting", VAULT, true);
  const bundleArgv = buildOmnigentArgv({ binaryPath: BIN, prompt, agent: { mode: "custom", path: BUNDLE_DIR } });
  check("bundle argv == [bin, run, <dir>, -p, prompt]", deepEq(bundleArgv, [BIN, "run", BUNDLE_DIR, "-p", prompt]));
  const looseArgv = buildOmnigentArgv({ binaryPath: BIN, prompt, agent: { mode: "custom", path: LOOSE } });
  check("loose argv == [bin, run, <file>, -p, prompt]", deepEq(looseArgv, [BIN, "run", LOOSE, "-p", prompt]));

  // Validator (safeCustomAgentRealPath): bundle accepted as a real direct child;
  // config-less subdir rejected; lexical gate accepts the extension-less bundle
  // candidate yet still rejects wrong extensions and `..` traversal.
  const id = (p) => p;
  eq("safe: bundle dir (has config.yaml) → returns real dir path", safeCustomAgentRealPath(BUNDLE_DIR, SCAN_DIR, { realpath: id, isFile, isDirectory, isRegularFileNoFollow }), BUNDLE_DIR);
  eq("safe: subdir WITHOUT config.yaml → null", safeCustomAgentRealPath(NOCONFIG_DIR, SCAN_DIR, { realpath: id, isFile, isDirectory, isRegularFileNoFollow }), null);
  eq("safe: extension-less path with no dir/file → null", safeCustomAgentRealPath(`${SCAN_DIR}/ghost`, SCAN_DIR, { realpath: id, isFile, isDirectory, isRegularFileNoFollow }), null);
  eq("safe: bundle path containing `..` → null without touching fs", safeCustomAgentRealPath(`${SCAN_DIR}/sub/../vault-agent`, SCAN_DIR, { realpath: () => { throw new Error("should not be called"); }, isFile: () => { throw new Error("should not be called"); }, isDirectory: () => { throw new Error("should not be called"); } }), null);
  eq("safe: bundle realpath escapes scan dir → null", safeCustomAgentRealPath(BUNDLE_DIR, SCAN_DIR, { realpath: (p) => (p === SCAN_DIR ? SCAN_DIR : `${VAULT}/evil/vault-agent`), isFile, isDirectory, isRegularFileNoFollow }), null);
  // Bundle with a config.yaml that is NOT a directly-contained regular file
  // (symlink / directory) → rejected: isRegularFileNoFollow returns false.
  eq("safe: bundle config.yaml is a symlink → null (no-follow rejects)", safeCustomAgentRealPath(BUNDLE_DIR, SCAN_DIR, { realpath: id, isFile, isDirectory, isRegularFileNoFollow: () => false }), null);
  check("lexical: extension-less bundle path accepted (candidate)", isValidCustomAgentPath(BUNDLE_DIR, SCAN_DIR));
  check("lexical: still rejects wrong-extension file (.txt)", !isValidCustomAgentPath(`${SCAN_DIR}/x.txt`, SCAN_DIR));
  check("lexical: rejects bundle path with `..` traversal", !isValidCustomAgentPath(`${SCAN_DIR}/sub/../vault-agent`, SCAN_DIR));

  // resolveAgentLaunch end-to-end for a bundle (injected fs).
  const resolvedBundle = resolveAgentLaunch(
    { kind: "custom", path: BUNDLE_DIR },
    { scanDir: SCAN_DIR, exists: (p) => dirs.has(p) || p in files, realpath: id, isFile, isDirectory, isRegularFileNoFollow },
  );
  check("resolveAgentLaunch bundle → mode custom with the DIR path", deepEq(resolvedBundle, { mode: "custom", path: BUNDLE_DIR }));
  const resolvedNoConfig = resolveAgentLaunch(
    { kind: "custom", path: NOCONFIG_DIR },
    { scanDir: SCAN_DIR, exists: (p) => dirs.has(p) || p in files, realpath: id, isFile, isDirectory, isRegularFileNoFollow },
  );
  check("resolveAgentLaunch config-less subdir → default", deepEq(resolvedNoConfig, { mode: "default" }));
}

// =====================================================================
// (n) REAL on-disk BUNDLE fixtures: discovery + resolveAgentLaunch with the
//     DEFAULT fs — proves a real bundle dir is a real direct child, a config-less
//     subdir is ignored/rejected, and symlink-escape / broken-symlink bundles
//     fall back to Default; never throws.
// =====================================================================
console.log("\n[n] real-fs bundle directory fixtures (default fs path)");
{
  const tmp = mkdtempSync(join(tmpdir(), "skill-layer-bundles-"));
  const scan = join(tmp, "agent-configs");
  mkdirSync(scan, { recursive: true });
  // A real bundle dir with config.yaml.
  const bundle = join(scan, "vault-agent");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "config.yaml"), "name: Vault Agent\ndescription: the real bundle\n");
  // A real loose file alongside.
  const loose = join(scan, "loose.yaml");
  writeFileSync(loose, "name: Loose\n");
  // A subdir WITHOUT config.yaml → ignored / rejected.
  const noconfig = join(scan, "not-an-agent");
  mkdirSync(noconfig, { recursive: true });
  writeFileSync(join(noconfig, "readme.md"), "nope\n");
  // A bundle dir OUTSIDE scan, plus an in-scan symlink to it (escape).
  const outsideBundle = join(tmp, "outside-bundle");
  mkdirSync(outsideBundle, { recursive: true });
  writeFileSync(join(outsideBundle, "config.yaml"), "name: Escapee\n");
  const escapeDirLink = join(scan, "escape-bundle");
  symlinkSync(outsideBundle, escapeDirLink);
  // A broken dir symlink (target does not exist).
  const brokenDirLink = join(scan, "broken-bundle");
  symlinkSync(join(tmp, "nope-dir"), brokenDirLink);

  // Discovery with the DEFAULT real fs.
  const agents = discoverCustomAgents({
    dir: scan,
    readdir: (d) => readdirSync(d),
    readFile: (p) => readFileSync(p, "utf8"),
    isFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
    isDirectory: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  });
  const paths = agents.map((a) => a.path);
  check("real discovery includes the bundle dir", paths.includes(bundle));
  check("real discovery includes the loose file", paths.includes(loose));
  check("real discovery excludes the config-less subdir", !paths.includes(noconfig));
  check("real bundle name read from config.yaml", agents.find((a) => a.path === bundle)?.name === "Vault Agent");
  // The escaping bundle symlink IS a directory with a (followed) config.yaml, so
  // discovery may surface it for display — launch re-validates and rejects it.

  const rr = (p) => resolveAgentLaunch({ kind: "custom", path: p }, { scanDir: scan, exists: (q) => existsSync(q) });
  // macOS tmpdir is a symlink (/var → /private/var); the gate realpaths both
  // sides, so a legitimate real child still matches.
  check("real bundle dir → ACCEPTED (real direct child), emits real dir path", deepEq(rr(bundle), { mode: "custom", path: realpathSync(bundle) }));
  check("config-less subdir → default", deepEq(rr(noconfig), { mode: "default" }));
  check("symlinked bundle escaping scan dir → default", deepEq(rr(escapeDirLink), { mode: "default" }));
  check("broken bundle symlink → default (fail-closed, no throw)", deepEq(rr(brokenDirLink), { mode: "default" }));
  check("(fixture sanity) escape bundle realpath is outside scan dir", dirname(realpathSync(escapeDirLink)) !== realpathSync(scan));

  rmSync(tmp, { recursive: true, force: true });
}

// =====================================================================
// (o) REAL on-disk fixtures for the BLOCKING fix: a bundle's `config.yaml` must
//     be a DIRECTLY-CONTAINED REGULAR FILE — a symlinked config.yaml (even to a
//     real file in or out of the scan dir) or a config.yaml that is a DIRECTORY
//     is rejected (fall back to Default). Uses the DEFAULT fs (lstat no-follow).
// =====================================================================
console.log("\n[o] real-fs bundle config.yaml must be a regular file (no-follow)");
{
  const tmp = mkdtempSync(join(tmpdir(), "skill-layer-cfgsym-"));
  const scan = join(tmp, "agent-configs");
  mkdirSync(scan, { recursive: true });

  // Control: a normal bundle with a regular-file config.yaml → ACCEPTED.
  const okBundle = join(scan, "ok-bundle");
  mkdirSync(okBundle, { recursive: true });
  writeFileSync(join(okBundle, "config.yaml"), "name: OK\n");

  // A real config target INSIDE the scan dir (so the target is not the issue —
  // only the fact that the bundle's config.yaml is a SYMLINK).
  const innerTarget = join(scan, "inner-target.yaml");
  writeFileSync(innerTarget, "name: InnerTarget\n");
  // A real config target OUTSIDE the scan dir.
  const outerTarget = join(tmp, "outer-target.yaml");
  writeFileSync(outerTarget, "name: OuterTarget\n");

  // Bundle whose config.yaml is a SYMLINK to a file INSIDE the scan dir.
  const symInBundle = join(scan, "sym-in-bundle");
  mkdirSync(symInBundle, { recursive: true });
  symlinkSync(innerTarget, join(symInBundle, "config.yaml"));

  // Bundle whose config.yaml is a SYMLINK to a file OUTSIDE the scan dir.
  const symOutBundle = join(scan, "sym-out-bundle");
  mkdirSync(symOutBundle, { recursive: true });
  symlinkSync(outerTarget, join(symOutBundle, "config.yaml"));

  // Bundle whose config.yaml is itself a DIRECTORY.
  const dirCfgBundle = join(scan, "dir-cfg-bundle");
  mkdirSync(join(dirCfgBundle, "config.yaml"), { recursive: true });

  const rr = (p) => resolveAgentLaunch({ kind: "custom", path: p }, { scanDir: scan, exists: (q) => existsSync(q) });

  check("regular-file config.yaml → ACCEPTED (no regression)", deepEq(rr(okBundle), { mode: "custom", path: realpathSync(okBundle) }));
  check("config.yaml symlink → file INSIDE scan dir → REJECTED", deepEq(rr(symInBundle), { mode: "default" }));
  check("config.yaml symlink → file OUTSIDE scan dir → REJECTED", deepEq(rr(symOutBundle), { mode: "default" }));
  check("config.yaml is a DIRECTORY → REJECTED", deepEq(rr(dirCfgBundle), { mode: "default" }));
  // Sanity: the symlinked config.yaml targets ARE real regular files — proving
  // it is the no-follow check (not a missing/odd target) that rejects them.
  check("(fixture sanity) inner symlink target is a regular file", statSync(join(symInBundle, "config.yaml")).isFile());
  check("(fixture sanity) outer symlink target is a regular file", statSync(join(symOutBundle, "config.yaml")).isFile());

  rmSync(tmp, { recursive: true, force: true });
}

// =====================================================================
// (p) M10 TABBED UI: tab-switch state, Agents-tab render model (N agents +
//     empty state), agent-session argv shape, copy-invocation format, and
//     launch-path validation rejecting a bad agent path.
// =====================================================================
console.log("\n[p] M10 tabbed UI (tab state, agents-tab model, agent launch)");
{
  // --- tab-switch state: default Skills; switch to Agents and back ---------
  eq("default tab is Skills", DEFAULT_TAB, "skills");
  check("TABS are Skills then Agents", deepEq(TABS.map((t) => t.id), ["skills", "agents"]));
  check("TABS labels are Skills / Agents", deepEq(TABS.map((t) => t.label), ["Skills", "Agents"]));
  // Simulate the click handler: state := clicked tab.id (assigned directly,
  // as src/view.ts does — the id always comes from the known TABS list).
  let tab = DEFAULT_TAB;
  eq("starts on Skills", tab, "skills");
  tab = TABS[1].id;
  eq("switching to Agents → agents", tab, "agents");
  tab = TABS[0].id;
  eq("switching back to Skills → skills", tab, "skills");

  // --- Agents tab renders N discovered agents -----------------------------
  const sampleAgents = [
    { path: "/v/.omnigent/agent-configs/vault-agent", name: "Vault Agent", description: "Helps in the vault" },
    { path: "/v/.omnigent/agent-configs/loose.yaml", name: "Loose One" },
    { path: "/v/.omnigent/agent-configs/another", name: "Another", description: "Third agent" },
  ];
  const model = buildAgentsTabModel(sampleAgents);
  check("3 agents → not empty", model.empty === false);
  eq("3 agents → 3 rows", model.empty ? -1 : model.rows.length, 3);
  check("row titles preserve discovery order", model.empty ? false : deepEq(model.rows.map((r) => r.title), ["Vault Agent", "Loose One", "Another"]));
  check("row paths are the discovered launch paths", model.empty ? false : deepEq(model.rows.map((r) => r.path), sampleAgents.map((a) => a.path)));
  check("description maps to subtitle", model.empty ? false : model.rows[0].subtitle === "Helps in the vault");
  check("missing description → empty subtitle", model.empty ? false : model.rows[1].subtitle === "");

  // --- Agents tab empty state ---------------------------------------------
  const emptyModel = buildAgentsTabModel([]);
  check("no agents → empty model", emptyModel.empty === true);
  eq("empty model carries the empty-state text", emptyModel.empty ? emptyModel.text : "", AGENTS_EMPTY_TEXT);
  check("empty text names the dir + the create skill", AGENTS_EMPTY_TEXT.includes(".omnigent/agent-configs/") && AGENTS_EMPTY_TEXT.includes("create-custom-agent"));
  check("non-array agents → empty (fail-safe)", buildAgentsTabModel(undefined).empty === true);

  // --- agent launch argv shape == [bin, 'run', <path>, '-p', <prompt>] -----
  const AGENT_PATH = "/Users/joe.utke/Documents/Obsidian/Vault/.omnigent/agent-configs/vault-agent";
  const launchArgv = buildOmnigentArgv({
    binaryPath: BIN,
    prompt: AGENT_SESSION_PROMPT,
    agent: { mode: "custom", path: AGENT_PATH },
  });
  check("agent-session argv == [bin,'run',<path>,'-p',<prompt>]", deepEq(launchArgv, [BIN, "run", AGENT_PATH, "-p", AGENT_SESSION_PROMPT]));
  check("agent path is a SINGLE inert argv element", launchArgv.filter((a) => a === AGENT_PATH).length === 1);
  check("default session prompt is a non-empty, non-slash sentence", typeof AGENT_SESSION_PROMPT === "string" && AGENT_SESSION_PROMPT.length > 0 && !AGENT_SESSION_PROMPT.startsWith("/"));
  // M11: a stale serverUrl is IGNORED — the agent-session argv emits no --server.
  const launchArgvSrv = buildOmnigentArgv({ binaryPath: BIN, prompt: AGENT_SESSION_PROMPT, serverUrl: "https://x", agent: { mode: "custom", path: AGENT_PATH } });
  check("agent-session argv ignores stale serverUrl: [bin,run,<path>,-p,prompt]", deepEq(launchArgvSrv, [BIN, "run", AGENT_PATH, "-p", AGENT_SESSION_PROMPT]));
  check("agent-session argv emits NO --server token", launchArgvSrv.indexOf("--server") === -1);

  // --- copy-invocation string format (M11: path is SHELL-QUOTED) ----------
  eq(
    "copy invocation == omnigent run '<path>' -p \"<your prompt here>\"",
    buildAgentInvocation(AGENT_PATH),
    `omnigent run '${AGENT_PATH}' -p "<your prompt here>"`,
  );
  check("invocation placeholder is the documented one", AGENT_INVOCATION_PLACEHOLDER === "<your prompt here>");
  check("invocation uses the 'run' subcommand (custom-agent form)", buildAgentInvocation(AGENT_PATH).startsWith("omnigent run "));
  check("agent path is single-quote wrapped in the invocation", buildAgentInvocation(AGENT_PATH).includes(`run '${AGENT_PATH}'`));

  // A path containing spaces and shell metacharacters is single-quoted so it
  // pastes into a shell as ONE safe argument; an embedded single quote is escaped
  // as '\'' (close-quote, escaped-quote, reopen-quote).
  const SPACEY = "/Users/me/Obsidian Vault/.omnigent/agent-configs/my agent; rm -rf ~";
  eq("shellSingleQuote wraps + leaves a metachar path inert", shellSingleQuote(SPACEY), `'${SPACEY}'`);
  const QUOTEY = "/v/.omnigent/agent-configs/it's-an-agent";
  eq("shellSingleQuote escapes an embedded single quote", shellSingleQuote(QUOTEY), `'/v/.omnigent/agent-configs/it'\\''s-an-agent'`);
  check(
    "agent invocation embeds the fully-quoted metachar path",
    buildAgentInvocation(SPACEY) === `omnigent run '${SPACEY}' -p "<your prompt here>"`,
  );
  // Re-quoting is idempotent at the boundary: the metachars never escape the quotes.
  check("metachars stay inside the single-quoted region", !/run [^']*[;&|$`]/.test(buildAgentInvocation(SPACEY)));

  // --- skill copy-invocation == the FIXED natural-language form -----------
  // (M11 removed the user-configurable template; embeds no path, no quoting.)
  eq("skill copy invocation == `Use the <name> skill.`", buildSkillInvocation("transcribe-meeting"), "Use the transcribe-meeting skill.");
  check("skill invocation has no leading slash (no REPL slash form)", !buildSkillInvocation("daily-note").startsWith("/"));
  check("skill invocation matches the launch-prompt base", buildLaunchPrompt("daily-note", VAULT, false) === buildSkillInvocation("daily-note"));

  // --- launch rejects an agent path that fails validation ------------------
  // safeCustomAgentRealPath is the SAME gate launch + copy use; null ⇒ no spawn.
  // These fail at the lexical gate (before any fs op), so stub fs ops that throw
  // prove the rejection is fail-closed and doesn't even touch the filesystem.
  const SCAN = "/Users/joe.utke/Documents/Obsidian/Vault/.omnigent/agent-configs";
  const throwingFs = {
    exists: () => { throw new Error("must not be called"); },
    realpath: () => { throw new Error("must not be called"); },
    isFile: () => { throw new Error("must not be called"); },
    isDirectory: () => { throw new Error("must not be called"); },
    isRegularFileNoFollow: () => { throw new Error("must not be called"); },
  };
  check("launch rejects a path outside the scan dir → null", safeCustomAgentRealPath("/etc/evil.yaml", SCAN, throwingFs) === null);
  check("launch rejects a `..` traversal path → null", safeCustomAgentRealPath(`${SCAN}/../evil.yaml`, SCAN, throwingFs) === null);
  check("launch rejects a non-yaml/non-bundle extension → null", safeCustomAgentRealPath(`${SCAN}/evil.txt`, SCAN, throwingFs) === null);
  check("launch rejects a relative path → null", safeCustomAgentRealPath("vault-agent", SCAN, throwingFs) === null);
  check("launch rejects empty path → null", safeCustomAgentRealPath("", SCAN, throwingFs) === null);
}

// =====================================================================
// M13: YAML-Viewer "Open file" routing — open in the `yaml-viewer` community
// plugin when it's installed+enabled AND the config is an in-vault TFile;
// otherwise fall back to the existing OS-default-app (`shell.openPath`) path.
// These exercise the pure decision core (src/yamlViewer.ts); the only impure
// parts (setViewState / FileSystemAdapter) are thin wrappers in main.ts.
// =====================================================================
console.log("\n[M13] YAML-Viewer detection + in-vault TFile resolution + fallback gate");
{
  // --- (a) detection helper: true only when installed AND enabled -----------
  const enabledApi = {
    enabledPlugins: new Set([YAML_VIEWER_PLUGIN_ID]),
    plugins: { [YAML_VIEWER_PLUGIN_ID]: { id: YAML_VIEWER_PLUGIN_ID } },
  };
  check("(a) enabled+installed → true", detectYamlViewerEnabled(enabledApi) === true);
  check(
    "(a) installed (in registry) but NOT in enabledPlugins → false",
    detectYamlViewerEnabled({ enabledPlugins: new Set(), plugins: { [YAML_VIEWER_PLUGIN_ID]: {} } }) === false,
  );
  check(
    "(a) enabled flag set but no plugin instance (not loaded) → false",
    detectYamlViewerEnabled({ enabledPlugins: new Set([YAML_VIEWER_PLUGIN_ID]), plugins: {} }) === false,
  );
  check("(a) some other plugin enabled → false", detectYamlViewerEnabled({ enabledPlugins: new Set(["other"]), plugins: { other: {} } }) === false);
  check("(a) undefined/empty plugins API → false (no throw)", detectYamlViewerEnabled(undefined) === false && detectYamlViewerEnabled(null) === false && detectYamlViewerEnabled({}) === false);

  // --- (b) path → in-vault TFile resolver -----------------------------------
  // Node's real `path` fns are injected, exactly as main.ts injects them.
  const pathDeps = { relative, isAbsolute, sep };
  // An index of the only file Obsidian "knows about" (an in-vault, indexed file).
  const indexedVaultPath = "agents/vault-agent/config.yaml";
  const tfileSentinel = { __isTFile: true, path: indexedVaultPath };
  const index = { [indexedVaultPath]: tfileSentinel };
  const mkDeps = (idx) => ({
    ...pathDeps,
    getAbstractFileByPath: (vp) => idx[vp] ?? null,
    isTFile: (f) => Boolean(f && f.__isTFile),
  });

  const inVaultAbs = `${VAULT}/${indexedVaultPath}`;
  check(
    "(b) in-vault indexed file → returns the TFile",
    resolveVaultTFile(VAULT, inVaultAbs, mkDeps(index)) === tfileSentinel,
  );
  check(
    "(b) out-of-vault absolute path → null",
    resolveVaultTFile(VAULT, "/etc/passwd.yaml", mkDeps(index)) === null,
  );
  check(
    "(b) parent-traversal (sibling of vault) → null",
    resolveVaultTFile(VAULT, `${VAULT}/../other/config.yaml`, mkDeps(index)) === null,
  );
  // A dot-folder path IS lexically inside the vault, but Obsidian doesn't index
  // dot-folders, so the lookup returns nothing → null (→ shell.openPath fallback).
  check(
    "(b) in-vault dot-folder path with no TFile → null",
    resolveVaultTFile(VAULT, `${VAULT}/.omnigent/agent-configs/a/config.yaml`, mkDeps(index)) === null,
  );
  check(
    "(b) null base path (adapter isn't FileSystemAdapter) → null",
    resolveVaultTFile(null, inVaultAbs, mkDeps(index)) === null,
  );

  // --- (c) fallback gate: viewer-disabled OR no-TFile → don't open in viewer -
  // canOpenInYamlViewer() === false is exactly the branch openCustomAgent uses
  // to fall through to the unchanged shell.openPath behavior.
  check(
    "(c) enabled + yaml + in-vault TFile → open in viewer (true)",
    canOpenInYamlViewer({ viewerEnabled: true, fileToOpen: inVaultAbs, hasTFile: true }) === true,
  );
  check(
    "(c) viewer DISABLED → false → falls back to shell.openPath",
    canOpenInYamlViewer({ viewerEnabled: false, fileToOpen: inVaultAbs, hasTFile: true }) === false,
  );
  check(
    "(c) out-of-vault (no TFile) → false → falls back to shell.openPath",
    canOpenInYamlViewer({ viewerEnabled: true, fileToOpen: "/etc/passwd.yaml", hasTFile: false }) === false,
  );
  check(
    "(c) non-yaml extension → false → falls back to shell.openPath",
    canOpenInYamlViewer({ viewerEnabled: true, fileToOpen: `${VAULT}/agents/a/config.json`, hasTFile: true }) === false,
  );
  check("(c) isYamlFile matches .yaml/.yml (case-insensitive), rejects others", isYamlFile("a/config.yaml") && isYamlFile("b.yml") && isYamlFile("C.YAML") && !isYamlFile("c.json") && !isYamlFile("d.yamlx"));
  // End-to-end of the pure gate: disabled-viewer path is identical whether or
  // not a TFile exists — both fall back.
  check(
    "(c) disabled viewer ignores TFile presence (both fall back)",
    canOpenInYamlViewer({ viewerEnabled: false, fileToOpen: inVaultAbs, hasTFile: true }) === false &&
      canOpenInYamlViewer({ viewerEnabled: false, fileToOpen: inVaultAbs, hasTFile: false }) === false,
  );
}

// =====================================================================
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
