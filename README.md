# dsh-plugin-todo-stack

A persistent tree-shaped todo stack for DeepSeek Harness agents. The plugin
keeps one task tree per session and exposes a single focus path through it.

## Tools

- `get_todo_stack` reads all roots or a depth-limited subtree and returns the
  current revision and focus path.
- `update_todo_stack` applies one revision-guarded action: `push`, `add`,
  `focus`, `exit`, `complete`, `rename`, `move`, `drop`, or `reopen`.

`push` descends into newly created work. `exit` returns without claiming the
work is done. `complete` finishes the current focus only when no pending work
remains below it.

## DSH integration

The plugin registers:

- the two model tools;
- a persistent `todoStack` session projection;
- a flattened persistent `todos` projection consumed by the stock Web
  TodoDock;
- dynamic model context containing the focus breadcrumb and immediate
  children.

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
```

Restart the DSH profile after installation or patch changes.

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
| `todoDock` | `true` | Publish the flattened stock-UI projection. |

See [design.md](./design.md) for state semantics and the rc.7 persistence
carrier rationale.
