# Todo Stack Tool Redesign

This file records the agreed tool redesign and the implementation choices made
while turning it into the first testable version.

## Decided

### Tool naming

Todo Stack tools use `todo_stack__<operation>` names so they remain grouped and
the namespace is visually separate from the operation.

Todo mutations are exposed as distinct tools rather than hidden behind one
generic tool's `action` enum. Besides giving each operation a precise schema and
description, the visible family of Todo Stack tools should make the capability
more salient to the agent.

### Focus invariant

- Focus may only point to a pending leaf node.
- A non-leaf node cannot be focused directly.
- While pending work remains, the agent must restore a meaningful focus before
  continuing substantive work. A mutation such as completing the focused node
  may leave a brief no-focus interval between tool calls so the agent can choose
  the next focus deliberately.

### No-focus guard

Focus is guarded across the active session, not only after Todo Stack tool
calls. After any eligible node where the plugin can insert a reminder, a null
focus causes an immediate action instruction. If the agent does not restore
focus, later eligible nodes repeat the instruction.

The reminder applies whether or not pending nodes currently exist:

- with pending work, the agent chooses a meaningful pending leaf;
- without pending work, the agent creates new focused work if substantive work
  will continue; and
- if the agent is only wrapping up and summarizing completed work, it may remain
  without focus.

Plugin-generated guard reminders must not recursively trigger another copy of
themselves.

Candidate generic reminder:

```text
Do not continue substantive work or call another non-Todo tool until focus is
restored. Focus a matching pending leaf, or create one brief focused outcome if
no pending work remains. If only a pending parent remains after its children
finish, complete it when verified or expand it into the remaining work. Skip
this only for the final response summarizing already completed work.
```

### Actionable errors

- When a rejected operation has a clear alternative, its error names the
  relevant Todo Stack tool and explains why it should be used.
- Errors should guide the agent at the point of failure instead of relying on
  additional persistent prompt instructions.

For example, rejecting an unfocused push below the focused leaf should say:

```text
Cannot add an unfocused child below the focused leaf because focus must remain
on a leaf. Use todo_stack__expand to decompose the focused task.
```

## Prompt design

The prompts use direct action instructions. They state the required Todo Stack
transition before other tools, name the relevant tool when useful, and keep the
single final-response exception explicit.

The earlier design required first-person reflection because it behaved well in
turn-compaction experiments. That constraint is superseded: in a real
DeepSeek V4 Flash Vision Exp session, the model ignored repeated first-person
no-focus reminders. In the controlled completed-stack continuation scenario,
the tag-free first-person variant created todos but violated node-content
semantics in 3/3 runs, while the directive variant satisfied the full contract
in 3/3 runs. Prompt refinements must still rewrite the opening, turn-start,
no-focus, and post-create instructions as one coherent contract rather than
accumulating local warnings.

The wording below is directional rather than final. Before implementation, the
opening and turn-start prompts should be rewritten together as one coherent
prompt design rather than accumulated through local wording patches.

### Opening prompt

The opening prompt establishes both reasons for maintaining the stack:

1. preserving direction across compacted turns and sessions; and
2. making the task structure and progress visible to the user.

Candidate wording:

```text
Before substantive work or another tool, call todo_stack__create as the first
tool action. Create a brief tree and focus the concrete outcome to handle first.
The tree preserves direction across compacted turns and sessions and makes task
structure visible to the user. Example:
- [ ] Implement the dashboard
  - [ ] Implement task cards
    - [ ] Add drag and drop
      - [ ] Evaluate a suitable drag-and-drop approach (focus)
    - [ ] Style the task cards
Keep one meaningful leaf focused while working. Skip initialization only for an
immediate final answer with no substantive work or tool call.
```

`Brief` describes the content of each node, not a shallow tree. Intermediate
nodes preserve the structure of the plan, while focus can descend to the
specific piece of work currently being handled. The example should use short,
concrete outcomes rather than generic labels such as `category` and
`subcategory`.

### Turn-start reflection

The reflection asks the agent to actively check whether its work is still
synchronized with the Todo Stack at the beginning of each later turn. This is
the natural reorientation point after ordinary or automatic turn compaction,
and avoids competing with Turn Memory's stop-and-handoff reminder inside a long
turn.

```text
Before another non-Todo tool, synchronize the Todo Stack with the next work:
- Confirm that the focused leaf matches the next concrete outcome.
- If the next work is more specific, call todo_stack__expand first.
- Record established later work below the relevant todo without losing focus.
- If the stack already matches the work, continue without changing it.
```

