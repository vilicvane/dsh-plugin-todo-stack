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
  todoDockItems,
} from '../lib/state.ts';
import { validateTodoStackHistory } from '../invariant.ts';

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] as string;
}

test('push, exit, focus, and complete preserve stack semantics', () => {
  let state = emptyTodoStack();
  state = mutateTodoStack(state, { action: 'push', title: 'Root work' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  assert.equal(state.revision, 1);
  assert.equal(state.focusId, 'root');

  state = mutateTodoStack(state, { action: 'push', title: 'Child work' }, {
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
  let state = mutateTodoStack(emptyTodoStack(), { action: 'push', title: 'Root' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  state = mutateTodoStack(state, { action: 'push', title: 'Wrong path' }, {
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
  let state = mutateTodoStack(emptyTodoStack(), { action: 'push', title: 'A' }, {
    maxNodes: 20,
    createId: ids('a'),
  }).state;
  state = mutateTodoStack(state, { action: 'push', title: 'B' }, {
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

test('add, rename, drop, and reopen maintain ordered siblings', () => {
  let state = mutateTodoStack(emptyTodoStack(), { action: 'push', title: 'Root' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  state = mutateTodoStack(state, { action: 'add', title: 'First' }, {
    maxNodes: 20,
    createId: ids('first'),
  }).state;
  state = mutateTodoStack(state, { action: 'add', title: 'Second', afterId: 'first' }, {
    maxNodes: 20,
    createId: ids('second'),
  }).state;
  assert.deepEqual(state.nodes.root.children, ['first', 'second']);

  state = mutateTodoStack(state, { action: 'rename', id: 'second', title: 'Renamed' }, {
    maxNodes: 20,
  }).state;
  state = mutateTodoStack(state, { action: 'drop', id: 'first' }, { maxNodes: 20 }).state;
  state = mutateTodoStack(state, { action: 'reopen', id: 'first' }, { maxNodes: 20 }).state;
  assert.equal(state.nodes.first.status, 'pending');
  assert.equal(state.nodes.second.title, 'Renamed');
});

test('whole snapshots fold through ordinary todo/write events', () => {
  let state = mutateTodoStack(emptyTodoStack(), { action: 'push', title: 'Root' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  const first = makeTodoStackCarrier('push', state);
  state = mutateTodoStack(state, { action: 'push', title: 'Child' }, {
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
  let state = mutateTodoStack(emptyTodoStack(), { action: 'add', title: 'Same' }, {
    maxNodes: 20,
    createId: ids('a'),
  }).state;
  state = mutateTodoStack(state, { action: 'add', title: 'Same' }, {
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
  const state = mutateTodoStack(emptyTodoStack(), { action: 'push', title: 'Persistent root' }, {
    maxNodes: 20,
    createId: ids('root'),
  }).state;
  session.append('todo/write', makeTodoStackCarrier('push', state));

  const events = JSON.parse(JSON.stringify(session.events));
  const header = JSON.parse(JSON.stringify(session.header));
  const restored = Session.fromRestore(id, events, header);
  const folded = foldTodoStack(restored.events);
  assert.equal(folded.revision, 1);
  assert.equal(folded.nodes.root.title, 'Persistent root');
});

test('invariant rejects mismatched compatibility rows and revision gaps', () => {
  const state = mutateTodoStack(emptyTodoStack(), { action: 'push', title: 'Root' }, {
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
