// Launch-construction helpers (no Obsidian imports) — the argv builder, binary
// allowlist/resolution, and PATH augmentation are all unit-testable. The actual
// spawn (impure) lives in main.ts and consumes these. The custom-agent path
// gate additionally needs `fs` for its symlink-aware (realpath) containment
// check; those fs calls are injectable so the resolver stays unit-testable, and
// default to the real `fs` so existing call sites need no change.

import * as fs from "fs";
import * as nodePath from "path";

/** The only binary this milestone (M1) is allowed to spawn. */
export const OMNIGENT_BIN_NAME = "omnigent";

/**
 * Build the launch prompt as NATURAL LANGUAGE, not a `/slash` form. `omnigent
 * run -p` routes a leading-slash first token to its REPL slash-command
 * dispatcher (which has no skill commands → "Unknown command"); a plain
 * sentence goes through normal model input and lets the host skill be selected
 * natively from the vault cwd. Form: `Use the <name> skill.` optionally
 * followed by a `Context file: <path>.` clause (the M3 right-click path) and/or
 * a generic vault-anchor instruction naming the real vault path.
 *
 * `contextPath` is the M3 addition: when present (the file-explorer right-click
 * path) the clicked file/folder's ABSOLUTE path is embedded as a pure TEXT
 * fragment inside this single returned string — it is NEVER its own argv
 * element and is never parsed as a flag. Because a context launch operates on a
 * specific path, the vault anchor is ALWAYS included on that path (regardless
 * of `appendAnchor`) so writes stay scoped to the vault. When `contextPath` is
 * absent the M1 behavior is byte-for-byte preserved (no Context line; anchor
 * only when `appendAnchor`).
 *
 * Returned as ONE inert string for a single `-p` argv element. Never starts
 * with `/`. Skill-agnostic (substitutes any `skillName`).
 */
export function buildLaunchPrompt(
  skillName: string,
  vaultPath: string,
  appendAnchor: boolean,
  contextPath?: string,
  userPrompt?: string,
  kind: "skill" | "command" = "skill",
): string {
  // A command (M18) is a `/name` slash command; a skill is invoked by name. The
  // command form starts with "Run" (NOT a leading slash) so omnigent's REPL
  // slash-dispatcher isn't triggered, while still naming the `/command` for
  // Claude-family harnesses to execute.
  const base =
    kind === "command"
      ? `Run the /${skillName} command.`
      : `Use the ${skillName} skill.`;
  // M16: optional free-text the user typed in the Launch modal, appended right
  // after the skill directive so the session reads `Use the <name> skill.
  // <their instructions>` — giving skills that need more context something to
  // act on. It reaches argv only as part of the single inert `-p` element (or,
  // for a custom harness, control-char-stripped into one token), so free text —
  // spaces, quotes, dashes — is safe and never tokenized. Empty/whitespace →
  // omitted, preserving the exact prior prompt.
  const extra = typeof userPrompt === "string" ? userPrompt.trim() : "";
  const withUser = extra ? `${base} ${extra}` : base;
  const hasContext = typeof contextPath === "string" && contextPath.length > 0;
  // The path is concatenated as inert prose — never split out as a separate
  // token — so any spaces/quotes/dashes/metacharacters in it stay contained.
  const head = hasContext ? `${withUser} Context file: ${contextPath}.` : withUser;
  // No context + anchor off + no user text → exactly the M1 prompt.
  if (!appendAnchor && !hasContext) return head;
  return (
    `${head} Operate in this vault: ${vaultPath}.` +
    " Write any files into this vault directory only." +
    " Do not create a git worktree or delegate the final file write."
  );
}

/**
 * Build the omnigent one-shot argv array (UI-visible run; exits on its own).
 * The per-skill AGENT selection (already resolved fail-closed by
 * `resolveAgentLaunch`) determines the subcommand and any positional; the
 * per-skill HARNESS selection (M15, resolved fail-closed by `resolveHarness`)
 * OPTIONALLY appends `--harness <h>`:
 *   - default          → [bin, 'run', '-p', prompt]
 *   - builtin          → [bin, <name>, '-p', prompt]  (subcommand, NOT 'run')
 *   - custom           → [bin, 'run', <abs agent path>, '-p', prompt]
 *   - + harness (any)  → …, '--harness', <h>, '-p', prompt
 * For a custom agent the path (a loose `.yaml`/`.yml` FILE or a BUNDLE directory)
 * is emitted as a SINGLE inert argv element after `run` — never split, never its
 * own flag (the resolver guarantees it is an absolute path, so it can never be
 * read as an option). No '--no-session'
 * (that path is ephemeral / not UI-visible). The prompt is a single inert
 * element.
 *
 * `harness` (M15) is emitted as `--harness <value>` ONLY when it is a member of
 * the hardcoded `OMNIGENT_HARNESSES` allowlist (re-checked here as
 * belt-and-suspenders; callers pass a value already resolved by
 * `resolveHarness`). It routes through the SAME omnigent binary — `omnigent run`
 * accepts `--harness`, and bundled subcommands (polly/debby) forward all run
 * options — so it is correct for every agent form. Never free text, never a
 * positional.
 *
 * No `--server` is EVER emitted (M11): omnigent's own config.yaml decides server
 * routing, so `omnigent run <agent>` with no `--server` routes via the user's
 * omnigent config. This removed the overlap with omnigent's own configuration.
 */
export function buildOmnigentArgv(opts: {
  binaryPath: string;
  prompt: string;
  agent?: ResolvedAgent;
  harness?: string | null;
  server?: string | null;
}): string[] {
  const agent: ResolvedAgent = opts.agent ?? { mode: "default" };
  const subcommand = agent.mode === "builtin" ? agent.name : "run";
  const argv = [opts.binaryPath, subcommand];
  // The custom agent path is a single inert positional after `run` — a loose
  // `.yaml`/`.yml` file or a bundle directory. The resolver has already proven
  // it absolute + a real direct child of the scan dir, so it can never split or
  // become a flag.
  if (agent.mode === "custom") argv.push(agent.path);
  // Optional omnigent `--server` target (M19). A single inert argv element
  // (shell:false); validated to a whitespace-free token so it can never split.
  if (isValidOmnigentServer(opts.server)) argv.push("--server", opts.server.trim());
  // Optional omnigent harness pin (M15). Only a hardcoded-allowlist member is
  // ever emitted, so the value can never be free text or a flag-able positional.
  if (isAllowedHarness(opts.harness)) argv.push("--harness", opts.harness);
  argv.push("-p", opts.prompt);
  return argv;
}

