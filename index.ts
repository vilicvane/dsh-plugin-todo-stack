import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import type { Agent } from '@deepseek-ai/dsh-agent';

import {
  todoDockProjection,
  todoStackProjection,
} from './lib/projection.ts';
import { foldTodoStack } from './lib/state.ts';
import { createTodoStackTools } from './lib/tools.ts';
import {
  TODO_STACK_NO_FOCUS_CONTEXT_NAME,
  TODO_STACK_TURN_START_CONTEXT_NAME,
  buildNoFocusGuardContext,
  buildTurnStartReflectionContext,
} from './lib/reminders.ts';
import { renderTodoStackContext } from './lib/view.ts';
import type { TodoStackState } from './lib/types.ts';

const name = 'todo-stack';
const inject = ['tools', 'systemPrompt'];

const DEFAULT_MAX_NODES = 200;
const DEFAULT_CONTEXT_CHILDREN = 8;

const TODO_STACK_GUIDANCE = [
  '## Todo Stack workflow',
  'Maintain a persistent todo tree as the focus map across compacted turns and sessions and as the user\'s view of task structure and progress.',
  'Before every substantive or potentially blocking non-Todo tool call, ensure that one pending leaf is focused on the concrete outcome about to be handled. If no pending work exists, call todo_stack__create. If pending work exists but focus is absent, call todo_stack__focus. If the focused outcome is broader than the next work, call todo_stack__expand before the non-Todo tool. Track even one tool call when it can block or require follow-up. Only a direct answer with no tracked pending task may skip creating a stack.',
  'Write each node as one brief, distinct outcome—not execution steps, acceptance criteria, tool arguments, evidence, progress, notes, or final-answer requirements. Use "Assess release readiness", not "Inspect once and report every evidence code". Never copy an ancestor into a descendant or add a placeholder merely to finish its parent.',
  'Use root siblings only for independent top-level outcomes. Put checks or steps serving one goal below that goal; do not flatten them into extra roots.',
  'Add only current or established unconditional outcomes. Exclude hypothetical branches, guessed future phases, final-reporting steps, and bookkeeping actions until they become real work. Record known later work below its relevant task without losing the current focus.',
  'When a tool reveals a blocker, complete only diagnostic outcomes that are truly verified and keep the actual blocked outcome as a concise pending focus. Phrase it as objective plus dependency, such as "Deploy after credentials are provided"—not status narration such as "Blocked", "Waiting", or "Request input", and never include an error or evidence code.',
  'Before every final response, reconcile the existing stack with the actual outcome. Complete the focused leaf when its outcome is verified; keep it pending and accurately focused when work is blocked or unfinished. Never leave completed work marked pending. Keep detailed working context in the conversation or workspace.',
].join('\n');

const TODO_STACK_INITIAL_GUIDANCE = [
  '## Initialize Todo Stack before work',
  'Before beginning substantive work or calling any other tool, call todo_stack__create as the first tool action. Give the first todo only the shared outcome—not its checks, sequence, tool calls, evidence, or reporting instructions. For example, use "Assess release readiness", not "Inspect API and storage, then report the evidence".',
  'Keep one concrete leaf focused. Use todo_stack__expand before another tool when the focused outcome has multiple distinct child outcomes. The stack preserves direction across compacted turns and sessions and makes task structure visible to the user. A deep stack may look like:',
  '- [ ] Implement the dashboard',
  '  - [ ] Implement task cards',
  '    - [ ] Add drag and drop',
  '      - [ ] Evaluate a suitable drag-and-drop approach (focus)',
  '    - [ ] Style the task cards',
  'For this example, create only the dashboard root first, then use todo_stack__expand to deepen it into task cards and their children. Do not concatenate those children into the root or pass them as extra roots.',
  'Keep every node brief, but make the tree as deep as the real work requires. Root siblings are independent top-level outcomes; steps of one goal are children. Add only distinct, unconditional outcomes already known. Exclude hypothetical branches and final-reporting steps, and omit siblings when none are meaningful. Keep one meaningful leaf focused while working, including while waiting on a blocker.',
  'After a tool call, synchronize the focused outcome with what actually happened. Before the final response, complete verified work. If work is blocked, keep it pending and use todo_stack__edit so the focus names the objective plus its dependency, such as "Deploy after credentials are provided".',
  'Skip initialization only when the next action is an immediate final answer with no substantive work and no tool call.',
].join('\n');

