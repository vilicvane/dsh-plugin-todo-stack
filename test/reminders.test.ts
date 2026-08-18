import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  TODO_STACK_REMINDER_CONTEXT_NAME,
  buildTodoStackReminderContext,
  countOpenTurnNodes,
  latestAnnouncedNodeMilestone,
} from '../lib/reminders.ts';

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
  test('tool results do not trigger dynamic system-prompt reminders', () => {
    const session = fixtureSession();
    session.append('turn/start', { turn: 1 });
    session.append('user/message', message('work'), 'append');
    session.append('assistant/message', assistant('update stack'), 'append');
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'update_todo_stack', arguments: '{}' });
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'r1',
        role: 'user',
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'updated' }] }],
      },
    }, 'append');

    assert.equal(buildTodoStackReminderContext({
      session,
      reminderIntervalNodes: 30,
    }), '');
  });

  test('announces each node milestone once and excludes runtime snapshots from the count', () => {
    const session = fixtureSession();
    session.append('turn/start', { turn: 1 });
    session.append('user/message', message('one'), 'append');
    session.append('assistant/message', assistant('two'), 'append');
    session.append('user/message', message('runtime', {
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
      sections: [],
    }), 'append');
    assert.equal(countOpenTurnNodes(session, 1), 2);

    const reminder = buildTodoStackReminderContext({
      session,
      reminderIntervalNodes: 2,
    });
    assert.match(reminder, /milestone-nodes="2"/);
    assert.match(reminder, /If you think updating the current todo branch would make your work and progress clearer to the user/);
    assert.doesNotMatch(reminder, /if it no longer/);
    session.append('user/message', message(reminder, {
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
      sections: [{ name: TODO_STACK_REMINDER_CONTEXT_NAME, text: reminder }],
    }), 'append');
    assert.equal(latestAnnouncedNodeMilestone(session, 1), 2);
    assert.equal(buildTodoStackReminderContext({
      session,
      reminderIntervalNodes: 2,
    }), '');
  });
});