/**
 * Whether a user-configured omnigent `--server` value is safe to emit: a
 * non-empty, whitespace-free single token (e.g. `local` or a host URL). Empty /
 * blank = omit `--server` (omnigent uses its own default). A value containing
 * ANY whitespace is rejected (would otherwise become multiple argv elements or a
 * confusing single one), failing closed to "no --server". Pure / unit-testable.
 */
export function isValidOmnigentServer(
  server: string | null | undefined,
): server is string {
  return typeof server === "string" && server.trim().length > 0 && !/\s/.test(server.trim());
}

/**
 * The FIXED skill invocation string for the "Copy invocation" row action
 * (manual REPL/clipboard paste). Natural-language form `Use the <name> skill.`,
 * consistent with how launch prompts are built (`buildLaunchPrompt`'s base).
 * There is no user-configurable template (M11). Embeds NO path, so no shell
 * quoting is required. Pure / unit-testable.
 */
export function buildSkillInvocation(
  skillName: string,
  kind: "skill" | "command" = "skill",
): string {
  return kind === "command"
    ? `Run the /${skillName} command.`
    : `Use the ${skillName} skill.`;
}

/**
 * The agent-aware copyable CLI for the Skills-tab "Copy invocation" action. Where
 * `buildSkillInvocation` is the bare REPL prompt (agent-agnostic), this reflects
 * the per-skill AGENT selection so the copied command runs the skill under the
 * chosen agent — mirroring `buildOmnigentArgv`'s subcommand/positional shape, but
 * as a single shell-pasteable string using the `omnigent` bin NAME (not an
 * absolute binary path, matching `buildAgentInvocation`):
 *   - default → omnigent run -p '<prompt>'
 *   - builtin → omnigent <name> -p '<prompt>'        (subcommand, NOT 'run')
 *   - custom  → omnigent run '<abs path>' -p '<prompt>'
 *   - + harness (any) → … --harness <h> -p '<prompt>'
 * `agent` MUST already be resolved fail-closed by `resolveAgentLaunch`, so a
 * custom path is the validated absolute real path. The custom path and the prompt
 * are each POSIX single-quote wrapped so spaces / shell metacharacters paste as
 * one safe argument. `harness` (M15) is appended as `--harness <h>` only when it
 * is a hardcoded-allowlist member (so it can carry no metacharacters and needs
 * no quoting). Clipboard text only — pure / unit-testable.
 */
export function buildSkillCliInvocation(opts: {
  skillName: string;
  agent?: ResolvedAgent;
  harness?: string | null;
  server?: string | null;
  kind?: "skill" | "command";
}): string {
  const agent: ResolvedAgent = opts.agent ?? { mode: "default" };
  const prompt = buildSkillInvocation(opts.skillName, opts.kind ?? "skill");
  const subcommand = agent.mode === "builtin" ? agent.name : "run";
  let cli = `${OMNIGENT_BIN_NAME} ${subcommand}`;
  if (agent.mode === "custom") cli += ` ${shellSingleQuote(agent.path)}`;
  if (isValidOmnigentServer(opts.server)) cli += ` --server ${shellSingleQuote(opts.server.trim())}`;
  if (isAllowedHarness(opts.harness)) cli += ` --harness ${opts.harness}`;
  cli += ` -p ${shellSingleQuote(prompt)}`;
  return cli;
}

/**
 * POSIX single-quote shell escaping: wrap `s` in single quotes and escape any
 * embedded single quote as `'\''`. This makes a path containing spaces or shell
 * metacharacters safe to paste into a shell as one argument. Used only for the
 * COPYABLE invocation strings (clipboard text); never for argv (argv is passed
 * to spawn with shell:false and needs no quoting). Pure / unit-testable.
 */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Default opening prompt for a custom-agent SESSION launched from the Agents tab
 * (M10). That spawn is non-interactive (stdio ignored), so a sensible `-p`
 * prompt is passed so the session actually opens and is visible in the omnigent
 * UI. Reaches argv as the single inert `-p` element.
 */
export const AGENT_SESSION_PROMPT =
  "Hi — what can you help with in this vault?";

/**
 * Placeholder prompt embedded in the copyable Agents-tab invocation string
 * (M10). This is clipboard text only — it never reaches argv.
 */
export const AGENT_INVOCATION_PLACEHOLDER = "<your prompt here>";

/**
 * The exact CLI to start a session with a custom agent, for the Agents-tab
 * "Copy invocation" action (M10): `omnigent run '<agentPath>' -p "<placeholder>"`.
 * `agentPath` MUST be the validated absolute real path (a loose `.yaml`/`.yml`
 * file or a bundle directory) produced by `safeCustomAgentRealPath`. The path is
 * SHELL-QUOTED (POSIX single-quote wrap, M11) so a path containing spaces or
 * shell metacharacters pastes safely into a shell as one argument. Clipboard
 * text only — pure / unit-testable.
 */
export function buildAgentInvocation(agentPath: string): string {
  return `${OMNIGENT_BIN_NAME} run ${shellSingleQuote(agentPath)} -p "${AGENT_INVOCATION_PLACEHOLDER}"`;
}

// =====================================================================
// Per-skill AGENT selector (replaces the M1–M7 harness selector).
//
// A skill is tied to a specific omnigent AGENT; omnigent itself picks the
// harness. The stored, per-skill choice is a discriminated value:
//   { kind: 'default' }                       → `omnigent run -p "<prompt>"`
//   { kind: 'builtin', name: 'polly'|'debby'} → `omnigent <name> -p "<prompt>"`
//   { kind: 'custom',  path: '<abs yaml>' }   → `omnigent run <abs yaml> -p "<prompt>"`
// At LAUNCH the stored value is re-validated fail-closed by `resolveAgentLaunch`
// before anything reaches argv. Plugin-local state only — NEVER written into any
// SKILL.md, and the display label/description of a custom agent NEVER reaches
// argv (only its validated absolute path does, as one inert element).
// =====================================================================

