import { z } from 'zod';

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import type { TodoItem } from '@deepseek-ai/dsh-session';

import {
  emptyTodoStack,
  extractTodoStackEnvelope,
  todoDockItems,
} from './state.ts';
import type { TodoStackState } from './types.ts';

const todoNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  parentId: z.string().nullable(),
  children: z.array(z.string()),
  status: z.union([z.literal('pending'), z.literal('completed'), z.literal('dropped')]),
});

export const todoStackProjectionSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  roots: z.array(z.string()),
  nodes: z.record(z.string(), todoNodeSchema),
  focusId: z.string().nullable(),
});

export const todosProjectionSchema = z.union([
  z.array(z.object({
    content: z.string(),
    status: z.union([
      z.literal('pending'),
      z.literal('in_progress'),
      z.literal('completed'),
    ]),
  })),
  z.null(),
]);

export function todoStackProjection(): ProjectionDefinition<'todoStack', TodoStackState> {
  return {
    key: 'todoStack',
    schema: todoStackProjectionSchema,
    init: emptyTodoStack,
    apply(state, event) {
      const envelope = extractTodoStackEnvelope(event);
      if (envelope === undefined) return state;
      if (envelope.state.revision !== state.revision + 1) {
        throw new Error(
          `invalid todo stack: revision ${envelope.state.revision} does not follow ${state.revision}`,
        );
      }
      return envelope.state;
    },
    view: (state) => state,
    stateVersion: 1,
  };
}

export function todoDockProjection(): ProjectionDefinition<'todos', TodoItem[] | null> {
  return {
    key: 'todos',
    schema: todosProjectionSchema,
    init: () => null,
    apply(state, event) {
      const envelope = extractTodoStackEnvelope(event);
      if (envelope === undefined) return state;
      return todoDockItems(envelope.state);
    },
    view: (state) => state,
    stateVersion: 1,
  };
}

