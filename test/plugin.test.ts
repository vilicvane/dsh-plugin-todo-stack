import assert from 'node:assert/strict';
import test from 'node:test';

import { Session, SessionId } from '@deepseek-ai/dsh-session';

import { apply } from '../index.ts';
import { foldTodoStack, makeTodoStackCarrier } from '../lib/state.ts';

interface CapturedTool {
  name: string;
  parameters: Record<string, unknown>;
  output: { render(args: unknown, value: any): Array<{ type: string; text: string }> };
  execute(args: any, exec: any): Promise<any>;
}

function harness() {
  const tools = new Map<string, CapturedTool>();
  const projections: any[] = [];
  const sections: any[] = [];
  const contexts: any[] = [];
  const ctx: any = {
    get() { return undefined; },
    tools: {
      register(tool: CapturedTool) { tools.set(tool.name, tool); },
    },
    systemPrompt: {
      section(section: any) { sections.push(section); },
      context(context: any) { contexts.push(context); },
    },
    inject(names: string[], callback: (ctx: any) => void) {
      if (names.includes('sessionProjections')) {
        callback({
          sessionProjections: {
            register(definition: any) { projections.push(definition); },
          },
        });
      }
    },
  };
  apply(ctx);
  return { tools, projections, sections, contexts };
}

