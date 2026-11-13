# Replicating the review pipeline

Agent Watchtower only reads what Claude Code writes to its transcripts, so what shows up on screen depends on **which app you use Claude Code in and how it is configured**. This guide replicates the development/review setup Watchtower was built with. Follow it and you get the same screen as the screenshots: advisor panel, critic subagent cards and so on.

[한국어](SETUP.ko.md)

## Screen elements and what they need

| On screen | Recorded as | Needs |
|---|---|---|
| Session title | `custom-title` / `agent-name` (desktop app), `ai-title` (VS Code) | Desktop app or the VS Code extension |
| Advisor panel, `--advisor` in the status line | `advisorModel` field, `advisor` server tool calls | `advisorModel` in `settings.json` |
| Subagent cards and progress | `subagents/agent-*.jsonl`, `.meta.json` | Subagent definitions (`critic`, `scout`) and a rule that calls them |
| Effort bars | `effort` field | Recorded by default; change it with `effortLevel` |
| Cost | `cost-state` lines | Desktop app or the VS Code extension |
| Bookkeeping calls left out of the decision layer | `update_plan`, `wrap_up` (desktop app), `TodoWrite` (terminal), `ToolSearch` | Nothing to do |

The advisor panel is hidden for sessions that do not use an advisor, and cost only appears when it is recorded. A missing piece never breaks the screen.

## 1. Prerequisites

- The **Code tab in the Claude desktop app** (recommended; what Watchtower was built with) or the **Claude Code extension for VS Code**.
- Claude Code **2.1.317 or newer**. The app and the extension ship their own version. The developer's transcripts were checked on 2.1.317–2.1.321.
- Node.js 22 or newer, to run Watchtower.

## 2. One command

```bash
npx agent-watchtower setup
```

This only shows what it would add; nothing is changed. After reviewing it:

```bash
npx agent-watchtower setup --yes
```

What it does:

- Adds `~/.claude/agents/critic.md` and `~/.claude/agents/scout.md`. If a file with the same name exists (even a symlink), it is skipped.
- Appends a "review with critic before reporting done" rule to `~/.claude/CLAUDE.md`, between marker comments. Skipped if this command added it before. If you already wrote a similar rule by hand, remove one of the two afterwards.
- Adds `"advisorModel": "opus"` to `~/.claude/settings.json`. An existing value is kept, and a backup is written before the file is changed.

It honors `CLAUDE_CONFIG_DIR`. The rule is written in Korean if your system language is Korean and in English otherwise (`--lang=en` / `--lang=ko` to choose). Restart Claude Code or open a new session afterwards.

## 3. By hand (same result)

### Advisor

`~/.claude/settings.json`:

```json
{
  "advisorModel": "opus"
}
```

The advisor lets a stronger model review the work as it goes. It may not be available on every account or plan; if it is not, no consults are recorded and the advisor panel stays hidden. (Not verified on accounts other than the developer's.)

### Subagents

`~/.claude/agents/critic.md` reviews work before it is called done: see [`setup/en/critic.md`](../setup/en/critic.md).
`~/.claude/agents/scout.md` only finds where code is: see [`setup/en/scout.md`](../setup/en/scout.md).

### Global rule

Add the three lines in [`setup/en/CLAUDE.md`](../setup/en/CLAUDE.md) to `~/.claude/CLAUDE.md`. This rule is what makes the main session launch a critic subagent before finishing, which is the card you see in Watchtower.

## 4. Optional: model and guard rails

These are not applied automatically because they depend on taste and plan.

```json
{
  "model": "opus",
  "effortLevel": "medium",
  "permissions": {
    "deny": [
      "Bash(sudo rm:*)",
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(git reset --hard:*)",
      "Bash(git clean -fd:*)"
    ]
  }
}
```

- `model`, `effortLevel`: the developer defaults to Opus with medium effort (high per model).
- `permissions.deny`: part of a list that blocks hard-to-undo commands.

## 5. Check it

1. Give Claude Code a task that changes code.
2. In another terminal, run `npx agent-watchtower`.
3. Near the end of the task a `critic` subagent card appears in the flow chart, and on accounts with the advisor, the advisor panel shows on the left with a consult count.

## Not replicated

- **Permission allow lists**: the developer's list is tailored to their own projects and tools.
- **Personal plugins and MCP servers**: they do not affect Watchtower.
