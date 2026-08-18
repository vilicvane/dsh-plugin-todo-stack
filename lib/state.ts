import { randomUUID } from 'node:crypto';

import type { TodoItem } from '@deepseek-ai/dsh-session';

import {
  TODO_STACK_ENVELOPE_KIND,
  TODO_STACK_VERSION,
} from './types.ts';
import type {
  TodoNodeStatus,
  TodoStackCarrier,
  TodoStackEnvelope,
  TodoStackNode,
  TodoStackOperation,
  TodoStackState,
} from './types.ts';

export const MAX_TITLE_CHARS = 240;
export const MAX_TREE_DEPTH = 64;

const OPERATIONS = new Set<TodoStackOperation>([
  'push',
  'add',
  'focus',
  'exit',
  'complete',
  'rename',
  'move',
  'drop',
  'reopen',
]);

const STATUSES = new Set<TodoNodeStatus>([
  'pending',
  'completed',
  'dropped',
]);

export type TodoStackMutation =
  | { action: 'push'; title: string }
  | { action: 'add'; title: string; parentId?: string | null; afterId?: string }
  | { action: 'focus'; id: string }
  | { action: 'exit' }
  | { action: 'complete' }
  | { action: 'rename'; id: string; title: string }
  | { action: 'move'; id: string; parentId: string | null; afterId?: string }
  | { action: 'drop'; id?: string }
  | { action: 'reopen'; id: string };

export interface MutationOptions {
  maxNodes: number;
  createId?: () => string;
}

export interface MutationResult {
  state: TodoStackState;
  affectedId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`invalid todo stack: ${message}`);
}

export function emptyTodoStack(): TodoStackState {
  return {
    version: TODO_STACK_VERSION,
    revision: 0,
    roots: [],
    nodes: {},
    focusId: null,
  };
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`${field} must be an array of strings`);
  }
}

