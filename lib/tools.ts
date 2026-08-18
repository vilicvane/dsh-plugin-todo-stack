import { defineTool } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-session';

import {
  foldTodoStack,
  makeTodoStackCarrier,
  mutateTodoStack,
  resolveTodoNodeId,
  todoNodeRef,
} from './state.ts';
import type { TodoStackMutation } from './state.ts';
import {
  buildTodoStackView,
  focusPath,
  todoStackCounts,
} from './view.ts';
import type { TodoNodeView, TodoStackState } from './types.ts';

export interface TodoStackRuntimeSettings {
  maxNodes: number;
  maxReadNodes: number;
}

interface RuntimeContext {
  get(name: 'sessionProjections'): {
    snapshot(session: unknown): {
      values: { todoStack?: TodoStackState };
    };
  } | undefined;
}

const CHILD_REMINDER = 'Add and focus one direct child now, unless the focused task will finish in the next few actions or has no distinct child worth tracking. A useful hierarchy of short tasks helps the user understand your progress; keep each node to one short outcome.';

function renderToolValue(_args: unknown, value: JsonValue): Array<{ type: 'text'; text: string }> {
  const focusId = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value.focusId
    : null;
  return [{
    type: 'text',
    text: JSON.stringify(value) + (typeof focusId === 'string' ? '\n\n' + CHILD_REMINDER : ''),
  }];
}

interface SessionLike {
  events: readonly { type: string; data: unknown }[];
  append(type: 'todo/write', data: unknown): unknown;
}

