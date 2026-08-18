import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installModelSelection } from '@deepseek-ai/dsh-agent';

import {
  foldTodoStack,
  todoDockItems,
} from '../lib/state.ts';
import type { TodoStackState } from '../lib/types.ts';

const name = 'todo-stack-e2e-runner';
const inject = ['agentDefaultModel', 'agents', 'sessionProjections', 'sessions', 'tools'];

const ROOT_TITLE = 'E2E root cobalt 771';
const CHILD_TITLE = 'E2E child gamma 194';
const ALLOWED_TOOLS = ['get_todo_stack', 'update_todo_stack'];

function todoWrites(session: any): any[] {
  return session.events.filter((event: any) =>
    event.type === 'todo/write'
      && event.data?.todoStack?.kind === 'dsh-plugin-todo-stack');
}

function toolCalls(session: any): any[] {
  return session.events.filter((event: any) => event.type === 'tool/call');
}

function logPhase(session: any, phase: string): void {
  console.log(`E2E_PHASE=${phase} ${JSON.stringify({
    seq: session.seq,
    operations: todoWrites(session).map((event: any) => event.data.todoStack.operation),
    toolCalls: toolCalls(session).map((event: any) => event.data.name),
    tail: session.events.slice(-6).map((event: any) => event.type),
  })}`);
}