/**
 * The hardcoded built-in agent allowlist. These launch via an omnigent
 * SUBCOMMAND (`omnigent polly …`, NOT `omnigent run …`). This is the ONLY set a
 * stored `{kind:'builtin'}` name is permitted against at launch; anything else
 * fails closed to the Default agent.
 */
export const BUILTIN_AGENTS = ["polly", "debby"] as const;
export type BuiltinAgentName = (typeof BUILTIN_AGENTS)[number];

// =====================================================================
// Per-skill HARNESS selector (M15) — ORTHOGONAL to the AGENT selector.
//
// A skill always runs through the `omnigent` binary; the AGENT choice picks the
// subcommand / positional (`run` | `polly`/`debby` | a custom agent YAML), and
// INDEPENDENTLY a skill may pin a specific omnigent harness via `--harness <h>`.
// Verified 2026-07-06 against the real CLI: `omnigent run --help` lists the
// fixed `--harness` set below (and shows `omnigent run <agent.yaml> --harness
// <h>` as a combine example), and `omnigent polly --help` states "All run
// options are accepted and forwarded" — so a bundled agent subcommand forwards
// `--harness`/`-p` too. Because the harness routes through the SAME omnigent
// binary, this introduces NO new spawn surface and NO new binary allowlist: the
// value is re-validated fail-closed against the hardcoded allowlist below and
// only ever emitted as `--harness <member>` (never free text, never a flag-able
// positional). Plugin-local state; never written into any SKILL.md.
// =====================================================================

/**
 * The hardcoded omnigent `--harness` allowlist (from `omnigent run --help`).
 * `claude` is omnigent's documented alias for `claude-sdk`; both are listed so a
 * stored value of either resolves. This is the ONLY set a stored per-skill
 * harness is permitted against at launch; anything else fails closed to "no
 * --harness" (omnigent then uses its own configured default harness).
 */
export const OMNIGENT_HARNESSES = [
  "claude",
  "claude-sdk",
  "codex",
  "cursor",
  "kimi",
  "openai-agents",
  "open-responses",
  "pi",
  "antigravity",
  "qwen",
  "goose",
  "copilot",
] as const;
export type OmnigentHarness = (typeof OMNIGENT_HARNESSES)[number];

/** The <select> option value meaning "no explicit harness" (omnigent's default). */
export const HARNESS_DEFAULT_VALUE = "default";

/** Membership test for the hardcoded harness allowlist. */
export function isAllowedHarness(name: unknown): name is OmnigentHarness {
  return (
    typeof name === "string" &&
    (OMNIGENT_HARNESSES as readonly string[]).includes(name)
  );
}

/**
 * Resolve a per-skill stored harness choice to the validated launch value,
 * FAILING CLOSED to null ("no --harness"; omnigent uses its own default). Only a
 * member of the hardcoded allowlist survives; anything else — absent, unknown
 * string, the `"default"` sentinel, or a stale legacy object shape from the
 * removed M4–M7 harness selector — resolves to null. Pure / unit-testable.
 */
export function resolveHarness(stored: unknown): OmnigentHarness | null {
  return isAllowedHarness(stored) ? stored : null;
}

/** Encode a stored harness choice to its <select> option value. */
export function encodeHarnessChoice(harness: unknown): string {
  return isAllowedHarness(harness) ? harness : HARNESS_DEFAULT_VALUE;
}

/** Decode a <select> option value to a harness name, or null for Default. */
export function decodeHarnessChoice(value: string): OmnigentHarness | null {
  return isAllowedHarness(value) ? value : null;
}

// =====================================================================
// CUSTOM (user-defined) harnesses (M15.3) — the escape hatch for a command the
// built-in omnigent `--harness` set does not cover (e.g. a different CLI or a
// preset omnigent invocation). A custom harness spawns an ARBITRARY external
// binary instead of omnigent, so it is the plugin's only non-omnigent spawn
// surface. SECURITY, in depth:
//   • `command[0]` (the binary) MUST be an ABSOLUTE path — validated at add-time
//     AND again fail-closed at launch — so it can never be a bare name resolved
//     through PATH (no hijack) nor read as a flag.
//   • args are stored as an ARRAY (the UI takes one arg per line), so there is
//     NEVER any shell-word tokenization (the defect class that cost 3 review
//     rounds). Spawned with shell:false.
//   • only the `{prompt}` placeholder is interpolated, control-char-stripped, and
//     substituted WITHIN a token (never as its own split element).
//   • a custom harness only ever runs when the user explicitly created it AND
//     selected it for a skill; anything invalid fails closed (no spawn).
// Plugin-local state; never written into any SKILL.md.
// =====================================================================

/** Placeholder token replaced with the launch prompt in a custom harness command. */
export const HARNESS_PROMPT_PLACEHOLDER = "{prompt}";

/**
 * OPTIONAL placeholder (M17) replaced with the selected Claude subagent name in a
 * custom-harness command, e.g. `claude --agent {agent} -p {prompt}`. When the
 * skill has NO agent selected, the token — and, if it stood alone, the flag
 * immediately before it (e.g. `--agent`) — is dropped so no dangling flag
 * swallows the next argument. Substituted WITHIN a token, never split. Unlike
 * `{prompt}` it is optional: a command need not contain it.
 */
export const HARNESS_AGENT_PLACEHOLDER = "{agent}";

/** The per-skill <select> value prefix identifying a custom-harness choice. */
export const CUSTOM_HARNESS_VALUE_PREFIX = "custom:";

/**
 * A user-defined harness. `command` is an argv template: `command[0]` is the
 * absolute binary, the rest are inert args, and at least one token contains
 * `{prompt}`. See the block comment above for the security contract.
 */
export interface CustomHarness {
  id: string;
  label: string;
  command: string[];
  /**
   * Optional argv to RECONNECT to a session this harness started (M20 Sessions
   * tab). `command[0]` is the absolute binary; the rest are inert args; NO
   * `{prompt}` (resume continues an existing session). When set, it is what the
   * Sessions-tab "Connect" runs for this harness — overriding the built-in
   * defaults (claude/codex/isaac) and the generic best-effort guess. Absent =
   * best-effort (`<binary> --continue`) with a terminal hint to configure this.
   */
  resumeCommand?: string[];
}

