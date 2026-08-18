import assert from 'node:assert/strict';
import test from 'node:test';

import { Session, SessionId } from '@deepseek-ai/dsh-session';

import { apply } from '../index.ts';
import { foldTodoStack } from '../lib/state.ts';

interface CapturedTool {
  name: string;
  execute(args: any, exec: any): Promise<any>;
}

function harness() {
  const tools = new Map<string, CapturedTool>();
  const projections: any[] = [];
  const sections: any[] = [];
  const contexts: any[] = [];
  const ctx: any = {
    get() {
      return undefined;
    },
    tools: {
      register(tool: CapturedTool) {
        tools.set(tool.name, tool);
      },
    },
    systemPrompt: {
      section(section: any) {
        sections.push(section);
      },
      context(context: any) {
        contexts.push(context);
      },
    },
    inject(names: string[], callback: (ctx: any) => void) {
      if (names.includes('sessionProjections')) {
        callback({
          sessionProjections: {
            register(definition: any) {
              projections.push(definition);
            },
          },
        });
      }
    },
  };
  apply(ctx);
  return { ctx, tools, projections, sections, contexts };
}

test('plugin registers tools, projections, and prompt contributions', () => {
  const captured = harness();
  assert.deepEqual([...captured.tools.keys()], ['get_todo_stack', 'update_todo_stack']);
  assert.deepEqual(captured.projections.map((item) => item.key), ['todoStack', 'todos']);
  assert.equal(captured.sections.length, 1);
  assert.equal(captured.contexts.length, 1);
});

test('tools mutate a real Session, enforce revisions, and render focus context', async () => {
  const captured = harness();
  const session = Session.create(SessionId('session-plugin-test'));
  const exec = { agent: { session } };
  const update = captured.tools.get('update_todo_stack') as CapturedTool;
  const read = captured.tools.get('get_todo_stack') as CapturedTool;

  const first = await update.execute({
    expected_revision: 0,
    action: 'push',
    title: 'Implement feature',
  }, exec);
  assert.equal(first.revision, 1);
  assert.equal(typeof first.focusId, 'string');

  await assert.rejects(
    update.execute({ expected_revision: 0, action: 'exit' }, exec),
    /stale todo stack revision/,
  );

  const view = await read.execute({ depth: 2 }, exec);
  assert.equal(view.revision, 1);
  assert.equal(view.nodes[0].title, 'Implement feature');

  const context = captured.contexts[0].text({ agent: { session } });
  assert.match(context, /Focus path: Implement feature/);
  assert.match(context, /revision="1"/);
  assert.equal(foldTodoStack(session.events).revision, 1);
});

test('todo projections persist across turn boundaries', async () => {
  const captured = harness();
  const session = Session.create(SessionId('session-projection-test'));
  const update = captured.tools.get('update_todo_stack') as CapturedTool;
  await update.execute({ expected_revision: 0, action: 'push', title: 'Root' }, {
    agent: { session },
  });

  const stackProjection = captured.projections.find((item) => item.key === 'todoStack');
  const dockProjection = captured.projections.find((item) => item.key === 'todos');
  let stack = stackProjection.init();
  let dock = dockProjection.init();
  for (const event of session.events) {
    stack = stackProjection.apply(stack, event);
    dock = dockProjection.apply(dock, event);
  }
  const turnStart = { type: 'turn/start', data: { turn: 2 } };
  assert.strictEqual(stackProjection.apply(stack, turnStart), stack);
  assert.strictEqual(dockProjection.apply(dock, turnStart), dock);
  assert.equal(stack.revision, 1);
  assert.equal(dock[0].status, 'in_progress');
});
