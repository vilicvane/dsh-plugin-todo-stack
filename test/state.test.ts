import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
} from '@deepseek-ai/dsh-session';

import {
  emptyTodoStack,
  foldTodoStack,
  makeTodoStackCarrier,
  mutateTodoStack,
  resolveTodoNodeId,
  todoNodeRef,
  todoDockItems,
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

test('default ids are compact, stable tool references', () => {
  let state = mutateTodoStack(emptyTodoStack(), { action: 'push', content: 'Root' }, {
    maxNodes: 20,
  }).state;
  state = mutateTodoStack(state, { action: 'push', content: 'Child' }, {
    maxNodes: 20,
  }).state;

  assert.deepEqual(Object.keys(state.nodes), ['t1', 't2']);
  assert.equal(state.focusId, 't2');
  assert.equal(todoNodeRef(state, 't2'), 't2');
  assert.equal(resolveTodoNodeId(state, 't2'), 't2');
});

test('legacy ids expose and resolve the shortest unique prefix', () => {
  let state = mutateTodoStack(emptyTodoStack(), { action: 'add', content: 'First' }, {
    maxNodes: 20,
    createId: ids('b05aefee-2946-4542-9f0e-bdae28926d39'),
  }).state;
  state = mutateTodoStack(state, { action: 'add', content: 'Second' }, {
    maxNodes: 20,
    createId: ids('b05aff11-aaaa-bbbb-cccc-123456789012'),
  }).state;

  assert.equal(todoNodeRef(state, 'b05aefee-2946-4542-9f0e-bdae28926d39'), 'b05aef');
  assert.equal(resolveTodoNodeId(state, 'b05aef'), 'b05aefee-2946-4542-9f0e-bdae28926d39');
  assert.throws(() => resolveTodoNodeId(state, 'b05a'), /ambiguous/);
});

test('push, exit, focus, and complete preserve stack semantics', () => {
  let state = emptyTodoStack();
  state = mutateTodoStack(state, { action: 'push', content: 'Root work' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  assert.equal(state.revision, 1);
  assert.equal(state.focusId, 'root');

  state = mutateTodoStack(state, { action: 'push', content: 'Child work' }, {
    maxNodes: 20,
    createId: ids('child'),
  }).state;
  assert.equal(state.focusId, 'child');
  assert.deepEqual(state.nodes.root.children, ['child']);

  state = mutateTodoStack(state, { action: 'exit' }, { maxNodes: 20 }).state;
  assert.equal(state.focusId, 'root');
  assert.equal(state.nodes.child.status, 'pending');

  state = mutateTodoStack(state, { action: 'focus', id: 'child' }, { maxNodes: 20 }).state;
  state = mutateTodoStack(state, { action: 'complete' }, { maxNodes: 20 }).state;
  assert.equal(state.focusId, 'root');
  assert.equal(state.nodes.child.status, 'completed');

  state = mutateTodoStack(state, { action: 'complete' }, { maxNodes: 20 }).state;
  assert.equal(state.focusId, null);
  assert.equal(state.nodes.root.status, 'completed');
  assert.equal(state.revision, 6);
});

test('complete rejects pending descendants and drop records abandoned work', () => {
  let state = mutateTodoStack(emptyTodoStack(), { action: 'push', content: 'Root' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  state = mutateTodoStack(state, { action: 'push', content: 'Wrong path' }, {
    maxNodes: 20,
    createId: ids('wrong'),
  }).state;
  state = mutateTodoStack(state, { action: 'exit' }, { maxNodes: 20 }).state;

  assert.throws(
    () => mutateTodoStack(state, { action: 'complete' }, { maxNodes: 20 }),
    /pending work/,
  );

  state = mutateTodoStack(state, { action: 'drop', id: 'wrong' }, { maxNodes: 20 }).state;
  assert.equal(state.nodes.wrong.status, 'dropped');
  assert.equal(state.focusId, 'root');
  state = mutateTodoStack(state, { action: 'complete' }, { maxNodes: 20 }).state;
  assert.equal(state.nodes.root.status, 'completed');
});

test('move rejects cycles and supports explicit roots', () => {
  let state = mutateTodoStack(emptyTodoStack(), { action: 'push', content: 'A' }, {
    maxNodes: 20,
    createId: ids('a'),
  }).state;
  state = mutateTodoStack(state, { action: 'push', content: 'B' }, {
    maxNodes: 20,
    createId: ids('b'),
  }).state;

  assert.throws(
    () => mutateTodoStack(state, { action: 'move', id: 'a', parentId: 'b' }, { maxNodes: 20 }),
    /descendants/,
  );

  state = mutateTodoStack(state, { action: 'move', id: 'b', parentId: null }, { maxNodes: 20 }).state;
  assert.deepEqual(state.roots, ['a', 'b']);
  assert.equal(state.nodes.b.parentId, null);
  assert.equal(state.focusId, 'b');
});

test('add, edit, drop, and reopen maintain ordered siblings', () => {
  let state = mutateTodoStack(emptyTodoStack(), { action: 'push', content: 'Root' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  state = mutateTodoStack(state, { action: 'add', content: 'First' }, {
    maxNodes: 20,
    createId: ids('first'),
  }).state;
  state = mutateTodoStack(state, { action: 'add', content: 'Second', afterId: 'first' }, {
    maxNodes: 20,
    createId: ids('second'),
  }).state;
  assert.deepEqual(state.nodes.root.children, ['first', 'second']);

  state = mutateTodoStack(state, { action: 'edit', id: 'second', content: 'Edited' }, {
    maxNodes: 20,
  }).state;
  state = mutateTodoStack(state, { action: 'drop', id: 'first' }, { maxNodes: 20 }).state;
  state = mutateTodoStack(state, { action: 'reopen', id: 'first' }, { maxNodes: 20 }).state;
  assert.equal(state.nodes.first.status, 'pending');
  assert.equal(state.nodes.second.content, 'Edited');
});

test('whole snapshots fold through ordinary todo/write events', () => {
  let state = mutateTodoStack(emptyTodoStack(), { action: 'push', content: 'Root' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  const first = makeTodoStackCarrier('push', state);
  state = mutateTodoStack(state, { action: 'push', content: 'Child' }, {
    maxNodes: 20,
    createId: ids('child'),
  }).state;
  const second = makeTodoStackCarrier('push', state);

  const folded = foldTodoStack([
    { type: 'todo/write', data: first },
    { type: 'todo/write', data: { todos: [{ content: 'foreign', status: 'pending' }] } },
    { type: 'todo/write', data: second },
  ]);
  assert.equal(folded.revision, 2);
  assert.equal(folded.focusId, 'child');
});

test('compatibility todo rows are trimmed and unique', () => {
  let state = mutateTodoStack(emptyTodoStack(), { action: 'add', content: 'Same' }, {
    maxNodes: 20,
    createId: ids('a'),
  }).state;
  state = mutateTodoStack(state, { action: 'add', content: 'Same' }, {
    maxNodes: 20,
    createId: ids('b'),
  }).state;
  const todos = todoDockItems(state);
  assert.equal(todos.length, 2);
  assert.notEqual(todos[0].content, todos[1].content);
  assert.ok(todos.every((todo) => todo.content === todo.content.trim()));
});

test('todo/write carrier survives a Session JSON restore', () => {
  assert.equal(KNOWN_SESSION_EVENT_TYPES.has('todo/write'), true);
  const id = SessionId('session-todo-stack-test');
  const session = Session.create(id);
  const state = mutateTodoStack(emptyTodoStack(), { action: 'push', content: 'Persistent root' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  session.append('todo/write', makeTodoStackCarrier('push', state));

  const events = JSON.parse(JSON.stringify(session.events));
  const header = JSON.parse(JSON.stringify(session.header));
  const restored = Session.fromRestore(id, events, header);
  const folded = foldTodoStack(restored.events);
  assert.equal(folded.revision, 1);
  assert.equal(folded.nodes.root.content, 'Persistent root');
});

test('legacy durable title and rename metadata normalize to content and edit', () => {
  const legacy = {
    todos: [{ content: '▶ Legacy task', status: 'in_progress' }],
    todoStack: {
      kind: TODO_STACK_ENVELOPE_KIND,
      version: TODO_STACK_VERSION,
      operation: 'rename',
      state: {
        version: TODO_STACK_VERSION,
        revision: 1,
        roots: ['legacy'],
        nodes: {
          legacy: {
            id: 'legacy',
            title: 'Legacy task',
            parentId: null,
            children: [],
            status: 'pending',
          },
        },
        focusId: 'legacy',
      },
    },
  };
  const events = [{ type: 'todo/write', data: legacy }];
  const folded = foldTodoStack(events);
  assert.equal(folded.nodes.legacy.content, 'Legacy task');
  assert.equal(Object.hasOwn(folded.nodes.legacy, 'title'), false);
  assert.doesNotThrow(() => validateTodoStackHistory(events, (message) => { throw new Error(message); }));
});

test('invariant rejects mismatched compatibility rows and revision gaps', () => {
  const state = mutateTodoStack(emptyTodoStack(), { action: 'push', content: 'Root' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  const carrier = makeTodoStackCarrier('push', state);
  const fail = (message: string): never => {
    throw new Error(message);
  };

  assert.throws(
    () => validateTodoStackHistory([
      { type: 'todo/write', data: { ...carrier, todos: [] } },
    ], fail),
    /does not match/,
  );
  assert.throws(
    () => validateTodoStackHistory([
      {
        type: 'todo/write',
        data: {
          ...carrier,
          todoStack: {
            ...carrier.todoStack,
            state: { ...carrier.todoStack.state, revision: 2 },
          },
        },
      },
    ], fail),
    /does not follow/,
  );
});
