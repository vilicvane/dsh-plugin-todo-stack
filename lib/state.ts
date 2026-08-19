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

export const MAX_CONTENT_CHARS = 240;
export const MAX_TREE_DEPTH = 64;

const OPERATIONS = new Set<TodoStackOperation>([
  'push',
  'add',
  'focus',
  'exit',
  'complete',
  'edit',
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
  | { action: 'push'; content: string }
  | { action: 'add'; content: string; parentId?: string | null; afterId?: string }
  | { action: 'focus'; id: string }
  | { action: 'exit' }
  | { action: 'complete' }
  | { action: 'edit'; id: string; content: string }
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

function normalizePersistedState(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.nodes)) return value;
  let changed = false;
  const nodes: Record<string, unknown> = {};
  for (const [id, candidate] of Object.entries(value.nodes)) {
    if (!isRecord(candidate) || !Object.hasOwn(candidate, 'title')) {
      nodes[id] = candidate;
      continue;
    }
    const { title, ...node } = candidate;
    if (node.content === undefined && typeof title === 'string') node.content = title;
    nodes[id] = node;
    changed = true;
  }
  let focusId = value.focusId;
  if (focusId === null) {
    const pendingId = firstPersistedPendingFocus(nodes, value.roots);
    if (pendingId !== null) {
      focusId = pendingId;
      changed = true;
    }
  }
  return changed ? { ...value, nodes, focusId } : value;
}

