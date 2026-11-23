---
name: subagent
description: Spawn and communicate with observable Pi subagents for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Use the `subagent` CLI to delegate work to a separate Pi process with its own context and Herdr pane. Managed subagents cannot spawn nested subagents, and this skill is not loaded into their sessions. Use these primitives instead of Shepherdr during this local trial. Delegate only when useful; no profiles are required. Give implementation writers dedicated worktrees with `--cwd`.

## Spawn

Give each child a short, descriptive name. The name appears in the parent UI, while the generated handle remains its stable identifier:

```sh
subagent spawn --name implementation --prompt "Complete task"
```

By default, the child inherits the current Pi provider, model, and reasoning level from the bash environment. Use `--provider`, `--model`, or `--thinking` only when deliberately choosing a different configuration, for example a faster model for simple investigation or a stronger model for difficult review. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back to the CLI explicitly.

`--cwd` defaults to the current directory. Repeat `--prompt` and `--file` as needed; Pi receives all of them in the first user turn. Run `subagent spawn` directly without piping or redirecting its concise output.

## Tools

Without `--tools`, Pi enables its four default tools:

- `read` - Read text files and images.
- `bash` - Execute shell commands. This can also modify files, so it is not a read-only capability.
- `edit` - Apply exact text replacements to existing files.
- `write` - Create or overwrite files.

Three additional built-in tools are available but off by default:

- `grep` - Search file contents.
- `find` - Find files by glob pattern.
- `ls` - List directory contents.

`--tools` is a comma-separated allowlist across built-in, extension, and custom tools. Common choices:

```sh
# Enforced read-only repository investigation
--tools read,grep,find,ls

# Investigation that may run tests or other commands; bash can modify files
--tools read,bash,grep,find,ls

# Implementation work: omit --tools to use the defaults
```

## Isolation flags

- `--no-extensions` - Disable normal extension discovery. Use for an independent run that should not inherit unrelated extension behavior or extension-provided tools. The subagent control bridge is still explicitly loaded. **Provider caveat:** it also disables extensions that *provide* the inherited provider. If the current Pi session's provider is extension-provided (e.g. `openference`), the child cannot resolve it and the spawn fails fast (sub-second) with the real cause. In that case drop `--no-extensions` and isolate with a `--tools` allowlist instead — a read-only tool list is usually the isolation that actually matters. Spawn's preflight probes exact provider resolvability (same provider, model, and `--no-extensions`) before starting the child, so this failure mode is caught instantly rather than surfacing as a generic startup timeout.
- `--no-skills` - Hide installed skills from the child. Use for tightly specified tasks that should rely only on the supplied prompt and files.
- `--no-prompt-templates` - Disable prompt-template commands. Usually unnecessary, but useful when testing a minimal child environment.
- `--no-context-files` - Ignore repository instruction files such as `AGENTS.md` and `CLAUDE.md`. Use only when those instructions would bias an independent investigation. Do not use for implementation unless intentionally bypassing repository guidance.

Spawn prints a random handle and the Herdr pane ID. Keep the handle for later commands. Subagents persist after their current turn completes: `wait`, completion, and becoming idle do not terminate them. They survive `/reload`. When the spawning Pi session quits or is replaced, they are suspended with their history retained. Reopening the parent does not relaunch them; resume explicitly. `subagent stop` releases the pane but retains the transcript and metadata. Reopen it with `subagent resume <handle>`. Only an explicitly authorized `subagent purge <handle> --confirm` deletes history.

## Inspect and wait

```sh
subagent status <handle>
subagent list
subagent wait <handle>
```

Run `subagent list` at any time to rediscover active subagents and their handles, names, and current states if you no longer remember them.

`wait` follows the durable session state and prints the latest final assistant response. Each spawn/send prints an assignment ID. `wait` snapshots the current assignment and returns only its correlated result, not a previous idle-turn answer. Use `wait <handle> --task <id>` for an earlier result. Resume clears the current assignment. Run it directly so the bash tool returns that response; do not redirect it to a file or pipe it unless the user explicitly asks for an artifact. Do not infer completion from captured terminal text. Set the bash timeout above `wait`'s default 1800-second deadline.

## Communicate

```sh
# Change the name shown in the parent UI.
subagent rename <handle> "new name"

# Idle: starts a new prompt. Busy: steers the current work.
subagent send <handle> "message"

# Busy: waits until current work finishes, then starts another turn.
subagent send <handle> --follow-up "message"
```

Names are 1–64 characters and need not be unique. Messages use the subagent extension's control inbox; do not use raw terminal input for steering.

## Stop

```sh
subagent stop <handle>
```

Explicitly stop every subagent when it is no longer needed; do not leave completed subagents running idle. This closes only the task-owned Herdr pane and retains its transcript and metadata. Keep the human’s current participation and pending work in mind before stopping. Never stop a pre-existing agent. Keep an idle subagent alive only when concrete follow-up work is expected, then stop it afterward.

The interactive `/subagent` command lists active subagents spawned by the current Pi session. Selecting one focuses its Herdr pane so the human can inspect or participate in the real conversation. The parent remains visible in its own pane. Background spawning does not change focus. Do not overwrite human drafts; steering and follow-ups use the control inbox, not terminal input.

## Retained conversations

```sh
subagent resume <handle>
```

Resume opens a new sibling pane with the full retained history, idle. `list` includes released runs. `status` prints the transcript path. Do not automatically purge retained history. Only on explicit human authorization:

```sh
subagent purge <handle> --confirm
```

## Notifications and pending work

Completion and attention are pushed to the parent conversation; stay available
for human discussion instead of blocking on `wait` unless the result is needed
immediately. Notifications identify assignments and can repeat after a crash.

`subagent pending <handle>` displays retained queued/interrupted messages. Stop,
resume and detected parent loss hold pending work instead of silently replaying
it. Explicitly send a new assignment to restart desired work. Inspect recovery
warnings in `status`/`list`; never infer that a missing/replaced pane is safe to
close. There are no profiles or fleet policies.

If a worker's pane now hosts a different human conversation, do not close it.
`subagent detach <handle>` releases only retained bookkeeping when foreign/missing
identity is provable; then `resume` can open a new worker for the original history.
An uncertain ownership check is a blocker, not permission to close a pane.
