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
import { dirname, join } from "path";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  statSync,
  realpathSync,
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
  augmentPath,
} = await import(pathToFileURL(outfile).href);

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

  // With a server + a custom agent configured, those become their OWN elements,
  // but the hostile CONTEXT path STILL stays contained in the prompt only (the
  // custom config path is a separate, distinct inert element).
  const cfg = `${VAULT}/.omnigent/agent-configs/my-agent.yaml`;
  const argvWithFlags = buildOmnigentArgv({
    binaryPath: BIN,
    prompt: buildLaunchPrompt("transcribe-meeting", VAULT, true, hostile),
    serverUrl: "https://omni.example",
    agent: { mode: "custom", path: cfg },
  });
  check(
    "configured shape: [bin, run, --server, <url>, <config>, -p, prompt]",
    deepEq(argvWithFlags.slice(0, 5), [BIN, "run", "--server", "https://omni.example", cfg]) &&
      argvWithFlags[5] === "-p" &&
      argvWithFlags.length === 7,
  );
  check(
    "hostile context path still contained ONLY in the prompt element when flags set",
    argvWithFlags[6].includes(hostile) && !argvWithFlags.slice(0, 6).some((x) => x.includes(hostile)),
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
// (f) argv shape for each launch form (Default / builtin / custom), with
//     and without --server; the prompt stays a single inert `-p` element.
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

  // With --server set, the flag is its own two elements in every form; the
  // prompt stays the single final `-p` element.
  const url = "https://omni.example";
  const sd = buildOmnigentArgv({ binaryPath: BIN, prompt, serverUrl: url, agent: { mode: "default" } });
  const sp = buildOmnigentArgv({ binaryPath: BIN, prompt, serverUrl: url, agent: { mode: "builtin", name: "polly" } });
  const sc = buildOmnigentArgv({ binaryPath: BIN, prompt, serverUrl: url, agent: { mode: "custom", path: GOOD_YAML } });
  check("Default+server: [bin, run, --server, url, -p, prompt]", deepEq(sd, [BIN, "run", "--server", url, "-p", prompt]));
  check("polly+server: [bin, polly, --server, url, -p, prompt]", deepEq(sp, [BIN, "polly", "--server", url, "-p", prompt]));
  check("custom+server: [bin, run, --server, url, <config>, -p, prompt]", deepEq(sc, [BIN, "run", "--server", url, GOOD_YAML, "-p", prompt]));
  for (const [n, a] of [["Default", sd], ["polly", sp], ["custom", sc]]) {
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
  // legacy harness key (global + per-skill machinery) gets them stripped, while
  // everything else — including the new skillAgent map — is preserved.
  const persisted = {
    skillHarness: { "/abs/skill.md": "codex" },
    discoveredHarnesses: ["newharness"],
    customHarnesses: ["mything"],
    omnigentHarness: "claude",
    skillAgent: { "/abs/skill.md": { kind: "builtin", name: "polly" } },
    pinnedSkillIds: ["/abs/skill.md"],
    invocationTemplate: "/{name}",
  };
  const merged = Object.assign({}, persisted);
  for (const key of ["skillHarness", "discoveredHarnesses", "customHarnesses", "omnigentHarness"]) {
    delete merged[key];
  }
  check("skillHarness stripped", merged.skillHarness === undefined);
  check("discoveredHarnesses stripped", merged.discoveredHarnesses === undefined);
  check("customHarnesses stripped", merged.customHarnesses === undefined);
  check("omnigentHarness stripped", merged.omnigentHarness === undefined);
  check("skillAgent preserved", deepEq(merged.skillAgent, { "/abs/skill.md": { kind: "builtin", name: "polly" } }));
  check("unrelated settings preserved", deepEq(merged.pinnedSkillIds, ["/abs/skill.md"]) && merged.invocationTemplate === "/{name}");

  // A skill that previously had a harness selected reverts to the Default agent
  // (it has no skillAgent entry → resolveAgentLaunch yields mode default).
  const reverted = Object.assign({}, persisted);
  for (const key of ["skillHarness", "discoveredHarnesses", "customHarnesses", "omnigentHarness", "skillAgent"]) {
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
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
