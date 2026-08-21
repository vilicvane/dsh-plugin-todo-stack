import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildNoFocusGuardContext,
  TODO_STACK_TURN_START_CONTEXT_NAME,
  buildTurnStartReflectionContext,
  turnStartReflectionWasShown,
} from '../lib/reminders.ts';
import type { TodoStackState } from '../lib/types.ts';

function message(text: string, source: any = { kind: 'user' }): any {
  return { id: `m-${text}`, role: 'user', content: [{ type: 'text', text }], source };
}

function fixtureSession(): any {
  const events: any[] = [];
  const surface = { nodes: [] as number[] };
  const append = (type: string, data: any, surfaceOp?: any): any => {
    const event = { seq: events.length, type, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) };
    events.push(event);
    if (surfaceOp === 'append') surface.nodes.push(event.seq);
    return event;
  };
  return { events, surface, header: {}, append };
}

function assistant(text: string, turn = 1, step = 1): any {
  return {
    turn,
    step,
    message: {
      id: `a-${step}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  };
}

describe('todo stack dynamic reminders', () => {
  test('reflects once at the start of each non-opening focused turn', () => {
    const session = fixtureSession();
    session.append('turn/start', { turn: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    session.append('turn/start', { turn: 2 });
    session.append('user/message', message('continue'), 'append');
    const state: TodoStackState = {
      version: 1,
      revision: 1,
      roots: ['t1'],
      nodes: {
        t1: {
          id: 't1',
          content: 'Focused work',
          parentId: null,
          children: [],
          status: 'pending',
        },
      },
      focusId: 't1',
    };

    const first = buildTurnStartReflectionContext({ session, state, opening: false });
    assert.match(first, /todo-stack-turn-start turn="2"/);
    assert.match(first, /I am starting a new turn/);
    assert.match(first, /Does the current focus still match/);
    assert.match(first, /Am I diving deeper/);
    assert.match(first, /Did I identify something to handle later/);
    assert.doesNotMatch(first, /todo_stack__/);

    session.append('user/message', message(first, {
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
      sections: [{ name: TODO_STACK_TURN_START_CONTEXT_NAME, text: first }],
    }), 'append');
    assert.equal(turnStartReflectionWasShown(session, 2), true);
    assert.equal(buildTurnStartReflectionContext({ session, state, opening: false }), '');

    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    session.append('turn/start', { turn: 3 });
    session.append('user/message', message('next'), 'append');
    assert.match(
      buildTurnStartReflectionContext({ session, state, opening: false }),
      /todo-stack-turn-start turn="3"/,
    );
  });

  test('does not introduce a turn-start reflection after work begins or without focus', () => {
    const session = fixtureSession();
    session.append('turn/start', { turn: 1 });
    session.append('user/message', message('work'), 'append');
    const state: TodoStackState = {
      version: 1,
      revision: 1,
      roots: ['t1'],
      nodes: {
        t1: {
          id: 't1',
          content: 'Focused work',
          parentId: null,
          children: [],
          status: 'pending',
        },
      },
      focusId: 't1',
    };
    assert.equal(buildTurnStartReflectionContext({ session, state, opening: true }), '');
    state.focusId = null;
    assert.equal(buildTurnStartReflectionContext({ session, state, opening: false }), '');
    state.focusId = 't1';
    session.append('assistant/message', assistant('already working'), 'append');
    assert.equal(buildTurnStartReflectionContext({ session, state, opening: false }), '');
  });

  test('no-focus guard follows each eligible node and ignores its own snapshots', () => {
    const session = fixtureSession();
    const state: TodoStackState = {
      version: 1,
      revision: 2,
      roots: ['t1'],
      nodes: {
        t1: {
          id: 't1',
          content: 'Pending work',
          parentId: null,
          children: [],
          status: 'pending',
        },
      },
      focusId: null,
    };
    session.append('turn/start', { turn: 1 });
    session.append('user/message', message('work'), 'append');
    const first = buildNoFocusGuardContext({ session, state, opening: false });
    assert.match(first, /after-node="1"/);
    assert.match(first, /I currently have no todo focus/);
    assert.match(first, /summarizing completed work/);

    session.append('user/message', message(first, {
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
      sections: [],
    }), 'append');
    assert.equal(buildNoFocusGuardContext({ session, state, opening: false }), first);

    session.append('assistant/message', assistant('continued', 1, 2), 'append');
    const second = buildNoFocusGuardContext({ session, state, opening: false });
    assert.match(second, /after-node="3"/);
    assert.notEqual(second, first);
  });

  test('no-focus guard is suppressed by opening guidance or an existing focus', () => {
    const session = fixtureSession();
    session.append('turn/start', { turn: 1 });
    session.append('user/message', message('work'), 'append');
    const state: TodoStackState = {
      version: 1,
      revision: 1,
      roots: ['t1'],
      nodes: {
        t1: {
          id: 't1',
          content: 'Focused work',
          parentId: null,
          children: [],
          status: 'pending',
        },
      },
      focusId: null,
    };
    assert.equal(buildNoFocusGuardContext({ session, state, opening: true }), '');
    state.focusId = 't1';
    assert.equal(buildNoFocusGuardContext({ session, state, opening: false }), '');
  });
});
