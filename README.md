# dsh-plugin-todo-stack

A persistent tree-shaped focus anchor for DeepSeek Harness agents. The tree
keeps the structure of substantive work available across turn and session
compaction, while its focused leaf shows both the agent and the user what is
being worked on now.

Todo nodes are deliberately brief. Each node stores one task outcome, not a
plan, progress log, evidence store, notes field, or handoff narrative. Detailed
working context stays in the conversation or workspace.

## Tools

- `todo_stack__show()` returns the complete tree, terminal history, current
  focus, ids, and revision.
- `todo_stack__create(todo_to_focus, rest_todos?)` creates a root group and
  focuses its first item. Optional remaining roots are independent top-level
  outcomes, not steps of the first goal.
- `todo_stack__expand(id, sub_todo_to_focus, rest_todos?)` decomposes the
  current focused leaf into ordered children and focuses the first child.
- `todo_stack__focus(id)` selects an existing pending leaf.
- `todo_stack__push(id, todo, focus=false)` records one child below an explicit
  parent, optionally entering it immediately.
- `todo_stack__complete(id)` marks a verified outcome complete.
- `todo_stack__delete(id)` permanently deletes a node and its whole subtree.
- `todo_stack__edit(id, todo)` replaces only a node's short task outcome.

Focus may point only to a pending leaf. Completing or deleting the focused node
clears focus instead of guessing what the agent should do next. If substantive
work continues, the agent must deliberately focus another pending leaf or
create new focused work. A short no-focus reminder appears on the first model
request of an already initialized turn and repeats after model-visible nodes
until that happens; it allows no focus only while wrapping up completed work.

`push` is for recording deferred work under an existing task. An unfocused
push below the focused leaf would turn that leaf into a branch, so it is
rejected with an instruction to use `todo_stack__expand`. `complete` rejects a
node whose subtree still contains pending work.

New nodes receive compact session-local ids (`t1`, `t2`, ...). Restored legacy
ids remain canonical, but views expose a shortest unique prefix that every
id-taking tool accepts.

## Prompt behavior

The prompt uses direct action instructions. At the beginning of substantive
work it requires a concise tree, one meaningful focused leaf, deeper children
when the current branch is broader than the next work, and deferred children
for established later work. The hierarchy may be deep even though each node
is brief.

One goal with several checks starts as one root and then expands into children;
the checks are not flattened into extra roots. Nodes name outcomes rather than
tool arguments, acceptance criteria, evidence, or final-response requirements.
After `create`, the tool result carries one lifecycle instruction: shorten a
root that accidentally includes its checks, expand it when it contains multiple
child outcomes, then complete verified work or keep a blocked objective pending
as objective plus dependency.

Immediate answers with no existing tracked work do not need a stack. An
existing stack must be reconciled before every final response: verified focus
is completed, while blocked or unfinished focus remains pending and accurate.
At the start of each later turn, a one-request instruction first checks for an
already verified focus, then checks whether the current focus matches the next
concrete work, whether the active branch should deepen, and whether newly
identified later work belongs in the tree. If focus is absent, the more
specific no-focus action appears instead. That action also closes a completed
branch by completing its verified parent, or expands the parent when concrete
work still remains.

## DSH integration

The plugin registers:

- the eight model tools above;
- a persistent `todoStack` session projection;
- a Web `TodoStackDock` that renders hierarchy, focus, and lifecycle;
- a flattened `todos` compatibility projection for clients without the custom
  dock;
- opening guidance as runtime context, so a complete persona cannot suppress
  Todo Stack initialization;
- turn-start context containing the focused branch and one brief
  synchronization reflection;
- the live updated branch in every mutation result, with `complete` showing
  the affected node and all of its siblings, plus the bounded post-`create`
  focus-granularity check; and
- the dynamic no-focus guard.

The turn-start branch stays frozen until the first Todo Stack mutation in that
turn. Mutation results carry the live branch, avoiding a new system context
snapshot after every Todo Stack call. A focused node uses the compact `[*]`
marker; pending and completed nodes use `[ ]` and `[x]`. `todo_stack__show`
loads the full tree only when the agent needs it.

Model-facing tree views and reminders use ordinary Markdown rather than XML
wrapper tags. Each tree includes the compact marker legend `[*] focused
pending; [ ] pending; [x] completed` so focus cannot be mistaken for
completion. Revisions, turn numbers, and surface-node numbers remain as plain
text because they make successive runtime-context snapshots distinct.

The plugin does not depend on or load `@deepseek-ai/dsh-tool-todo`. Keep the
stock `tool-todo` loader entry disabled so it cannot register a competing
`todos` projection or conflicting instructions.

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
        contextChildren: 8
        todoDock: true
```

Restart the DSH profile after installation or patch changes.

The browser entry is committed as `client.js`, so a GitHub installation does
not require a client build toolchain. After changing `client/index.ts`, rebuild
it with:

```sh
pnpm build:client
```

`pnpm check` verifies that the committed browser bundle is current.

## End-to-end tests

The deterministic E2E uses an isolated `test-todo-stack` profile and a real
model/tool loop. It checks the tool family, projections, no-focus guard, and two
cold session resumes:

```sh
pnpm e2e
```

The production-prompt evaluation uses independent real sessions:

```sh
TODO_STACK_PROMPT_EVAL_RUNS=3 pnpm e2e:prompt
```

Its eight scenarios cover tracked multi-tool work, completing a single
verified outcome before the final response, completing an already verified
focus during a Turn Memory continuation, a trivial direct answer, a blocked
focused task, expansion below an existing focus, recovery from a pending tree
with no focus, and starting new work after the previous stack is complete. It
grades durable tool order and tree state rather than exact wording or a fixed
tree shape, fingerprints the effective prompt and tools, and writes JSON
artifacts under `.tmp/`. Isolate a scenario with, for example:

```sh
TODO_STACK_PROMPT_EVAL_RUNS=3 \
TODO_STACK_PROMPT_EVAL_SCENARIOS=recover_focus \
pnpm e2e:prompt
```

Prompt evaluation uses `deepseek-official/deepseek-v4-flash` by default so it
does not contend with local GPU workloads. Set `TODO_STACK_PROMPT_EVAL_PROVIDER`
and `TODO_STACK_PROMPT_EVAL_MODEL` when evaluating a specific model instead.
Set `TODO_STACK_PROMPT_EVAL_COMPLETE_PERSONA=1` to suppress ordinary system
sections and exercise the runtime-context-only path used by a complete persona.

## Configuration

| Setting | Default | Meaning |
| --- | ---: | --- |
| `maxNodes` | `200` | Maximum retained nodes in one session tree. |
| `contextChildren` | `8` | Immediate siblings or children included at the working frontier. |
| `todoDock` | `true` | Publish the flattened `todos` compatibility projection. The custom Web dock reads `todoStack` directly. |

See [design.md](./design.md) for state, persistence, and prompt semantics and
[tool-redesign.md](./tool-redesign.md) for the decisions behind this tool
family.