/** Repair pre-invariant snapshots that retained pending work without a focus. */
function firstPersistedPendingFocus(
  nodes: Record<string, unknown>,
  roots: unknown,
): string | null {
  if (!Array.isArray(roots)) return null;
  const visited = new Set<string>();
  const descend = (id: unknown): string | null => {
    if (typeof id !== 'string' || visited.has(id)) return null;
    visited.add(id);
    const node = nodes[id];
    if (!isRecord(node) || node.status !== 'pending') return null;
    if (Array.isArray(node.children)) {
      for (const childId of node.children) {
        const pending = descend(childId);
        if (pending !== null) return pending;
      }
    }
    return id;
  };
  for (const rootId of roots) {
    const pending = descend(rootId);
    if (pending !== null) return pending;
  }
  return null;
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
    if (typeof rawNode.content !== 'string' || rawNode.content.length === 0 || rawNode.content.trim() !== rawNode.content) {
      fail(`node ${JSON.stringify(key)} has empty or untrimmed content`);
    }
    if (rawNode.content.length > MAX_CONTENT_CHARS) {
      fail(`node ${JSON.stringify(key)} content exceeds ${MAX_CONTENT_CHARS} characters`);
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
  const hasPending = Object.values(nodes).some(
    (node) => (node as unknown as TodoStackNode).status === 'pending',
  );
  if (hasPending !== (value.focusId !== null)) {
    fail('focus must exist exactly while pending work exists');
  }
}

export function extractTodoStackEnvelope(event: { type: string; data: unknown }): TodoStackEnvelope | undefined {
  if (event.type !== 'todo/write' || !isRecord(event.data)) return undefined;
  const raw = event.data.todoStack;
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail('todoStack carrier field must be an object');
  if (raw.kind !== TODO_STACK_ENVELOPE_KIND) fail('todoStack carrier has an unknown kind');
  if (raw.version !== TODO_STACK_VERSION) fail(`unsupported envelope version ${String(raw.version)}`);
  const operation = raw.operation === 'rename' ? 'edit' : raw.operation;
  if (typeof operation !== 'string' || !OPERATIONS.has(operation as TodoStackOperation)) {
    fail(`unknown operation ${JSON.stringify(raw.operation)}`);
  }
  const state = normalizePersistedState(raw.state);
  assertTodoStackState(state);
  return { ...raw, operation, state } as unknown as TodoStackEnvelope;
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

function normalizeContent(content: string): string {
  const normalized = content.trim();
  if (normalized.length === 0) throw new Error('todo content must not be empty');
  if (normalized.length > MAX_CONTENT_CHARS) {
    throw new Error(`todo content must be at most ${MAX_CONTENT_CHARS} characters`);
  }
  return normalized;
}

function requireNode(state: TodoStackState, id: string): TodoStackNode {
  const node = state.nodes[id];
  if (node === undefined) throw new Error(`todo node ${JSON.stringify(id)} does not exist`);
  return node;
}

const SHORT_ID_PATTERN = /^t[1-9][0-9]*$/;

function nextTodoId(state: TodoStackState): string {
  let number = 1;
  while (state.nodes[`t${number}`] !== undefined) number += 1;
  return `t${number}`;
}

/**
 * Return the stable model-facing reference for one canonical node id.
 * New nodes already use compact `tN` ids. Legacy ids retain their canonical
 * identity and are exposed through the shortest unique prefix of at least six
 * characters, so old sessions do not require a state migration.
 */
export function todoNodeRef(state: TodoStackState, id: string): string {
  requireNode(state, id);
  if (SHORT_ID_PATTERN.test(id) || id.length <= 6) return id;
  const ids = Object.keys(state.nodes);
  for (let length = 6; length < id.length; length += 1) {
    const prefix = id.slice(0, length);
    if (ids.every((candidate) => candidate === id || !candidate.startsWith(prefix))) {
      return prefix;
    }
  }
  return id;
}

/** Resolve an exact canonical id, compact id, or unambiguous legacy prefix. */
export function resolveTodoNodeId(state: TodoStackState, reference: string): string {
  if (state.nodes[reference] !== undefined) return reference;
  const matches = Object.keys(state.nodes).filter((id) => id.startsWith(reference));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`todo node reference ${JSON.stringify(reference)} is ambiguous`);
  }
  throw new Error(`todo node ${JSON.stringify(reference)} does not exist`);
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

function firstPendingFocus(state: TodoStackState): string | null {
  const descend = (id: string): string | null => {
    const node = requireNode(state, id);
    if (node.status !== 'pending') return null;
    for (const childId of node.children) {
      const pending = descend(childId);
      if (pending !== null) return pending;
    }
    return id;
  };
  for (const rootId of state.roots) {
    const pending = descend(rootId);
    if (pending !== null) return pending;
  }
  return null;
}

function fallbackFocus(state: TodoStackState, preferredParentId: string | null): string | null {
  if (preferredParentId !== null) {
    const parent = requireNode(state, preferredParentId);
    if (parent.status === 'pending') return parent.id;
  }
  return firstPendingFocus(state);
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
  const createId = options.createId ?? (() => nextTodoId(state));
  let affectedId: string | null = null;

  if (mutation.action === 'push' || mutation.action === 'add') {
    if (Object.keys(state.nodes).length >= options.maxNodes) {
      throw new Error(`todo stack is limited to ${options.maxNodes} nodes`);
    }
    const content = normalizeContent(mutation.content);
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
      content,
      parentId,
      children: [],
      status: 'pending',
    };
    insertPlacement(state, id, parentId, mutation.action === 'add' ? mutation.afterId : undefined);
    if (mutation.action === 'push' || state.focusId === null) state.focusId = id;
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
    if (focused.parentId === null) {
      throw new Error('cannot exit a pending root; complete or drop it, or focus another pending task');
    }
    affectedId = focused.id;
    state.focusId = focused.parentId;
  } else if (mutation.action === 'complete') {
    if (state.focusId === null) throw new Error('todo stack has no current focus to complete');
    const focused = requireNode(state, state.focusId);
    if (focused.children.some((id) => subtreeHasPending(state, id))) {
      throw new Error('cannot complete a node while its subtree contains pending work');
    }
    focused.status = 'completed';
    state.focusId = fallbackFocus(state, focused.parentId);
    affectedId = focused.id;
  } else if (mutation.action === 'edit') {
    const node = requireNode(state, mutation.id);
    const content = normalizeContent(mutation.content);
    if (node.content === content) throw new Error('edit would not change the node content');
    node.content = content;
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
      state.focusId = fallbackFocus(state, node.parentId);
    }
    affectedId = id;
  } else if (mutation.action === 'reopen') {
    const node = requireNode(state, mutation.id);
    if (node.status === 'pending') throw new Error('todo node is already pending');
    if (node.parentId !== null && requireNode(state, node.parentId).status !== 'pending') {
      throw new Error('reopen the node ancestors before reopening this node');
    }
    node.status = 'pending';
    if (state.focusId === null) state.focusId = node.id;
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
    const base = `${'· '.repeat(depth)}${marker}${node.content}`;
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
