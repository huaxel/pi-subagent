# Pi Subagent

Observable, persistent Pi subagents for independent reviews, investigations, and delegated implementation.

Each subagent runs in its own Herdr pane with a dedicated Pi JSONL session. The parent can inspect status, wait for durable results, steer active work, queue follow-ups, or attach directly to the child TUI.

## Requirements

- Pi
- Node.js 22.19 or newer
- Herdr (run Pi inside a Herdr-managed pane)
- Linux with `flock` (this local fork’s lock/process-identity backend)

## Install

This local fork lives at `~/projects/pi-extensions/pi-subagent`. Add its absolute
path to `packages` in Pi settings and put `subagent.ts` on PATH as `subagent`.
No npm install or tmux is required.

Run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

## Usage

Spawn with a descriptive name using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

Names appear in the parent UI. Generated handles remain the stable identifiers used by management commands.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Manage a run by its generated handle:

```sh
subagent status a1b2c3
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent stop a1b2c3
subagent list
```

Use `/subagent` to select and focus an active child’s Herdr pane. The status widget shows active names (or handles for unnamed runs) and their current state.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery while retaining the control bridge
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill. Children survive `/reload`. When their spawning Pi session quits or is replaced, running children are suspended: the process stops, but transcript and metadata are kept. Reopening the parent restores bookkeeping without relaunching helpers; resume each retained conversation explicitly. `subagent stop` closes the task-owned pane and retains the transcript and metadata. `subagent resume <handle>` reopens the retained session idle. `subagent purge <handle> --confirm` permanently deletes a stopped run; use only with explicit human authorization.

## Local fork scope

Based on https://github.com/badlogic/pi-subagent (upstream remote remains `origin`).
The `herdr-local` branch replaces the tmux transport with sibling Herdr panes,
uses returned opaque pane IDs, preserves UI focus on spawn, and verifies child
session ownership before closing. No profile catalogue or routing policy is added.
Per-task provider/model/thinking overrides and the upstream inbox bridge remain.

Runs live under `$PI_CODING_AGENT_DIR/subagents-herdr` (or `~/.pi/agent/subagents-herdr`),
separate from upstream tmux runs. Released runs remain in `list`; `/subagent` shows
live conversations only. Parent shutdown suspends live children without deleting
history; reopening that parent does not relaunch them automatically. Explicitly stopped children
stay stopped until `resume`.

### Checks

```sh
node --test test/*.test.ts
deno check --node-modules-dir=auto subagent.ts shared.ts herdr.ts
```

### Trial rollback

Remove the local package from Pi settings; re-enable the existing
`npm:@howaboua/pi-shepherdr` entry by removing its empty resource filters, then run
`/reload`. Stop trial-owned workers first; their transcripts remain available.
The local fork and CLI can remain on disk without being loaded.

Management commands require the owning `PI_SESSION_ID`, normally injected into
Pi’s bash tool. Cross-session mutation is refused; direct shell invocations must
explicitly set that parent identity. Metadata paths are validated before deletion.

Ownership normally uses Herdr's reported Pi session path. Isolated children with
`--no-extensions` use the bridge PID plus Linux process start ticks, checked
against the pane's foreground process. This fallback is Linux-only; other
platforms require Herdr session reporting. Launch waits for bridge registration
before returning. The parent widget polls asynchronously so a slow Herdr response
does not block the editor.

## Assignment and recovery semantics

`spawn` and `send` return a durable assignment ID. `wait <handle>` waits for the
assignment current when invoked, not just an idle worker or its latest old answer.
Use `wait <handle> --task <id>` to retrieve a specific earlier result. Resuming
clears the current assignment: it opens idle and `wait` requires a new task or
an explicit ID. Text files passed with `--file` are included in the tagged input.

Pending/submitted messages are retained as **held** on stop/resume or detected
parent loss. `subagent pending <handle>` displays them, including migrated legacy
inbox files. They never replay automatically; explicitly send any work you want
to restart. Acceptance/completion use tagged user inputs and persisted response
IDs on the active transcript branch. Steering inputs combined into one turn can
share that turn's response; separate follow-up turns retain separate answers.

Parents receive completion and attention messages asynchronously (including RPC
mode), with full transcript paths. Notification delivery is at-least-once around
crashes; a task ID allows deduplication. Metadata writes and lifecycle actions use
kernel-released `flock` locks; old child generations cannot overwrite a new one.
Unexpected process loss/replaced panes surface as attention with held assignments.
Orphaned conversations are not automatically killed: inspect and release them
when safe. Ownership uncertainty never authorizes closing another conversation.

If a human replaces a child’s session, the original transcript reference stays
immutable and pending assignments are held. A failed stop clears its coordination
freeze and exposes attention. `subagent detach <handle>` can release bookkeeping
for a provably foreign or missing pane without closing it; ambiguous ownership is
refused. Resume/stop/purge all require fresh metadata under one lifecycle lock.
