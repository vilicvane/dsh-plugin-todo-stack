import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { foldTodoStack, todoDockItems } from '../lib/state.ts';
import type { TodoStackState } from '../lib/types.ts';

const name = 'todo-stack-e2e-runner';
const inject = ['agentDefaultModel', 'agents', 'sessionProjections', 'sessions', 'tools'];

const ROOT_CONTENT = 'E2E root cobalt 771';
const CHILD_CONTENT = 'E2E child gamma 194';
const SIBLING_CONTENT = 'E2E sibling delta 508';
const NEXT_CONTENT = 'E2E next phase amber 620';
const PROBE_TOOL_NAME = 'todo_stack_e2e_probe';
const TODO_TOOLS = [
  'todo_stack__show',
  'todo_stack__create',
  'todo_stack__expand',
  'todo_stack__focus',
  'todo_stack__push',
  'todo_stack__complete',
  'todo_stack__delete',
  'todo_stack__edit',
] as const;
const ALLOWED_TOOLS = [...TODO_TOOLS, PROBE_TOOL_NAME];

function todoWrites(session: any): any[] {
  return session.events.filter((event: any) =>
    event.type === 'todo/write'
      && event.data?.todoStack?.kind === 'dsh-plugin-todo-stack');
}

function toolCalls(session: any): any[] {
  return session.events.filter((event: any) => event.type === 'tool/call');
}

function contextSections(session: any, name: string): any[] {
  return session.events.flatMap((event: any) => {
    if (event.type !== 'user/message'
      || event.data?.source?.kind !== 'plugin'
      || event.data.source.plugin !== '@deepseek-ai/dsh-system-prompt'
      || event.data.source.form !== 'snapshot') return [];
    return event.data.source.sections.filter((section: any) => section.name === name);
  });
}

function toolResultsFor(session: any, toolName: string): any[] {
  const callIds = new Set(session.events
    .filter((event: any) => event.type === 'tool/call' && event.data?.name === toolName)
    .map((event: any) => event.data.callId));
  return session.events.filter((event: any) =>
    event.type === 'tool/result' && callIds.has(event.data?.message?.source?.callId));
}

function toolResultText(result: any): string {
  const chunks: string[] = [];
  const visit = (value: any): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (value.type === 'text' && typeof value.text === 'string') chunks.push(value.text);
    if (Object.hasOwn(value, 'content')) visit(value.content);
  };
  visit(result?.data?.message?.content ?? []);
  return chunks.join('\n');
}

function projectedState(projections: any, session: any): TodoStackState {
  const snapshot = projections.snapshot(session);
  const state = snapshot.values.todoStack;
  assert.ok(state, 'todoStack projection is missing');
  assert.deepEqual(state, foldTodoStack(session.events), 'projection must equal a full event replay');
  assert.deepEqual(snapshot.values.todos, todoDockItems(state), 'TodoDock projection must match the tree snapshot');
  return state;
}

function assertOperations(session: any, expected: string[], phase: string): void {
  assert.deepEqual(
    todoWrites(session).map((event: any) => event.data.todoStack.operation),
    expected,
    `${phase}: unexpected durable mutation sequence`,
  );
}

function assertVisibleTools(session: any, phase: string): void {
  const visible = new Set((session.requestHeader()?.tools ?? []).map((tool: any) => tool.name));
  for (const tool of ALLOWED_TOOLS) assert.ok(visible.has(tool), `${phase}: ${tool} is missing`);
  assert.ok(!visible.has('update_todo_stack'), `${phase}: obsolete update_todo_stack must be absent`);
  assert.ok(!visible.has('get_todo_stack'), `${phase}: obsolete get_todo_stack must be absent`);
  assert.ok(!visible.has('todo_write'), `${phase}: stock flat todo tool must remain absent`);
}

async function followup(agent: any, text: string): Promise<void> {
  agent.followup({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  });
  await agent.whenIdle();
}

