# todo-stack design

## Purpose

todo-stack gives one DSH agent a persistent task tree and one focus pointer.
The focus-to-root ancestor path is the stack. The tree records work structure;
the focus records where the agent is working now.

## State

- Each node has a stable id, one `content` string, parent, ordered children, and lifecycle
  status: `pending`, `completed`, or `dropped`.
- `content` is a short, stable core task anchor, preferably one concise outcome
  phrase. It carries only the objective and any constraint required to
  distinguish that task. There is no title-versus-details distinction and no
  secondary description or notes field. Plans, progress, findings, evidence,
  commands, file-by-file notes, and handoff narration remain in the conversation
  or workspace rather than being copied into the tree.
- New ids are short session-local references (`t1`, `t2`, ...). Legacy ids
  remain canonical in restored sessions and are addressed through a unique
  displayed prefix; exact ids continue to work.
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

`add`, `edit`, `move`, `drop`, and `reopen` maintain the surrounding tree.
`edit` replaces only one node's `content`; structural and lifecycle changes use
their dedicated operations.
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

Early development sessions that persisted the same single content string as
`title` and recorded the corresponding operation as `rename` are normalized at
the read boundary to `content` and `edit`. New state, projections, and model
tools expose only the current vocabulary.

## Model context

Every prompt assembly receives a focus-local tree view rather than a tree
summary. Ancestors show only the active branch. At the working frontier, the
focus node's direct children are shown; when focus is a leaf, its siblings are
shown instead. Only a focused leaf carries the `（进行中）` annotation. Completing
or exiting work moves focus upward, so the next snapshot naturally exposes the
new level's siblings. A bounded window always retains the focused leaf.

Global counts and unrelated branches are omitted. The complete tree is read
lazily with `get_todo_stack`; it is not injected into every request. With no
focus, pending roots form the frontier; when no pending root remains, the
plugin contributes no todo runtime context.

The prompt is deliberately direct and short. Work beyond a direct answer or one
trivial action should have a focused task before execution. When the agent is
about to perform a distinct multi-action piece of focused work, it should add
and focus one direct child unless the current task will finish in the next few
actions or there is no distinct child worth tracking. Nodes remain short
outcome anchors, while a useful hierarchy helps the user understand the current
work and its progress. Details stay in conversation or workspace. Verified work
is completed, suspended work is exited, and unrelated siblings or ancestors
are left alone unless their state actually changes.

Two transient reminders reinforce that policy without changing persistent todo
state. Every todo-stack tool result directly appends one short instruction to
add and focus a child unless the focused task is nearly finished or has no
distinct child worth tracking; results from other tools contain no such text.
No dynamic system-prompt scan is involved. At 30, 60, 90, ... append-origin
model-visible nodes in an open turn, a one-request checkpoint asks whether the
agent thinks updating the current branch would make the work and progress
clearer to the user. Runtime system-prompt snapshots are not counted. Durable
named snapshot markers prevent the same node milestone from being announced
twice across ordinary steps or process restarts. Both reminder forms stay short
and keep working detail out of todo content.

This maintenance pressure is intentionally asymmetric. Capturing current work
is proactive; creating, editing, moving, or polishing siblings and ancestors
is not. Surrounding structure changes only when its objective, relationship, or
lifecycle genuinely changes, or when the user requests maintenance. This keeps
the tree small and outcome-oriented instead of growing a speculative exhaustive
plan. `complete` means verified completion; `exit` means suspension; `drop`
records an abandoned branch. Work completed in one immediate step needs no node.

## Web surface

The plugin contributes its own `conversation.input.dock` entry under the
standard `todo` cell. Its lower slot priority shadows the stock flat TodoDock
when both are installed, without removing the compatibility projection.

The custom dock consumes `todoStack` directly. Tree depth is layout metadata,
not node content; focus and lifecycle are separate visual states. It uses the
Web client's semantic color and composer geometry tokens so it follows the
host theme while retaining plugin-owned structure and styling.

## Scope

State belongs to one agent session. A session fork inherits its prefix and then
diverges independently. Shared multi-agent ownership, claims, leases,
dependencies, priorities, and scheduling are outside the MVP.
