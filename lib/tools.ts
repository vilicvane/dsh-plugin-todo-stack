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
  buildCompleteTodoTree,
  renderTodoStackContext,
} from './view.ts';
import type { TodoStackOperation, TodoStackState } from './types.ts';

export interface TodoStackRuntimeSettings {
  maxNodes: number;
  contextChildren: number;
}

interface RuntimeContext {
  get(name: 'sessionProjections'): {
    snapshot(session: unknown): {
      values: { todoStack?: TodoStackState };
    };
  } | undefined;
}

interface SessionLike {
  events: readonly { type: string; data: unknown }[];
  append(type: 'todo/write', data: unknown): unknown;
}

const TOOL_CONTEXT_FIELD = 'todoStackContext';

function renderToolValue(_args: unknown, value: JsonValue): Array<{ type: 'text'; text: string }> {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : undefined;
  const context = record === undefined || typeof record[TOOL_CONTEXT_FIELD] !== 'string'
    ? ''
    : record[TOOL_CONTEXT_FIELD];
  const publicValue = record === undefined
    ? value
    : Object.fromEntries(Object.entries(record).filter(([key]) => key !== TOOL_CONTEXT_FIELD));
  return [{
    type: 'text',
    text: JSON.stringify(publicValue) + (context.length > 0 ? `\n\n${context}` : ''),
  }];
}

function stateFor(ctx: RuntimeContext, session: SessionLike): TodoStackState {
  const projected = ctx.get('sessionProjections')?.snapshot(session).values.todoStack;
  return projected ?? foldTodoStack(session.events);
}

function mutationResult(
  state: TodoStackState,
  operation: TodoStackOperation,
  affectedId: string | null,
  createdIds: string[],
  contextChildren: number,
): JsonValue {
  const branch = renderTodoStackContext(state, contextChildren);
  const focusReflection = operation === 'create' && state.focusId !== null
    ? 'I need to check this new root before using another tool: only if it contains two or more independent outcomes should I expand it first. A single tool call, its arguments, or a final-answer requirement is not a child todo.'
    : '';
  return {
    operation,
    revision: state.revision,
    affectedId,
    createdIds,
    focusId: state.focusId === null ? null : todoNodeRef(state, state.focusId),
    [TOOL_CONTEXT_FIELD]: [branch, focusReflection].filter((part) => part.length > 0).join('\n\n'),
  };
}

function executeMutation(
  ctx: RuntimeContext,
  settings: TodoStackRuntimeSettings,
  exec: any,
  mutationFor: (state: TodoStackState) => TodoStackMutation,
): JsonValue {
  if (!exec.agent) throw new Error('todo stack mutation requires an owning agent session');
  const session = exec.agent.session as SessionLike;
  const current = stateFor(ctx, session);
  const mutation = mutationFor(current);
  const deletedRef = mutation.action === 'delete' ? todoNodeRef(current, mutation.id) : null;
  const result = mutateTodoStack(current, mutation, { maxNodes: settings.maxNodes });
  session.append('todo/write', makeTodoStackCarrier(mutation.action, result.state));
  const affectedId = deletedRef ?? (result.affectedId === null
    ? null
    : todoNodeRef(result.state, result.affectedId));
  return mutationResult(
    result.state,
    mutation.action,
    affectedId,
    result.createdIds.map((id) => todoNodeRef(result.state, id)),
    settings.contextChildren,
  );
}

const TODO_DESCRIPTION = 'One short, distinct task outcome phrased as objective plus any necessary constraint or dependency. Do not copy execution steps, acceptance criteria, tool arguments, or final-answer requirements. Never mention evidence in a todo—not an actual code and not instructions to collect, capture, include, or report evidence. Do not use status narration such as "Blocked:", "Waiting", or "Request input", restate an ancestor, or add a placeholder merely to finish its parent. Keep plans, progress, evidence, notes, and implementation detail in the conversation or workspace.';