export function assertTodoStackState(value: unknown): asserts value is TodoStackState {
  if (!isRecord(value)) fail('state must be an object');
  if (value.version !== TODO_STACK_VERSION) fail(`unsupported state version ${String(value.version)}`);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    fail('revision must be a non-negative safe integer');
  }
  assertStringArray(value.roots, 'roots');
  if (!isRecord(value.nodes)) fail('nodes must be an object map');
  if (value.focusId !== null && typeof value.focusId !== 'string') {
    fail('focusId must be a string or null');
  }

  const nodes = value.nodes as Record<string, unknown>;
  const placements = new Map<string, number>();
  const roots = value.roots;
  if (new Set(roots).size !== roots.length) fail('roots contains duplicate ids');

  for (const [key, rawNode] of Object.entries(nodes)) {
    if (!isRecord(rawNode)) fail(`node ${JSON.stringify(key)} must be an object`);
    if (rawNode.id !== key) fail(`node map key ${JSON.stringify(key)} does not match its id`);
    if (typeof rawNode.title !== 'string' || rawNode.title.length === 0 || rawNode.title.trim() !== rawNode.title) {
      fail(`node ${JSON.stringify(key)} has an empty or untrimmed title`);
    }
    if (rawNode.title.length > MAX_TITLE_CHARS) {
      fail(`node ${JSON.stringify(key)} title exceeds ${MAX_TITLE_CHARS} characters`);
    }
    if (rawNode.parentId !== null && typeof rawNode.parentId !== 'string') {
      fail(`node ${JSON.stringify(key)} has an invalid parentId`);
    }
    assertStringArray(rawNode.children, `node ${JSON.stringify(key)} children`);
    if (new Set(rawNode.children).size !== rawNode.children.length) {
      fail(`node ${JSON.stringify(key)} contains duplicate child ids`);
    }
    if (typeof rawNode.status !== 'string' || !STATUSES.has(rawNode.status as TodoNodeStatus)) {
      fail(`node ${JSON.stringify(key)} has an invalid status`);
    }
  }

  for (const id of roots) {
    const node = nodes[id] as Record<string, unknown> | undefined;
    if (node === undefined) fail(`root ${JSON.stringify(id)} does not exist`);
    if (node.parentId !== null) fail(`root ${JSON.stringify(id)} has a parent`);
    placements.set(id, (placements.get(id) ?? 0) + 1);
  }

  for (const [id, rawNode] of Object.entries(nodes)) {
    const node = rawNode as unknown as TodoStackNode;
    if (node.parentId !== null && nodes[node.parentId] === undefined) {
      fail(`node ${JSON.stringify(id)} references missing parent ${JSON.stringify(node.parentId)}`);
    }
    for (const childId of node.children) {
      const child = nodes[childId] as Record<string, unknown> | undefined;
      if (child === undefined) fail(`node ${JSON.stringify(id)} references missing child ${JSON.stringify(childId)}`);
      if (child.parentId !== id) {
        fail(`child ${JSON.stringify(childId)} does not point back to parent ${JSON.stringify(id)}`);
      }
      placements.set(childId, (placements.get(childId) ?? 0) + 1);
    }
  }

  for (const id of Object.keys(nodes)) {
    if (placements.get(id) !== 1) fail(`node ${JSON.stringify(id)} must appear exactly once in the tree`);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string, depth: number): boolean => {
    if (depth > MAX_TREE_DEPTH) fail(`tree depth exceeds ${MAX_TREE_DEPTH}`);
    if (visiting.has(id)) fail(`cycle detected at node ${JSON.stringify(id)}`);
    if (visited.has(id)) fail(`node ${JSON.stringify(id)} is reachable more than once`);
    visiting.add(id);
    const node = nodes[id] as unknown as TodoStackNode;
    let subtreeHasPending = node.status === 'pending';
    for (const childId of node.children) {
      subtreeHasPending = walk(childId, depth + 1) || subtreeHasPending;
    }
    if (node.status !== 'pending' && subtreeHasPending) {
      fail(`${node.status} node ${JSON.stringify(id)} contains pending work`);
    }
    visiting.delete(id);
    visited.add(id);
    return subtreeHasPending;
  };
  for (const id of roots) walk(id, 0);
  if (visited.size !== Object.keys(nodes).length) fail('tree contains unreachable nodes');

  if (value.focusId !== null) {
    const focused = nodes[value.focusId] as unknown as TodoStackNode | undefined;
    if (focused === undefined) fail(`focus ${JSON.stringify(value.focusId)} does not exist`);
    if (focused.status !== 'pending') fail('focus must point to a pending node');
  }
}

export function extractTodoStackEnvelope(event: { type: string; data: unknown }): TodoStackEnvelope | undefined {
  if (event.type !== 'todo/write' || !isRecord(event.data)) return undefined;
  const raw = event.data.todoStack;
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail('todoStack carrier field must be an object');
  if (raw.kind !== TODO_STACK_ENVELOPE_KIND) fail('todoStack carrier has an unknown kind');
  if (raw.version !== TODO_STACK_VERSION) fail(`unsupported envelope version ${String(raw.version)}`);
  if (typeof raw.operation !== 'string' || !OPERATIONS.has(raw.operation as TodoStackOperation)) {
    fail(`unknown operation ${JSON.stringify(raw.operation)}`);
  }
  assertTodoStackState(raw.state);
  return raw as unknown as TodoStackEnvelope;
}

export function foldTodoStack(events: readonly { type: string; data: unknown }[]): TodoStackState {
  let state = emptyTodoStack();
  for (const event of events) {
    const envelope = extractTodoStackEnvelope(event);
    if (envelope === undefined) continue;
    if (envelope.state.revision !== state.revision + 1) {
      fail(`revision ${envelope.state.revision} does not follow ${state.revision}`);
    }
    state = envelope.state;
  }
  return state;
}

function cloneState(state: TodoStackState): TodoStackState {
  const nodes: Record<string, TodoStackNode> = {};
  for (const [id, node] of Object.entries(state.nodes)) {
    nodes[id] = { ...node, children: [...node.children] };
  }
  return {
    version: TODO_STACK_VERSION,
    revision: state.revision,
    roots: [...state.roots],
    nodes,
    focusId: state.focusId,
  };
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0) throw new Error('todo title must not be empty');
  if (normalized.length > MAX_TITLE_CHARS) {
    throw new Error(`todo title must be at most ${MAX_TITLE_CHARS} characters`);
  }
  return normalized;
}

