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
 * The exact `--harness` token omnigent expects for the Claude harness. Confirmed
 * via `omnigent run --help`: `--harness` accepts `'claude'` (documented as an
 * alias for `'claude-sdk'`), with the example `omnigent run --harness claude`.
 */
export const CLAUDE_HARNESS_TOKEN = "claude";

/**
 * Resolve a per-skill harness choice to the `--harness` string handed to
 * `buildOmnigentArgv`, FAILING CLOSED to today's behavior. Only the literal
 * `"claude"` is mapped to the hardcoded Claude token; the raw stored string is
 * NEVER passed through as free-form `--harness` text. Every other value —
 * `"omnigent"`, absent/undefined, or any unrecognized string — preserves the
 * existing global behavior by returning `globalHarness` (usually blank, so
 * `buildOmnigentArgv` omits `--harness`). Pure / unit-testable.
 */
export function resolveHarnessArg(
  choice: string | undefined,
  globalHarness: string,
): string {
  if (choice === "claude") return CLAUDE_HARNESS_TOKEN;
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