test('plugin registers namespaced tools, projections, and directive prompts', () => {
  const captured = harness();
  assert.deepEqual([...captured.tools.keys()], [
    'todo_stack__show',
    'todo_stack__create',
    'todo_stack__expand',
    'todo_stack__focus',
    'todo_stack__push',
    'todo_stack__complete',
    'todo_stack__delete',
    'todo_stack__edit',
  ]);
  assert.deepEqual(captured.tools.get('todo_stack__show')?.parameters, {
    type: 'object',
    properties: {},
  });
  assert.deepEqual(captured.projections.map((item) => item.key), ['todoStack', 'todos']);
  assert.equal(captured.sections.length, 1);
  assert.equal(captured.contexts.length, 4);
  assert.deepEqual(captured.contexts.map((item) => item.name), [
    'todo-stack:initial-guidance',
    'todo-stack:focus',
    'todo-stack:turn-start',
    'todo-stack:no-focus',
  ]);

  const guidance = captured.sections.find((item) => item.name === 'todo-stack:guidance').text;
  assert.match(guidance, /Maintain a persistent todo tree/);
  assert.match(guidance, /ensure that one pending leaf is focused/);
  assert.match(guidance, /user's view/);
  assert.match(guidance, /brief, distinct outcome/);
  assert.match(guidance, /Never copy an ancestor into a descendant/);
  assert.match(guidance, /Before every final response/);
  assert.match(guidance, /Never leave completed work marked pending/);

  const initial = captured.contexts.find((item) => item.name === 'todo-stack:initial-guidance');
  const openingSession = Session.create(SessionId('session-initial-guidance'));
  const text = initial.text({ agent: { session: openingSession } });
  assert.match(text, /Before beginning substantive work/);
  assert.match(text, /compacted turns and sessions/);
  assert.match(text, /Evaluate a suitable drag-and-drop approach \(focus\)/);
  assert.match(text, /one meaningful leaf focused/);
  openingSession.append('turn/start', { turn: 1 });
  openingSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.equal(initial.text({ agent: { session: openingSession } }), '');

  const focusedSession = Session.create(SessionId('session-turn-start-guidance'));
  focusedSession.append('todo/write', makeTodoStackCarrier('create', {
    version: 1,
    revision: 1,
    roots: ['t1'],
    nodes: {
      t1: {
        id: 't1',
        content: 'Continue implementation',
        parentId: null,
        children: [],
        status: 'pending',
      },
    },
    focusId: 't1',
  }));
  focusedSession.append('turn/start', { turn: 1 });
  const turnStart = captured.contexts.find((item) => item.name === 'todo-stack:turn-start');
  const turnStartText = turnStart.text({ agent: { session: focusedSession } });
  assert.match(turnStartText, /Todo Stack check required/);
  assert.match(turnStartText, /\[\*\] means focused and still pending/);
  assert.match(turnStartText, /call todo_stack__complete before giving the final response/);
  assert.match(turnStartText, /Confirm that the focused leaf matches/);
});

test('namespaced tools create, expand, show, complete, and refocus a real Session', async () => {
  const captured = harness();
  const session = Session.create(SessionId('session-plugin-test'));
  const exec = { agent: { session } };
  const create = captured.tools.get('todo_stack__create') as CapturedTool;
  const expand = captured.tools.get('todo_stack__expand') as CapturedTool;
  const show = captured.tools.get('todo_stack__show') as CapturedTool;
  const complete = captured.tools.get('todo_stack__complete') as CapturedTool;
  const focus = captured.tools.get('todo_stack__focus') as CapturedTool;

  const created = await create.execute({
    todo_to_focus: 'Implement feature',
    rest_todos: ['Document feature'],
  }, exec);
  assert.equal(created.revision, 1);
  assert.deepEqual(created.createdIds, ['t1', 't2']);
  assert.equal(created.focusId, 't1');
  const createdText = create.output.render({}, created)[0].text;
  assert.match(createdText, /Todo stack \(revision 1\):/);
  assert.match(createdText, /If its text includes checks or a sequence/);
  assert.match(createdText, /only when the root contains two or more independent child outcomes/);
  assert.match(createdText, /if it is blocked, keep it pending and call todo_stack__edit/);

  const expanded = await expand.execute({
    id: 't1',
    sub_todo_to_focus: 'Implement API',
    rest_todos: ['Implement UI'],
  }, exec);
  assert.equal(expanded.revision, 2);
  assert.deepEqual(expanded.createdIds, ['t3', 't4']);
  assert.equal(expanded.focusId, 't3');

  const tree = await show.execute({}, exec);
  assert.equal(tree.revision, 2);
  assert.equal(tree.focusId, 't3');
  assert.equal(tree.roots.length, 2);
  assert.deepEqual(tree.roots[0].children.map((node: any) => node.id), ['t3', 't4']);

  const completed = await complete.execute({ id: 't3' }, exec);
  assert.equal(completed.revision, 3);
  assert.equal(completed.focusId, null);
  const completedText = complete.output.render({}, completed)[0].text;
  assert.match(completedText, /- \[x\] t3 Implement API/);
  assert.match(completedText, /- \[ \] t4 Implement UI/);
  assert.doesNotMatch(completedText, /two or more independent outcomes/);
  const refocused = await focus.execute({ id: 't4' }, exec);
  assert.equal(refocused.revision, 4);
  assert.equal(refocused.focusId, 't4');
  assert.doesNotMatch(focus.output.render({}, refocused)[0].text, /two or more independent outcomes/);
  assert.equal(foldTodoStack(session.snapshotEvents()).revision, 4);
});

test('push failure recommends expand and delete cascades through a focused subtree', async () => {
  const captured = harness();
  const session = Session.create(SessionId('session-tool-errors'));
  const exec = { agent: { session } };
  await (captured.tools.get('todo_stack__create') as CapturedTool).execute({
    todo_to_focus: 'Root',
    rest_todos: [],
  }, exec);

  await assert.rejects(
    (captured.tools.get('todo_stack__push') as CapturedTool).execute({
      id: 't1',
      todo: 'Child',
      focus: false,
    }, exec),
    /use todo_stack__expand/,
  );

  await (captured.tools.get('todo_stack__expand') as CapturedTool).execute({
    id: 't1',
    sub_todo_to_focus: 'Child',
    rest_todos: [],
  }, exec);
  const deleted = await (captured.tools.get('todo_stack__delete') as CapturedTool)
    .execute({ id: 't1' }, exec);
  assert.equal(deleted.focusId, null);
  assert.deepEqual(foldTodoStack(session.snapshotEvents()).nodes, {});
});

test('focus context is frozen for a turn while mutation results carry live revisions', async () => {
  const captured = harness();
  const session = Session.create(SessionId('session-turn-context-test'));
  const create = captured.tools.get('todo_stack__create') as CapturedTool;
  const expand = captured.tools.get('todo_stack__expand') as CapturedTool;
  const focusContext = captured.contexts.find((item) => item.name === 'todo-stack:focus');
  const exec = { agent: { session } };

  session.append('turn/start', { turn: 1 });
  assert.equal(focusContext.text({ agent: { session } }), '');
  const root = await create.execute({ todo_to_focus: 'Root', rest_todos: [] }, exec);
  assert.match(create.output.render({}, root)[0].text, /Todo stack \(revision 1\):/);
  assert.equal(focusContext.text({ agent: { session } }), '');

  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  session.append('turn/start', { turn: 2 });
  assert.match(focusContext.text({ agent: { session } }), /Todo stack \(revision 1\):/);
  const child = await expand.execute({
    id: 't1',
    sub_todo_to_focus: 'Child',
    rest_todos: [],
  }, exec);
  assert.match(expand.output.render({}, child)[0].text, /Todo stack \(revision 2\):/);
  assert.equal(focusContext.text({ agent: { session } }), '');
});

test('tools accept the displayed prefix of a legacy node id', async () => {
  const captured = harness();
  const session = Session.create(SessionId('session-legacy-id-test'));
  const legacyId = 'b05aefee-2946-4542-9f0e-bdae28926d39';
  session.append('todo/write', makeTodoStackCarrier('create', {
    version: 1,
    revision: 1,
    roots: [legacyId],
    nodes: {
      [legacyId]: {
        id: legacyId,
        content: 'Legacy root',
        parentId: null,
        children: [],
        status: 'pending',
      },
    },
    focusId: legacyId,
  }));

  const result = await (captured.tools.get('todo_stack__edit') as CapturedTool).execute({
    id: 'b05aef',
    todo: 'Edited legacy root',
  }, { agent: { session } });
  assert.equal(result.affectedId, 'b05aef');
  assert.equal(foldTodoStack(session.snapshotEvents()).nodes[legacyId].content, 'Edited legacy root');
});

test('todo projections persist across turn boundaries', async () => {
  const captured = harness();
  const session = Session.create(SessionId('session-projection-test'));
  await (captured.tools.get('todo_stack__create') as CapturedTool).execute({
    todo_to_focus: 'Root',
    rest_todos: [],
  }, { agent: { session } });

  const stackProjection = captured.projections.find((item) => item.key === 'todoStack');
  const dockProjection = captured.projections.find((item) => item.key === 'todos');
  let stack = stackProjection.init();
  let dock = dockProjection.init();
  for (const event of session.snapshotEvents()) {
    stack = stackProjection.apply(stack, event);
    dock = dockProjection.apply(dock, event);
  }
  const turnStart = { type: 'turn/start', data: { turn: 2 } };
  assert.strictEqual(stackProjection.apply(stack, turnStart), stack);
  assert.strictEqual(dockProjection.apply(dock, turnStart), dock);
  assert.equal(stack.revision, 1);
  assert.equal(dock[0].status, 'in_progress');
});
