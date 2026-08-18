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
import { renderTodoStackContext } from './lib/view.ts';
import type { TodoStackState } from './lib/types.ts';

const name = 'todo-stack';
const inject = ['tools', 'systemPrompt'];

const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_READ_NODES = 80;
const DEFAULT_CONTEXT_CHILDREN = 8;

export interface Config {
  /** Maximum number of retained tree nodes. */
  maxNodes?: number;
  /** Maximum nodes returned by one get_todo_stack call. */
  maxReadNodes?: number;
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

function apply(ctx: Context, config: Config = {}): void {
  const maxNodes = positiveInteger(config.maxNodes, DEFAULT_MAX_NODES, 'maxNodes');
  const maxReadNodes = positiveInteger(config.maxReadNodes, DEFAULT_MAX_READ_NODES, 'maxReadNodes');
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

  ctx.tools.register(createGetTodoStackTool(ctx, { maxNodes, maxReadNodes }));
  ctx.tools.register(createUpdateTodoStackTool(ctx, { maxNodes, maxReadNodes }));

  ctx.systemPrompt.section({
    name: 'todo-stack:guidance',
    order: 150,
    text:
      'Use the todo stack for non-trivial multi-step work. Keep the tree small and outcome-oriented; decompose only when the current work reveals a useful subtask. `push` means descend into new work, `complete` means the focused work is actually done, and `exit` means suspend it without claiming completion. Record abandoned paths as dropped rather than completed. Maintain the stack as work changes, and skip it for trivial one-step requests.',
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
}

export { apply, inject, name };
export * from './lib/types.ts';
