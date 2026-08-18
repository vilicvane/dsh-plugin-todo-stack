# dsh-plugin-todo-stack

A persistent tree-shaped todo stack for DeepSeek Harness agents. The plugin
keeps one task tree per session and exposes a single focus path through it.

## Tools

- `get_todo_stack` reads all roots or a depth-limited subtree and returns the
  current revision and focus path.
- `update_todo_stack` applies one revision-guarded action: `push`, `add`,
  `focus`, `exit`, `complete`, `edit`, `move`, `drop`, or `reopen`.

Each node carries one short core-task anchor in `content`, preferably a concise
outcome phrase. It is not a plan, progress log, evidence store, notes field, or
handoff narrative. There is no separate title, description, details, or notes
layer. `edit` replaces that anchor and does not change the node id, focus,
lifecycle, parent, or sibling order.

`push` descends into newly created work. `exit` returns without claiming the
work is done. `complete` finishes the current focus only when no pending work
remains below it.

The model guidance is intentionally short: during the opening turn, create and
focus a root for work that needs multiple steps or tool calls, using revision
`0` when no todo context exists. The opening reminder is a transient system
section rather than a durable transcript snapshot. Keep nodes to one outcome,
and add a focused direct child
for the next distinct multi-action piece unless the current task is nearly done
or has no useful child. A useful hierarchy of short tasks helps the user see
what the agent is doing and how the work is progressing. Completion is recorded
after verification; detailed working context stays in the conversation and
workspace.

New nodes receive compact stable ids (`t1`, `t2`, ...). Existing sessions keep
their canonical legacy ids, but model-facing views expose a unique short
prefix that the tools accept directly.

## DSH integration

The plugin registers:

- the two model tools;
- a persistent `todoStack` session projection;
- a Web `TodoStackDock` that renders the hierarchy, current focus, and node
  lifecycle without encoding UI markers into task titles;
- a flattened persistent `todos` projection retained as a compatibility
  fallback for clients without the custom dock;
- dynamic model context containing only the active branch and its current
  working level;
- one short direct-child instruction appended to todo-stack tool results;
- one-request dynamic branch reminders at each 30-node open-turn milestone.

It does not depend on or load `@deepseek-ai/dsh-tool-todo`. Keep the stock
`tool-todo` loader entry disabled so it does not register a competing `todos`
projection or expose conflicting model instructions.

## Install for local development

```sh
dsh plugin --profile web add link:/home/vilicvane/projects/vilicvane/dsh-plugins/todo-stack
```

Add the plugin to the profile patch:

```yaml
- id: tool-todo
  disabled: true

- insert:
    - id: todo-stack
      name: dsh-plugin-todo-stack
      config:
        maxNodes: 200
        maxReadNodes: 80
        contextChildren: 8
        todoDock: true
        reminderIntervalNodes: 30
```

Restart the DSH profile after installation or patch changes.

The browser entry is prebuilt as `client.js`, so installing directly from the
Git repository does not require a client build toolchain. When changing
`client/index.ts` locally, regenerate it with:

```sh
pnpm build:client
```

`pnpm check` verifies that the committed browser bundle is current.

## End-to-end test

The repeatable E2E workflow uses an isolated `test-todo-stack` profile and a
real model/tool loop. It checks mutations across multiple turns, runtime
context refreshes, both projections, and two cold session resumes:

```sh
pnpm e2e
```

The script writes a compact diagnostic artifact under `.tmp/` and prints its
path together with the persisted session id.

## Configuration

| Setting | Default | Meaning |
| --- | ---: | --- |
| `maxNodes` | `200` | Maximum retained nodes in one session tree. |
| `maxReadNodes` | `80` | Maximum nodes returned by one read. |
| `contextChildren` | `8` | Immediate children included in runtime context. |
| `todoDock` | `true` | Publish the flattened `todos` compatibility projection. The custom Web dock reads `todoStack` directly. |
| `reminderIntervalNodes` | `30` | Open-turn surface-node interval for optional current-branch maintenance reminders. |

See [design.md](./design.md) for state semantics and the rc.7 persistence
carrier rationale.
