// Preferred TERMINAL EMULATOR registry, detection, and opener-command builder.
//
// This backs the "Preferred terminal" setting + the "run in a terminal" launch
// mode. Terminal mode writes a temp script that `cd`s into the vault and runs the
// skill's SAME resolved harness command headless mode would run (omnigent / a
// custom harness) — the only difference is it runs VISIBLY in the user's chosen
// terminal emulator instead of detached. This module decides WHICH terminal opens
// that script; it never constructs the harness command itself.
//
// Pure / injectable (no Obsidian imports; fs + platform injected) so it stays
// unit-testable, matching launch.ts. macOS is the primary target (this is a
// desktop-only, macOS-centric plugin); Windows/Linux always fall back to the
// default-terminal opener regardless of the chosen emulator.

import * as nodePath from "path";

/** The opener process to spawn: an absolute-ish bin + inert args. */
export interface OpenerCommand {
  bin: string;
  args: string[];
}

/**
 * A supported terminal emulator. Detection is by macOS app bundle (`appName` →
 * `/Applications/<appName>.app`) and/or a binary on PATH-standard dirs
 * (`binName`). `macOpener` builds the spawn command to open a written script in
 * that terminal on macOS; when absent the default opener is used. `auto` (no
 * appName/binName/macOpener) always resolves to the OS default terminal.
 */
export interface TerminalDefinition {
  id: string;
  label: string;
  /** macOS app bundle base name, e.g. "Ghostty" (detected in the app dirs). */
  appName?: string;
  /** CLI binary name, e.g. "ghostty" (detected in the standard bin dirs). */
  binName?: string;
  /**
   * Opener using the resolved CLI BINARY (preferred when the binary is detected)
   * — the reliable way to run a command in emulators that ship a CLI (Ghostty
   * takes `-e`). Pure function of (binPath, scriptPath).
   */
  binOpener?: (binPath: string, scriptPath: string) => OpenerCommand;
  /**
   * macOS opener via the app bundle (`open …`) — the FALLBACK when no CLI binary
   * is detected. Omit to use the default opener. Pure function of the script path.
   */
  macOpener?: (scriptPath: string) => OpenerCommand;
  /**
   * CLI path INSIDE the app bundle (relative to `<appDir>/<appName>.app`), probed
   * when no standalone `binName` is found — cmux ships its CLI this way.
   */
  bundledBin?: string;
  /**
   * A richer launch integration main.ts uses instead of the opener command when
   * available: `cmux` (workspace + tabs over the cmux CLI) or `ghostty` (tabs via
   * AppleScript on Ghostty ≥ 1.3). The opener remains the fallback.
   */
  integration?: "cmux" | "ghostty";
}

/**
 * The hardcoded terminal registry, in settings-dropdown order: Terminal (the OS
 * default terminal — Terminal.app on macOS; always available), cmux and Ghostty
 * (each only when installed). A stale stored id (e.g. a removed emulator)
 * resolves back to Terminal.
 */
export const KNOWN_TERMINALS: readonly TerminalDefinition[] = [
  { id: "auto", label: "Terminal" },
  {
    id: "cmux",
    label: "cmux",
    appName: "cmux",
    // cmux is a native macOS terminal (libghostty) with workspaces + tabs and a
    // CLI bundled in its app. Runs are opened by main.ts's cmux integration (a
    // tab in the "Obsidian Sessions" workspace via `cmux new-surface`), NOT by an
    // opener command — so no binOpener/macOpener here. If the integration can't
    // reach cmux the run falls back to the OS default terminal with a Notice.
    bundledBin: "Contents/Resources/bin/cmux",
    integration: "cmux",
  },
  {
    id: "ghostty",
    label: "Ghostty",
    appName: "Ghostty",
    // Ghostty ≥ 1.3 is driven by AppleScript (a tab in the front window; see
    // ghostty.ts). Before 1.3 — or if AppleScript fails — `open -na … -e` runs the
    // script in a separate Ghostty instance. (The `ghostty` CLI can't open
    // windows on macOS, so it's never used.)
    integration: "ghostty",
    macOpener: (s) => ({ bin: "/usr/bin/open", args: ["-na", "Ghostty", "--args", "-e", "bash", s] }),
  },
] as const;

/** Look up a terminal definition by id, or undefined. */
export function terminalById(
  id: string | undefined | null,
): TerminalDefinition | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return KNOWN_TERMINALS.find((t) => t.id === id);
}

/** Standard bin dirs a terminal's CLI is probed in (POSIX / Windows). */
export function terminalBinCandidates(
  binName: string,
  homedir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") {
    return [".exe", ".cmd", ".bat", ""].map((ext) =>
      nodePath.join(homedir, ".local", "bin", binName + ext),
    );
  }
  return [
    `/opt/homebrew/bin/${binName}`,
    `/usr/local/bin/${binName}`,
    `${homedir}/.local/bin/${binName}`,
  ];
}