function runtimeContextSections(session: any): any[] {
  return session.events.flatMap((event: any) => {
    if (
      event.type !== 'user/message'
      || event.data?.source?.kind !== 'plugin'
      || event.data.source.plugin !== '@deepseek-ai/dsh-system-prompt'
      || event.data.source.form !== 'snapshot'
    ) return [];
    return event.data.source.sections.filter((section: any) => section.name === 'todo-stack:focus');
  });
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

function assertRuntimeRevision(session: any, revision: number, phase: string): void {
  const expected = `<todo-stack revision="${revision}">`;
  assert.ok(
    runtimeContextSections(session).some((section: any) => section.text.includes(expected)),
    `${phase}: no durable runtime-context snapshot exposed revision ${revision}`,
  );
}

function assertVisibleTools(session: any, phase: string): void {
  const visible = new Set((session.requestHeader()?.tools ?? []).map((tool: any) => tool.name));
  for (const tool of ALLOWED_TOOLS) {
    assert.ok(visible.has(tool), `${phase}: ${tool} is missing from the model request`);
  }
  assert.ok(!visible.has('todo_write'), `${phase}: the stock flat todo tool must remain absent`);
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
  const setup = (agentCtx: any) => {
    installModelSelection(agentCtx, {
      current: { ...selection },
      assembled: undefined,
    });
    agentCtx.tools.presentAs('native');
    agentCtx.tools.restrict({ allow: ALLOWED_TOOLS });
    agentCtx.systemPrompt.section({
      name: 'todo-stack:e2e-protocol',
      order: 149,
      text: 'This session is a deterministic todo-stack integration test. Follow each user-requested tool sequence exactly, use the supplied revisions and ids literally, perform no extra tree mutations, and stop after the requested calls.',
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
    const liveAgent = liveHandle.agent;
    await liveAgent.whenIdle();

    await followup(
      liveAgent,
      `Call update_todo_stack exactly once with expected_revision 0, action "push", and title "${ROOT_TITLE}". Then reply briefly without calling another tool.`,
    );
    logPhase(liveAgent.session, 'root-turn');
    let state = projectedState(projections, liveAgent.session);
    assert.equal(state.revision, 1, 'root push must produce revision 1');
    assert.equal(state.roots.length, 1, 'root push must create one root');
    const rootId = state.roots[0];
    assert.equal(state.nodes[rootId]?.title, ROOT_TITLE);
    assert.equal(state.focusId, rootId);
    assertOperations(liveAgent.session, ['push'], 'root turn');
    assertRuntimeRevision(liveAgent.session, 1, 'root turn');

    await followup(
      liveAgent,
      `Perform exactly these two update_todo_stack calls in order. First: expected_revision 1, action "push", title "${CHILD_TITLE}". After that succeeds, second: expected_revision 2, action "exit". Then reply briefly and make no other tool call.`,
    );
    state = projectedState(projections, liveAgent.session);
    const childId = state.nodes[rootId]?.children[0];
    assert.ok(childId, 'child push must create a child under the root');
    assert.equal(state.revision, 3);
    assert.equal(state.nodes[childId]?.title, CHILD_TITLE);
    assert.equal(state.focusId, rootId, 'exit must return focus to the root');
    assertOperations(liveAgent.session, ['push', 'push', 'exit'], 'nested turn');
    assertRuntimeRevision(liveAgent.session, 3, 'nested turn');
    assertVisibleTools(liveAgent.session, 'live session');

    const sessionId = liveAgent.session.id;
    const beforeResumeSeq = liveAgent.session.seq;
    const beforeResumeMutationSeqs = todoWrites(liveAgent.session).map((event: any) => event.seq);
    await sessions.flush(liveAgent.session);
    await liveHandle.dispose();
    liveHandle = undefined;

    recoveryHandle = await agents.resume({
      resumeSessionId: sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await recoveryHandle.agent.whenIdle();
    logPhase(recoveryHandle.agent.session, 'first-resume-idle');
    assert.deepEqual(
      recoveryHandle.agent.session.events.slice(beforeResumeSeq).map((event: any) => event.type),
      ['session/end-seed'],
      'resume may append only its durable seed boundary while idle',
    );
    assert.deepEqual(
      todoWrites(recoveryHandle.agent.session).map((event: any) => event.seq),
      beforeResumeMutationSeqs,
      'resume must not append or duplicate todo mutations while idle',
    );
    state = projectedState(projections, recoveryHandle.agent.session);
    assert.equal(state.revision, 3, 'first cold resume must restore revision 3');
    assert.equal(state.focusId, rootId);
    assertOperations(recoveryHandle.agent.session, ['push', 'push', 'exit'], 'first resume');

    await followup(
      recoveryHandle.agent,
      `Perform exactly these calls in order. First call get_todo_stack with no arguments. Then call update_todo_stack with expected_revision 3, action "focus", id "${childId}". Then call update_todo_stack with expected_revision 4 and action "complete". Reply briefly and make no other tool call.`,
    );
    state = projectedState(projections, recoveryHandle.agent.session);
    assert.equal(state.revision, 5);
    assert.equal(state.nodes[childId]?.status, 'completed');
    assert.equal(state.focusId, rootId, 'completing the child must return to the root');
    assertOperations(recoveryHandle.agent.session, ['push', 'push', 'exit', 'focus', 'complete'], 'child completion');
    assertRuntimeRevision(recoveryHandle.agent.session, 5, 'child completion');
    assert.equal(
      toolCalls(recoveryHandle.agent.session).filter((event: any) => event.data.name === 'get_todo_stack').length,
      1,
      'read tool must run exactly once',
    );

    await followup(
      recoveryHandle.agent,
      'Call update_todo_stack exactly once with expected_revision 5 and action "complete". Then reply briefly without calling another tool.',
    );
    state = projectedState(projections, recoveryHandle.agent.session);
    assert.equal(state.revision, 6);
    assert.equal(state.nodes[rootId]?.status, 'completed');
    assert.equal(state.focusId, null);
    assertOperations(recoveryHandle.agent.session, ['push', 'push', 'exit', 'focus', 'complete', 'complete'], 'root completion');
    assertRuntimeRevision(recoveryHandle.agent.session, 6, 'root completion');
    assertVisibleTools(recoveryHandle.agent.session, 'recovered session');

    const expectedSeq = recoveryHandle.agent.session.seq;
    const expectedMutationSeqs = todoWrites(recoveryHandle.agent.session).map((event: any) => event.seq);
    const expectedToolCalls = toolCalls(recoveryHandle.agent.session).map((event: any) => ({
      seq: event.seq,
      name: event.data.name,
      arguments: event.data.arguments,
    }));
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
      'second cold resume may append only its durable seed boundary while idle',
    );
    assert.deepEqual(
      todoWrites(coldHandle.agent.session).map((event: any) => event.seq),
      expectedMutationSeqs,
      'second cold resume must not append or duplicate todo mutations',
    );
    state = projectedState(projections, coldHandle.agent.session);
    assert.equal(state.revision, 6);
    assert.equal(state.focusId, null);
    assert.equal(state.nodes[rootId]?.status, 'completed');
    assert.equal(state.nodes[childId]?.status, 'completed');
    assertOperations(coldHandle.agent.session, ['push', 'push', 'exit', 'focus', 'complete', 'complete'], 'second resume');

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
      toolCalls: expectedToolCalls,
      runtimeContexts: runtimeContextSections(coldHandle.agent.session),
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
