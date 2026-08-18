import { assertTodoStackState } from './state.ts';
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

function nodeView(node: TodoStackNode, depth: number, focusId: string | null): TodoNodeView {
  return {
    id: node.id,
    title: node.title,
    parentId: node.parentId,
    status: node.status,
    depth,
    hasChildren: node.children.length > 0,
    focused: node.id === focusId,
  };
}

export function todoStackCounts(state: TodoStackState): TodoStackCounts {
  const counts: TodoStackCounts = { pending: 0, completed: 0, dropped: 0 };
  for (const node of Object.values(state.nodes)) counts[node.status] += 1;
  return counts;
}

export function focusPath(state: TodoStackState): TodoNodeView[] {
  assertTodoStackState(state);
  if (state.focusId === null) return [];
  const reversed: TodoStackNode[] = [];
  let id: string | null = state.focusId;
  while (id !== null) {
    const node = requireNode(state, id);
    reversed.push(node);
    id = node.parentId;
  }
  return reversed.reverse().map((node, depth) => nodeView(node, depth, state.focusId));
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

  const roots = options.rootId === undefined ? state.roots : [requireNode(state, options.rootId).id];
  const nodes: TodoNodeView[] = [];
  let truncated = false;

  const visit = (id: string, depth: number): void => {
    const node = requireNode(state, id);
    if (!includeEnded && node.status !== 'pending') return;
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    nodes.push(nodeView(node, depth, state.focusId));
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
    focusId: state.focusId,
    path: focusPath(state),
    nodes,
    counts: todoStackCounts(state),
    truncated,
  };
}

function formatNode(node: TodoStackNode): string {
  const status = node.status === 'pending' ? ' ' : node.status === 'completed' ? 'x' : '-';
  return `- [${status}] ${node.title} (${node.id})`;
}

export function renderTodoStackContext(state: TodoStackState, childLimit: number): string {
  assertTodoStackState(state);
  if (Object.keys(state.nodes).length === 0) return '';
  if (!Number.isSafeInteger(childLimit) || childLimit < 1) {
    throw new Error('context child limit must be a positive safe integer');
  }

  const counts = todoStackCounts(state);
  const path = focusPath(state);
  const lines = [
    `<todo-stack revision="${state.revision}">`,
    `Progress: ${counts.pending} pending, ${counts.completed} completed, ${counts.dropped} dropped.`,
  ];

  if (state.focusId === null) {
    lines.push('Focus: none. Choose an existing pending root with focus, or push a new root.');
    const roots = state.roots
      .map((id) => requireNode(state, id))
      .filter((node) => node.status === 'pending');
    if (roots.length > 0) {
      lines.push('Pending roots:');
      for (const node of roots.slice(0, childLimit)) lines.push(formatNode(node));
      if (roots.length > childLimit) lines.push(`- … ${roots.length - childLimit} more`);
    }
  } else {
    const focused = requireNode(state, state.focusId);
    lines.push(`Focus path: ${path.map((node) => `${node.title} (${node.id})`).join(' > ')}`);
    if (focused.children.length === 0) {
      lines.push('Children: none.');
    } else {
      lines.push('Children:');
      for (const childId of focused.children.slice(0, childLimit)) {
        lines.push(formatNode(requireNode(state, childId)));
      }
      if (focused.children.length > childLimit) {
        lines.push(`- … ${focused.children.length - childLimit} more`);
      }
    }
  }

  lines.push('</todo-stack>');
  return lines.join('\n');
}

