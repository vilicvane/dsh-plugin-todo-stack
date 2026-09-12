import type { TodoItem } from '@deepseek-ai/dsh-tool-todo';

export const TODO_STACK_ENVELOPE_KIND = 'dsh-plugin-todo-stack';
export const TODO_STACK_VERSION = 1;

export type TodoNodeStatus = 'pending' | 'completed' | 'dropped';

export interface TodoStackNode {
  id: string;
  content: string;
  parentId: string | null;
  children: string[];
  status: TodoNodeStatus;
}

export interface TodoStackState {
  version: 1;
  revision: number;
  roots: string[];
  nodes: Record<string, TodoStackNode>;
  focusId: string | null;
}

export type TodoStackOperation =
  | 'create'
  | 'expand'
  | 'push'
  | 'delete'
  // Legacy operation names remain readable in persisted sessions.
  | 'add'
  | 'focus'
  | 'exit'
  | 'complete'
  | 'edit'
  | 'move'
  | 'drop'
  | 'reopen';

export interface TodoStackEnvelope {
  kind: typeof TODO_STACK_ENVELOPE_KIND;
  version: 1;
  operation: TodoStackOperation;
  state: TodoStackState;
}

export interface TodoStackCarrier {
  todos: TodoItem[];
  todoStack: TodoStackEnvelope;
}

export interface TodoNodeView {
  id: string;
  content: string;
  parentId: string | null;
  status: TodoNodeStatus;
  depth: number;
  hasChildren: boolean;
  focused: boolean;
}

export interface TodoStackCounts {
  pending: number;
  completed: number;
  dropped: number;
}

export interface TodoStackView {
  revision: number;
  focusId: string | null;
  path: TodoNodeView[];
  nodes: TodoNodeView[];
  counts: TodoStackCounts;
  truncated: boolean;
}

export interface CompleteTodoNodeView {
  id: string;
  todo: string;
  status: TodoNodeStatus;
  focused: boolean;
  children: CompleteTodoNodeView[];
}

export interface CompleteTodoTreeView {
  revision: number;
  focusId: string | null;
  roots: CompleteTodoNodeView[];
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    todoStack: TodoStackState;
    todos: TodoItem[] | null;
  }

  interface SessionProjectionMap {
    todoStack: TodoStackState;
    todos: TodoItem[] | null;
  }
}
