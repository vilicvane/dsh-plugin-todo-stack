import assert from 'node:assert/strict';
import test from 'node:test';

import { Session, SessionId } from '@deepseek-ai/dsh-session';

import { apply } from '../index.ts';
import { foldTodoStack, makeTodoStackCarrier } from '../lib/state.ts';

interface CapturedTool {
  name: string;
  output: { render(args: unknown, value: any): Array<{ type: string; text: string }> };
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
  assert.equal(captured.contexts.length, 2);
  const guidance = captured.sections[0].text;
  assert.match(guidance, /Add and focus a direct child/);
  assert.match(guidance, /unless the focused task will finish in the next few actions/);
  assert.match(guidance, /helps the user understand what you are doing and how the work is progressing/);
  assert.match(guidance, /Keep each node to one short outcome/);
  assert.ok(guidance.length < 700, 'todo-stack guidance should stay concise');
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
    content: 'Implement feature',
  }, exec);
  assert.equal(first.revision, 1);
  assert.equal(typeof first.focusId, 'string');
  const renderedUpdate = update.output.render({}, first).map((block) => block.text).join('\n');
  assert.match(renderedUpdate, /Add and focus one direct child now/);
  assert.match(renderedUpdate, /unless the focused task will finish in the next few actions/);
  assert.match(renderedUpdate, /helps the user understand your progress/);

  await assert.rejects(
    update.execute({ expected_revision: 0, action: 'exit' }, exec),
    /stale todo stack revision/,
  );

  const view = await read.execute({ depth: 2 }, exec);
  assert.equal(view.revision, 1);
  assert.equal(view.nodes[0].content, 'Implement feature');
  const renderedRead = read.output.render({}, view).map((block) => block.text).join('\n');
  assert.match(renderedRead, /Add and focus one direct child now/);

  const context = captured.contexts.find((item) => item.name === 'todo-stack:focus')
    .text({ agent: { session } });
  assert.match(context, /- \[ \] t1 Implement feature（进行中）/);
  assert.match(context, /revision="1"/);
  assert.equal(foldTodoStack(session.events).revision, 1);

  const completed = await update.execute({ expected_revision: 1, action: 'complete' }, exec);
  const renderedComplete = update.output.render({}, completed).map((block) => block.text).join('\n');
  assert.doesNotMatch(renderedComplete, /Add and focus one direct child now/,
    'an ended stack should not ask for another child');
});

test('tools accept the displayed prefix of a legacy node id', async () => {
  const captured = harness();
  const session = Session.create(SessionId('session-legacy-id-test'));
  const legacyId = 'b05aefee-2946-4542-9f0e-bdae28926d39';
  const legacy = {
    version: 1 as const,
    revision: 1,
    roots: [legacyId],
    nodes: {
      [legacyId]: {
        id: legacyId,
        content: 'Legacy root',
        parentId: null,
        children: [],
        status: 'pending' as const,
      },
    },
    focusId: legacyId,
  };
  session.append('todo/write', makeTodoStackCarrier('push', legacy));

  const update = captured.tools.get('update_todo_stack') as CapturedTool;
  const read = captured.tools.get('get_todo_stack') as CapturedTool;
  const result = await update.execute({
    expected_revision: 1,
    action: 'edit',
    id: 'b05aef',
    content: 'Edited legacy root',
  }, { agent: { session } });

  assert.equal(result.affectedId, 'b05aef');
  assert.equal(foldTodoStack(session.events).nodes[legacyId].content, 'Edited legacy root');
  const view = await read.execute({}, { agent: { session } });
  assert.equal(view.focusId, 'b05aef');
  assert.equal(view.nodes[0].id, 'b05aef');
});

test('todo projections persist across turn boundaries', async () => {
  const captured = harness();
  const session = Session.create(SessionId('session-projection-test'));
  const update = captured.tools.get('update_todo_stack') as CapturedTool;
  await update.execute({ expected_revision: 0, action: 'push', content: 'Root' }, {
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