function requireNode(state: TodoStackState, id: string): TodoStackNode {
  const node = state.nodes[id];
  if (node === undefined) throw new Error(`todo node ${JSON.stringify(id)} does not exist`);
  return node;
}

function childList(state: TodoStackState, parentId: string | null): string[] {
  return parentId === null ? state.roots : requireNode(state, parentId).children;
}

function removePlacement(state: TodoStackState, id: string): void {
  const node = requireNode(state, id);
  const siblings = childList(state, node.parentId);
  const index = siblings.indexOf(id);
  if (index < 0) throw new Error(`todo node ${JSON.stringify(id)} is missing from its parent`);
  siblings.splice(index, 1);
}

function insertPlacement(
  state: TodoStackState,
  id: string,
  parentId: string | null,
  afterId?: string,
): void {
  const siblings = childList(state, parentId);
  if (afterId === undefined) {
    siblings.push(id);
    return;
  }
  if (afterId === id) throw new Error('a node cannot be placed after itself');
  const index = siblings.indexOf(afterId);
  if (index < 0) {
    throw new Error(`after_id ${JSON.stringify(afterId)} is not a child of the destination parent`);
  }
  siblings.splice(index + 1, 0, id);
}

function isInSubtree(state: TodoStackState, rootId: string, candidateId: string): boolean {
  if (rootId === candidateId) return true;
  const pending = [...requireNode(state, rootId).children];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    if (id === candidateId) return true;
    pending.push(...requireNode(state, id).children);
  }
  return false;
}

function subtreeHasPending(state: TodoStackState, rootId: string): boolean {
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop() as string;
    const node = requireNode(state, id);
    if (node.status === 'pending') return true;
    pending.push(...node.children);
  }
  return false;
}

function finalizeMutation(state: TodoStackState, previousRevision: number): TodoStackState {
  state.revision = previousRevision + 1;
  assertTodoStackState(state);
  return state;
}

