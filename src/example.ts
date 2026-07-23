// The bundled example skill. Because a plugin release ships only main.js /
// manifest.json / styles.css, the example SKILL.md can't be shipped as a file —
// instead the plugin writes this content into the vault on first run (see
// `seedExampleSkill` in main.ts), so a new user immediately has one real,
// browsable, taggable skill to learn from. Kept as a plain string constant (no
// Obsidian imports) so it can be referenced anywhere.

/** Vault-relative path the example skill is written to (a default scan root). */
export const EXAMPLE_SKILL_REL_PATH =
  ".agents/skills/hello-skill-harness-manager/SKILL.md";

/** The example skill's SKILL.md content: frontmatter (name/description/tags) + a body. */
export const EXAMPLE_SKILL_BODY = `---
name: hello-skill-harness-manager
description: An example skill that ships with the Skill and Harness Manager plugin — shows how skills are discovered, tagged, and launched. Safe to edit or delete.
tags:
  - example
---

# Hello from Skill and Harness Manager

This is an **example skill** that the plugin created for you the first time it
ran. It lives at \`.agents/skills/hello-skill-harness-manager/SKILL.md\` and is
here so you have something real to explore. Editing or deleting it is safe — the
plugin will not recreate it.

## What a skill is

A skill is a Markdown file named \`SKILL.md\` with a \`name\` and \`description\`
in its frontmatter (like the block at the top of this file), or any Markdown file
directly inside a \`skills/\` folder. The plugin scans your vault's tool folders
(\`.claude/\`, \`.codex/\`, \`.cursor/\`, \`.agents/\`, …) and lists everything it
finds in the **Skills** browser.

## Things to try

- **Run it** — click **Run skill** on this row. You can add optional extra
  instructions in the box before running.
- **Choose how it runs** — open the ⚙ **Configure** panel to pick a launch mode:
  *headless* (runs in the background) or *terminal* (runs the same command in a
  terminal window). Set the global default and your preferred terminal (Terminal,
  Ghostty, kitty, tmux, …) in the plugin's settings.
- **Pin it to the ribbon** — from ⚙ Configure, add it to the ribbon for one-click
  launch, and give it a custom icon.
- **Right-click a file** — enable the right-click menu (⚙ Configure) and you can
  run a skill against any file in your vault.
- **Tag and filter** — this skill carries the \`#example\` tag. Use the tag filter
  at the top of the Skills tab to find it, and add your own tags with **+ tag**.

When you write your own skills, drop a \`SKILL.md\` into any of the scanned
folders and it will appear here automatically.
`;
