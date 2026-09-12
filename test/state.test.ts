import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session';

import {
  assertTodoStackState,
  emptyTodoStack,
  foldTodoStack,
  makeTodoStackCarrier,
  mutateTodoStack,
  resolveTodoNodeId,
  todoDockItems,
  todoNodeRef,
} from '../lib/state.ts';
import { validateTodoStackHistory } from '../invariant.ts';
import {
  TODO_STACK_ENVELOPE_KIND,
  TODO_STACK_VERSION,
} from '../lib/types.ts';

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] as string;
}

test('create builds ordered roots and focuses the first compact id', () => {
  const result = mutateTodoStack(emptyTodoStack(), {
    action: 'create',
    todos: ['Implement dashboard', 'Document release'],
  }, { maxNodes: 20 });

  assert.deepEqual(result.createdIds, ['t1', 't2']);
  assert.deepEqual(result.state.roots, ['t1', 't2']);
  assert.equal(result.state.focusId, 't1');
  assert.equal(todoNodeRef(result.state, 't2'), 't2');
  assert.equal(resolveTodoNodeId(result.state, 't2'), 't2');
});

test('legacy ids expose and resolve the shortest unique prefix', () => {
  const state = mutateTodoStack(emptyTodoStack(), {
    action: 'create',
    todos: ['First', 'Second'],
  }, {
    maxNodes: 20,
    createId: ids(
      'b05aefee-2946-4542-9f0e-bdae28926d39',
      'b05aff11-aaaa-bbbb-cccc-123456789012',
    ),
  }).state;

  assert.equal(todoNodeRef(state, 'b05aefee-2946-4542-9f0e-bdae28926d39'), 'b05aef');
  assert.equal(resolveTodoNodeId(state, 'b05aef'), 'b05aefee-2946-4542-9f0e-bdae28926d39');
  assert.throws(() => resolveTodoNodeId(state, 'b05a'), /ambiguous/);
});

test('create rejects overlapping pending work but starts a new root group after completion', () => {
  let state = mutateTodoStack(emptyTodoStack(), {
    action: 'create',
    todos: ['First phase'],
  }, { maxNodes: 20 }).state;
  assert.throws(
    () => mutateTodoStack(state, { action: 'create', todos: ['Overlap'] }, { maxNodes: 20 }),
    /pending work exists/,
  );

  state = mutateTodoStack(state, { action: 'complete', id: 't1' }, { maxNodes: 20 }).state;
  state = mutateTodoStack(state, { action: 'create', todos: ['Second phase'] }, { maxNodes: 20 }).state;
  assert.deepEqual(state.roots, ['t1', 't2']);
  assert.equal(state.nodes.t1.status, 'completed');
  assert.equal(state.focusId, 't2');
});

test('expand decomposes only the focused leaf and focuses its first child', () => {
  let state = mutateTodoStack(emptyTodoStack(), {
    action: 'create',
    todos: ['Implement dashboard'],
  }, { maxNodes: 20 }).state;
  const result = mutateTodoStack(state, {
    action: 'expand',
    id: 't1',
    todos: ['Implement cards', 'Implement filters'],
  }, { maxNodes: 20 });
  state = result.state;

  assert.deepEqual(result.createdIds, ['t2', 't3']);
  assert.deepEqual(state.nodes.t1.children, ['t2', 't3']);
  assert.equal(state.focusId, 't2');
  assert.throws(
    () => mutateTodoStack(state, { action: 'focus', id: 't1' }, { maxNodes: 20 }),
    /pending leaf/,
  );
  assert.throws(
    () => mutateTodoStack(state, { action: 'expand', id: 't3', todos: ['Wrong'] }, { maxNodes: 20 }),
    /current focus/,
  );
});