async function run(ctx: any): Promise<void> {
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const projections = ctx.get('sessionProjections');
  const sessions = ctx.get('sessions');
  const defaultModel = ctx.get('agentDefaultModel');
  if (agents === undefined || projections === undefined || sessions === undefined || defaultModel === undefined) {
    throw new Error('required DSH services are missing');
  }

  const selection = defaultModel.currentSelection();
  let probeCalls = 0;
  ctx.tools.register(defineTool({
    name: PROBE_TOOL_NAME,
    description: 'Deterministic external-tool probe for the todo-stack E2E.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    async execute() {
      probeCalls += 1;
      return 'probe complete; continue the exact requested sequence';
    },
  }));
  const setup = (agentCtx: any) => {
    installModelSelection(agentCtx, { current: { ...selection }, assembled: undefined });
    agentCtx.tools.presentAs('native');
    agentCtx.tools.restrict({ allow: ALLOWED_TOOLS });
    agentCtx.systemPrompt.section({
      name: 'todo-stack:e2e-protocol',
      order: 149,
      text: 'This is a deterministic todo-stack integration test. Perform exactly the requested tool calls in order, never repeat a recorded call, and make no extra tree mutation. Runtime-context reminders continue the same sequence rather than restarting it.',
      complete: true,
    });
  };

  let liveHandle: any;
  let recoveryHandle: any;
  let coldHandle: any;
  try {
    liveHandle = await agents.create({
      sessionId: `session-todo-stack-e2e-${randomUUID()}`,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await liveHandle.agent.whenIdle();

    await followup(
      liveHandle.agent,
      `Call todo_stack__create exactly once with todo_to_focus "${ROOT_CONTENT}" and rest_todos []. Then call ${PROBE_TOOL_NAME} exactly once. Reply briefly and make no other tool call.`,
    );
    let state = projectedState(projections, liveHandle.agent.session);
    assert.equal(state.revision, 1);
    assert.deepEqual(state.roots, ['t1']);
    assert.equal(state.nodes.t1.content, ROOT_CONTENT);
    assert.equal(state.focusId, 't1');
    assert.equal(probeCalls, 1);
    assert.equal(
      contextSections(liveHandle.agent.session, 'todo-stack:initial-guidance').length,
      1,
      'complete persona must not suppress the opening todo-stack runtime context',
    );
    assertOperations(liveHandle.agent.session, ['create'], 'create turn');
    assertVisibleTools(liveHandle.agent.session, 'live session');
    const createdText = toolResultText(toolResultsFor(liveHandle.agent.session, 'todo_stack__create')[0]);
    assert.match(createdText, /- \[\*\] t1 E2E root cobalt 771/);

    await followup(
      liveHandle.agent,
      `Perform exactly these calls in order: todo_stack__expand with id "t1", sub_todo_to_focus "${CHILD_CONTENT}", rest_todos ["${SIBLING_CONTENT}"]; todo_stack__complete with id "t2". Then reply briefly about the completed child and make no other tool call in this turn.`,
    );
    state = projectedState(projections, liveHandle.agent.session);
    assert.equal(state.revision, 3);
    assert.equal(state.nodes.t2.status, 'completed');
    assert.equal(state.nodes.t3.status, 'pending');
    assert.equal(state.focusId, null);
    assertOperations(liveHandle.agent.session, ['create', 'expand', 'complete'], 'leaf completion');
    const completedText = toolResultText(
      toolResultsFor(liveHandle.agent.session, 'todo_stack__complete')[0],
    );
    assert.match(completedText, /- \[x\] t2 E2E child gamma 194/);
    assert.match(completedText, /- \[ \] t3 E2E sibling delta 508/);
    assert.equal(toolResultsFor(liveHandle.agent.session, 'todo_stack__show').length, 0);
    assert.ok(
      contextSections(liveHandle.agent.session, 'todo-stack:turn-start').some((section: any) =>
        /Todo Stack check required/.test(section.text)),
      'a later focused turn must receive the turn-start reflection',
    );
    assert.ok(
      contextSections(liveHandle.agent.session, 'todo-stack:no-focus').some((section: any) =>
        /Todo Stack action required/.test(section.text)),
      'completion must produce a durable no-focus guard before refocus',
    );

    await followup(
      liveHandle.agent,
      'Call todo_stack__focus exactly once with id "t3". Then reply briefly and make no other tool call.',
    );
    state = projectedState(projections, liveHandle.agent.session);
    assert.equal(state.revision, 4);
    assert.equal(state.focusId, 't3');
    assertOperations(liveHandle.agent.session, ['create', 'expand', 'complete', 'focus'], 'leaf workflow');

    const sessionId = liveHandle.agent.session.id;
    const beforeResumeSeq = liveHandle.agent.session.seq;
    const beforeResumeMutationSeqs = todoWrites(liveHandle.agent.session).map((event: any) => event.seq);
    await sessions.flush(liveHandle.agent.session);
    await liveHandle.dispose();
    liveHandle = undefined;

    recoveryHandle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await recoveryHandle.agent.whenIdle();
    assert.deepEqual(
      recoveryHandle.agent.session.events.slice(beforeResumeSeq).map((event: any) => event.type),
      ['session/end-seed'],
    );
    assert.deepEqual(
      todoWrites(recoveryHandle.agent.session).map((event: any) => event.seq),
      beforeResumeMutationSeqs,
    );
    state = projectedState(projections, recoveryHandle.agent.session);
    assert.equal(state.revision, 4);
    assert.equal(state.focusId, 't3');

    await followup(
      recoveryHandle.agent,
      'Call todo_stack__show with no arguments. Then call todo_stack__complete with id "t3", followed by todo_stack__complete with id "t1". Reply briefly and make no other tool call.',
    );
    state = projectedState(projections, recoveryHandle.agent.session);
    assert.equal(state.revision, 6);
    assert.equal(state.nodes.t1.status, 'completed');
    assert.equal(state.nodes.t3.status, 'completed');
    assert.equal(state.focusId, null);
    assert.equal(toolResultsFor(recoveryHandle.agent.session, 'todo_stack__show').length, 1);
    const shown = toolResultText(toolResultsFor(recoveryHandle.agent.session, 'todo_stack__show')[0]);
    assert.match(shown, /"todo":"E2E root cobalt 771"/);
    assert.match(shown, /"todo":"E2E sibling delta 508"/);

    await followup(
      recoveryHandle.agent,
      `Call todo_stack__create with todo_to_focus "${NEXT_CONTENT}" and rest_todos []. Then call todo_stack__delete with id "t4". Reply briefly and make no other tool call.`,
    );
    state = projectedState(projections, recoveryHandle.agent.session);
    assert.equal(state.revision, 8);
    assert.equal(state.nodes.t4, undefined);
    assert.equal(state.focusId, null);
    assertOperations(
      recoveryHandle.agent.session,
      ['create', 'expand', 'complete', 'focus', 'complete', 'complete', 'create', 'delete'],
      'recovered completion and delete',
    );
    assertVisibleTools(recoveryHandle.agent.session, 'recovered session');

    const expectedSeq = recoveryHandle.agent.session.seq;
    const expectedMutationSeqs = todoWrites(recoveryHandle.agent.session).map((event: any) => event.seq);
    await sessions.flush(recoveryHandle.agent.session);
    await recoveryHandle.dispose();
    recoveryHandle = undefined;

    coldHandle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await coldHandle.agent.whenIdle();
    assert.deepEqual(
      coldHandle.agent.session.events.slice(expectedSeq).map((event: any) => event.type),
      ['session/end-seed'],
    );
    assert.deepEqual(
      todoWrites(coldHandle.agent.session).map((event: any) => event.seq),
      expectedMutationSeqs,
    );
    state = projectedState(projections, coldHandle.agent.session);
    assert.equal(state.revision, 8);
    assert.equal(state.focusId, null);
    assert.equal(state.nodes.t1.status, 'completed');
    assert.equal(state.nodes.t4, undefined);

    const artifactDir = resolve(process.env.TODO_STACK_E2E_ARTIFACT_DIR ?? '.tmp');
    const artifactPath = resolve(artifactDir, `e2e-${sessionId}.json`);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify({
      sessionId,
      finalSeq: coldHandle.agent.session.seq,
      state,
      todoDock: projections.snapshot(coldHandle.agent.session).values.todos,
      operations: todoWrites(coldHandle.agent.session).map((event: any) => ({
        seq: event.seq,
        operation: event.data.todoStack.operation,
        revision: event.data.todoStack.state.revision,
      })),
      toolCalls: toolCalls(coldHandle.agent.session).map((event: any) => ({
        seq: event.seq,
        name: event.data.name,
        arguments: event.data.arguments,
      })),
      focusContexts: contextSections(coldHandle.agent.session, 'todo-stack:focus'),
      turnStartContexts: contextSections(coldHandle.agent.session, 'todo-stack:turn-start'),
      noFocusContexts: contextSections(coldHandle.agent.session, 'todo-stack:no-focus'),
    }, null, 2)}\n`, 'utf8');

    console.log(`E2E_SESSION_ID=${sessionId}`);
    console.log(`E2E_FINAL_REVISION=${state.revision}`);
    console.log(`E2E_MUTATIONS=${todoWrites(coldHandle.agent.session).length}`);
    console.log('E2E_COLD_RESUMES=2');
    console.log(`E2E_ARTIFACT_PATH=${artifactPath}`);
    console.log('E2E_RESULT=PASS');
  } finally {
    if (coldHandle !== undefined) await coldHandle.dispose();
    if (recoveryHandle !== undefined) await recoveryHandle.dispose();
    if (liveHandle !== undefined) await liveHandle.dispose();
  }
}

function apply(ctx: any): void {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('todo-stack-e2e-runner requires the headless appExit service');
  run(ctx).then(
    () => exit(0),
    (error) => {
      console.error('E2E_RESULT=FAIL');
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      exit(1);
    },
  );
}

export { apply, inject, name };
