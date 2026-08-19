import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  emptyTodoStack,
  foldTodoStack,
  makeTodoStackCarrier,
  mutateTodoStack,
} from '../lib/state.ts';

const name = 'todo-stack-prompt-eval-runner';
const inject = ['agentDefaultModel', 'agents', 'sessions'];

const PROBE_TOOL = 'inspect_release_area';
const SCENARIOS = [
  'tracked_release',
  'trivial_direct',
  'blocked_release',
  'existing_focus',
] as const;
type Scenario = typeof SCENARIOS[number];

interface CheckResult {
  pass: boolean;
  detail: string;
}

interface RunResult {
  scenario: Scenario;
  repetition: number;
  sessionId: string;
  elapsedMs: number;
  requestFingerprint: string | null;
  checks: Record<string, CheckResult>;
  passed: boolean;
  toolCalls: Array<{ seq: number; name: string; arguments: any }>;
  operations: Array<{ seq: number; action: string }>;
  state: ReturnType<typeof foldTodoStack>;
  finalText: string;
  error?: string;
}

interface ScenarioRuntime {
  inspected: string[];
  seededOperationCount: number;
}

const scenarioPrompt: Record<Scenario, string> = {
  tracked_release: `Assess whether release cobalt is ready. Inspect the api and storage areas separately with ${PROBE_TOOL}, then use its verify area to validate the combined decision. Report a concise conclusion containing every returned COBALT evidence code. Carry out the checks yourself rather than asking me to do them.`,
  trivial_direct: 'Reply with exactly COBALT-PONG and nothing else. This is a direct answer: do not use any tool.',
  blocked_release: `Assess whether blocked release cobalt can proceed by calling ${PROBE_TOOL} once with area blocked. If it reports missing external input, stop work without retrying or inventing the input, preserve the task as pending, and ask me for what is needed. Include the returned COBALT evidence code.`,
  existing_focus: `Within the currently focused release task, assess cobalt readiness as one distinct subtask. Inspect api and storage separately with ${PROBE_TOOL}, then use its verify area. Complete only the readiness subtask, leave the broader release task pending, and report every returned COBALT evidence code.`,
};

function textOf(value: unknown): string {
  const chunks: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      chunks.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (current === null || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') chunks.push(record.text);
    if (Object.hasOwn(record, 'content')) visit(record.content);
  };
  visit(value);
  return chunks.join('\n');
}