/** Strip ASCII control chars (incl. NUL / CR / LF) from an interpolated value. */
export function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip C0/C1 control chars (incl. NUL/CR/LF) so an interpolated value can't inject newlines/terminators into a spawned command
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Validate a custom-harness command array (no filesystem). Passes ONLY if it is
 * a non-empty array of non-empty strings whose FIRST element is an ABSOLUTE path
 * and where at least one element contains the `{prompt}` placeholder. Pure /
 * unit-testable. (Filesystem existence of the binary is checked separately,
 * fail-closed, at launch.)
 */
export function isValidCustomHarnessCommand(command: unknown): command is string[] {
  if (!Array.isArray(command) || command.length === 0) return false;
  const arr = command as unknown[];
  if (!arr.every((t) => typeof t === "string" && t.length > 0)) return false;
  const strs = arr as string[];
  return (
    nodePath.isAbsolute(strs[0]) &&
    strs.some((t) => t.includes(HARNESS_PROMPT_PLACEHOLDER))
  );
}

/**
 * Build the argv for a custom harness: substitute the (control-char-stripped)
 * prompt into EVERY `{prompt}` occurrence, within each token (never split), and
 * return the argv array. Returns null (FAIL CLOSED) if the command is invalid.
 * The binary (argv[0]) passes through verbatim (already validated absolute).
 * Pure / unit-testable.
 */
export function buildCustomHarnessArgv(opts: {
  command: string[];
  prompt: string;
  agent?: string;
}): string[] | null {
  if (!isValidCustomHarnessCommand(opts.command)) return null;
  const safePrompt = stripControlChars(opts.prompt);
  const agent =
    typeof opts.agent === "string" ? stripControlChars(opts.agent).trim() : "";

  // First resolve the OPTIONAL {agent} token(s). With an agent selected,
  // substitute it within the token (like {prompt}); with none, drop the token
  // AND — if the token was the standalone value of a preceding flag (e.g.
  // `--agent {agent}`) — drop that flag too, so nothing dangles. A token that
  // merely CONTAINS the placeholder (e.g. `--agent={agent}`) is dropped whole.
  const resolved: string[] = [];
  for (const tok of opts.command) {
    if (!tok.includes(HARNESS_AGENT_PLACEHOLDER)) {
      resolved.push(tok);
      continue;
    }
    if (agent) {
      resolved.push(tok.split(HARNESS_AGENT_PLACEHOLDER).join(agent));
    } else if (tok === HARNESS_AGENT_PLACEHOLDER) {
      const prev = resolved[resolved.length - 1];
      if (prev !== undefined && prev.startsWith("-")) resolved.pop();
    }
    // else (token contains but ≠ placeholder, no agent): drop the whole token.
  }

  // Then substitute {prompt} within each surviving token (unchanged behavior).
  return resolved.map((t) => t.split(HARNESS_PROMPT_PLACEHOLDER).join(safePrompt));
}

/** The per-skill stored value for a custom-harness selection. */
export function encodeCustomHarnessChoice(id: string): string {
  return `${CUSTOM_HARNESS_VALUE_PREFIX}${id}`;
}

/**
 * Split a single-line custom-harness command into an argv array. This is a PLAIN
 * whitespace split — NOT a shell-words tokenizer: there is no quote handling, no
 * backslash escapes, no metacharacter interpretation (that whole defect class is
 * avoided by design; see `[[skillsplugin_learnings]]`). Consequently a token
 * cannot itself contain a space — except the `{prompt}` placeholder, which is
 * substituted (as ONE element) with the full prompt at launch. `command[0]` is
 * the binary. Empty tokens are dropped. Pure / unit-testable.
 */
export function parseHarnessCommandLine(line: string): string[] {
  if (typeof line !== "string") return [];
  return line.trim().split(/\s+/).filter((t) => t.length > 0);
}

/** A harness omnigent has configured (parsed from `omnigent config list`). */
export interface ConfiguredHarness {
  /** Display name exactly as omnigent groups it, e.g. "Claude", "Codex". */
  name: string;
  /** True when at least one credential is configured (not "(none configured)"). */
  configured: boolean;
}

/**
 * Parse the "Credentials (by harness)" section of `omnigent config list` output
 * into the harnesses omnigent knows, each flagged configured / not. omnigent has
 * no machine-readable form, so we parse the indented text: the section header is
 * at column 0; each harness is a 2-space-indented group header; its credential
 * lines are indented deeper. A group is `configured:false` only when its sole
 * child is the literal "(none configured)". A dedent (column-0 line) ends the
 * section. Pure / unit-testable; returns [] on anything unexpected.
 */
export function parseConfiguredHarnesses(stdout: string): ConfiguredHarness[] {
  if (typeof stdout !== "string") return [];
  const out: ConfiguredHarness[] = [];
  let inSection = false;
  let current: ConfiguredHarness | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (/^Credentials \(by harness\)/.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (line.trim() === "") continue; // tolerate blank lines within the section
    if (/^\S/.test(line)) break; // a column-0 line ends the section
    if (/^ {3,}\S/.test(line)) {
      // A credential/detail line for the current group.
      if (current && line.trim() !== "(none configured)") current.configured = true;
      continue;
    }
    const header = /^ {2}(\S.*?)\s*$/.exec(line); // exactly-2-space-indented group
    if (header) {
      current = { name: header[1].trim(), configured: false };
      out.push(current);
    }
  }
  return out;
}

/** A parsed per-skill harness selection (still unvalidated against existence). */
export type HarnessChoice =
  | { kind: "none" }
  | { kind: "omnigent"; name: OmnigentHarness }
  | { kind: "custom"; id: string };

/**
 * Parse a stored/selected per-skill harness value into a choice: a hardcoded
 * omnigent-harness name, a `custom:<id>` reference, or none (Default / anything
 * unrecognized). Pure / unit-testable.
 */
