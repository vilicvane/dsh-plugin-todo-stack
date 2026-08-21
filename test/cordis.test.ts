import assert from 'node:assert/strict';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';

import * as todoStackPlugin from '../index.ts';

test('plugin loads through real Cordis services', async () => {
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolRuntime, { mode: 'native' });
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(todoStackPlugin, {});

    const names = ctx.tools.schemas().map((tool) => tool.name);
    assert.ok(names.includes('todo_stack__show'));
    assert.ok(names.includes('todo_stack__create'));
    assert.ok(names.includes('todo_stack__expand'));
    assert.ok(names.includes('todo_stack__focus'));
    assert.ok(names.includes('todo_stack__push'));
    assert.ok(names.includes('todo_stack__complete'));
    assert.ok(names.includes('todo_stack__delete'));
    assert.ok(names.includes('todo_stack__edit'));

    const assembly = await ctx.systemPrompt.assemble();
    assert.ok(assembly.sections.some((section) => section.name === 'todo-stack:guidance'));

    const session = Session.create(SessionId('session-cordis-smoke'));
    const agentAssembly = await ctx.systemPrompt.assemble({ agent: { session } } as any);
    assert.match(
      agentAssembly.sections.find((section) => section.name === 'todo-stack:initial-guidance')?.text ?? '',
      /Before I begin substantive work/,
    );
    assert.equal(
      agentAssembly.contexts.find((context) => context.name === 'todo-stack:focus')?.text,
      '',
    );
    assert.equal(
      agentAssembly.contexts.find((context) => context.name === 'todo-stack:turn-start')?.text,
      '',
    );

    const values = ctx.sessionProjections.snapshot(session).values;
    assert.equal(values.todoStack?.revision, 0);
    assert.equal(values.todos, null);
  } finally {
    await ctx.fiber.dispose();
  }
});
