// Pure launch-construction helpers (no Obsidian imports; only node `path` for
// absolute/basename checks) — the argv builder, binary allowlist/resolution,
// and PATH augmentation are all unit-testable. The actual spawn (impure) lives
// in main.ts and consumes these.

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
): string {
  const base = `Use the ${skillName} skill.`;
  const hasContext = typeof contextPath === "string" && contextPath.length > 0;
  // The path is concatenated as inert prose — never split out as a separate
  // token — so any spaces/quotes/dashes/metacharacters in it stay contained.
  const head = hasContext ? `${base} Context file: ${contextPath}.` : base;
  // No context + anchor off → exactly the M1 prompt (`Use the <name> skill.`).
  if (!appendAnchor && !hasContext) return head;
  return (
    `${head} Operate in this vault: ${vaultPath}.` +
    " Write any files into this vault directory only." +
    " Do not create a git worktree or delegate the final file write."
  );
}

/**
 * Build the omnigent one-shot argv array (UI-visible run; exits on its own).
 * Shape: [bin, 'run', ('--server' url)?, ('--harness' h)?, '-p', prompt].
 * No '--no-session' (that path is ephemeral / not UI-visible). The prompt is a
 * single inert element.
 */
export function buildOmnigentArgv(opts: {
  binaryPath: string;
  prompt: string;
  serverUrl?: string;
  harness?: string;
}): string[] {
  const argv = [opts.binaryPath, "run"];
  const server = opts.serverUrl?.trim();
  if (server) argv.push("--server", server);
  const harness = opts.harness?.trim();
  if (harness) argv.push("--harness", harness);
  argv.push("-p", opts.prompt);
  return argv;
}

/**
 * The default per-skill choice: a SENTINEL meaning "omit `--harness` entirely"
 * (use omnigent's own default / the global override). It is NOT a harness token
 * and is never passed as an argv value — it only selects the global behavior.
 */
export const OMNIGENT_HARNESS_SENTINEL = "omnigent";

/**
 * Strict validity test for a harness token that may reach the `--harness` argv
 * element. Must be non-empty, start with an alphanumeric (NO leading dash so it
 * can never be read as a flag), and otherwise contain only `A-Za-z0-9._-`. This
 * rejects spaces, quotes, shell metacharacters, command substitution, and flag
 * injection. Pure / unit-testable.
 */
export function isValidHarnessToken(s: string): boolean {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s);
}

/**
 * Parse the harness tokens advertised in `omnigent run --help`. The relevant
 * line reads, e.g.:
 *   `Harness to use: 'claude' (alias for 'claude-sdk'), 'claude-sdk', 'codex',
 *    'openai-agents', 'open-responses', or 'pi'.`
 * Strategy: for each `--harness` occurrence, slice from it up to the next
 * option line (a newline followed by optional indent then `-`) or end of text,
 * extract every single-quoted token, keep only valid tokens, and dedupe in
 * first-seen order. The `(alias for 'claude-sdk')` parenthetical contributes a
 * duplicate that the dedupe collapses, so the excerpt above yields exactly
 * `[claude, claude-sdk, codex, openai-agents, open-responses, pi]`. The first
 * occurrence that yields tokens wins (a bare usage-synopsis mention with no
 * quoted tokens is skipped). Tolerant of wrapping/whitespace — including a
 * token hyphen-wrapped across lines (`'open-\n   responses'`), which the real
 * `--help` does and which is rejoined before extraction. Pure.
 */
export function parseHarnessChoicesFromHelp(helpText: string): string[] {
  if (typeof helpText !== "string" || helpText.length === 0) return [];
  const flagRe = /--harness/g;
  let m: RegExpExecArray | null;
  while ((m = flagRe.exec(helpText)) !== null) {
    const start = m.index;
    // End the region at the next option line (`\n` + optional indent + `-`),
    // searched strictly after this `--harness` keyword so we don't stop on it.
    const afterKeyword = start + "--harness".length;
    const nextFlag = helpText.slice(afterKeyword).search(/\n[ \t]*-/);
    const end = nextFlag === -1 ? helpText.length : afterKeyword + nextFlag;
    // Rejoin CLI hyphen-wraps (`open-\n<indent>responses` → `open-responses`)
    // so a token broken across lines is recovered intact before extraction.
    const region = helpText.slice(start, end).replace(/-[ \t]*\r?\n[ \t]*/g, "-");
    const seen = new Set<string>();
    const tokens: string[] = [];
    const quoteRe = /'([^']+)'/g;
    let q: RegExpExecArray | null;
    while ((q = quoteRe.exec(region)) !== null) {
      const tok = q[1];
      if (!isValidHarnessToken(tok) || seen.has(tok)) continue;
      seen.add(tok);
      tokens.push(tok);
    }
    if (tokens.length > 0) return tokens;
  }
  return [];
}

/**
 * The deduped effective harness TOKEN list (no sentinel): built-ins first, then
 * discovered, then custom, each not already present. This is the allowed set a
 * per-skill choice is checked against and the source for the dropdown options
 * (the view prepends the "omnigent" default sentinel). Pure / unit-testable.
 */
export function effectiveHarnessTokens(
  builtins: readonly string[],
  discovered: readonly string[],
  custom: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [builtins, discovered, custom]) {
    for (const t of list) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * The full effective option list for the per-skill selector: the "omnigent"
 * default sentinel first, then `effectiveHarnessTokens`. Pure / unit-testable.
 */
export function effectiveHarnessOptions(
  builtins: readonly string[],
  discovered: readonly string[],
  custom: readonly string[],
): string[] {
  return [
    OMNIGENT_HARNESS_SENTINEL,
    ...effectiveHarnessTokens(builtins, discovered, custom),
  ];
}

/**
 * Resolve a per-skill harness choice to the `--harness` string handed to
 * `buildOmnigentArgv`, FAILING CLOSED to today's behavior. The default sentinel
 * `"omnigent"`, absent/undefined, or empty → return `globalHarness` (usually
 * blank, so `buildOmnigentArgv` omits `--harness`). Otherwise the choice is
 * returned ONLY if it both passes `isValidHarnessToken` AND is a member of
 * `allowedTokens`; any other value (invalid charset, or a valid-looking token
 * not in the allowed set) fails closed to `globalHarness`. Free-form text never
 * reaches `--harness`. Pure / unit-testable.
 */
export function resolveHarnessArg(
  choice: string | undefined,
  globalHarness: string,
  allowedTokens: readonly string[],
): string {
  if (!choice || choice === OMNIGENT_HARNESS_SENTINEL) return globalHarness;
  if (isValidHarnessToken(choice) && allowedTokens.includes(choice)) {
    return choice;
  }
  return globalHarness;
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
