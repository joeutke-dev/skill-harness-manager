# Skill and Harness Manager

**An Obsidian plugin that consolidates your AI skills, commands, and agents into one place inside your vault — and makes your skills available in Obsidians ribbon and right click menus.**

If you collect *skills* (`SKILL.md` files), slash-commands, and agents across `.claude/`, `.codex/`, `.cursor/`, `.agents/`, marketplace bundles, and loose notes, they end up spread over folders you can't easily see or use. This plugin helps you organize and tags them, and lets you read and edit them as normal notes. The plugin also supports launching skills against the harness of your choice — from the ribbon, the command palette when right clicking a file or folder, or a right-click when highlighting text so that you can better integrate LLM's into your notetaking, and expand obsidian from a notetaking app into a control plane to run AI driven workflows like creating emails, reading your calendar or processing data or whatever else you create a skill for.


---

## 1. One place for every skill

**The plugin scans a set of configurable roots and lists everything it finds in an Obsidian side pane** A skill is a `SKILL.md` with `name` + `description` frontmatter, or any Markdown file directly inside a `skills/` folder — so the same rule surfaces skills from every tool that follows this convention. Results are grouped into a collapsible source-folder tree enabling you to search and filter by agent, harness, and tag. 

Out of the box it scans your vault and the common in-vault tool folders (`.claude/skills`, `.codex/skills`, `.cursor/skills`, `.agents/skills`, and others). The browser opens from the `brain-circuit` ribbon icon and has tabs for Skills, Commands, Scripts, Sessions, Agents, and Harnesses.


### Adding an external skills folder

Skill folders that live outside the vault — like `yourname/.claude/skills` — can be added as scan roots in the plugin settings menu or sidepane At the bottom of the Skills or Commands tab, the + Add a folder button opens a menu; the Open file explorer… option launches the OS folder picker, and the folder you choose is added as an external scan root surfacing skills in the UI immediately.



---

## 2. View and edit skills in Obsidian

Since Skills are built on Markdown they open as a normal Obsidian note — including skills that live outside the vault. Clicking **View file** on a row opens the `SKILL.md` and reveals its folder in the file explorer, so you also see the scripts and references a multi-file skill ships with. Editing and saving writes straight back to the source file enabling you to quickly test and adjust skills. The goal is more ownership and pruning of skills over time instead of collecting or building skills that aren't used regularly and aren't maintained.


---

## 3. Run a skill where you work

**Every skill can be launched from wherever is convenient — a right-click, the sidebar, or the command palette.** The plugin builds a natural-language invocation, runs it through your chosen harness, and (for a targeted run) tells the model to operate inside the vault. If you call a skill on text that you've highlighted or by right clicking a file, the prompt sent to the model includes the file name or text in the prompt.

Right-click a file in the file explorer to run a skill *against that file* — useful for "reformat this note", "transcribe this recording", or "summarize this". The clicked file's path is passed to the skill as context.


Right-click a text selection inside a note to run a skill *on the highlighted text*. The skill receives the current file and the selection, and edits that file in place by default unless the skill says otherwise — handy for "rewrite this passage", "translate this", or "clean up this section".


Pin a skill to the ribbon to create a one-click launcher with its own Lucide icon; pinning also registers a **command-palette** command, so the same skill is reachable by keyboard. This is helpful for automation skills like setting up your daily note with meetings from your calendar.

### Headless or terminal

Each skill runs one of two ways, set globally or per skill. *Headless* spawns the run in the background and surfaces progress through notices and the Sessions tab. *Terminal* runs the identical command visibly in your preferred terminal so you can watch and interact. There is an option to add 3rd party terminals but this feature is still being developed.

---

## 4. Harnesses

A harness is the command that executes a skill — usually via CLI. The plugin substitutes the skill's prompt into a command template and runs it with no shell, so the invocation is inert and safe. Omnigent, ucode, claude, opencode and codex are common options, but as this is triggering a command in your CLI this should work with nearly every harness.

A custom harness is a name plus a one-line command whose first token is the absolute path to a binary and which contains a `{prompt}` placeholder — for example:

```
/opt/homebrew/bin/claude -p {prompt}
```

The same shape covers wrappers and gateways. A ucode harness, for instance, forwards to the underlying tool's own non-interactive form:

```
/Users/me/.local/bin/ucode claude -p {prompt}
/Users/me/.local/bin/ucode codex exec {prompt}
```


---

## 5. Agents

On top of the harness, a skill can pin an agent so it runs as a specific persona or is scoped to discover and use only a specific set of skills. currently this plugin supports Claude and Omnigent Agent configurations.

**Claude sub-agents** — when a skill's harness is a Claude-based custom harness, a `.claude/agents/*.md` sub-agent can be selected and is substituted into the harness command's `{agent}` token.

Discovered agents appear in the **Agents** tab, and the per-skill agent selector lives in each skill's configuration panel.


---

## Requirements

Desktop only and MacOS Only for now — the plugin scans folders and launches local CLIs. Launching a skill needs whatever harness you use to be configured on your machine and added to the skill and harness manager.