export interface Config {
  /** Maximum number of retained tree nodes. */
  maxNodes?: number;
  /** Direct children shown in the dynamic focus context. */
  contextChildren?: number;
  /** Publish the flattened `todos` projection consumed by the stock TodoDock. */
  todoDock?: boolean;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`todo-stack ${name} must be a positive safe integer`);
  }
  return resolved;
}

function stateFor(ctx: Context, session: Session): TodoStackState {
  const registry = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined;
  return registry?.stateOf(session, 'todoStack') ?? foldTodoStack(session.snapshotEvents());
}

/** Keep turn-start context only until the first todo mutation; results carry live updates. */
function contextStateFor(ctx: Context, session: Session): TodoStackState | null {
  for (let index = session.snapshotEvents().length - 1; index >= 0; index -= 1) {
    const event: any = session.snapshotEvents()[index];
    if (event?.type === 'turn/end') break;
    if (event?.type === 'turn/start') {
      const turnStartState = foldTodoStack(session.snapshotEvents().slice(0, index));
      return stateFor(ctx, session).revision === turnStartState.revision
        ? turnStartState
        : null;
    }
  }
  return stateFor(ctx, session);
}

function isSessionOpening(session: Session, state: TodoStackState): boolean {
  return state.revision === 0
    && !session.snapshotEvents().some((event: any) => event?.type === 'turn/end');
}

function apply(ctx: Context, config: Config = {}): void {
  const maxNodes = positiveInteger(config.maxNodes, DEFAULT_MAX_NODES, 'maxNodes');
  const contextChildren = positiveInteger(
    config.contextChildren,
    DEFAULT_CONTEXT_CHILDREN,
    'contextChildren',
  );
  const todoDock = config.todoDock !== false;

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const registry = projectionCtx.sessionProjections as unknown as {
      register(
        definition: ReturnType<typeof todoStackProjection> | ReturnType<typeof todoDockProjection>,
      ): () => void;
    };
    registry.register(todoStackProjection());
    if (todoDock) registry.register(todoDockProjection());
  });

  for (const tool of createTodoStackTools(ctx, { maxNodes, contextChildren })) {
    ctx.tools.register(tool);
  }

  ctx.systemPrompt.section({
    name: 'todo-stack:guidance',
    order: 150,
    text: TODO_STACK_GUIDANCE,
  });

  ctx.systemPrompt.context({
    name: 'todo-stack:initial-guidance',
    order: 149,
    text: (assembly: AssembleContext) => {
      const agent: Agent | undefined = assembly.agent;
      if (agent === undefined) return '';
      const state = stateFor(ctx, agent.session);
      return isSessionOpening(agent.session, state) ? TODO_STACK_INITIAL_GUIDANCE : '';
    },
  });

  ctx.systemPrompt.context({
    name: 'todo-stack:focus',
    order: 150,
    text: (assembly: AssembleContext) => {
      const agent: Agent | undefined = assembly.agent;
      if (agent === undefined) return '';
      const state = contextStateFor(ctx, agent.session);
      return state === null ? '' : renderTodoStackContext(state, contextChildren);
    },
  });

  ctx.systemPrompt.context({
    name: TODO_STACK_TURN_START_CONTEXT_NAME,
    order: 152,
    text: (assembly: AssembleContext) => {
      const agent: Agent | undefined = assembly.agent;
      if (agent === undefined) return '';
      const state = stateFor(ctx, agent.session);
      return buildTurnStartReflectionContext({
        session: agent.session,
        state,
        opening: isSessionOpening(agent.session, state),
      });
    },
  });

  ctx.systemPrompt.context({
    name: TODO_STACK_NO_FOCUS_CONTEXT_NAME,
    order: 151,
    text: (assembly: AssembleContext) => {
      const agent: Agent | undefined = assembly.agent;
      if (agent === undefined) return '';
      const state = stateFor(ctx, agent.session);
      return buildNoFocusGuardContext({
        session: agent.session,
        state,
        opening: isSessionOpening(agent.session, state),
      });
    },
  });
}

export { apply, inject, name };
export * from './lib/types.ts';
