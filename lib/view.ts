import {
  assertTodoStackState,
  resolveTodoNodeId,
  todoNodeRef,
} from './state.ts';
import type {
  TodoNodeView,
  TodoStackCounts,
  TodoStackNode,
  TodoStackState,
  TodoStackView,
} from './types.ts';

export interface ViewOptions {
  rootId?: string;
  depth?: number;
  includeEnded?: boolean;
  maxNodes?: number;
}

function requireNode(state: TodoStackState, id: string): TodoStackNode {
  const node = state.nodes[id];
  if (node === undefined) throw new Error(`todo node ${JSON.stringify(id)} does not exist`);
  return node;
}

function nodeView(
  state: TodoStackState,
  node: TodoStackNode,
  depth: number,
): TodoNodeView {
  return {
    id: todoNodeRef(state, node.id),
    content: node.content,
    parentId: node.parentId === null ? null : todoNodeRef(state, node.parentId),
    status: node.status,
    depth,
    hasChildren: node.children.length > 0,
    focused: node.id === state.focusId,
  };
}

export function todoStackCounts(state: TodoStackState): TodoStackCounts {
  const counts: TodoStackCounts = { pending: 0, completed: 0, dropped: 0 };
  for (const node of Object.values(state.nodes)) counts[node.status] += 1;
  return counts;
}

export function focusPath(state: TodoStackState): TodoNodeView[] {
  assertTodoStackState(state);
  return focusPathNodes(state).map((node, depth) => nodeView(state, node, depth));
}

function focusPathNodes(state: TodoStackState): TodoStackNode[] {
  if (state.focusId === null) return [];
  const reversed: TodoStackNode[] = [];
  let id: string | null = state.focusId;
  while (id !== null) {
    const node = requireNode(state, id);
    reversed.push(node);
    id = node.parentId;
  }
  return reversed.reverse();
}

export function buildTodoStackView(state: TodoStackState, options: ViewOptions = {}): TodoStackView {
  assertTodoStackState(state);
  const depthLimit = options.depth ?? 3;
  const maxNodes = options.maxNodes ?? 80;
  const includeEnded = options.includeEnded ?? true;
  if (!Number.isSafeInteger(depthLimit) || depthLimit < 0) {
    throw new Error('depth must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new Error('maxNodes must be a positive safe integer');
  }

  const roots = options.rootId === undefined
    ? state.roots
    : [resolveTodoNodeId(state, options.rootId)];
  const nodes: TodoNodeView[] = [];
  let truncated = false;

  const visit = (id: string, depth: number): void => {
    const node = requireNode(state, id);
    if (!includeEnded && node.status !== 'pending') return;
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    nodes.push(nodeView(state, node, depth));
    const visibleChildren = node.children.filter((childId) =>
      includeEnded || requireNode(state, childId).status === 'pending');
    if (depth >= depthLimit) {
      if (visibleChildren.length > 0) truncated = true;
      return;
    }
    for (const childId of visibleChildren) visit(childId, depth + 1);
  };
  for (const rootId of roots) visit(rootId, 0);

  return {
    revision: state.revision,
    focusId: state.focusId === null ? null : todoNodeRef(state, state.focusId),
    path: focusPath(state),
    nodes,
    counts: todoStackCounts(state),
    truncated,
  };
}

function formatNode(
  state: TodoStackState,
  node: TodoStackNode,
  depth: number,
  markCurrent: boolean,
): string {
  const status = node.status === 'pending' ? ' ' : node.status === 'completed' ? 'x' : '-';
  const current = markCurrent ? '（进行中）' : '';
  return `${'  '.repeat(depth)}- [${status}] ${todoNodeRef(state, node.id)} ${node.content}${current}`;
}

interface VisibleChildren {
  before: number;
  nodes: TodoStackNode[];
  after: number;
}

function visibleChildren(
  state: TodoStackState,
  parent: TodoStackNode | null,
  focusId: string | null,
  limit: number,
): VisibleChildren {
  const ids = parent === null ? state.roots : parent.children;
  const visible = ids
    .map((id) => requireNode(state, id))
    .filter((node) => parent !== null || node.status === 'pending');
  if (visible.length <= limit) return { before: 0, nodes: visible, after: 0 };

  const focusIndex = focusId === null ? -1 : visible.findIndex((node) => node.id === focusId);
  if (focusIndex < 0) {
    return { before: 0, nodes: visible.slice(0, limit), after: visible.length - limit };
  }

  const start = Math.min(
    Math.max(0, focusIndex - Math.floor(limit / 2)),
    visible.length - limit,
  );
  return {
    before: start,
    nodes: visible.slice(start, start + limit),
    after: visible.length - start - limit,
  };
}

export function renderTodoStackContext(state: TodoStackState, childLimit: number): string {
  assertTodoStackState(state);
  if (Object.keys(state.nodes).length === 0) return '';
  if (!Number.isSafeInteger(childLimit) || childLimit < 1) {
    throw new Error('context child limit must be a positive safe integer');
  }

  const lines = [`<todo-stack revision="${state.revision}">`];

  if (state.focusId === null) {
    const roots = visibleChildren(state, null, null, childLimit);
    if (roots.nodes.length === 0) return '';
    for (const node of roots.nodes) lines.push(formatNode(state, node, 0, false));
    if (roots.after > 0) lines.push(`- … ${roots.after} more`);
  } else {
    const focused = requireNode(state, state.focusId);
    const frontierParent = focused.children.length === 0
      ? focused.parentId === null ? null : requireNode(state, focused.parentId)
      : focused;
    const path = focusPathNodes(state);
    const branchEnd = frontierParent === null
      ? -1
      : path.findIndex((node) => node.id === frontierParent.id);

    for (let index = 0; index <= branchEnd; index += 1) {
      lines.push(formatNode(state, path[index], index, false));
    }

    const frontier = visibleChildren(state, frontierParent, state.focusId, childLimit);
    const depth = branchEnd + 1;
    if (frontier.before > 0) lines.push(`${'  '.repeat(depth)}- … ${frontier.before} earlier`);
    for (const node of frontier.nodes) {
      lines.push(formatNode(
        state,
        node,
        depth,
        node.id === state.focusId && node.children.length === 0,
      ));
    }
    if (frontier.after > 0) lines.push(`${'  '.repeat(depth)}- … ${frontier.after} more`);
  }

  lines.push('</todo-stack>');
  return lines.join('\n');
}