export function parseHarnessValue(value: unknown): HarnessChoice {
  if (isAllowedHarness(value)) return { kind: "omnigent", name: value };
  if (
    typeof value === "string" &&
    value.startsWith(CUSTOM_HARNESS_VALUE_PREFIX)
  ) {
    const id = value.slice(CUSTOM_HARNESS_VALUE_PREFIX.length);
    if (id.length > 0) return { kind: "custom", id };
  }
  return { kind: "none" };
}

/** The launch-resolved per-skill harness, with the custom command attached. */
export type ResolvedSkillHarness =
  | { kind: "none" }
  | { kind: "omnigent"; name: OmnigentHarness }
  | { kind: "custom"; harness: CustomHarness };

/**
 * Resolve a stored per-skill harness value, FAILING CLOSED. An omnigent harness
 * name resolves to `{omnigent}`; a `custom:<id>` resolves to `{custom}` ONLY if
 * that id is in `customHarnesses` AND its command still passes
 * `isValidCustomHarnessCommand`; everything else → `{none}`. Pure /
 * unit-testable (existence of the binary is checked at spawn time).
 */
export function resolveSkillHarness(
  stored: unknown,
  customHarnesses: CustomHarness[] | undefined | null,
): ResolvedSkillHarness {
  const choice = parseHarnessValue(stored);
  if (choice.kind === "omnigent") return { kind: "omnigent", name: choice.name };
  if (choice.kind === "custom") {
    const h = (customHarnesses ?? []).find((c) => c && c.id === choice.id);
    if (h && isValidCustomHarnessCommand(h.command)) {
      return { kind: "custom", harness: h };
    }
  }
  return { kind: "none" };
}

/**
 * The copyable CLI string for a custom harness (clipboard only). Each token is
 * POSIX single-quote wrapped so it pastes as one safe shell argument; the
 * `{prompt}` placeholder is replaced with the (control-char-stripped, quoted)
 * prompt. Pure / unit-testable.
 */
export function buildCustomHarnessCliInvocation(opts: {
  command: string[];
  prompt: string;
  agent?: string;
}): string {
  const argv = buildCustomHarnessArgv(opts);
  if (!argv) return "";
  return argv.map((t) => shellSingleQuote(t)).join(" ");
}

/** The vault-relative directory custom agent YAML configs are scanned from. */
export const AGENT_CONFIG_SUBDIR = ".omnigent/agent-configs";

// =====================================================================
// Claude subagents (M17) — `.claude/agents/*.md` files (Claude Code's own agent
// format: frontmatter name/description/tools/model + a system-prompt body).
// These are ORTHOGONAL to omnigent YAML agents: they apply only when the harness
// is a claude-based CUSTOM harness, and are passed via the `{agent}` placeholder
// (see HARNESS_AGENT_PLACEHOLDER). Discovery is a plain filesystem scan; only the
// agent NAME ever reaches argv (control-char-stripped, as one inert token).
// =====================================================================

/** The vault-relative directory Claude subagents are scanned from. */
export const CLAUDE_AGENTS_SUBDIR = ".claude/agents";

/** A discovered Claude subagent (display metadata; only `name` reaches argv). */
export interface ClaudeAgent {
  /** The subagent name (frontmatter `name:`, else the filename stem). Passed to
   *  `--agent` via the `{agent}` token — the ONLY field that reaches argv. */
  name: string;
  /** Absolute path to the `.md` file (display / open only; never argv). */
  path: string;
  /** Optional frontmatter `description:` (tooltip; never argv). */
  description?: string;
  /** "project" (vault `.claude/agents`) or "global" (`~/.claude/agents`). */
  source: "project" | "global";
}

/**
 * Read a Claude subagent's frontmatter `name:` and `description:` (top-level
 * scalars inside the leading `---` fence). Minimal + dependency-free; mirrors
 * `parseAgentConfigYaml` but scoped to a fenced frontmatter block. Pure /
 * unit-testable. Returns nulls when absent.
 */