function stateFor(ctx: RuntimeContext, session: SessionLike): TodoStackState {
  const projected = ctx.get('sessionProjections')?.snapshot(session).values.todoStack;
  return projected ?? foldTodoStack(session.events);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required for this action`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toMutation(args: Record<string, unknown>): TodoStackMutation {
  const action = args.action;
  if (action === 'push') {
    return { action, content: requireString(args.content, 'content') };
  }
  if (action === 'add') {
    const mutation: TodoStackMutation = {
      action,
      content: requireString(args.content, 'content'),
    };
    if (Object.hasOwn(args, 'parent_id')) {
      mutation.parentId = args.parent_id === null ? null : requireString(args.parent_id, 'parent_id');
    }
    const afterId = optionalString(args.after_id);
    if (afterId !== undefined) mutation.afterId = afterId;
    return mutation;
  }
  if (action === 'focus') {
    return { action, id: requireString(args.id, 'id') };
  }
  if (action === 'exit' || action === 'complete') return { action };
  if (action === 'edit') {
    return {
      action,
      id: requireString(args.id, 'id'),
      content: requireString(args.content, 'content'),
    };
  }
  if (action === 'move') {
    if (!Object.hasOwn(args, 'parent_id')) {
      throw new Error('parent_id is required for move; use null to move to the root');
    }
    const mutation: TodoStackMutation = {
      action,
      id: requireString(args.id, 'id'),
      parentId: args.parent_id === null ? null : requireString(args.parent_id, 'parent_id'),
    };
    const afterId = optionalString(args.after_id);
    if (afterId !== undefined) mutation.afterId = afterId;
    return mutation;
  }
  if (action === 'drop') {
    const id = optionalString(args.id);
    return id === undefined ? { action } : { action, id };
  }
  if (action === 'reopen') {
    return { action, id: requireString(args.id, 'id') };
  }
  throw new Error(`unknown todo stack action ${JSON.stringify(action)}`);
}

function resolveMutationReferences(
  state: TodoStackState,
  mutation: TodoStackMutation,
): TodoStackMutation {
  switch (mutation.action) {
    case 'push':
    case 'exit':
    case 'complete':
      return mutation;
    case 'add':
      return {
        ...mutation,
        ...(typeof mutation.parentId === 'string'
          ? { parentId: resolveTodoNodeId(state, mutation.parentId) }
          : {}),
        ...(mutation.afterId === undefined
          ? {}
          : { afterId: resolveTodoNodeId(state, mutation.afterId) }),
      };
    case 'focus':
    case 'edit':
    case 'reopen':
      return { ...mutation, id: resolveTodoNodeId(state, mutation.id) };
    case 'move':
      return {
        ...mutation,
        id: resolveTodoNodeId(state, mutation.id),
        parentId: mutation.parentId === null
          ? null
          : resolveTodoNodeId(state, mutation.parentId),
        ...(mutation.afterId === undefined
          ? {}
          : { afterId: resolveTodoNodeId(state, mutation.afterId) }),
      };
    case 'drop':
      return mutation.id === undefined
        ? mutation
        : { ...mutation, id: resolveTodoNodeId(state, mutation.id) };
  }
}

function compactNode(node: TodoNodeView): JsonValue {
  return {
    id: node.id,
    content: node.content,
    parentId: node.parentId,
    status: node.status,
    focused: node.focused,
  };
}

function mutationResult(state: TodoStackState, action: string, affectedId: string | null): JsonValue {
  const focus = state.focusId === null ? undefined : state.nodes[state.focusId];
  const counts = todoStackCounts(state);
  return {
    action,
    revision: state.revision,
    affectedId: affectedId === null ? null : todoNodeRef(state, affectedId),
    focusId: state.focusId === null ? null : todoNodeRef(state, state.focusId),
    path: focusPath(state).map(compactNode),
    children: focus === undefined
      ? []
      : focus.children.map((id) => ({
          id: todoNodeRef(state, id),
          content: state.nodes[id].content,
          status: state.nodes[id].status,
        })),
    counts: {
      pending: counts.pending,
      completed: counts.completed,
      dropped: counts.dropped,
    },
  };
}

const GET_PARAMETERS = {
  root_id: {
    type: 'string',
    description: 'Optional subtree root id or unique legacy-id prefix. Omit to read all roots.',
  },
  depth: {
    type: 'integer',
    description: 'Maximum descendant depth to return. Defaults to 3.',
  },
  include_ended: {
    type: 'boolean',
    description: 'Include completed and dropped nodes. Defaults to true.',
  },
  max_nodes: {
    type: 'integer',
    description: 'Maximum returned nodes, capped by plugin configuration.',
  },
} as const;

const UPDATE_PARAMETERS = {
  expected_revision: {
    type: 'integer',
    required: true,
    description: 'Exact current revision from runtime context or get_todo_stack.',
  },
  action: {
    type: 'string',
    required: true,
    enum: ['push', 'add', 'focus', 'exit', 'complete', 'edit', 'move', 'drop', 'reopen'],
    description: 'One atomic stack or tree mutation.',
  },
  content: {
    type: 'string',
    description: 'A short core task anchor, preferably one concise outcome phrase. Include only the objective and a distinguishing constraint, never plans, progress, evidence, notes, or handoff detail. Required by push, add, and edit.',
  },
  id: {
    type: 'string',
    description: 'Target node id or unique legacy-id prefix for focus, edit, move, reopen, or optional drop.',
  },
  parent_id: {
    oneOf: [{ type: 'string' }, { type: 'null' }],
    description: 'Destination parent id or unique legacy-id prefix for move; optional parent for add. Null means a root.',
  },
  after_id: {
    type: 'string',
    description: 'Optional sibling id or unique legacy-id prefix after which add or move inserts the node.',
  },
} as const;

export function createGetTodoStackTool(ctx: RuntimeContext, settings: TodoStackRuntimeSettings) {
  return defineTool({
    name: 'get_todo_stack',
    description:
      'Read the persistent task tree when the injected current branch is insufficient. Returns the revision required by update_todo_stack.',
    parameters: GET_PARAMETERS,
    output: {
      schema: { type: 'json' },
      render: renderToolValue,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('get_todo_stack requires an owning agent session');
      const requestedMax = args.max_nodes ?? settings.maxReadNodes;
      if (!Number.isSafeInteger(requestedMax) || requestedMax < 1) {
        throw new Error('max_nodes must be a positive safe integer');
      }
      const state = stateFor(ctx, exec.agent.session as SessionLike);
      return buildTodoStackView(state, {
        rootId: optionalString(args.root_id),
        depth: args.depth,
        includeEnded: args.include_ended,
        maxNodes: Math.min(requestedMax, settings.maxReadNodes),
      }) as unknown as JsonValue;
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Read todo stack',
      kind: 'read',
      rawInput: args,
    }),
  });
}

export function createUpdateTodoStackTool(ctx: RuntimeContext, settings: TodoStackRuntimeSettings) {
  return defineTool({
    name: 'update_todo_stack',
    description:
      'Apply one todo-tree mutation. push creates and focuses current work; add records non-current work; complete finishes verified focus; exit suspends it. Keep content to one short outcome and use the exact current revision.',
    parameters: UPDATE_PARAMETERS,
    output: {
      schema: { type: 'json' },
      render: renderToolValue,
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('update_todo_stack requires an owning agent session');
      if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0) {
        throw new Error('expected_revision must be a non-negative safe integer');
      }
      const session = exec.agent.session as SessionLike;
      const current = stateFor(ctx, session);
      if (args.expected_revision !== current.revision) {
        throw new Error(
          `stale todo stack revision: expected ${args.expected_revision}, current is ${current.revision}; read the stack and retry`,
        );
      }
      const mutation = resolveMutationReferences(current, toMutation(args));
      const result = mutateTodoStack(current, mutation, { maxNodes: settings.maxNodes });
      const carrier = makeTodoStackCarrier(mutation.action, result.state);
      session.append('todo/write', carrier);
      return mutationResult(result.state, mutation.action, result.affectedId);
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Update todo stack: ${args.action}`,
      kind: 'other',
      rawInput: args,
    }),
  });
}
