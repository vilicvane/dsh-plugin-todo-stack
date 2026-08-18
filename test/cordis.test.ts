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
    assert.ok(names.includes('get_todo_stack'));
    assert.ok(names.includes('update_todo_stack'));

    const assembly = await ctx.systemPrompt.assemble();
    assert.ok(assembly.sections.some((section) => section.name === 'todo-stack:guidance'));

    const session = Session.create(SessionId('session-cordis-smoke'));
    const agentAssembly = await ctx.systemPrompt.assemble({ agent: { session } } as any);
    assert.equal(
      agentAssembly.contexts.find((context) => context.name === 'todo-stack:focus')?.text,
      '',
    );

    const values = ctx.sessionProjections.snapshot(session).values;
    assert.equal(values.todoStack?.revision, 0);
    assert.equal(values.todos, null);
  } finally {
    await ctx.fiber.dispose();
  }
});
