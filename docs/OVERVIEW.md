# Skill and Harness Manager

**An Obsidian plugin that gathers the AI skills, commands, and agents scattered across your tools into one place inside your vault — and makes each one runnable with a click.**

If you collect *skills* (`SKILL.md` files), slash-commands, and agents across `.claude/`, `.codex/`, `.cursor/`, `.agents/`, marketplace bundles, and loose notes, they end up spread over folders you can't easily see or use. This plugin discovers them, organizes and tags them, lets you read and edit them as normal notes, and launches each one against the AI CLI of your choice — from the ribbon, the command palette, or a right-click.

> No bundled model, no inference, no network calls of its own. It finds, organizes, and launches; the actual work runs in whatever AI CLI you point it at (Claude Code, Codex, omnigent, ucode, or your own). Desktop only.

[gif of opening the browser and skimming the tabs]

---

## 1. One place for every skill

**The plugin scans a set of configurable roots and lists everything it finds in a single browser.** A skill is a `SKILL.md` with `name` + `description` frontmatter, or any Markdown file directly inside a `skills/` folder — so the same rule surfaces skills from every tool that follows the convention. Results are grouped into a collapsible source-folder tree and filterable by agent, harness, tag, and access, with search across the set.

Out of the box it scans your vault and the common in-vault tool folders (`.claude/skills`, `.codex/skills`, `.cursor/skills`, `.agents/skills`, and others). The browser opens from the `brain-circuit` ribbon icon and has tabs for **Skills**, **Commands**, **Scripts**, **Sessions**, **Agents**, and **Harnesses**.

[gif of the Skills tab with the folder tree and filters]

### Adding an external skills folder

**Skill folders that live outside the vault — like `~/.claude/skills` — can be added as scan roots without leaving the browser.** At the bottom of the Skills or Commands tab, the **+ Add a folder** button opens a menu; the **Open file explorer…** option launches the OS folder picker, and the folder you choose is added as an external scan root and rescanned immediately.

External roots are ordinary, first-class sources — they persist across reloads and dedupe against in-vault copies of the same skill.

[gif of adding an external skills folder via Open file explorer]

---

## 2. View and edit a skill in Obsidian

**Any skill opens as a normal Obsidian note — including skills that live outside the vault.** Clicking **View file** on a row opens the `SKILL.md` in a tab and reveals its folder in the file explorer, so you also see the scripts and references a multi-file skill ships with. Editing and saving writes straight back to the source file.

For a skill stored outside the vault, the plugin bridges it in transparently: it links the skill's folder into the vault so Obsidian can open it in a tab, rather than handing it off to an external editor. You read and edit external skills the same way you edit your own notes.

[gif of viewing and editing an external skill in Obsidian]

---

## 3. Run a skill where you work

**Every skill can be launched from wherever is convenient — a right-click, the sidebar, or the command palette.** The plugin builds a natural-language invocation, runs it through your chosen harness, and (for a targeted run) tells the model to operate inside the vault.

**Right-click a file** in the file explorer to run a skill *against that file* — useful for "reformat this note", "transcribe this recording", or "summarize this". The clicked file's path is passed to the skill as context.

[gif of running a skill from the file-explorer right-click menu]

**Right-click a text selection** inside a note to run a skill *on the highlighted text*. The skill receives the current file and the selection, and edits that file in place by default unless the skill says otherwise — handy for "rewrite this passage", "translate this", or "clean up this section".

[gif of selecting text and running a skill on the selection]

**Pin a skill to the ribbon** to create a one-click launcher with its own Lucide icon; pinning also registers a **command-palette** command, so the same skill is reachable by keyboard.

[gif of pinning a skill to the ribbon and triggering it]

### Headless or terminal

**Each skill runs one of two ways, set globally or per skill.** *Headless* spawns the run in the background and surfaces progress through notices and the Sessions tab. *Terminal* runs the identical command visibly in your preferred terminal so you can watch and interact. The preferred terminal is auto-detected from the emulators you have installed.

---

## 4. Harnesses — how skills actually run

**A harness is the command that executes a skill — usually an AI CLI.** The plugin substitutes the skill's prompt into a command template and runs it with no shell, so the invocation is inert and safe. omnigent is supported out of the box; you add your own for anything else.

A custom harness is a name plus a one-line command whose first token is the absolute path to a binary and which contains a `{prompt}` placeholder — for example:

```
/opt/homebrew/bin/claude -p {prompt}
```

The same shape covers wrappers and gateways. A ucode harness, for instance, forwards to the underlying tool's own non-interactive form:

```
/Users/me/.local/bin/ucode claude -p {prompt}
/Users/me/.local/bin/ucode codex exec {prompt}
```

Optionally add a **resume command** so the Sessions tab's **Connect** button can reopen a session. Harnesses are managed from the Harnesses tab, and the model can register itself as one on request.

[gif of adding a custom harness in the Harnesses tab]

---

## 5. Agents

**On top of the harness, a skill can pin an agent so it runs as a specific persona or sub-agent.** This is orthogonal to the harness — a skill can set both.

**omnigent agents** — pick a built-in agent or a custom agent config from your vault's agent-configs directory; the choice is validated at launch, so a stale or invalid selection quietly falls back to the default.

**Claude sub-agents** — when a skill's harness is a Claude-based custom harness, a `.claude/agents/*.md` sub-agent can be selected and is substituted into the harness command's `{agent}` token.

Discovered agents appear in the **Agents** tab, and the per-skill agent selector lives in each skill's configuration panel.

[gif of assigning an agent to a skill and running it]

---

## 6. Sessions and scripts

**Runs you start are tracked, and your own maintenance commands live alongside your skills.** The **Sessions** tab lists the launches you've made with a **Connect** button that reopens a resumable session in your terminal; entries are pruned automatically. The **Scripts** tab holds user-authored bash scripts — a name, description, and body — each runnable on click in a terminal or headless, for things like updating or launching a harness.

---

## Requirements

Desktop only — the plugin scans folders and launches local CLIs. Browsing, organizing, tagging, and editing work without any CLI; launching a skill needs whatever harness you configure.