export function mutateTodoStack(
  current: TodoStackState,
  mutation: TodoStackMutation,
  options: MutationOptions,
): MutationResult {
  assertTodoStackState(current);
  if (!Number.isSafeInteger(options.maxNodes) || options.maxNodes < 1) {
    throw new Error('maxNodes must be a positive safe integer');
  }
  const state = cloneState(current);
  const createId = options.createId ?? randomUUID;
  let affectedId: string | null = null;

  if (mutation.action === 'push' || mutation.action === 'add') {
    if (Object.keys(state.nodes).length >= options.maxNodes) {
      throw new Error(`todo stack is limited to ${options.maxNodes} nodes`);
    }
    const title = normalizeTitle(mutation.title);
    const parentId = mutation.action === 'push'
      ? state.focusId
      : mutation.parentId === undefined ? state.focusId : mutation.parentId;
    if (parentId !== null && requireNode(state, parentId).status !== 'pending') {
      throw new Error('new work can only be added below a pending node');
    }
    let id = createId();
    while (state.nodes[id] !== undefined) id = createId();
    state.nodes[id] = {
      id,
      title,
      parentId,
      children: [],
      status: 'pending',
    };
    insertPlacement(state, id, parentId, mutation.action === 'add' ? mutation.afterId : undefined);
    if (mutation.action === 'push') state.focusId = id;
    affectedId = id;
  } else if (mutation.action === 'focus') {
    const node = requireNode(state, mutation.id);
    if (node.status !== 'pending') throw new Error('only a pending node can receive focus');
    if (state.focusId === node.id) throw new Error('todo node is already focused');
    state.focusId = node.id;
    affectedId = node.id;
  } else if (mutation.action === 'exit') {
    if (state.focusId === null) throw new Error('todo stack has no current focus to exit');
    const focused = requireNode(state, state.focusId);
    affectedId = focused.id;
    state.focusId = focused.parentId;
  } else if (mutation.action === 'complete') {
    if (state.focusId === null) throw new Error('todo stack has no current focus to complete');
    const focused = requireNode(state, state.focusId);
    if (focused.children.some((id) => subtreeHasPending(state, id))) {
      throw new Error('cannot complete a node while its subtree contains pending work');
    }
    focused.status = 'completed';
    state.focusId = focused.parentId;
    affectedId = focused.id;
  } else if (mutation.action === 'rename') {
    const node = requireNode(state, mutation.id);
    const title = normalizeTitle(mutation.title);
    if (node.title === title) throw new Error('rename would not change the node title');
    node.title = title;
    affectedId = node.id;
  } else if (mutation.action === 'move') {
    const node = requireNode(state, mutation.id);
    if (mutation.parentId !== null) {
      const parent = requireNode(state, mutation.parentId);
      if (isInSubtree(state, node.id, parent.id)) {
        throw new Error('cannot move a node below itself or one of its descendants');
      }
      if (parent.status !== 'pending' && subtreeHasPending(state, node.id)) {
        throw new Error('pending work cannot be moved below a completed or dropped node');
      }
    }
    const before = JSON.stringify({ parentId: node.parentId, siblings: childList(state, node.parentId) });
    removePlacement(state, node.id);
    node.parentId = mutation.parentId;
    insertPlacement(state, node.id, mutation.parentId, mutation.afterId);
    const after = JSON.stringify({ parentId: node.parentId, siblings: childList(state, node.parentId) });
    if (before === after) throw new Error('move would not change the tree');
    affectedId = node.id;
  } else if (mutation.action === 'drop') {
    const id = mutation.id ?? state.focusId;
    if (id === null) throw new Error('drop requires an id when the stack has no focus');
    const node = requireNode(state, id);
    if (node.status !== 'pending') throw new Error('only pending work can be dropped');
    const pending = [id];
    while (pending.length > 0) {
      const currentId = pending.pop() as string;
      const currentNode = requireNode(state, currentId);
      if (currentNode.status !== 'completed') currentNode.status = 'dropped';
      pending.push(...currentNode.children);
    }
    if (state.focusId !== null && isInSubtree(state, id, state.focusId)) {
      state.focusId = node.parentId;
    }
    affectedId = id;
  } else if (mutation.action === 'reopen') {
    const node = requireNode(state, mutation.id);
    if (node.status === 'pending') throw new Error('todo node is already pending');
    if (node.parentId !== null && requireNode(state, node.parentId).status !== 'pending') {
      throw new Error('reopen the node ancestors before reopening this node');
    }
    node.status = 'pending';
    affectedId = node.id;
  }

  return {
    state: finalizeMutation(state, current.revision),
    affectedId,
  };
}

function flattenNodes(state: TodoStackState): Array<{ node: TodoStackNode; depth: number }> {
  const result: Array<{ node: TodoStackNode; depth: number }> = [];
  const visit = (id: string, depth: number): void => {
    const node = requireNode(state, id);
    result.push({ node, depth });
    for (const childId of node.children) visit(childId, depth + 1);
  };
  for (const rootId of state.roots) visit(rootId, 0);
  return result;
}

export function todoDockItems(state: TodoStackState): TodoItem[] {
  assertTodoStackState(state);
  const seen = new Set<string>();
  return flattenNodes(state).map(({ node, depth }) => {
    const marker = node.status === 'dropped' ? '× ' : state.focusId === node.id ? '▶ ' : '';
    const base = `${'· '.repeat(depth)}${marker}${node.title}`;
    const content = seen.has(base) ? `${base} [${node.id.slice(0, 8)}]` : base;
    seen.add(content);
    return {
      content,
      status: node.status === 'pending'
        ? state.focusId === node.id ? 'in_progress' : 'pending'
        : 'completed',
    };
  });
}

export function makeTodoStackCarrier(
  operation: TodoStackOperation,
  state: TodoStackState,
): TodoStackCarrier {
  assertTodoStackState(state);
  return {
    todos: todoDockItems(state),
    todoStack: {
      kind: TODO_STACK_ENVELOPE_KIND,
      version: TODO_STACK_VERSION,
      operation,
      state,
    },
  };
}