export function createTodoStackTools(ctx: RuntimeContext, settings: TodoStackRuntimeSettings) {
  const show = defineTool({
    name: 'todo_stack__show',
    description: 'Show the complete persistent todo tree, including terminal history, current focus, ids, and revision. Use it when the injected current branch is not enough to choose or update work.',
    parameters: {},
    output: { schema: { type: 'json' }, render: renderToolValue },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      if (!exec.agent) throw new Error('todo_stack__show requires an owning agent session');
      return buildCompleteTodoTree(stateFor(ctx, exec.agent.session as SessionLike)) as unknown as JsonValue;
    },
    presentCall: () => ({ card: 'generic', title: 'Show todo stack', kind: 'read', rawInput: {} }),
  });

  const create = defineTool({
    name: 'todo_stack__create',
    description: `Create an ordered root-level todo stack when no pending work exists. The first todo becomes the focused leaf. Optional rest_todos are only independent established top-level outcomes for later, and most single-request calls should omit them. Checks or steps serving the first goal are not roots: create that goal alone, then use todo_stack__expand before other tools. Do not pre-create hypothetical branches, final-reporting steps, bookkeeping actions, or speculative roots. ${TODO_DESCRIPTION}`,
    parameters: {
      todo_to_focus: { type: 'string', required: true, description: `The first root todo and immediate meaningful focus. ${TODO_DESCRIPTION}` },
      rest_todos: { type: 'array', items: { type: 'string' }, description: `Rarely needed: other independent, unconditional top-level outcomes already established for later. Exclude checks or steps of the first goal, hypothetical branches, and reporting steps. Omit when none are known. Every item must follow this content rule: ${TODO_DESCRIPTION}` },
    },
    output: { schema: { type: 'json' }, render: renderToolValue },
    async execute(args, exec) {
      return executeMutation(ctx, settings, exec, () => ({
        action: 'create',
        todos: [args.todo_to_focus, ...(args.rest_todos ?? [])],
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: 'Create todo stack', kind: 'other', rawInput: args }),
  });

  const expand = defineTool({
    name: 'todo_stack__expand',
    description: `Decompose the current focused leaf into ordered direct children in one atomic update. The first child becomes the new focus. Optional rest_todos are only distinct established sibling outcomes for later. The id must identify the current focus. Use this before the first non-todo tool call when a new outcome is more concrete than the current focus. Do not restate the parent, guess future phases, or create a child whose only meaning is to complete the parent; omit rest_todos when no real sibling is known. ${TODO_DESCRIPTION}`,
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the current focused leaf to expand.' },
      sub_todo_to_focus: { type: 'string', required: true, description: `First direct child and next concrete focus. ${TODO_DESCRIPTION}` },
      rest_todos: { type: 'array', items: { type: 'string' }, description: `Optional distinct child outcomes already established by the request or current plan. Never repeat the parent or guess future phases; omit when none are known. Every item must follow this content rule: ${TODO_DESCRIPTION}` },
    },
    output: { schema: { type: 'json' }, render: renderToolValue },
    async execute(args, exec) {
      return executeMutation(ctx, settings, exec, (state) => ({
        action: 'expand',
        id: resolveTodoNodeId(state, args.id),
        todos: [args.sub_todo_to_focus, ...(args.rest_todos ?? [])],
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: `Expand todo ${args.id}`, kind: 'other', rawInput: args }),
  });

  const focus = defineTool({
    name: 'todo_stack__focus',
    description: 'Choose one existing pending leaf as the meaningful current focus. Use this before continuing substantive work whenever pending work exists but focus is absent. Non-leaf and terminal nodes cannot receive focus.',
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the pending leaf to focus.' },
    },
    output: { schema: { type: 'json' }, render: renderToolValue },
    async execute(args, exec) {
      return executeMutation(ctx, settings, exec, (state) => ({
        action: 'focus',
        id: resolveTodoNodeId(state, args.id),
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: `Focus todo ${args.id}`, kind: 'other', rawInput: args }),
  });

  const push = defineTool({
    name: 'todo_stack__push',
    description: `Add one pending direct child below an identified pending todo. By default this records later work without changing focus; set focus true only when entering the new child now. An unfocused push below the focused leaf is rejected: use todo_stack__expand to decompose current work. ${TODO_DESCRIPTION}`,
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the pending parent todo.' },
      todo: { type: 'string', required: true, description: TODO_DESCRIPTION },
      focus: { type: 'boolean', description: 'Whether the new child becomes focus. Defaults to false.' },
    },
    output: { schema: { type: 'json' }, render: renderToolValue },
    async execute(args, exec) {
      return executeMutation(ctx, settings, exec, (state) => ({
        action: 'push',
        parentId: resolveTodoNodeId(state, args.id),
        content: args.todo,
        focus: args.focus ?? false,
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: `Push below todo ${args.id}`, kind: 'other', rawInput: args }),
  });

  const complete = defineTool({
    name: 'todo_stack__complete',
    description: 'Mark an identified pending todo complete after its outcome is verified. A todo with pending descendants cannot complete. Completing the focused leaf clears focus; if substantive work remains, choose a new meaningful leaf before continuing.',
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the verified todo to complete.' },
    },
    output: { schema: { type: 'json' }, render: renderToolValue },
    async execute(args, exec) {
      return executeMutation(ctx, settings, exec, (state) => ({
        action: 'complete',
        id: resolveTodoNodeId(state, args.id),
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: `Complete todo ${args.id}`, kind: 'other', rawInput: args }),
  });

  const remove = defineTool({
    name: 'todo_stack__delete',
    description: 'Permanently delete an identified todo and its entire subtree. This is not recoverable. If deletion removes the current focus and substantive work remains, choose another meaningful pending leaf before continuing.',
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the subtree root to delete permanently.' },
    },
    output: { schema: { type: 'json' }, render: renderToolValue },
    async execute(args, exec) {
      return executeMutation(ctx, settings, exec, (state) => ({
        action: 'delete',
        id: resolveTodoNodeId(state, args.id),
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: `Delete todo ${args.id}`, kind: 'other', rawInput: args }),
  });

  const edit = defineTool({
    name: 'todo_stack__edit',
    description: `Replace the short task outcome of an identified todo without changing its id, tree position, status, or focus. ${TODO_DESCRIPTION}`,
    parameters: {
      id: { type: 'string', required: true, description: 'Id of the todo to edit.' },
      todo: { type: 'string', required: true, description: `Replacement content. ${TODO_DESCRIPTION}` },
    },
    output: { schema: { type: 'json' }, render: renderToolValue },
    async execute(args, exec) {
      return executeMutation(ctx, settings, exec, (state) => ({
        action: 'edit',
        id: resolveTodoNodeId(state, args.id),
        content: args.todo,
      }));
    },
    presentCall: (args) => ({ card: 'generic', title: `Edit todo ${args.id}`, kind: 'other', rawInput: args }),
  });

  return [show, create, expand, focus, push, complete, remove, edit] as const;
}
