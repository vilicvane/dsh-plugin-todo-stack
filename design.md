# todo-stack design

## Purpose

Todo Stack is a persistent task-focus anchor, not a general task database. Its
tree preserves the structure of substantive work across compacted turns and
sessions and exposes that structure to the user. One focused leaf records the
agent's current point of attention.

Nodes contain only a short task outcome and any constraint required to
distinguish it. Plans, progress, findings, evidence, commands, file notes, and
handoff narration remain in the conversation or workspace. A useful tree may
be deep; brevity applies to each node, not to the hierarchy.

## State and invariants

Each node has a stable id, `content`, parent, ordered children, and a lifecycle
status. New writes use `pending` and `completed`; `dropped` remains readable for
legacy sessions.

- New ids are short session-local references (`t1`, `t2`, ...). Legacy ids are
  addressed through a unique displayed prefix; exact ids still work.
- `focusId` is either null or points to one pending leaf.
- A pending tree may temporarily have no focus between deliberate operations.
- A terminal node cannot contain a pending descendant.
- Parent progress is derived from descendants rather than stored separately.
- Completed nodes remain as history. Deletion physically removes an entire
  subtree and is not recoverable.
- Every accepted mutation writes the next revision. Revisions serialize
  durable snapshots internally; model tools do not expose compare-and-set
  arguments.

## Operations

`create` appends one ordered root group only when no pending work exists. Its
first node becomes focus. Optional remaining roots are independent top-level
outcomes; steps of the first goal belong below it. It works on an empty tree
and after previous work has ended, preserving terminal history.

`expand` decomposes the current focused leaf into ordered direct children. The
first child becomes focus. Restricting expansion to the current focus makes it
the explicit operation for diving deeper into active work.

`push` appends one child below an identified pending parent. It preserves the
existing focus by default or focuses the new child atomically. An unfocused
push below the focused leaf is invalid because the old focus would cease to be
a leaf; the error directs the agent to `todo_stack__expand`.

`focus` selects an existing pending leaf. `complete` marks an identified node
complete only after all descendants are terminal. Completing the focused node
clears focus. `delete` removes an identified subtree and clears focus if it was
inside that subtree. `edit` replaces only one node's `content`.

The plugin never guesses a successor focus. If work continues after focus is
cleared, the agent chooses an appropriate pending leaf or creates new focused
work. This preserves the semantic difference between finishing one branch and
deciding what matters next.

## Persistence

The canonical mutation record is a whole-state snapshot carried by the known
log-only `todo/write` event:

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

The `todos` field is a compatibility projection carrier, not a dependency on
`@deepseek-ai/dsh-tool-todo`. Folding validates that revisions are contiguous
and every snapshot satisfies the tree invariants.

Early snapshots using `title` and `rename` normalize at the read boundary to
`content` and `edit`. Legacy non-leaf focus is moved to its first pending leaf.
Existing explicit null focus is preserved because it now has deliberate
semantics.

## Model context

The static prompt is a first-person working contract. It explains why the tree
exists, keeps node contents brief, requires a meaningful leaf focus during
substantive work, and distinguishes deeper current work from deferred work.
The opening section adds a concrete deep-tree example and permits skipping the
stack only for an immediate non-substantive answer.

At turn start, the agent receives a focus-local tree view. Ancestors show only
the active branch. At the frontier, a branch focus exposes its direct children;
a leaf focus exposes its siblings. Pending nodes use `[ ]`, the focused leaf
uses `[*]`, and completed nodes use `[x]`. The view is bounded but always
retains the focus path.

That injected view remains frozen until the first Todo Stack mutation in the
turn and then clears. Each mutation result carries the current live branch, so
Todo Stack calls do not continually append fresh dynamic context snapshots.
The complete tree is loaded explicitly with `todo_stack__show`. Completing a
todo is the exception to the ordinary focus-local mutation result: because
completion may clear focus, its result shows the affected node's ancestor path
and every sibling, including the completed node, so the agent can choose the
next focus without an intermediate `show` call.

The `create` result also carries one short first-person granularity check. It
asks the agent to expand before another tool only when the new root contains at
least two independent outcomes, and explicitly excludes single tool calls,
arguments, and final-answer requirements from becoming child todos. Limiting
this reflection to `create` avoids over-decomposing an already precise leaf
selected later with `focus`.

Two dynamic reflections reinforce the contract without competing inside a
long turn:

1. At the first model request of each later turn with a focus, a one-request
   first-person reflection asks whether the focus still matches the next
   concrete work, whether the active branch should deepen, and whether newly
   identified later work should be recorded. The reflection is never injected
   after work has already begun in that turn.
2. Whenever focus is null, a first-person guard follows each eligible
   model-visible node. It asks the agent to choose a pending leaf or create new
   work before continuing, while allowing no focus during a final wrap-up.

The turn-start reflection is recorded once in that turn's runtime-context
snapshot. The no-focus marker includes the latest eligible surface sequence,
so ignoring one reminder does not suppress later reminders. Runtime
system-prompt snapshots are excluded from no-focus trigger selection,
preventing self-recursion. Opening guidance suppresses the redundant first
no-focus guard, and null focus suppresses the less specific turn-start
reflection.

Maintenance pressure is intentionally asymmetric. The agent proactively keeps
its current branch and remembered later work synchronized, but does not polish
unrelated ancestors or siblings without a real semantic change. This keeps the
tree useful as an anchor rather than turning it into a detailed speculative
plan.

## Web surface

The plugin contributes a `conversation.input.dock` entry under the standard
`todo` cell. Its lower slot priority shadows the stock flat TodoDock when both
are installed without removing the flattened compatibility projection.

The custom dock consumes `todoStack` directly. Tree depth is layout metadata;
focus and lifecycle are separate visual states. It uses host semantic color and
composer geometry tokens so it follows the DSH theme.

## Scope

State belongs to one agent session. A session fork inherits its prefix and then
diverges independently. Shared multi-agent ownership, claims, leases,
dependencies, priorities, scheduling, and rich task notes remain out of scope.
