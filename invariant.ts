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

function compatibilityRowsForLegacyFocus(
  state: TodoStackState,
  rawFocusId: unknown,
): ReturnType<typeof todoDockItems> | undefined {
  if (typeof rawFocusId !== 'string') return undefined;
  const focused = state.nodes[rawFocusId];
  if (focused?.status !== 'pending') return undefined;
  const ids: string[] = [];
  const visit = (id: string): void => {
    ids.push(id);
    for (const childId of state.nodes[id].children) visit(childId);
  };
  for (const rootId of state.roots) visit(rootId);
  const index = ids.indexOf(rawFocusId);
  if (index < 0) return undefined;

  const rows = todoDockItems({ ...state, focusId: null });
  const row = rows[index];
  const match = /^((?:· )*)(.*)$/.exec(row.content);
  if (match === null) return undefined;
  rows[index] = {
    content: `${match[1]}▶ ${match[2]}`,
    status: 'in_progress',
  };
  return rows;
}

function withoutLegacyFocusMarker(
  rows: ReturnType<typeof todoDockItems>,
): ReturnType<typeof todoDockItems> {
  return rows.map((row) => ({
    ...row,
    content: row.content.replace(/^((?:· )*)▶ /, '$1'),
  }));
}

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
  const legacyTodos = rawState?.focusId === envelope.state.focusId
    ? undefined
    : compatibilityRowsForLegacyFocus(envelope.state, rawState?.focusId);
  const rawOperation = (event.data as any)?.todoStack?.operation;
  const legacyShape = rawOperation === 'rename'
    || Object.values(rawState?.nodes ?? {}).some((node: any) => node?.title !== undefined);
  const acceptedTodos = [expectedTodos];
  if (legacyTodos !== undefined) acceptedTodos.push(legacyTodos);
  if (legacyShape) {
    acceptedTodos.push(withoutLegacyFocusMarker(expectedTodos));
    if (legacyTodos !== undefined) acceptedTodos.push(withoutLegacyFocusMarker(legacyTodos));
  }
  if (!acceptedTodos.some((candidate) =>
    JSON.stringify(rawTodos) === JSON.stringify(candidate))) {
    fail('todo/write compatibility list does not match its todoStack snapshot');
  }
  return envelope.state;
}

export function validateTodoStackHistory(events: readonly EventLike[], fail: Fail): void {
  let state = emptyTodoStack();
  for (const event of events) state = validateCarrier(event, state, fail);
}

const install = Object.assign((ctx: any, fail: Fail) => {
  for (const session of ctx.sessions.list()) validateTodoStackHistory(session.snapshotEvents(), fail);
  ctx.on('internal/dispatch', (_mode: unknown, eventName: string, args: unknown[]) => {
    if (eventName !== 'session/event') return;
    const session = args[0] as { snapshotEvents(): readonly EventLike[] };
    const event = args[1] as EventLike;
    if (event.type !== 'todo/write') return;
    const previousEvents = session.snapshotEvents();
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
