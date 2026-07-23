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
  /** CLI binary name, e.g. "ghostty"/"tmux" (detected in the standard bin dirs). */
  binName?: string;
  /**
   * Opener using the resolved CLI BINARY (preferred when the binary is detected)
   * — the reliable way to run a command in emulators that ship a CLI (Ghostty,
   * kitty, WezTerm all take `-e`/`start`). Pure function of (binPath, scriptPath).
   */
  binOpener?: (binPath: string, scriptPath: string) => OpenerCommand;
  /**
   * macOS opener via the app bundle (`open …`) — the FALLBACK when no CLI binary
   * is detected. Omit to use the default opener. Pure function of the script path.
   */
  macOpener?: (scriptPath: string) => OpenerCommand;
  /**
   * True when this terminal runs the script DETACHED (no window we control), so
   * the caller shows a "how to attach" hint instead of a plain open Notice
   * (currently only tmux). Display concern only.
   */
  detached?: boolean;
}

/** Fixed tmux session name reused across launches so attaches are predictable. */
export const TMUX_SESSION = "skill-harness";

/**
 * The hardcoded terminal registry. `auto` first (the safe default). GUI
 * emulators use `open`/`open -na`; tmux runs the script in a detached session the
 * user attaches to. Order is the settings-dropdown order.
 */
export const KNOWN_TERMINALS: readonly TerminalDefinition[] = [
  { id: "auto", label: "Auto (OS default terminal)" },
  {
    id: "terminal",
    label: "Terminal",
    appName: "Terminal",
    macOpener: (s) => ({ bin: "/usr/bin/open", args: ["-a", "Terminal", s] }),
  },
  {
    id: "iterm",
    label: "iTerm",
    appName: "iTerm",
    macOpener: (s) => ({ bin: "/usr/bin/open", args: ["-a", "iTerm", s] }),
  },
  {
    id: "ghostty",
    label: "Ghostty",
    appName: "Ghostty",
    binName: "ghostty",
    // Preferred: the ghostty CLI runs an initial command via `-e` reliably.
    binOpener: (bin, s) => ({ bin, args: ["-e", "bash", s] }),
    // Fallback (no CLI): `open -na` does NOT reliably pass `-e`, so just open the
    // app — the script won't auto-run. Install the `ghostty` CLI for auto-run.
    macOpener: (s) => ({ bin: "/usr/bin/open", args: ["-na", "Ghostty", "--args", "-e", "bash", s] }),
  },
  {
    id: "kitty",
    label: "kitty",
    appName: "kitty",
    binName: "kitty",
    binOpener: (bin, s) => ({ bin, args: ["bash", s] }),
    macOpener: (s) => ({ bin: "/usr/bin/open", args: ["-na", "kitty", "--args", "bash", s] }),
  },
  {
    id: "wezterm",
    label: "WezTerm",
    appName: "WezTerm",
    binName: "wezterm",
    binOpener: (bin, s) => ({ bin, args: ["start", "--", "bash", s] }),
    macOpener: (s) => ({ bin: "/usr/bin/open", args: ["-na", "WezTerm", "--args", "start", "--", "bash", s] }),
  },
  {
    id: "cmux",
    label: "cmux",
    appName: "cmux",
    // cmux (manaflow-ai/cmux) is an Electron agent-orchestration app, not a
    // classic emulator with a documented run-a-command flag. Best-effort: open
    // the app with the script path as an arg. If cmux ignores it, the launch
    // won't auto-run — use Ghostty/Terminal for a guaranteed run.
    macOpener: (s) => ({
      bin: "/usr/bin/open",
      args: ["-na", "cmux", "--args", s],
    }),
  },
  {
    id: "tmux",
    label: "tmux",
    binName: "tmux",
    detached: true,
  },
] as const;

/** Look up a terminal definition by id, or undefined. */
export function terminalById(
  id: string | undefined | null,
): TerminalDefinition | undefined {
  if (typeof id !== "string" || !id) return undefined;
  return KNOWN_TERMINALS.find((t) => t.id === id);
}

/** Standard bin dirs a CLI terminal (tmux) is probed in (POSIX / Windows). */
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
  /** Resolved CLI binary path when detected (ghostty/kitty/wezterm/tmux); else undefined. */
  binPath?: string;
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
    const hasApp =
      !!def.appName &&
      opts.appDirs.some((dir) => opts.exists(nodePath.join(dir, `${def.appName}.app`)));
    if (binPath) out.push({ def, binPath });
    else if (hasApp) out.push({ def });
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
 * - tmux → `<tmux> new-session -A -s skill-harness bash <script>` (detached; the
 *   caller tells the user to `tmux attach -t skill-harness`).
 * - a CLI binary was detected + the def has a `binOpener` → run via the binary
 *   (the RELIABLE run-a-command path; e.g. `ghostty -e bash <script>`).
 * - tmux (binName, no binOpener) → its detached `new-session` form.
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
  if (def.id === "tmux" && binPath) {
    return {
      bin: binPath,
      args: ["new-session", "-A", "-s", TMUX_SESSION, "bash", s],
    };
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
