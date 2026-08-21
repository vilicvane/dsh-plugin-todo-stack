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
  '## My todo stack',
  'I maintain a persistent todo tree as my focus map across compacted turns and sessions and as the user\'s view of my task structure and progress.',
  'Before every substantive or potentially blocking non-todo tool call, I first make sure the tree has one pending leaf whose outcome matches the work I am about to do. If no pending work exists, I create it; if focus is absent, I restore it; if the focused outcome is broader, I deepen it before that other tool call. Even one call must be tracked when it can block or require follow-up. Only an immediate final answer that needs no tool may skip the stack.',
  'Each node names one brief, distinct outcome—not the steps, acceptance criteria, tool arguments, or final-answer requirements for producing it. For example, I write "Assess release readiness", not "Inspect once and report every evidence code". I do not copy an ancestor into a descendant, add a placeholder merely to finish its parent, or store plans, evidence, progress, notes, and implementation detail in a node.',
  'Root siblings are independent top-level outcomes. When one goal has several checks or steps, I create that goal and deepen it into child outcomes before using non-todo tools; I do not flatten those steps into separate roots.',
  'I add only current or established unconditional outcomes. A hypothetical branch, guessed future phase, reporting step, or bookkeeping action stays out until it becomes real work. A known later outcome belongs below its relevant task without losing focus.',
  'When a tool reveals a blocker, I may complete a diagnostic outcome that is truly verified, but I keep the actual blocked outcome as a concise pending focus while I wait. I phrase it as objective plus dependency, for example "Deploy after credentials are provided"—never as status narration such as "Blocked: ...", "Waiting ...", or "Request input ...", and never with an error or evidence code.',
  'I complete only verified outcomes and keep the tree synchronized with what I am actually doing. Detailed working context stays in the conversation or workspace.',
].join('\n');

const TODO_STACK_INITIAL_GUIDANCE = [
  '## Before I get started',
  'Before I begin substantive work or call another tool, my first tool action needs to create a brief todo stack and focus the concrete outcome I will handle first. It will guide me through compacted turns and sessions and make my task structure visible to the user. For example:',
  '- [ ] Implement the dashboard',
  '  - [ ] Implement task cards',
  '    - [ ] Add drag and drop',
  '      - [ ] Evaluate a suitable drag-and-drop approach (focus)',
  '    - [ ] Style the task cards',
  'For this example I would create only the dashboard root, then deepen it into task cards and their children. I would not pass those steps as extra root todos.',
  'I will keep the tree concise but as deep as the real work requires. Root siblings are independent top-level outcomes; steps of one goal become children. I add only distinct, unconditional outcomes I already know; hypothetical branches and final-reporting steps stay out, and if no meaningful sibling is known I add none. I keep one meaningful leaf focused while working, including while waiting on a blocker.',
  'If I am only giving an immediate final answer and doing no substantive work, I can finish without creating a stack.',
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
  return registry?.snapshot(session).values.todoStack ?? foldTodoStack(session.events);
}

/** Keep turn-start context only until the first todo mutation; results carry live updates. */
function contextStateFor(ctx: Context, session: Session): TodoStackState | null {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event: any = session.events[index];
    if (event?.type === 'turn/end') break;
    if (event?.type === 'turn/start') {
      const turnStartState = foldTodoStack(session.events.slice(0, index));
      return stateFor(ctx, session).revision === turnStartState.revision
        ? turnStartState
        : null;
    }
  }
  return stateFor(ctx, session);
}

function isSessionOpening(session: Session, state: TodoStackState): boolean {
  return state.revision === 0
    && !session.events.some((event: any) => event?.type === 'turn/end');
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
    projectionCtx.sessionProjections.register(todoStackProjection());
    if (todoDock) projectionCtx.sessionProjections.register(todoDockProjection());
  });

  for (const tool of createTodoStackTools(ctx, { maxNodes, contextChildren })) {
    ctx.tools.register(tool);
  }

  ctx.systemPrompt.section({
    name: 'todo-stack:guidance',
    order: 150,
    text: TODO_STACK_GUIDANCE,
  });

  ctx.systemPrompt.section({
    name: 'todo-stack:initial-guidance',
    order: 151,
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
