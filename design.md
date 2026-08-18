# todo-stack design

## Purpose

todo-stack gives one DSH agent a persistent task tree and one focus pointer.
The focus-to-root ancestor path is the stack. The tree records work structure;
the focus records where the agent is working now.

## State

- Each node has a stable id, title, parent, ordered children, and lifecycle
  status: `pending`, `completed`, or `dropped`.
- `in_progress` is not stored. The single `focusId` is the execution pointer.
- Parent progress is derived from descendants rather than stored separately.
- Completed and dropped nodes remain in the tree; the MVP does not hard-delete
  task history.
- Every accepted mutation increments a compare-and-set `revision`.

## Stack operations

- `push`: create a child below the focus and focus it. With no focus, create a
  root.
- `exit`: move focus to the parent without changing lifecycle status.
- `complete`: complete the focus and move to its parent. Pending descendants
  make completion fail.
- `focus`: enter an existing pending node.

`add`, `rename`, `move`, `drop`, and `reopen` maintain the surrounding tree.
Dropping a subtree marks every non-completed node in it dropped. Reopening is
top-down: ancestors must already be pending.

## Persistence

The canonical mutation record is a whole-state snapshot. DSH rc.7 does not
provide a downstream event-type registration API, and its persistence reader
refuses unknown unmarked events. Therefore the MVP carries its namespaced
snapshot in the already-known log-only `todo/write` event:

```ts
{
  todos: TodoItem[],
  todoStack: {
    kind: "dsh-plugin-todo-stack",
    version: 1,
    operation: TodoStackOperation,
    state: TodoStackState
  }
}
```

This is a compatibility carrier, not a dependency on
`@deepseek-ai/dsh-tool-todo`. The plugin owns both model tools and both
projections. If DSH gains third-party event registration, the envelope can move
unchanged to `todo-stack/change`.

## Model context

Every prompt assembly receives only the revision, focus breadcrumb, immediate
children, and global counts. The complete tree is read lazily with
`get_todo_stack`; it is not injected into every request.

The prompt asks the agent to decompose as useful work appears, rather than
building a speculative exhaustive plan. `complete` means verified completion;
`exit` means suspension; `drop` records an abandoned branch.

## Scope

State belongs to one agent session. A session fork inherits its prefix and then
diverges independently. Shared multi-agent ownership, claims, leases,
dependencies, priorities, scheduling, and a dedicated tree UI are outside the
MVP.