test('push preserves focus on other branches and rejects unfocused children below focus', () => {
  let state = mutateTodoStack(emptyTodoStack(), {
    action: 'create',
    todos: ['Current', 'Later'],
  }, { maxNodes: 20 }).state;

  state = mutateTodoStack(state, {
    action: 'push',
    parentId: 't2',
    content: 'Deferred detail',
    focus: false,
  }, { maxNodes: 20 }).state;
  assert.equal(state.focusId, 't1');
  assert.deepEqual(state.nodes.t2.children, ['t3']);

  assert.throws(
    () => mutateTodoStack(state, {
      action: 'push',
      parentId: 't1',
      content: 'Unfocused child',
      focus: false,
    }, { maxNodes: 20 }),
    /use todo_stack__expand/,
  );

  state = mutateTodoStack(state, {
    action: 'push',
    parentId: 't1',
    content: 'Enter child',
    focus: true,
  }, { maxNodes: 20 }).state;
  assert.equal(state.focusId, 't4');
});

test('complete clears focused work and rejects pending descendants', () => {
  let state = mutateTodoStack(emptyTodoStack(), {
    action: 'create',
    todos: ['Root'],
  }, { maxNodes: 20 }).state;
  state = mutateTodoStack(state, {
    action: 'expand',
    id: 't1',
    todos: ['First child', 'Second child'],
  }, { maxNodes: 20 }).state;

  assert.throws(
    () => mutateTodoStack(state, { action: 'complete', id: 't1' }, { maxNodes: 20 }),
    /pending work/,
  );
  state = mutateTodoStack(state, { action: 'complete', id: 't2' }, { maxNodes: 20 }).state;
  assert.equal(state.focusId, null);
  assert.equal(state.nodes.t2.status, 'completed');
  state = mutateTodoStack(state, { action: 'focus', id: 't3' }, { maxNodes: 20 }).state;
  state = mutateTodoStack(state, { action: 'complete', id: 't3' }, { maxNodes: 20 }).state;
  state = mutateTodoStack(state, { action: 'complete', id: 't1' }, { maxNodes: 20 }).state;
  assert.equal(state.nodes.t1.status, 'completed');
  assert.equal(state.focusId, null);
});

test('delete physically removes a subtree and clears a contained focus', () => {
  let state = mutateTodoStack(emptyTodoStack(), {
    action: 'create',
    todos: ['Root', 'Keep'],
  }, { maxNodes: 20 }).state;
  state = mutateTodoStack(state, {
    action: 'expand',
    id: 't1',
    todos: ['Child', 'Sibling'],
  }, { maxNodes: 20 }).state;
  state = mutateTodoStack(state, {
    action: 'expand',
    id: 't3',
    todos: ['Grandchild'],
  }, { maxNodes: 20 }).state;

  state = mutateTodoStack(state, { action: 'delete', id: 't1' }, { maxNodes: 20 }).state;
  assert.deepEqual(state.roots, ['t2']);
  assert.deepEqual(Object.keys(state.nodes), ['t2']);
  assert.equal(state.focusId, null);
});

test('edit changes only content', () => {
  let state = mutateTodoStack(emptyTodoStack(), {
    action: 'create',
    todos: ['Old content'],
  }, { maxNodes: 20 }).state;
  state = mutateTodoStack(state, {
    action: 'edit',
    id: 't1',
    content: 'New content',
  }, { maxNodes: 20 }).state;
  assert.equal(state.nodes.t1.content, 'New content');
  assert.equal(state.focusId, 't1');
  assert.equal(state.nodes.t1.status, 'pending');
});

test('state permits temporary no-focus work but rejects a non-leaf focus', () => {
  const noFocus = {
    version: TODO_STACK_VERSION,
    revision: 1,
    roots: ['root'],
    nodes: {
      root: {
        id: 'root',
        content: 'Pending root',
        parentId: null,
        children: [],
        status: 'pending' as const,
      },
    },
    focusId: null,
  };
  assert.doesNotThrow(() => assertTodoStackState(noFocus));

  assert.throws(() => assertTodoStackState({
    ...noFocus,
    nodes: {
      root: { ...noFocus.nodes.root, children: ['leaf'] },
      leaf: {
        id: 'leaf',
        content: 'Leaf',
        parentId: 'root',
        children: [],
        status: 'pending',
      },
    },
    focusId: 'root',
  }), /leaf node/);
});