export function parseClaudeAgentFrontmatter(text: string): {
  name: string | null;
  description: string | null;
} {
  const out: { name: string | null; description: string | null } = {
    name: null,
    description: null,
  };
  if (typeof text !== "string") return out;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break; // end of frontmatter
    if (/^[ \t]/.test(line)) continue; // nested — top-level keys only
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (key !== "name" && key !== "description") continue;
    if (out[key] !== null) continue; // first occurrence wins
    let val = m[2].trim();
    if (
      val.length >= 2 &&
      ((val[0] === '"' && val[val.length - 1] === '"') ||
        (val[0] === "'" && val[val.length - 1] === "'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val.length ? val : null;
  }
  return out;
}

/**
 * The per-skill stored choice (a discriminated union). Persisted verbatim in
 * data.json under `skillAgent[skillId]`. Absent key = Default.
 */
export type SkillAgent =
  | { kind: "default" }
  | { kind: "builtin"; name: string }
  | { kind: "custom"; path: string };

/**
 * The resolved, validated launch form consumed by `buildOmnigentArgv`. Only
 * ever produced by `resolveAgentLaunch`, which fails closed.
 */
export type ResolvedAgent =
  | { mode: "default" }
  | { mode: "builtin"; name: BuiltinAgentName }
  | { mode: "custom"; path: string };

/** A discovered custom agent (display metadata + the only argv-bound field, path). */
export interface CustomAgent {
  /**
   * Absolute launch path — the ONLY field that can reach argv. Either a loose
   * YAML config FILE or a BUNDLE directory (`omnigent run <dir>`); never the
   * `config.yaml` inside a bundle.
   */
  path: string;
  /** Display label (top-level `name:`, else the filename stem). Never argv. */
  name: string;
  /** Optional tooltip (top-level `description:`). Never argv. */
  description?: string;
}

/** Membership test for the hardcoded built-in agent allowlist. */
export function isAllowedBuiltinAgent(name: unknown): name is BuiltinAgentName {
  return (
    typeof name === "string" &&
    (BUILTIN_AGENTS as readonly string[]).includes(name)
  );
}

/**
 * The LEXICAL half of the custom-agent path gate (no filesystem). A path passes
 * only if: it is a non-empty string; the RAW string contains NO `..` path
 * segment (rejected up front, before any resolve — so traversal *syntax* that
 * would lexically collapse back into the dir, e.g. `<scanDir>/sub/../evil.yaml`
 * or `<scanDir>/../agent-configs/evil.yaml`, is refused outright); it is an
 * ABSOLUTE path (so it can never be read as a flag — leading-dash safe by
 * construction); it carries either a `.yaml`/`.yml` extension (a loose file) OR
 * NO file extension at all (a candidate BUNDLE directory `<name>/config.yaml`,
 * whose directory path has no extension) — any OTHER extension (e.g. `.txt`) is
 * rejected here; and it is a direct child of `scanDir`. Whether the path is in
 * fact a loose `.yaml`/`.yml` file or a bundle directory containing
 * `config.yaml` is decided by the filesystem-aware `safeCustomAgentRealPath`;
 * that gate also performs existence + a symlink-aware (realpath) containment
 * check. Pure / unit-testable.
 */
export function isValidCustomAgentPath(p: unknown, scanDir: string): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (typeof scanDir !== "string" || scanDir.length === 0) return false;
  // 1. Reject ANY `..` segment in the RAW string, before resolve() can collapse
  // it. `resolve()` flattens `..` lexically, so a syntax like `sub/../evil.yaml`
  // would otherwise survive — the contract forbids traversal syntax entirely.
  if (rawPathHasDotDot(p)) return false;
  if (!nodePath.isAbsolute(p)) return false;
  // With `..` already rejected, resolve() only normalizes separators / `.`
  // segments here.
  const resolved = nodePath.resolve(p);
  // A loose YAML file (`.yaml`/`.yml`) OR an extension-less path that may be a
  // bundle directory. Any other extension is refused outright. The file-vs-dir
  // distinction (and the `config.yaml`-inside requirement for a bundle) is the
  // job of the fs-aware gate.
  const ext = nodePath.extname(resolved).toLowerCase();
  if (ext !== "" && ext !== ".yaml" && ext !== ".yml") return false;
  // Direct child of the scan dir only (lexical).
  return nodePath.dirname(resolved) === nodePath.resolve(scanDir);
}

/** True if the raw path string contains a `..` segment (any separator). */
function rawPathHasDotDot(p: string): boolean {
  return p.split(/[\\/]+/).some((seg) => seg === "..");
}

/** Basename of the canonical config file inside an omnigent BUNDLE directory. */
export const BUNDLE_CONFIG_NAME = "config.yaml";

/**
 * The FULL custom-agent path gate, fail-closed and defense-in-depth. Returns the
 * real (symlink-resolved) absolute path ONLY if every check holds, else null
 * (caller falls back to Default); NEVER throws. The path may resolve to EITHER a
 * loose YAML file or an omnigent BUNDLE directory. Checks, in order:
 *   1–3. lexical gate (`isValidCustomAgentPath`: no `..` syntax, absolute,
 *        `.yaml`/`.yml` OR extension-less, lexical direct-child of scanDir);
 *   4.   the path exists (injected `exists`) and is EITHER
 *          (a) a regular FILE ending `.yaml`/`.yml`, OR
 *          (b) a DIRECTORY that DIRECTLY CONTAINS a regular file `config.yaml`
 *              (the canonical bundle layout — `omnigent run <dir>`). The
 *              `config.yaml` must be a directly-contained REGULAR file — checked
 *              with a NON-symlink-following stat (`isRegularFileNoFollow`), so a
 *              symlinked `config.yaml` (which would let the bundle consume a
 *              config from outside itself) or a `config.yaml` directory is
 *              rejected;
 *        anything else (extension-less plain file, dir without `config.yaml`,
 *        special file) → null;
 *   5.   the symlink gap is closed — `realpath` of the candidate AND of scanDir
 *        are computed, and the candidate's real dirname must equal the real
 *        scanDir (a real, direct child of the real scan dir).
 * The emitted real path is the validated FILE (loose) or DIRECTORY (bundle) —
 * never the `config.yaml` inside a bundle (`omnigent run <dir>` is canonical).
 * A broken symlink / ENOENT / any throw from the fs ops resolves to null. fs
 * ops are injected so this stays unit-testable; the real `fs` is the default.
 */
export function safeCustomAgentRealPath(
  rawPath: unknown,
  scanDir: string,
  fsOps: {
    exists?: (p: string) => boolean;
    realpath: (p: string) => string;
    isFile: (p: string) => boolean;
    isDirectory?: (p: string) => boolean;
    isRegularFileNoFollow?: (p: string) => boolean;
  },
): string | null {
  if (!isValidCustomAgentPath(rawPath, scanDir)) return null;
  const p = rawPath as string;
  try {
    if (fsOps.exists && !fsOps.exists(p)) return null;
    // (a) loose YAML file, OR (b) bundle directory with a regular config.yaml.
    let kindOk = false;
    if (fsOps.isFile(p)) {
      kindOk = /\.ya?ml$/i.test(p);
    } else if (fsOps.isDirectory && fsOps.isDirectory(p)) {
      // The bundle's config.yaml must be a directly-contained REGULAR file:
      // checked WITHOUT following the final symlink, so a symlinked config.yaml
      // (escaping the bundle) or a config.yaml directory is rejected.
      kindOk =
        !!fsOps.isRegularFileNoFollow &&
        fsOps.isRegularFileNoFollow(nodePath.join(p, BUNDLE_CONFIG_NAME));
    }
    if (!kindOk) return null;
    const real = fsOps.realpath(p);
    const realDir = fsOps.realpath(scanDir);
    // Real, direct child of the real scan dir — closes the symlink gap that the
    // lexical check alone (which never follows links) would miss. Applies
    // equally to a loose file and to a bundle directory.
    if (nodePath.dirname(real) !== realDir) return null;
    return real;
  } catch {
    return null; // ENOENT / broken symlink / any fs throw → fail closed.
  }
}

/**
 * Resolve a per-skill stored agent choice to the validated launch form, FAILING
 * CLOSED to the Default agent. The only value that can reach argv as a flag-able
 * token is a built-in name that is in the hardcoded allowlist; the only value
 * that can reach argv as a positional is a custom path that passes
 * `isValidCustomAgentPath` AND still exists. Anything else — unknown kind,
 * missing value, bad built-in name, custom path outside the scan dir / wrong
 * extension / non-existent — resolves to `{ mode: 'default' }`. `exists` is
 * injected so this stays pure / unit-testable. NEVER consults a display label.
 */
export function resolveAgentLaunch(
  stored: SkillAgent | undefined | null,
  opts: {
    scanDir: string;
    exists: (p: string) => boolean;
    realpath?: (p: string) => string;
    isFile?: (p: string) => boolean;
    isDirectory?: (p: string) => boolean;
    isRegularFileNoFollow?: (p: string) => boolean;
  },
): ResolvedAgent {
  if (!stored || typeof stored !== "object") return { mode: "default" };
  if (stored.kind === "builtin") {
    return isAllowedBuiltinAgent(stored.name)
      ? { mode: "builtin", name: stored.name }
      : { mode: "default" };
  }
  if (stored.kind === "custom") {
    // Fail-closed, symlink-aware containment check. fs ops default to the real
    // `fs` (so the unchanged main.ts call site is correct at runtime) and are
    // injectable for tests. The emitted path is the real (resolved) absolute
    // path — the single inert positional after `run`.
    const real = safeCustomAgentRealPath(stored.path, opts.scanDir, {
      exists: opts.exists,
      realpath: opts.realpath ?? ((p) => fs.realpathSync(p)),
      isFile: opts.isFile ?? ((p) => fs.statSync(p).isFile()),
      isDirectory: opts.isDirectory ?? ((p) => fs.statSync(p).isDirectory()),
      // lstat does NOT follow the final symlink: a symlinked config.yaml yields
      // isSymbolicLink (isFile()===false) and a directory yields isFile()===false.
      isRegularFileNoFollow:
        opts.isRegularFileNoFollow ?? ((p) => fs.lstatSync(p).isFile()),
    });
    return real ? { mode: "custom", path: real } : { mode: "default" };
  }
  // 'default' or any unrecognized kind.
  return { mode: "default" };
}

/**
 * Minimal, safe top-level scalar reader for a custom agent YAML config. Reads
 * ONLY the first top-level `name:` and `description:` (column-0 keys); nested or
 * indented keys are ignored. Surrounding quotes are stripped and a trailing
 * inline `#` comment on an unquoted scalar is dropped. This intentionally does
 * NOT pull a full YAML dependency — it never executes anything and only ever
 * yields two display strings (which never reach argv). Pure / unit-testable.
 */
export function parseAgentConfigYaml(text: string): {
  name: string | null;
  description: string | null;
} {
  const out: { name: string | null; description: string | null } = {
    name: null,
    description: null,
  };
  if (typeof text !== "string") return out;
  for (const line of text.split(/\r?\n/)) {
    // Top-level keys only — any leading whitespace means it is nested.
    if (/^[ \t]/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (key !== "name" && key !== "description") continue;
    if (out[key] !== null) continue; // first occurrence wins
    const val = unquoteScalar(m[2].trim());
    out[key] = val.length ? val : null;
  }
  return out;
}

/** Strip matching surrounding quotes, else drop a trailing ` #` inline comment. */
function unquoteScalar(s: string): string {
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    return s.slice(1, -1);
  }
  const hash = s.indexOf(" #");
  return hash === -1 ? s : s.slice(0, hash).trim();
}

/**
 * Discover the custom agents in `dir` (the absolute
 * `<vaultBase>/.omnigent/agent-configs`), considering ONLY direct children of
 * two kinds:
 *   1. LOOSE FILE  — a child ending `.yaml`/`.yml`; the launch path is the FILE,
 *      its display name is read from that file's top-level `name:` (else the
 *      filename stem).
 *   2. BUNDLE DIR  — a child directory that directly contains a regular
 *      `config.yaml`; the launch path is the DIRECTORY (`omnigent run <dir>` is
 *      canonical — never the `config.yaml` inside it), its display name is read
 *      from `<dir>/config.yaml`'s top-level `name:` (else the directory name).
 * Bundle detection requires the injected `isDirectory` callback; without it only
 * loose files are enumerated (the pre-bundle behavior). Subdirectories with no
 * `config.yaml` and non-yaml files are ignored. Each yields an optional tooltip
 * (`description:`). If `dir` is null or does not exist (readdir throws), yields
 * ZERO agents — never an error. fs callbacks are injected so this stays pure /
 * unit-testable. Results are sorted by entry name for stable ordering.
 */
export function discoverCustomAgents(opts: {
  dir: string | null;
  readdir: (dir: string) => string[];
  readFile: (path: string) => string;
  isFile?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
}): CustomAgent[] {
  if (!opts.dir) return [];
  let entries: string[];
  try {
    entries = opts.readdir(opts.dir);
  } catch {
    return []; // missing dir → zero agents (no error)
  }
  const probe = (p: string, fn?: (q: string) => boolean): boolean => {
    if (!fn) return false;
    try {
      return fn(p);
    } catch {
      return false;
    }
  };
  const out: CustomAgent[] = [];
  for (const entry of [...entries].sort()) {
    const abs = nodePath.join(opts.dir, entry);
    // The path to launch (file OR dir) and the YAML to read display metadata
    // from, plus the fallback display name. Resolved per kind below.
    let launchPath: string | null = null;
    let readPath: string | null = null;
    let fallbackName = entry;

    if (/\.ya?ml$/i.test(entry)) {
      // LOOSE FILE: an isFile gate (when provided) must confirm it is a file.
      const isFileOk = opts.isFile ? probe(abs, opts.isFile) : true;
      if (isFileOk) {
        launchPath = abs;
        readPath = abs;
        fallbackName = entry.replace(/\.ya?ml$/i, "");
      }
    }
    if (launchPath === null && probe(abs, opts.isDirectory)) {
      // BUNDLE DIR: must directly contain a regular `config.yaml`.
      const config = nodePath.join(abs, BUNDLE_CONFIG_NAME);
      let hasConfig: boolean;
      if (opts.isFile) {
        hasConfig = probe(config, opts.isFile);
      } else {
        // No isFile probe → fall back to attempting the read.
        try {
          opts.readFile(config);
          hasConfig = true;
        } catch {
          hasConfig = false;
        }
      }
      if (hasConfig) {
        launchPath = abs; // the DIRECTORY, not the config.yaml inside it
        readPath = config;
        fallbackName = entry; // directory name
      }
    }
    if (launchPath === null || readPath === null) continue;

    let text: string;
    try {
      text = opts.readFile(readPath);
    } catch {
      continue;
    }
    const meta = parseAgentConfigYaml(text);
    const name = meta.name && meta.name.trim() ? meta.name.trim() : fallbackName;
    out.push({
      path: launchPath,
      name,
      ...(meta.description ? { description: meta.description } : {}),
    });
  }
  return out;
}

// --- UI encode/decode for the per-skill <select> value -----------------
// The dropdown is a flat <select>; its option values are strings. These map the
// discriminated `SkillAgent` to/from that flat string. Decoding is UNVALIDATED
// (the builtin name / custom path are taken verbatim) — validation happens at
// store time and again, authoritatively, at launch (`resolveAgentLaunch`).

export const AGENT_DEFAULT_VALUE = "default";

/** Encode a stored choice to its <select> option value. */
export function encodeAgentChoice(agent: SkillAgent | undefined | null): string {
  if (!agent || typeof agent !== "object") return AGENT_DEFAULT_VALUE;
  if (agent.kind === "builtin") return `builtin:${agent.name}`;
  if (agent.kind === "custom") return `custom:${agent.path}`;
  return AGENT_DEFAULT_VALUE;
}

/** Decode a <select> option value back to a (still-unvalidated) choice. */
export function decodeAgentChoice(value: string): SkillAgent {
  if (typeof value === "string") {
    if (value.startsWith("builtin:")) {
      return { kind: "builtin", name: value.slice("builtin:".length) };
    }
    if (value.startsWith("custom:")) {
      return { kind: "custom", path: value.slice("custom:".length) };
    }
  }
  return { kind: "default" };
}

/**
 * Ordered candidate absolute paths to probe for the omnigent binary:
 * user override first (if set), then the standard install locations.
 * `homedir` is injected so this stays pure/testable.
 */
export function omnigentCandidatePaths(
  override: string | undefined,
  homedir: string,
): string[] {
  const candidates: string[] = [];
  const ov = override?.trim();
  if (ov) candidates.push(ov);
  candidates.push(`${homedir}/.local/bin/${OMNIGENT_BIN_NAME}`);
  candidates.push(`/usr/local/bin/${OMNIGENT_BIN_NAME}`);
  candidates.push(`/opt/homebrew/bin/${OMNIGENT_BIN_NAME}`);
  return candidates;
}

/**
 * The allowlist control: a binary path is permitted ONLY if it is an absolute
 * path whose basename is exactly `omnigent`. Validates the path STRING (not the
 * realpath) so legitimate symlinked installs (e.g. /usr/local/bin/omnigent ->
 * .../omnigent-real) are not falsely rejected.
 */
export function isAllowedOmnigentPath(p: string): boolean {
  if (!p) return false;
  return nodePath.isAbsolute(p) && nodePath.basename(p) === OMNIGENT_BIN_NAME;
}

export type BinaryResolution =
  | { status: "ok"; path: string }
  | { status: "invalid-override" }
  | { status: "not-found" };

/**
 * Resolve the omnigent binary, FAILING CLOSED. If an override is set it must
 * pass the allowlist (`isAllowedOmnigentPath`) — a set-but-invalid override
 * yields `invalid-override` and is NEVER masked by falling back to the
 * defaults. When the override is blank, the (already allowlisted, absolute)
 * default candidates are probed in order. `exists` is injected (fs.existsSync
 * at runtime) so resolution is testable without the filesystem.
 */
export function resolveOmnigentBinary(opts: {
  override?: string;
  homedir: string;
  exists: (path: string) => boolean;
}): BinaryResolution {
  const override = opts.override?.trim();
  if (override) {
    if (!isAllowedOmnigentPath(override)) return { status: "invalid-override" };
    // Respect the explicit override: do not fall through to defaults.
    return opts.exists(override)
      ? { status: "ok", path: override }
      : { status: "not-found" };
  }
  for (const candidate of omnigentCandidatePaths(undefined, opts.homedir)) {
    if (opts.exists(candidate)) return { status: "ok", path: candidate };
  }
  return { status: "not-found" };
}

/**
 * Augment a PATH string with extra entries (GUI apps inherit a thin launchd
 * PATH; the spawned binary execs sub-tools and needs these). Preserves order
 * and de-dupes — existing entries are not re-appended.
 */
export function augmentPath(
  currentPath: string | undefined,
  extras: string[],
): string {
  const sep = ":";
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (entry: string) => {
    if (entry === "" || seen.has(entry)) return;
    seen.add(entry);
    out.push(entry);
  };
  for (const p of (currentPath ?? "").split(sep)) push(p);
  for (const e of extras) push(e);
  return out.join(sep);
}

/** A single resolved right-click (file-menu) entry: title + what to launch. */
export interface RightClickMenuItem {
  /** Menu label, e.g. `Run "transcribe-meeting" here`. */
  title: string;
  /** The skill id (= absolute path) to launch. */
  skillId: string;
  /** The clicked file/folder absolute path, passed as the launch context. */
  contextPath: string;
}

/**
 * Pure construction of the file-menu items for the M3 right-click surface.
 * GATED by `isEnabled(id)` — only skills with `rightClickEnabled` produce an
 * item, so a disabled skill never appears in the menu. The clicked file's
 * absolute path is carried through unchanged (the launcher embeds it as inert
 * text inside the single `-p` prompt). Kept side-effect-free so it is unit
 * testable independent of Obsidian's `Menu`.
 */
export function buildRightClickMenuItems(
  skills: { id: string; name: string }[],
  isEnabled: (id: string) => boolean,
  contextAbsPath: string,
): RightClickMenuItem[] {
  const items: RightClickMenuItem[] = [];
  for (const s of skills) {
    if (!isEnabled(s.id)) continue;
    items.push({
      title: `Run "${s.name}" here`,
      skillId: s.id,
      contextPath: contextAbsPath,
    });
  }
  return items;
}
