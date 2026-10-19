import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionEvent } from '@deepseek-ai/dsh-session';

import { todoDockProjection } from '../lib/projection.ts';

test('shares the stock todos projection version used by built-in presets', () => {
  // Built-in agent presets register `@deepseek-ai/dsh-tool-todo` under the same
  // projection key, and the registry rejects differing state versions.
  assert.equal(todoDockProjection().stateVersion, 2);
});

test('renders the stock todo list written by built-in presets', () => {
  const todos = [{ content: 'Ship release', status: 'pending' as const }];

  const state = todoDockProjection().apply(null, {
    type: 'todo/write',
    seq: 1,
    time: 0,
    data: { todos },
  } as SessionEvent);

  assert.deepEqual(state, todos);
});