/** A detected terminal: its definition plus (when found) the resolved CLI binary path. */
export interface DetectedTerminal {
  def: TerminalDefinition;
  /** Resolved CLI binary path when detected (ghostty/cmux); else undefined. */
  binPath?: string;
  /** The detected app bundle path (e.g. `/Applications/Ghostty.app`), when found. */
  appPath?: string;
}

/**
 * Detect which known terminals are available. `auto` is ALWAYS included. On
 * non-macOS only `auto` is offered (the emulator list is macOS-centric and
 * Windows/Linux use the default terminal regardless). On macOS an emulator is
 * detected when its CLI binary exists (probed in the standard bin dirs) OR its
 * app bundle exists in any of `appDirs`; the resolved `binPath` is attached when
 * a binary is found (preferred at open time). fs is injected (`exists`) so this
 * stays pure / unit-testable.
 */
export function detectInstalledTerminals(opts: {
  homedir: string;
  appDirs: string[];
  exists: (p: string) => boolean;
  platform?: NodeJS.Platform;
}): DetectedTerminal[] {
  const platform = opts.platform ?? process.platform;
  const out: DetectedTerminal[] = [];
  for (const def of KNOWN_TERMINALS) {
    if (def.id === "auto") {
      out.push({ def });
      continue;
    }
    if (platform !== "darwin") continue; // only auto off macOS
    // Prefer a CLI binary (reliable run-a-command) — probe it first.
    let binPath: string | undefined;
    if (def.binName) {
      for (const c of terminalBinCandidates(def.binName, opts.homedir, platform)) {
        if (opts.exists(c)) {
          binPath = c;
          break;
        }
      }
    }
    const appDir = def.appName
      ? opts.appDirs
          .map((dir) => nodePath.join(dir, `${def.appName}.app`))
          .find((p) => opts.exists(p))
      : undefined;
    // An app that bundles its CLI (cmux): use that copy when no standalone one.
    if (!binPath && appDir && def.bundledBin) {
      const bundled = nodePath.join(appDir, def.bundledBin);
      if (opts.exists(bundled)) binPath = bundled;
    }
    if (binPath) out.push({ def, binPath, appPath: appDir });
    else if (appDir) out.push({ def, appPath: appDir });
  }
  return out;
}

/**
 * Resolve the effective preferred terminal, FAILING CLOSED to `auto`. Returns the
 * DetectedTerminal for `preferredId` when still available, else the `auto` entry
 * (always present). Pure / unit-testable.
 */
export function resolvePreferredTerminal(
  preferredId: string | undefined | null,
  detected: DetectedTerminal[],
): DetectedTerminal {
  if (typeof preferredId === "string" && preferredId) {
    const match = detected.find((d) => d.def.id === preferredId);
    if (match) return match;
  }
  const auto = detected.find((d) => d.def.id === "auto");
  return auto ?? { def: KNOWN_TERMINALS[0] };
}

/**
 * Build the opener command that runs the written `scriptPath` in `terminal`.
 * - a CLI binary was detected + the def has a `binOpener` → run via the binary
 *   (the RELIABLE run-a-command path; e.g. `ghostty -e bash <script>`).
 * - a macOS GUI emulator with a `macOpener` (and platform darwin) → that opener.
 * - otherwise → the DEFAULT opener: `open <script>` (macOS), `cmd /c start "" …`
 *   (Windows), `$TERMINAL -e bash <script>` / `x-terminal-emulator` (Linux).
 * `env` (Linux `$TERMINAL`) is injected. Pure / unit-testable.
 */
export function buildOpenerCommand(opts: {
  terminal: DetectedTerminal;
  scriptPath: string;
  platform?: NodeJS.Platform;
  linuxTerminalEnv?: string;
}): OpenerCommand {
  const platform = opts.platform ?? process.platform;
  const { def, binPath } = opts.terminal;
  const s = opts.scriptPath;

  // Preferred: a detected CLI binary with a binOpener runs the command reliably.
  if (binPath && def.binOpener) {
    return def.binOpener(binPath, s);
  }
  if (platform === "darwin" && def.macOpener) {
    return def.macOpener(s);
  }
  return buildDefaultOpener(s, platform, opts.linuxTerminalEnv);
}

/** The OS default-terminal opener (also the `auto` opener). Pure / unit-testable. */
export function buildDefaultOpener(
  scriptPath: string,
  platform: NodeJS.Platform = process.platform,
  linuxTerminalEnv?: string,
): OpenerCommand {
  if (platform === "win32") {
    return { bin: "cmd.exe", args: ["/c", "start", "", scriptPath] };
  }
  if (platform === "darwin") {
    return { bin: "/usr/bin/open", args: [scriptPath] };
  }
  return {
    bin: linuxTerminalEnv || "x-terminal-emulator",
    args: ["-e", "bash", scriptPath],
  };
}
