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

import esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";
import { mkdirSync } from "fs";

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
  resolveHarnessArg,
  isValidHarnessToken,
  parseHarnessChoicesFromHelp,
  effectiveHarnessTokens,
  effectiveHarnessOptions,
  OMNIGENT_HARNESS_SENTINEL,
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

  // With server+harness configured, those become their OWN elements (known
  // flags), but the hostile path STILL stays contained in the prompt only.
  const argvWithFlags = buildOmnigentArgv({
    binaryPath: BIN,
    prompt: buildLaunchPrompt("transcribe-meeting", VAULT, true, hostile),
    serverUrl: "https://omni.example",
    harness: "claude",
  });
  check(
    "configured flags shape: [bin, run, --server, <url>, --harness, <h>, -p, prompt]",
    deepEq(argvWithFlags.slice(0, 6), [BIN, "run", "--server", "https://omni.example", "--harness", "claude"]) &&
      argvWithFlags[6] === "-p" &&
      argvWithFlags.length === 8,
  );
  check(
    "hostile path still contained ONLY in the prompt element when flags set",
    argvWithFlags[7].includes(hostile) && !argvWithFlags.slice(0, 7).some((x) => x.includes(hostile)),
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

// =====================================================================
// (e) M6 per-skill harness: resolveHarnessArg fail-closed against an
//     allowed token set.
// =====================================================================
console.log("\n[e] Per-skill harness resolution (fail-closed against allowed set)");
{
  eq("OMNIGENT_HARNESS_SENTINEL is `omnigent`", OMNIGENT_HARNESS_SENTINEL, "omnigent");
  const allowed = ["claude", "claude-sdk", "codex", "pi"];

  // token-in-set → token (regardless of the global value).
  eq("in-set token → token (blank global)", resolveHarnessArg("codex", "", allowed), "codex");
  eq("in-set token → token (global set)", resolveHarnessArg("codex", "openai-agents", allowed), "codex");
  eq("in-set token → token (multi-segment)", resolveHarnessArg("claude-sdk", "", allowed), "claude-sdk");

  // sentinel / absent / empty → the global value (today's behavior).
  eq('sentinel "omnigent" → global value (blank)', resolveHarnessArg("omnigent", "", allowed), "");
  eq('sentinel "omnigent" → global value (set)', resolveHarnessArg("omnigent", "codex", allowed), "codex");
  eq("absent (undefined) → global value (blank)", resolveHarnessArg(undefined, "", allowed), "");
  eq("absent (undefined) → global value (set)", resolveHarnessArg(undefined, "codex", allowed), "codex");
  eq("empty string → global value (set)", resolveHarnessArg("", "codex", allowed), "codex");

  // valid-charset token NOT in the allowed set → global (FAIL-CLOSED).
  eq("valid token not in set → global (fail-closed)", resolveHarnessArg("openai-agents", "codex", allowed), "codex");
  eq("valid token not in set, blank global → blank", resolveHarnessArg("open-responses", "", allowed), "");

  // invalid charset → global, even if (perversely) present in the allowed set.
  eq("invalid charset → global (fail-closed)", resolveHarnessArg("evil; rm", "codex", allowed), "codex");
  eq("invalid charset → blank global", resolveHarnessArg("a b", "", allowed), "");
  check(
    "invalid charset never returned even if in allowed set",
    resolveHarnessArg("$(x)", "", ["$(x)"]) === "" &&
      resolveHarnessArg("-x", "fallback", ["-x"]) === "fallback",
  );
  // Free-form attack strings never echo as the harness arg.
  check(
    "raw stored string is never echoed as the harness arg",
    resolveHarnessArg("--server http://evil", "", allowed) === "" &&
      resolveHarnessArg("pwned", "", allowed) === "",
  );
}

// =====================================================================
// (f) M6 argv shape: a discovered token → `--harness <token>` as its
//     own two elements; the prompt stays a single inert `-p` element; the
//     default sentinel → no --harness, argv unchanged.
// =====================================================================
console.log("\n[f] discovered token → --harness as own two argv elements; prompt stays one -p element");
{
  const prompt = buildLaunchPrompt("transcribe-meeting", VAULT, true);
  // Mirror the main.ts call site: resolve against the effective set, then build.
  const allowed = ["claude", "codex", "pi"];
  const harness = resolveHarnessArg("codex", "", allowed);
  const argv = buildOmnigentArgv({ binaryPath: BIN, prompt, harness });

  check(
    "argv shape: [bin, run, --harness, codex, -p, prompt]",
    deepEq(argv, [BIN, "run", "--harness", "codex", "-p", prompt]),
  );
  eq("argv length == 6", argv.length, 6);
  // `--harness` and its token are TWO distinct, adjacent elements.
  const hi = argv.indexOf("--harness");
  check("`--harness` is its own element", hi !== -1);
  eq("the token follows `--harness` as the next element", argv[hi + 1], "codex");
  // The prompt is a single inert element introduced by exactly one `-p`.
  const flagLike = argv.filter((x) => /^-/.test(x));
  check("only flag-like elements are `--harness` and `-p`", deepEq(flagLike, ["--harness", "-p"]));
  eq("the lone `-p` immediately precedes the prompt", argv[argv.length - 2], "-p");
  eq("prompt is the final single element", argv[argv.length - 1], prompt);
  check("the prompt is not split (no metachar leak into other elements)", !argv.slice(0, -1).some((x) => x === prompt && x !== argv[argv.length - 1]));

  // Fail-closed default (sentinel, blank global) → no --harness, argv unchanged.
  const argvDefault = buildOmnigentArgv({
    binaryPath: BIN,
    prompt,
    harness: resolveHarnessArg("omnigent", "", allowed),
  });
  check("default choice → no --harness token", argvDefault.indexOf("--harness") === -1);
  check(
    "default choice argv shape unchanged: [bin, run, -p, prompt]",
    deepEq(argvDefault, [BIN, "run", "-p", prompt]),
  );
}

// =====================================================================
// (h) M6 isValidHarnessToken charset gate.
// =====================================================================
console.log("\n[h] isValidHarnessToken strict charset");
{
  check("accept claude", isValidHarnessToken("claude"));
  check("accept claude-sdk", isValidHarnessToken("claude-sdk"));
  check("accept openai-agents", isValidHarnessToken("openai-agents"));
  check("accept open-responses", isValidHarnessToken("open-responses"));
  check("accept dotted/underscored token", isValidHarnessToken("a.b_c-1"));
  check('reject "" (empty)', !isValidHarnessToken(""));
  check('reject " x" (leading space)', !isValidHarnessToken(" x"));
  check('reject "-x" (leading dash)', !isValidHarnessToken("-x"));
  check('reject "a b" (space)', !isValidHarnessToken("a b"));
  check('reject "a;b" (metachar)', !isValidHarnessToken("a;b"));
  check('reject "$(x)" (command subst)', !isValidHarnessToken("$(x)"));
  check("reject \"a'b\" (quote)", !isValidHarnessToken("a'b"));
}

// =====================================================================
// (i) M6 parseHarnessChoicesFromHelp on the real `omnigent run --help` line.
// =====================================================================
console.log("\n[i] parseHarnessChoicesFromHelp on the real help excerpt");
{
  const SIX = ["claude", "claude-sdk", "codex", "openai-agents", "open-responses", "pi"];
  // The exact grounding line.
  const oneLine =
    "Harness to use: 'claude' (alias for 'claude-sdk'), 'claude-sdk', 'codex', 'openai-agents', 'open-responses', or 'pi'.";
  // ...as it actually appears after `--harness` in --help, wrapped across lines
  // and surrounded by other options.
  const HELP = [
    "Usage: omnigent run [OPTIONS]",
    "",
    "Options:",
    "  --server <URL>     Server to use.",
    "  --harness <NAME>   " + "Harness to use: 'claude' (alias for 'claude-sdk'),",
    "                     'claude-sdk', 'codex', 'openai-agents',",
    "                     'open-responses', or 'pi'.",
    "  -p, --prompt <P>   The prompt to run.",
  ].join("\n");

  check(
    "single-line excerpt → exactly the 6 tokens (alias deduped, not double-counted)",
    deepEq(parseHarnessChoicesFromHelp("--harness <NAME>  " + oneLine), SIX),
  );
  check(
    "wrapped multi-line --help region → exactly the same 6 tokens",
    deepEq(parseHarnessChoicesFromHelp(HELP), SIX),
  );
  // The REAL `omnigent run --help` (Click) hyphen-wraps `'open-responses'`
  // across two lines; the parser must rejoin it, not drop the token.
  const REAL = [
    "  --tools TEXT          Client-side tool set name.",
    "  --harness TEXT        Harness to use: 'claude' (alias for 'claude-sdk'),",
    "                        'claude-sdk', 'codex', 'openai-agents', 'open-",
    "                        responses', or 'pi'. Without AGENT, launches that",
    "                        harness directly.",
    "  --model TEXT          Model to use for the agent.",
  ].join("\n");
  check(
    "real hyphen-wrapped --help → exactly the 6 tokens (open-responses rejoined)",
    deepEq(parseHarnessChoicesFromHelp(REAL), SIX),
  );
  check("the `--server` line's text does not leak into harness tokens", !parseHarnessChoicesFromHelp(HELP).includes("URL"));
  eq("no `--harness` present → empty", parseHarnessChoicesFromHelp("Usage: omnigent run\n  --server <URL>").length, 0);
  eq("empty input → empty", parseHarnessChoicesFromHelp("").length, 0);
}

// =====================================================================
// (j) M7 effective harness list: dedupe + order (builtins, discovered ONLY —
//     no custom term) and the sentinel-led option list.
// =====================================================================
console.log("\n[j] effectiveHarnessTokens / effectiveHarnessOptions dedupe + order");
{
  const builtins = ["claude", "claude-sdk", "codex", "openai-agents", "open-responses", "pi"];
  const discovered = ["claude", "codex", "newharness"]; // overlaps + one new

  const tokens = effectiveHarnessTokens(builtins, discovered);

  check(
    "tokens = builtins, then new discovered (deduped, in order)",
    deepEq(tokens, [
      "claude",
      "claude-sdk",
      "codex",
      "openai-agents",
      "open-responses",
      "pi",
      "newharness",
    ]),
  );
  check("no duplicate tokens", new Set(tokens).size === tokens.length);
  check("the `omnigent` sentinel is NOT a token", !tokens.includes("omnigent"));

  const opts = effectiveHarnessOptions(builtins, discovered);
  eq("options are sentinel-led", opts[0], OMNIGENT_HARNESS_SENTINEL);
  check("options = sentinel + tokens", deepEq(opts, [OMNIGENT_HARNESS_SENTINEL, ...tokens]));

  // Empty discovered → just the builtins (dropdown never empty).
  check(
    "empty discovered → builtins only",
    deepEq(effectiveHarnessTokens(builtins, []), builtins),
  );
}

// =====================================================================
// (k) M7 migration: a leftover `customHarnesses` in loaded settings is
//     ignored — it is stripped on load and can NEVER widen the allowed set.
// =====================================================================
console.log("\n[k] leftover customHarnesses is ignored (no longer widens the allowed set)");
{
  const builtins = ["claude", "claude-sdk", "codex", "openai-agents", "open-responses", "pi"];

  // Mirror main.ts loadSettings: merge a stale data.json (still carrying a
  // `customHarnesses` array AND a per-skill token that was a custom value),
  // then strip the dead key.
  const DEFAULTS = { discoveredHarnesses: [], skillHarness: {} };
  const persisted = {
    discoveredHarnesses: ["newharness"],
    skillHarness: { "/abs/skill.md": "mything" }, // a formerly-custom token
    customHarnesses: ["mything"], // legacy key from an older install
  };
  const merged = Object.assign({}, DEFAULTS, persisted);
  delete merged.customHarnesses;

  check("customHarnesses is stripped on load", merged.customHarnesses === undefined);

  // The effective set is now built only from builtins ∪ discovered — the
  // formerly-custom token cannot reach it.
  const tokens = effectiveHarnessTokens(builtins, merged.discoveredHarnesses);
  check("discovered token still present", tokens.includes("newharness"));
  check("formerly-custom 'mything' NOT in the effective set", !tokens.includes("mything"));

  // And a per-skill token that was custom now fails closed to the global
  // default at launch (resolveHarnessArg, allowed = the custom-free set).
  eq(
    "formerly-custom per-skill token → global fallback (blank)",
    resolveHarnessArg(merged.skillHarness["/abs/skill.md"], "", tokens),
    "",
  );
  eq(
    "formerly-custom per-skill token → global fallback (set)",
    resolveHarnessArg(merged.skillHarness["/abs/skill.md"], "codex", tokens),
    "codex",
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
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
