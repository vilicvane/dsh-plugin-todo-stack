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
import {
  createGetTodoStackTool,
  createUpdateTodoStackTool,
} from './lib/tools.ts';
import {
  TODO_STACK_REMINDER_CONTEXT_NAME,
  buildTodoStackReminderContext,
} from './lib/reminders.ts';
import { renderTodoStackContext } from './lib/view.ts';
import type { TodoStackState } from './lib/types.ts';

const name = 'todo-stack';
const inject = ['tools', 'systemPrompt'];

const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_READ_NODES = 80;
const DEFAULT_CONTEXT_CHILDREN = 8;
const DEFAULT_REMINDER_INTERVAL_NODES = 30;

const TODO_STACK_GUIDANCE = [
  '## Todo stack',
  'Before the first non-todo tool call in work beyond one trivial deterministic action, focus one short task. With no <todo-stack> context, push it at expected_revision 0.',
  'Add and focus a direct child when you are about to do a distinct multi-action piece of work, unless the focused task will finish in the next few actions or has no distinct child worth tracking.',
  'A short task tree makes work and progress visible to the user.',
  'Keep each node to one short outcome; details stay in the conversation and workspace.',
  'Complete verified work. If focused work is blocked or awaiting input, call exit before answering; pending does not suspend focus. Leave siblings and ancestors unchanged.',
].join('\n');

const TODO_STACK_INITIAL_GUIDANCE = [
  '## Start with todo stack',
  'If this request needs any non-todo tool call, create and focus one short root task now with expected_revision 0 unless one deterministic call is guaranteed to finish it.',
  'A call that may block or require follow-up never qualifies for that exception.',
  'A useful task tree makes your work and progress visible to the user.',
].join('\n');

export interface Config {
  /** Maximum number of retained tree nodes. */
  maxNodes?: number;
  /** Maximum nodes returned by one get_todo_stack call. */
  maxReadNodes?: number;
  /** Direct children shown in the dynamic focus context. */
  contextChildren?: number;
  /** Publish the flattened `todos` projection consumed by the stock TodoDock. */
  todoDock?: boolean;
  /** Open-turn surface-node interval for optional maintenance reminders. */
  reminderIntervalNodes?: number;
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

function isSessionOpening(session: Session, state: TodoStackState): boolean {
  return state.revision === 0
    && !session.events.some((event: any) => event?.type === 'turn/end');
}

function apply(ctx: Context, config: Config = {}): void {
  const maxNodes = positiveInteger(config.maxNodes, DEFAULT_MAX_NODES, 'maxNodes');
  const maxReadNodes = positiveInteger(config.maxReadNodes, DEFAULT_MAX_READ_NODES, 'maxReadNodes');
  const contextChildren = positiveInteger(
    config.contextChildren,
    DEFAULT_CONTEXT_CHILDREN,
    'contextChildren',
  );
  const todoDock = config.todoDock !== false;
  const reminderIntervalNodes = positiveInteger(
    config.reminderIntervalNodes,
    DEFAULT_REMINDER_INTERVAL_NODES,
    'reminderIntervalNodes',
  );

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(todoStackProjection());
    if (todoDock) projectionCtx.sessionProjections.register(todoDockProjection());
  });

  ctx.tools.register(createGetTodoStackTool(ctx, { maxNodes, maxReadNodes }));
  ctx.tools.register(createUpdateTodoStackTool(ctx, { maxNodes, maxReadNodes }));

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
      return renderTodoStackContext(stateFor(ctx, agent.session), contextChildren);
    },
  });

  ctx.systemPrompt.context({
    name: TODO_STACK_REMINDER_CONTEXT_NAME,
    order: 151,
    text: (assembly: AssembleContext) => {
      const agent: Agent | undefined = assembly.agent;
      if (agent === undefined) return '';
      return buildTodoStackReminderContext({
        session: agent.session,
        reminderIntervalNodes,
      });
    },
  });
}

export { apply, inject, name };
export * from './lib/types.ts';
