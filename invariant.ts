import type { Context } from '@deepseek-ai/cordis';

import {
  emptyTodoStack,
  extractTodoStackEnvelope,
  todoDockItems,
} from './lib/state.ts';
import type { TodoStackState } from './lib/types.ts';

const PACKAGE_NAME = 'dsh-plugin-todo-stack';
const name = 'todo-stack-invariant';
const inject = ['invariants'];

type Fail = (message: string) => never;
type EventLike = { type: string; data: unknown };

function validateCarrier(event: EventLike, previous: TodoStackState, fail: Fail): TodoStackState {
  let envelope;
  try {
    envelope = extractTodoStackEnvelope(event);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (envelope === undefined) return previous;
  if (envelope.state.revision !== previous.revision + 1) {
    fail(`todo stack revision ${envelope.state.revision} does not follow ${previous.revision}`);
  }
  const rawTodos = (event.data as { todos?: unknown }).todos;
  const expectedTodos = todoDockItems(envelope.state);
  const rawState = (event.data as any)?.todoStack?.state;
  const repairedLegacyFocus = rawState?.focusId === null
    && Object.values(rawState?.nodes ?? {}).some((node: any) => node?.status === 'pending');
  const legacyExpectedTodos = expectedTodos.map((todo) => todo.status !== 'in_progress'
    ? todo
    : {
        content: todo.content.replace(/^((?:· )*)▶ /, '$1'),
        status: 'pending' as const,
      });
  if (JSON.stringify(rawTodos) !== JSON.stringify(expectedTodos)
    && (!repairedLegacyFocus || JSON.stringify(rawTodos) !== JSON.stringify(legacyExpectedTodos))) {
    fail('todo/write compatibility list does not match its todoStack snapshot');
  }
  return envelope.state;
}

export function validateTodoStackHistory(events: readonly EventLike[], fail: Fail): void {
  let state = emptyTodoStack();
  for (const event of events) state = validateCarrier(event, state, fail);
}

const install = Object.assign((ctx: any, fail: Fail) => {
  for (const session of ctx.sessions.list()) validateTodoStackHistory(session.events, fail);
  ctx.on('internal/dispatch', (_mode: unknown, eventName: string, args: unknown[]) => {
    if (eventName !== 'session/event') return;
    const session = args[0] as { events: readonly EventLike[] };
    const event = args[1] as EventLike;
    if (event.type !== 'todo/write') return;
    const previousEvents = session.events;
    let previous = emptyTodoStack();
    for (const candidate of previousEvents) {
      previous = validateCarrier(candidate, previous, fail);
    }
    validateCarrier(event, previous, fail);
  }, { global: true });
}, { inject: ['sessions'] });

function apply(ctx: Context): Promise<() => void> {
  return Promise.resolve((ctx as any).invariants.register(PACKAGE_NAME, install));
}

export { apply, inject, name };