function parseToolArguments(value: unknown): any {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toolCalls(session: any): Array<{ seq: number; name: string; arguments: any }> {
  return session.events
    .filter((event: any) => event?.type === 'tool/call')
    .map((event: any) => ({
      seq: event.seq,
      name: String(event.data?.name),
      arguments: parseToolArguments(event.data?.arguments),
    }));
}

function todoOperations(session: any): Array<{ seq: number; action: string }> {
  return session.events
    .filter((event: any) => event?.type === 'todo/write'
      && event.data?.todoStack?.kind === 'dsh-plugin-todo-stack')
    .map((event: any) => ({ seq: event.seq, action: String(event.data.todoStack.operation) }));
}

function finalAssistantText(session: any): string {
  const message = session.events.findLast((event: any) => event?.type === 'assistant/message');
  return textOf(message?.data?.message?.content ?? message?.data?.content ?? []);
}

function requestFingerprint(session: any): string | null {
  const request = session.events.find((event: any) => event?.type === 'request/header'
    && Array.isArray(event.data?.header?.tools)
    && event.data.header.tools.some((tool: any) => tool?.name === PROBE_TOOL));
  if (request === undefined) return null;
  const payload = JSON.stringify({
    system: request.data.header.system,
    tools: request.data.header.tools,
  });
  return createHash('sha256').update(payload).digest('hex');
}

function check(pass: boolean, detail: string): CheckResult {
  return { pass, detail };
}

function commonEvidence(finalText: string): { found: string[]; expected: readonly string[] } {
  const expected = ['COBALT-API-2', 'COBALT-STORAGE-3', 'COBALT-READY'] as const;
  return { found: expected.filter((item) => finalText.includes(item)), expected };
}

function evaluateTracked(
  calls: ReturnType<typeof toolCalls>,
  operations: ReturnType<typeof todoOperations>,
  state: ReturnType<typeof foldTodoStack>,
  finalText: string,
  inspected: readonly string[],
): Record<string, CheckResult> {
  const probeCalls = calls.filter((call) => call.name === PROBE_TOOL);
  const firstProbeSeq = probeCalls.at(0)?.seq ?? Number.POSITIVE_INFINITY;
  const firstTodoSeq = calls.find((call) => call.name === 'update_todo_stack')?.seq ?? Number.POSITIVE_INFINITY;
  const verifyIndex = calls.findIndex((call) => call.name === PROBE_TOOL && call.arguments?.area === 'verify');
  const completeIndex = calls.findLastIndex((call) => call.name === 'update_todo_stack' && call.arguments?.action === 'complete');
  const nodes = Object.values(state.nodes);
  const shortAnchors = nodes.every((node) => node.content.trim() === node.content
    && !node.content.includes('\n')
    && node.content.length <= 100);
  const evidence = commonEvidence(finalText);
  return {
    root_before_work: check(
      firstTodoSeq < firstProbeSeq && operations.at(0)?.action === 'push',
      `first todo seq=${firstTodoSeq}, first work seq=${firstProbeSeq}, first operation=${operations.at(0)?.action ?? 'missing'}`,
    ),
    work_sequence: check(
      inspected.length === 3
        && new Set(inspected.slice(0, 2)).size === 2
        && inspected.slice(0, 2).every((area) => area === 'api' || area === 'storage')
        && inspected[2] === 'verify',
      `observed=${JSON.stringify(inspected)}`,
    ),
    complete_after_verify: check(
      verifyIndex >= 0 && completeIndex > verifyIndex,
      `verify call index=${verifyIndex}, final complete call index=${completeIndex}`,
    ),
    bounded_short_tree: check(
      state.roots.length === 1 && nodes.length >= 1 && nodes.length <= 6 && shortAnchors,
      `roots=${state.roots.length}, nodes=${nodes.length}, anchors=${JSON.stringify(nodes.map((node) => node.content))}`,
    ),
    no_unfinished_work: check(
      state.focusId === null && nodes.length > 0 && nodes.every((node) => node.status === 'completed'),
      `focus=${state.focusId ?? 'null'}, statuses=${JSON.stringify(nodes.map((node) => node.status))}`,
    ),
    final_evidence: check(
      evidence.found.length === evidence.expected.length,
      `found=${JSON.stringify(evidence.found)}, expected=${JSON.stringify(evidence.expected)}`,
    ),
  };
}

function evaluateTrivial(
  calls: ReturnType<typeof toolCalls>,
  operations: ReturnType<typeof todoOperations>,
  state: ReturnType<typeof foldTodoStack>,
  finalText: string,
): Record<string, CheckResult> {
  return {
    no_tool_calls: check(calls.length === 0, `calls=${JSON.stringify(calls)}`),
    no_todo_state: check(
      operations.length === 0 && state.revision === 0 && Object.keys(state.nodes).length === 0,
      `operations=${JSON.stringify(operations)}, revision=${state.revision}, nodes=${Object.keys(state.nodes).length}`,
    ),
    exact_answer: check(finalText.trim() === 'COBALT-PONG', `final=${JSON.stringify(finalText)}`),
  };
}

function evaluateBlocked(
  calls: ReturnType<typeof toolCalls>,
  state: ReturnType<typeof foldTodoStack>,
  finalText: string,
  inspected: readonly string[],
): Record<string, CheckResult> {
  const firstProbeSeq = calls.find((call) => call.name === PROBE_TOOL)?.seq ?? Number.POSITIVE_INFINITY;
  const firstTodoSeq = calls.find((call) => call.name === 'update_todo_stack')?.seq ?? Number.POSITIVE_INFINITY;
  const actions = calls
    .filter((call) => call.name === 'update_todo_stack')
    .map((call) => String(call.arguments?.action));
  const nodes = Object.values(state.nodes);
  return {
    root_before_work: check(
      firstTodoSeq < firstProbeSeq && actions.at(0) === 'push',
      `first todo seq=${firstTodoSeq}, first work seq=${firstProbeSeq}, actions=${JSON.stringify(actions)}`,
    ),
    one_blocked_probe: check(
      inspected.length === 1 && inspected[0] === 'blocked',
      `observed=${JSON.stringify(inspected)}`,
    ),
    retain_focus_after_blocker: check(
      Number.isFinite(firstProbeSeq)
        && !actions.some((action) => action === 'exit' || action === 'complete' || action === 'drop'),
      `probe seq=${firstProbeSeq}, actions=${JSON.stringify(actions)}`,
    ),
    pending_focused_task: check(
      state.roots.length === 1
        && nodes.length === 1
        && nodes[0]?.status === 'pending'
        && state.focusId === nodes[0]?.id,
      `roots=${state.roots.length}, focus=${state.focusId ?? 'null'}, nodes=${JSON.stringify(nodes)}`,
    ),
    blocker_reported: check(
      finalText.includes('COBALT-NEEDS-TOKEN') && /release token/i.test(finalText),
      `final=${JSON.stringify(finalText)}`,
    ),
  };
}

function evaluateExistingFocus(
  calls: ReturnType<typeof toolCalls>,
  operations: ReturnType<typeof todoOperations>,
  state: ReturnType<typeof foldTodoStack>,
  finalText: string,
  inspected: readonly string[],
  seededOperationCount: number,
): Record<string, CheckResult> {
  const modelOperations = operations.slice(seededOperationCount);
  const firstProbeSeq = calls.find((call) => call.name === PROBE_TOOL)?.seq ?? Number.POSITIVE_INFINITY;
  const firstTodoCall = calls.find((call) => call.name === 'update_todo_stack');
  const root = state.nodes.t1;
  const descendants = Object.values(state.nodes).filter((node) => node.id !== 't1');
  const evidence = commonEvidence(finalText);
  return {
    child_before_work: check(
      (firstTodoCall?.seq ?? Number.POSITIVE_INFINITY) < firstProbeSeq
        && firstTodoCall?.arguments?.action === 'push'
        && firstTodoCall?.arguments?.expected_revision === 1
        && modelOperations.at(0)?.action === 'push',
      `first todo=${JSON.stringify(firstTodoCall)}, first work seq=${firstProbeSeq}, model operations=${JSON.stringify(modelOperations)}`,
    ),
    work_sequence: check(
      inspected.length === 3
        && new Set(inspected.slice(0, 2)).size === 2
        && inspected.slice(0, 2).every((area) => area === 'api' || area === 'storage')
        && inspected[2] === 'verify',
      `observed=${JSON.stringify(inspected)}`,
    ),
    preserve_ancestor: check(
      state.roots.length === 1
        && root?.content === 'Deliver cobalt release'
        && root.status === 'pending'
        && state.focusId === 't1',
      `root=${JSON.stringify(root)}, focus=${state.focusId ?? 'null'}`,
    ),
    complete_only_subtask: check(
      descendants.length >= 1 && descendants.length <= 5
        && descendants.every((node) => node.status === 'completed'),
      `descendants=${JSON.stringify(descendants)}`,
    ),
    final_evidence: check(
      evidence.found.length === evidence.expected.length,
      `found=${JSON.stringify(evidence.found)}, expected=${JSON.stringify(evidence.expected)}`,
    ),
  };
}

function evaluate(
  scenario: Scenario,
  session: any,
  runtime: ScenarioRuntime,
  repetition: number,
  elapsedMs: number,
): RunResult {
  const calls = toolCalls(session);
  const operations = todoOperations(session);
  const state = foldTodoStack(session.events);
  const finalText = finalAssistantText(session);
  let checks: Record<string, CheckResult>;
  if (scenario === 'tracked_release') {
    checks = evaluateTracked(calls, operations, state, finalText, runtime.inspected);
  } else if (scenario === 'trivial_direct') {
    checks = evaluateTrivial(calls, operations, state, finalText);
  } else if (scenario === 'blocked_release') {
    checks = evaluateBlocked(calls, state, finalText, runtime.inspected);
  } else {
    checks = evaluateExistingFocus(
      calls,
      operations,
      state,
      finalText,
      runtime.inspected,
      runtime.seededOperationCount,
    );
  }
  return {
    scenario,
    repetition,
    sessionId: session.id,
    elapsedMs,
    requestFingerprint: requestFingerprint(session),
    checks,
    passed: Object.values(checks).every((result) => result.pass),
    toolCalls: calls,
    operations,
    state,
    finalText,
  };
}

function wilson95(successes: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const rate = successes / total;
  const denominator = 1 + z * z / total;
  const center = (rate + z * z / (2 * total)) / denominator;
  const spread = z * Math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / denominator;
  return { low: center - spread, high: center + spread };
}

async function runOne(ctx: any, selection: any, scenario: Scenario, repetition: number): Promise<RunResult> {
  const agents = ctx.get('agents');
  const sessions = ctx.get('sessions');
  const runtime: ScenarioRuntime = { inspected: [], seededOperationCount: 0 };
  const setup = (agentCtx: any): void => {
    installModelSelection(agentCtx, {
      current: { ...selection },
      assembled: undefined,
    });
    agentCtx.tools.presentAs('native');
    // Restrictions validate inherited/global names before agent-local tools are merged.
    agentCtx.tools.restrict({ allow: ['get_todo_stack', 'update_todo_stack'] });
    agentCtx.tools.register(defineTool({
      name: PROBE_TOOL,
      description: 'Inspect one release area. Inspect api and storage before verify. A blocked result requires external user input and must not be retried or treated as completed. Include returned evidence codes in the final answer.',
      parameters: {
        area: { type: 'string', required: true, enum: ['api', 'storage', 'verify', 'blocked'] },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => false,
      async execute(args: any) {
        const area = String(args.area);
        if (area === 'verify' && !(runtime.inspected.includes('api') && runtime.inspected.includes('storage'))) {
          throw new Error('verify requires api and storage inspections first');
        }
        runtime.inspected.push(area);
        if (area === 'api') return 'COBALT-API-2: two API smoke suites passed; no open compatibility blocker.';
        if (area === 'storage') return 'COBALT-STORAGE-3: the migration dry-run passed on three representative datasets.';
        if (area === 'blocked') return 'COBALT-NEEDS-TOKEN: deployment cannot proceed until the user supplies the release token.';
        return 'COBALT-READY: combined validation passed; release cobalt is ready.';
      },
    }));
  };

  let handle: any;
  const started = Date.now();
  const sessionId = `session-todo-stack-prompt-eval-${scenario}-${repetition}-${randomUUID()}`;
  try {
    handle = await agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup,
    });
    await handle.agent.whenIdle();
    if (scenario === 'existing_focus') {
      const seeded = mutateTodoStack(
        emptyTodoStack(),
        { action: 'push', content: 'Deliver cobalt release' },
        { maxNodes: 200 },
      ).state;
      handle.agent.session.append('todo/write', makeTodoStackCarrier('push', seeded));
      runtime.seededOperationCount = 1;
    }
    handle.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: scenarioPrompt[scenario] }],
      source: { kind: 'user' },
    });
    await handle.agent.whenIdle();
    const result = evaluate(scenario, handle.agent.session, runtime, repetition, Date.now() - started);
    await sessions.flush(handle.agent.session);
    return result;
  } catch (error) {
    const session = handle?.agent?.session;
    const base = session === undefined
      ? {
          scenario,
          repetition,
          sessionId,
          elapsedMs: Date.now() - started,
          requestFingerprint: null,
          checks: {},
          passed: false,
          toolCalls: [],
          operations: [],
          state: foldTodoStack([]),
          finalText: '',
        }
      : evaluate(scenario, session, runtime, repetition, Date.now() - started);
    return {
      ...base,
      passed: false,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    };
  } finally {
    if (handle !== undefined) await handle.dispose();
  }
}

