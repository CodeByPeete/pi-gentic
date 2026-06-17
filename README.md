# pi-gentic

`pi-gentic` is a Pi extension for orchestrating work across durable agent sessions. It lets you hand a session to a named agent, send work to child or existing sessions, inspect nearby orchestration sessions, and receive results back in the original conversation.

It is designed for people who want Pi to behave like a small team of focused collaborators while keeping every collaborator inside normal Pi sessions.

## What it gives you

| Surface | Purpose |
| --- | --- |
| `/agent` | Load, clear, or inspect the active agent for a session. |
| `/send` | Send a task to a new child session or an existing session. |
| `agents` tool | Let the model list agents, inspect status, delegate work, and discover related sessions through one JSON tool. |
| `/orchestration-tree` | View nearby parent and child sessions in a compact tree. |

## Why it is useful

Pi sessions are already durable. `pi-gentic` adds coordination on top of them:

```text
Main session
├─ Research agent: gathers context
├─ Reviewer agent: checks edge cases
└─ Builder agent: implements a scoped change
```

The original session can keep planning while other sessions work. When a delegated session finishes, its final answer is returned as context.

## Key features

- Agent handoff with `/agent <name>`.
- Foreground and background delegation with `/send`.
- Delegation to existing sessions with fast `--session` autocomplete.
- Session suggestions enriched with agent names and recent messages.
- Runtime override flags for models, thinking level, tools, agents, skills, themes, system prompt files, and subagent depth.
- Git worktree support through `/send --worktree` and the `agents` tool.
- A model-callable `agents` tool for structured orchestration.
- A live orchestration tree for navigating related sessions.
- Durable status cards that survive reopening sessions.

## Requirements

- Pi with package support.
- Node.js compatible with your Pi installation.
- Git, if you use the worktree features.

The package imports Pi runtime libraries as peer dependencies, which matches Pi package guidance for distributed extensions.

## Installation

Install from npm after publication:

```bash
pi install pi-gentic
```

Install from a git repository:

```bash
pi install git+https://github.com/<owner>/pi-gentic.git#<tag-or-commit>
```

Install from a local checkout while developing:

```bash
pi install ./path/to/pi-gentic
```

After installation, restart Pi or run Pi's reload command if your setup supports hot reloading trusted local extensions.

## Configuration

`pi-gentic` looks for configuration in user and project scopes. Later sources override earlier sources.

| Order | Location |
| ---: | --- |
| 1 | `~/.pi/agent/extensions/pi-gentic/settings.json` |
| 2 | `~/.pi/agent/extensions/pi-gentic/agents/*.md` |
| 3 | `<workspace>/.pi/extensions/pi-gentic/settings.json` |
| 4 | `<workspace>/.pi/extensions/pi-gentic/agents/*.md` |

### Example agent definition

Create a markdown file such as `.pi/extensions/pi-gentic/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Reviews changes, edge cases, and risks.
tools:
  - read
  - grep
  - bash
---

Review the requested change for correctness, maintainability, and missed cases.
Return concise findings with evidence.
```

## Commands

### `/agent`

```text
/agent [agentName] [--session <sessionId>]
```

Examples:

```text
/agent reviewer
/agent clear
/agent reviewer --session 019ed682
```

### `/send`

```text
/send <message> [--agent <name>] [--session <id>] [--fork] [--bg|--fg] [--no-invoke] [--cwd <dir>] [--worktree [branch]] [override flags]
```

Examples:

```text
/send Check this plan for edge cases --agent reviewer --bg
/send Continue the previous investigation --session 019ed682
/send Implement the parser cleanup --agent builder --worktree parser-cleanup
```

Useful override flags:

```text
--model <provider/model>
--thinking <low|medium|high>
--tools <filter,list>
--agents <filter,list>
--skills <filter,list>
--theme <name>
--system-prompt-files <filter,list>
--max-subagent-depth <number>
```

### `/orchestration-tree`

Shows a compact tree of nearby orchestration sessions, including agent names, recent messages, running state, and short session ids.

## Model tool

The extension registers one model-callable tool named `agents`.

Common actions:

| Action | Purpose |
| --- | --- |
| `list` | List available agents. |
| `get` | Show one agent definition. |
| `load` | Load or clear an agent in a session. |
| `send` | Delegate a message to a child or existing session. |
| `status` | Inspect a session. |
| `abort` | Stop a session run. |
| `discoverSessions` | Return nearby orchestration sessions. |

Example:

```json
{
  "action": "send",
  "agent": "reviewer",
  "message": "Review this implementation for regressions.",
  "async": true
}
```

## Worktree support

When `worktree` is set, `pi-gentic` prepares a git worktree before creating or using the target session.

```text
/send Build the migration --agent builder --worktree migration-builder
```

If `--cwd` is supplied, it is used as the worktree folder. If `--cwd` is omitted, `pi-gentic` creates a generated folder under:

```text
.agentfiles/worktrees/<generated-name>
```

Generated names are instructed to stay at 3 words max.

## Package structure

```text
pi-gentic/
├─ src/                 TypeScript source for the Pi extension
├─ test/                Node test suite
├─ test-ui/             UI rendering captures
├─ test-e2e/            terminal E2E captures
├─ dist/                build output created by npm run build
├─ package.json         npm and Pi package manifest
└─ tsconfig.json        TypeScript configuration
```

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run typecheck
npm test
npm run test:ui
npm run test:e2e
```

Build the package:

```bash
npm run build
```

Preview what npm would publish:

```bash
npm pack --dry-run
```

## Publishing readiness

`pi-gentic` is packaged as a standard npm or git-distributed Pi package:

- `package.json` contains a `pi.extensions` manifest.
- `exports` points to the compiled extension entrypoint.
- `files` limits the npm package to runtime output and documentation.
- The `pi-package` keyword makes the package discoverable by Pi package tooling and galleries.
- Pi runtime libraries are declared as peer dependencies.

Publish through normal npm or git release workflows after choosing a package name, repository URL, and versioning policy.

## Security note

Pi packages run inside your Pi environment and can register tools and commands. Review third-party packages before installing them.

## License

MIT
