# Codebase architecture

Pi-gentic groups code by the part of the product it changes. A folder name answers the first question a maintainer usually has: agents, delegation, sessions, worktrees, Pi, or UI.

## Source tree

```text
src/
├─ extension.ts
├─ extension-runtime.ts
├─ settings.ts
├─ agents/
│  ├─ activation.ts
│  ├─ prompts.ts
│  ├─ skills.ts
│  └─ tool.ts
├─ delegation/
│  ├─ activity.ts
│  ├─ delivery.ts
│  ├─ runs.ts
│  └─ send.ts
├─ sessions/
│  ├─ catalog.ts
│  ├─ discovery.ts
│  ├─ manage.ts
│  └─ policy.ts
├─ worktrees/
│  ├─ git.ts
│  └─ manager.ts
├─ pi/
│  ├─ host.ts
│  ├─ input.ts
│  ├─ runtime.ts
│  ├─ sessions.ts
│  ├─ types.ts
│  └─ resume/
│     ├─ cache.ts
│     ├─ selector.ts
│     └─ worker.ts
├─ ui/
│  ├─ cards.ts
│  ├─ card-renderer.ts
│  ├─ commands.ts
│  ├─ completions.ts
│  └─ terminal.ts
└─ shared/
   ├─ diagnostics.ts
   └─ values.ts
```

## Root files

- `extension.ts` connects Pi lifecycle events to the feature modules. It is the published package entry.
- `extension-runtime.ts` owns the Effect runtime, runtime leases, service layers, and shutdown.
- `settings.ts` reads trusted settings and agent definitions. Every feature uses the same normalized result.

## Feature ownership

### Agents

- `activation.ts` owns the active agent saved in a session and applies its runtime policy.
- `prompts.ts` builds system prompts and manual skill prompts.
- `skills.ts` asks Pi to discover skills and loads the selected skill instructions.
- `tool.ts` defines, registers, renders, and executes the `agents` tool.

### Delegation

- `send.ts` runs one delegation from target selection through its final outcome.
- `delivery.ts` transfers context and outcomes between sessions.
- `activity.ts` turns Pi progress events into the activity shown in cards and status output.
- `runs.ts` owns active delegation relationships, joined completion, cancellation, cycle checks, and local fibers.

### Sessions

- `catalog.ts` owns session identity, summaries, lineage, trees, lookup, and ordering.
- `discovery.ts` reads lightweight session information from disk.
- `manage.ts` creates, opens, inspects, aborts, and discovers sessions.
- `policy.ts` resolves resource filters and the effective policy for one session.

### Worktrees

- `manager.ts` validates worktree requests and creates or reuses safe Git worktrees.
- `git.ts` runs Git and owns its child process, metrics, timeout, and failure type.

### Pi

This folder contains every dependency on Pi's private implementation. Other folders may use the stable functions exported by these files. They must never load a private Pi file themselves.

- `runtime.ts` finds the installed Pi runtime and owns process-wide host state.
- `host.ts` validates required host methods and installs session-switching behavior.
- `sessions.ts` owns live Pi session runtimes and the visible session.
- `input.ts` owns Pi input hooks and input queued for a session transition.
- `types.ts` names the Pi values shared with the rest of pi-gentic.
- `resume/selector.ts` decorates Pi's native resume selector and installs the integration.
- `resume/cache.ts` keeps large session lists responsive and persists reusable metadata.
- `resume/worker.ts` loads large native session lists outside the terminal process.

### UI

- `commands.ts` parses and registers `/agent`, `/skill`, `/send`, and the agent-cycle shortcut.
- `completions.ts` captures completion context and returns command suggestions.
- `cards.ts` owns live cards, persisted card state, widgets, and repaint timing.
- `card-renderer.ts` renders normalized card data without owning card state.
- `terminal.ts` contains reusable terminal layout and startup diagnostics.

### Shared

- `values.ts` contains small value, path, and identifier helpers used by several features.
- `diagnostics.ts` stores bounded diagnostics and contains failures at stale host boundaries.

A helper belongs here only when at least two product areas use it and neither area owns the concept.

## State owners

Each mutable fact has one owner.

| State | Owner |
| --- | --- |
| Active agent and tool-policy cache | `agents/activation.ts` |
| Session identity graph | `sessions/catalog.ts` |
| Active delegations and their fibers | `delegation/runs.ts` |
| Live Pi sessions and visible session | `pi/sessions.ts` |
| Pi methods and diagnostics | `pi/runtime.ts` |
| Input waiting for a session transition | `pi/input.ts` |
| Live and persisted cards | `ui/cards.ts` |
| Effect runtime and leases | `extension-runtime.ts` |

Do not copy one owner's map into another module. Ask the owner for the current value.

## Dependency rules

- `extension.ts` composes features. Feature modules do not import it.
- `shared` imports no feature.
- `pi/runtime.ts` is the only file that loads private files from the installed Pi package.
- UI code may read feature results. Pure policy and session-catalog code do not import UI code.
- Relative imports must resolve directly to the file that owns the behavior. Forwarding `index.ts` files are forbidden.
- The source import graph must stay free of cycles.
- External data is checked when it enters through Pi, settings, JSONL, card persistence, or a child process. Internal functions receive named values.

`test/architecture.test.js` enforces the folder list, import resolution, private Pi boundary, forwarding-file rule, and import cycles.

## Where changes belong

| Change | Location |
| --- | --- |
| Add an agent setting | `settings.ts`, then `sessions/policy.ts` if it affects runtime policy |
| Change active-agent behavior | `agents/activation.ts` |
| Change the `agents` tool contract or action dispatch | `agents/tool.ts` |
| Change target selection or delegation lifecycle | `delegation/send.ts` |
| Change completion, cancellation, or cycle rules | `delegation/runs.ts` |
| Change session identity, trees, or lookup | `sessions/catalog.ts` |
| Change native session loading or switching | `pi/host.ts` or `pi/sessions.ts` |
| Change queued transition input | `pi/input.ts` |
| Change resume loading or display | `pi/resume/` |
| Change worktree safety or creation | `worktrees/manager.ts` |
| Change Git execution | `worktrees/git.ts` |
| Change a command | `ui/commands.ts` |
| Change card state or repainting | `ui/cards.ts` |
| Change card appearance | `ui/card-renderer.ts` |

## Tests

Node tests under `test/` mirror the source features. Effect tests under `test-effect/` cover Effect services and concurrency. `test-ui/` records renderer scenarios. `test-e2e/` drives the installed Pi terminal.

Tests observe feature entry points and persisted or rendered results. They do not require private helper exports. TypeScript checks both source and Effect tests, so moved or deleted contracts cannot leave stale test imports behind.
