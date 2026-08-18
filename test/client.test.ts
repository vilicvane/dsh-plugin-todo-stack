import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { createElement } from 'react';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { TodoStackState } from '../lib/types.ts';

interface ClientExports {
  apply(ctx: unknown): void;
  inject: string[];
  flattenTodoStack(state: TodoStackState): Array<{ node: { content: string }; depth: number }>;
  TodoStackPanel: ComponentType<{
    state: TodoStackState;
    t: typeof t;
    defaultCollapsed?: boolean;
  }>;
}

const state: TodoStackState = {
  version: 1,
  revision: 4,
  roots: ['root'],
  nodes: {
    root: {
      id: 'root',
      content: 'Ship the plugin',
      parentId: null,
      children: ['active', 'discarded'],
      status: 'pending',
    },
    active: {
      id: 'active',
      content: 'Polish the dock',
      parentId: 'root',
      children: ['done'],
      status: 'pending',
    },
    done: {
      id: 'done',
      content: 'Map the slot contract',
      parentId: 'active',
      children: [],
      status: 'completed',
    },
    discarded: {
      id: 'discarded',
      content: 'Encode depth in title markers',
      parentId: 'root',
      children: [],
      status: 'dropped',
    },
  },
  focusId: 'active',
};

function t(key: string, params: Record<string, unknown> = {}): string {
  const text: Record<string, string> = {
    title: 'Task Stack',
    'focus.current': 'Current: {content}',
    'progress.pending': '{count} pending',
    'progress.completed': '{count} completed',
    'progress.dropped': '{count} dropped',
    'status.focused': 'Current task',
    'status.pending': 'Pending',
    'status.completed': 'Completed',
    'status.dropped': 'Dropped',
  };
  return text[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]));
}

function loadClientModule(): { handoffId: string; exports: ClientExports } {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  let handoff: { id: string; factory: (require: (id: string) => unknown) => ClientExports } | undefined;
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value: typeof handoff) {
          handoff = value;
        },
      },
    },
  });

  assert.ok(handoff);
  const require = createRequire(import.meta.url);
  const exports = handoff.factory((id) => {
    if (id === 'react') return require('react');
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      const Icon = () => null;
      return {
        IconCheckOutline14: Icon,
        IconChevronDownOutline14: Icon,
        IconChevronUpOutline14: Icon,
        IconChecklistOutline14: Icon,
        IconCloseFill14: Icon,
      };
    }
    throw new Error(`unexpected client dependency ${id}`);
  });
  return { handoffId: handoff.id, exports };
}

test('flattens the tree without encoding hierarchy into node content', () => {
  const { exports } = loadClientModule();
  assert.deepEqual(
    Array.from(exports.flattenTodoStack(state), ({ node, depth }) => [node.content, depth]),
    [
      ['Ship the plugin', 0],
      ['Polish the dock', 1],
      ['Map the slot contract', 2],
      ['Encode depth in title markers', 1],
    ],
  );
});

test('renders structured hierarchy, focus, and terminal states', () => {
  const { exports } = loadClientModule();
  const html = renderToStaticMarkup(createElement(exports.TodoStackPanel, {
    state,
    t,
    defaultCollapsed: false,
  }));

  assert.match(html, /data-testid="todo-stack-panel"/);
  assert.match(html, /Current: Polish the dock/);
  assert.match(html, /style="--todo-indent:18px"/);
  assert.match(html, /data-focused="true"/);
  assert.match(html, /data-status="completed"/);
  assert.match(html, /data-status="dropped"/);
  assert.match(html, />Polish the dock</);
  assert.doesNotMatch(html, />[▶×·]+ Polish the dock</);
});

test('shadows the stock todo dock with a lower slot priority', () => {
  const { exports } = loadClientModule();
  let registered: Record<string, unknown> | undefined;
  const ctx = {
    effect(callback: () => unknown) {
      callback();
    },
    locale: {
      register() {
        return () => {};
      },
    },
    slots: {
      inject(name: string, callback: () => unknown) {
        assert.equal(name, 'conversation.input.dock');
        callback();
      },
      register(options: Record<string, unknown>) {
        registered = options;
        return () => {};
      },
    },
  };

  exports.apply(ctx);
  assert.equal(registered?.id, 'todo');
  assert.equal(registered?.order, 0);
  assert.equal(registered?.priority, -10);
  assert.equal(registered?.locale, 'todo-stack');
});

test('built browser module registers the same client plugin', () => {
  const { handoffId, exports } = loadClientModule();
  assert.equal(handoffId, 'dsh-plugin-todo-stack');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale']);
});