The turn-start prompt names `todo_stack__expand` because the directive form is
intended to cause an immediate state transition, not merely describe a useful
reflection. It still distinguishes decomposing current work from recording
deferred work elsewhere.

The earlier 30-node reminder is removed rather than retained as a fallback.
This deployment uses Todo Stack together with Turn Memory: Turn Memory owns
long-turn stopping and continuation, while Todo Stack resynchronizes focus at
the next turn boundary. Null focus remains covered by its dedicated guard.

### `todo_stack__create`

```ts
todo_stack__create(
  todo_to_focus: string,
  rest_todos?: string[],
): TodoStackMutationResult
```

- It creates an ordered set of root todos in one atomic mutation.
- `todo_to_focus` is created as the first root and becomes the focus.
- Each optional item in `rest_todos` is created after it as an unfocused
  pending root. Omit the array when there are no independent top-level
  outcomes; steps of the first goal are children, not roots.
- It is the root-level counterpart of `todo_stack__expand`, which creates
  children below an identified node.
- It works both for a completely empty tree and after earlier work has reached
  terminal state. In the latter case, the new root group is appended while the
  historical terminal nodes remain available.

### `todo_stack__show`

`todo_stack__show` replaces `get_todo_stack`.

```ts
todo_stack__show(): CompleteTodoTree
```

- It accepts no parameters.
- It returns the complete persisted todo tree rather than a selected subtree or
  a depth- or node-limited view.
- `get_todo_stack` is removed from the model-facing tool set rather than kept as
  an alias.

### `todo_stack__expand`

```ts
todo_stack__expand(
  id: string,
  sub_todo_to_focus: string,
  rest_todos?: string[],
): TodoStackMutationResult
```

- It expands the node identified by `id` into an ordered set of direct child
  todos in one atomic mutation.
- `sub_todo_to_focus` is created as the first child and becomes the new focus.
- Each optional item in `rest_todos` is created after it as an unfocused pending
  sibling.

### `todo_stack__focus`

```ts
todo_stack__focus(id: string): TodoStackMutationResult
```

- It makes the identified pending leaf node the current focus.
- `id` is a model-facing todo node id.

### `todo_stack__push`

```ts
todo_stack__push(
  id: string,
  todo: string,
  focus: boolean = false,
): TodoStackMutationResult
```

- It appends one new pending todo as a direct child of the node identified by
  `id`.
- The new node remains unfocused by default.
- With `focus: true`, the new node becomes the current focus in the same atomic
  mutation.
- If `id` is the currently focused leaf and `focus` is false, the call is
  rejected because it would leave focus on a non-leaf node. Agents should use
  `todo_stack__expand` when decomposing the focused task, and the rejection
  explicitly recommends that tool.

### `todo_stack__complete`

```ts
todo_stack__complete(id: string): TodoStackMutationResult
```

- It completes the todo identified by `id`.
- Completing a node that is not focused leaves the current focus unchanged.
- Completing the focused node clears focus rather than guessing the next task.
- The session-wide no-focus guard then reminds the agent unless it is wrapping
  up and summarizing completed work.

### `todo_stack__delete`

```ts
todo_stack__delete(id: string): TodoStackMutationResult
```

- It deletes the todo identified by `id`.
- Deletion physically removes the node and its entire subtree.
- Deleted state is not retained as a recoverable lifecycle state.

### `todo_stack__edit`

```ts
todo_stack__edit(
  id: string,
  todo: string,
): TodoStackMutationResult
```

- The target node is identified by `id`.
- `todo` replaces its current content.

## Implementation resolutions

- `todo_stack__show` returns a nested complete tree with `revision`, `focusId`,
  ordered roots, ids, content, lifecycle, focus flags, and children.
- Mutation results return `operation`, `revision`, `affectedId`, `createdIds`,
  and `focusId`, followed by the live focus-local tree in the rendered tool
  result. The `complete` result instead shows the affected node's ancestor path
  and every sibling because completion may clear the focus that would otherwise
  anchor the view.
- `maxReadNodes`, `get_todo_stack`, and `update_todo_stack` are removed from the
  model-facing contract.
- `rest_todos` may be omitted or empty, but the first focused item remains required, so
  `create` and `expand` always create at least one node.
- Deleting a subtree containing focus clears focus. It does not guess a
  successor; the no-focus guard drives a deliberate next choice.