async function run(ctx: any): Promise<void> {
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const sessions = ctx.get('sessions');
  const defaultModel = ctx.get('agentDefaultModel');
  if (agents === undefined || sessions === undefined || defaultModel === undefined) {
    throw new Error('required DSH services are missing');
  }

  const repetitions = Number(process.env.TODO_STACK_PROMPT_EVAL_RUNS ?? 1);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) {
    throw new Error('TODO_STACK_PROMPT_EVAL_RUNS must be an integer from 1 to 20');
  }
  const requestedScenarios = (process.env.TODO_STACK_PROMPT_EVAL_SCENARIOS ?? SCENARIOS.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (requestedScenarios.length === 0
    || requestedScenarios.some((value) => !(SCENARIOS as readonly string[]).includes(value))) {
    throw new Error(`TODO_STACK_PROMPT_EVAL_SCENARIOS must contain only: ${SCENARIOS.join(', ')}`);
  }
  const scenarios = [...new Set(requestedScenarios)] as Scenario[];
  const selection = defaultModel.currentSelection();
  const results: RunResult[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const scenario of scenarios) {
      const result = await runOne(ctx, selection, scenario, repetition);
      results.push(result);
      console.log(`PROMPT_EVAL_RUN scenario=${scenario} repetition=${repetition}/${repetitions} ${result.passed ? 'PASS' : 'FAIL'} session=${result.sessionId} elapsed_ms=${result.elapsedMs}`);
      for (const [criterion, value] of Object.entries(result.checks)) {
        console.log(`PROMPT_EVAL_CHECK scenario=${scenario} repetition=${repetition} criterion=${criterion} pass=${value.pass} detail=${JSON.stringify(value.detail)}`);
      }
      if (result.error !== undefined) {
        console.log(`PROMPT_EVAL_ERROR scenario=${scenario} repetition=${repetition} ${JSON.stringify(result.error)}`);
      }
    }
  }

  const scenarioSummaries = Object.fromEntries(scenarios.map((scenario) => {
    const scenarioResults = results.filter((result) => result.scenario === scenario);
    const successes = scenarioResults.filter((result) => result.passed).length;
    const fingerprints = [...new Set(scenarioResults
      .map((result) => result.requestFingerprint)
      .filter((value): value is string => value !== null))];
    return [scenario, {
      runs: scenarioResults.length,
      successes,
      passRate: successes / scenarioResults.length,
      wilson95: wilson95(successes, scenarioResults.length),
      stableFingerprint: fingerprints.length === 1
        && scenarioResults.every((result) => result.requestFingerprint !== null),
      requestFingerprints: fingerprints,
    }];
  })) as Record<Scenario, {
    runs: number;
    successes: number;
    passRate: number;
    wilson95: { low: number; high: number };
    stableFingerprint: boolean;
    requestFingerprints: string[];
  }>;
  const successes = results.filter((result) => result.passed).length;
  const stableFingerprints = Object.values(scenarioSummaries)
    .every((summary) => summary.stableFingerprint);
  const interval = wilson95(successes, results.length);
  const artifactDir = resolve(process.env.TODO_STACK_PROMPT_EVAL_ARTIFACT_DIR ?? '.tmp');
  const artifactPath = resolve(artifactDir, `prompt-eval-matrix-${Date.now()}.json`);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, JSON.stringify({
    kind: 'todo-stack-prompt-eval-matrix',
    model: selection,
    repetitions,
    scenarios,
    runs: results.length,
    successes,
    passRate: successes / results.length,
    wilson95: interval,
    stableFingerprints,
    scenarioSummaries,
    results,
  }, null, 2) + '\n', 'utf8');

  console.log(`PROMPT_EVAL_MODEL=${JSON.stringify(selection)}`);
  for (const scenario of scenarios) {
    console.log(`PROMPT_EVAL_SCENARIO_SUMMARY scenario=${scenario} ${JSON.stringify(scenarioSummaries[scenario])}`);
  }
  console.log(`PROMPT_EVAL_SUMMARY=${successes}/${results.length}`);
  console.log(`PROMPT_EVAL_PASS_RATE=${(successes / results.length).toFixed(4)}`);
  console.log(`PROMPT_EVAL_WILSON95=${interval.low.toFixed(4)},${interval.high.toFixed(4)}`);
  console.log(`PROMPT_EVAL_FINGERPRINTS_STABLE=${stableFingerprints}`);
  console.log(`PROMPT_EVAL_ARTIFACT_PATH=${artifactPath}`);
  if (!stableFingerprints) throw new Error('todo-stack prompt evaluation request fingerprint changed or was missing');
  if (successes !== results.length) throw new Error(`todo-stack prompt evaluation passed ${successes}/${results.length} runs`);
  console.log('PROMPT_EVAL_RESULT=PASS');
}

function apply(ctx: any): void {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('todo-stack-prompt-eval-runner requires the headless appExit service');
  run(ctx).then(
    () => exit(0),
    (error) => {
      console.error('PROMPT_EVAL_RESULT=FAIL');
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      exit(1);
    },
  );
}

export { apply, inject, name };
