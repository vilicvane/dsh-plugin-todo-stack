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
focus causes an immediate first-person reminder. If the agent does not restore
focus, later eligible nodes remind it again.

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
I currently have no todo focus. Before I continue working, I need to restore
one: choose a meaningful pending leaf, or create a new focused todo if more work
remains. If I am only wrapping up and summarizing completed work, I can continue
without one.
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

The prompts use first-person reflection and commitment. They should make the
Todo Stack feel like the agent's own working structure rather than an external
bookkeeping instruction.

First-person voice is a required behavior, not optional tone polish. It must not
be rewritten into second-person commands during prompt refinement. In observed
turn-compaction usage, first-person reminders have worked well: they read as
the agent's continuing working state and self-commitment rather than detached
policy text.

The wording below is directional rather than final. Before implementation, the
opening and mid-work prompts should be rewritten together as one coherent
prompt design rather than accumulated through local wording patches.

### Opening prompt

The opening prompt establishes both reasons for maintaining the stack:

1. preserving direction across compacted turns and sessions; and
2. making the task structure and progress visible to the user.

Candidate wording, preserving the requested tone:

```text
Before I get started, I need to create a brief todo stack. It will guide me
through compacted turns and sessions and make my task structure visible to the
user. A typical todo stack looks like:
- [ ] Implement the dashboard
  - [ ] Implement task cards
    - [ ] Add drag and drop
      - [ ] Evaluate a suitable drag-and-drop approach (focus)
    - [ ] Style the task cards
I will always keep the todo stack up to date with a meaningful focus.
```

`Brief` describes the content of each node, not a shallow tree. Intermediate
nodes preserve the structure of the plan, while focus can descend to the
specific piece of work currently being handled. The example should use short,
concrete outcomes rather than generic labels such as `category` and
`subcategory`.

### Mid-work reflection

The mid-work reminder asks the agent to actively check whether its work is
still synchronized with the Todo Stack. It maps common intentions directly to
the corresponding tools.

```text
I need to reflect now on whether I am still synchronized with the todo stack:
- Diving deeper? Break down the current focus and move focus to the next
  concrete step.
- Remembered something to handle later? Add it below the relevant task without
  losing my current focus.
- In any case, I have to keep the stack up to date. Otherwise I could completely
  lose focus during turn and session compaction, and the user would no longer
  be able to understand the structure of my plan.
```

The mid-work prompt deliberately uses natural language instead of naming tools.
This keeps it sounding like the agent's own reflection and encourages the agent
to inspect the complete tool descriptions before choosing an operation. It
still states the intended tree behavior precisely enough to distinguish
decomposing current work from recording deferred work elsewhere.

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
  result.
- `maxReadNodes`, `get_todo_stack`, and `update_todo_stack` are removed from the
  model-facing contract.
- `rest_todos` may be omitted or empty, but the first focused item remains required, so
  `create` and `expand` always create at least one node.
- Deleting a subtree containing focus clears focus. It does not guess a
  successor; the no-focus guard drives a deliberate next choice.