test('whole snapshots fold through todo/write events and survive Session restore', () => {
  assert.equal(KNOWN_SESSION_EVENT_TYPES.has('todo/write'), true);
  let state = mutateTodoStack(emptyTodoStack(), {
    action: 'create',
    todos: ['Persistent root'],
  }, { maxNodes: 20 }).state;
  const first = makeTodoStackCarrier('create', state);
  state = mutateTodoStack(state, {
    action: 'expand',
    id: 't1',
    todos: ['Persistent child'],
  }, { maxNodes: 20 }).state;
  const second = makeTodoStackCarrier('expand', state);

  const id = SessionId('session-todo-stack-test');
  const session = Session.create(id);
  session.append('todo/write', first);
  session.append('todo/write', second);
  const restored = Session.fromRestore(
    id,
    JSON.parse(JSON.stringify(session.snapshotEvents())),
    JSON.parse(JSON.stringify(session.header)),
    SessionLogOffset(0),
    // DSH 0.1.5 added the seed's aliasing state as a fifth argument. The
    // events above are deep copies, so they are detached from the original.
    'detached',
  );
  const folded = foldTodoStack(restored.snapshotEvents());
  assert.equal(folded.revision, 2);
  assert.equal(folded.focusId, 't2');
  assert.equal(folded.nodes.t2.content, 'Persistent child');
});

test('legacy title and non-leaf focus normalize at the read boundary', () => {
  const legacy = {
    todos: [
      { content: 'Root', status: 'pending' },
      { content: '· Leaf', status: 'in_progress' },
    ],
    todoStack: {
      kind: TODO_STACK_ENVELOPE_KIND,
      version: TODO_STACK_VERSION,
      operation: 'rename',
      state: {
        version: TODO_STACK_VERSION,
        revision: 1,
        roots: ['root'],
        nodes: {
          root: {
            id: 'root',
            title: 'Root',
            parentId: null,
            children: ['leaf'],
            status: 'pending',
          },
          leaf: {
            id: 'leaf',
            title: 'Leaf',
            parentId: 'root',
            children: [],
            status: 'pending',
          },
        },
        focusId: 'root',
      },
    },
  };
  const events = [{ type: 'todo/write', data: legacy }];
  const folded = foldTodoStack(events);
  assert.equal(folded.nodes.root.content, 'Root');
  assert.equal(folded.focusId, 'leaf');
  assert.doesNotThrow(() => validateTodoStackHistory(events, (message) => { throw new Error(message); }));

  const oldFocusRows = JSON.parse(JSON.stringify(legacy));
  oldFocusRows.todos = [
    { content: '▶ Root', status: 'in_progress' },
    { content: '· Leaf', status: 'pending' },
  ];
  assert.doesNotThrow(() => validateTodoStackHistory(
    [{ type: 'todo/write', data: oldFocusRows }],
    (message) => { throw new Error(message); },
  ));

  const corruptedRows = JSON.parse(JSON.stringify(legacy));
  corruptedRows.todos = [];
  assert.throws(
    () => validateTodoStackHistory(
      [{ type: 'todo/write', data: corruptedRows }],
      (message) => { throw new Error(message); },
    ),
    /does not match/,
  );
});

test('compatibility rows stay unique and invariant catches mismatches and gaps', () => {
  const state = mutateTodoStack(emptyTodoStack(), {
    action: 'create',
    todos: ['Same', 'Same'],
  }, { maxNodes: 20 }).state;
  const todos = todoDockItems(state);
  assert.equal(todos.length, 2);
  assert.notEqual(todos[0].content, todos[1].content);
  assert.ok(todos.every((todo) => todo.content === todo.content.trim()));

  const carrier = makeTodoStackCarrier('create', state);
  const fail = (message: string): never => { throw new Error(message); };
  assert.throws(
    () => validateTodoStackHistory([{ type: 'todo/write', data: { ...carrier, todos: [] } }], fail),
    /does not match/,
  );
  assert.throws(
    () => validateTodoStackHistory([{
      type: 'todo/write',
      data: {
        ...carrier,
        todoStack: {
          ...carrier.todoStack,
          state: { ...carrier.todoStack.state, revision: 2 },
        },
      },
    }], fail),
    /does not follow/,
  );
});
