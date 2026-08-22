import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import type { TodoStackState } from './types.ts';

export const TODO_STACK_NO_FOCUS_CONTEXT_NAME = 'todo-stack:no-focus';
export const TODO_STACK_TURN_START_CONTEXT_NAME = 'todo-stack:turn-start';

const SYSTEM_PROMPT_PLUGIN = '@deepseek-ai/dsh-system-prompt';

export function openTurnNumber(session: any): number | null {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index];
    if (event?.type === 'turn/end') return null;
    if (event?.type === 'turn/start') {
      return Number.isSafeInteger(event.data?.turn) ? event.data.turn : null;
    }
  }
  return null;
}

function turnStartSeq(session: any, turn: number): number | undefined {
  return session.events.findLast((event: any) =>
    event?.type === 'turn/start' && event.data?.turn === turn)?.seq;
}

function isRuntimeContextSnapshot(event: any): boolean {
  return event?.type === 'user/message'
    && event.data?.source?.kind === 'plugin'
    && event.data.source.plugin === SYSTEM_PROMPT_PLUGIN;
}

export function latestEligibleSurfaceSeq(session: any): number | undefined {
  for (let index = session.surface.nodes.length - 1; index >= 0; index -= 1) {
    const seq = session.surface.nodes[index];
    const event = session.events[seq];
    if (event?.surfaceOp !== 'append' || isRuntimeContextSnapshot(event)) continue;
    if (deriveEventMessage(event) !== null) return seq;
  }
  return undefined;
}

export function buildNoFocusGuardContext(options: {
  session: any;
  state: TodoStackState;
  opening: boolean;
}): string {
  if (options.opening || options.state.focusId !== null) return '';
  const afterSeq = latestEligibleSurfaceSeq(options.session);
  const turn = openTurnNumber(options.session);
  if (afterSeq === undefined && turn === null) return '';
  const position = afterSeq === undefined
    ? `turn ${turn}`
    : `after node ${afterSeq}`;
  return [
    `Todo Stack action required — ${position}`,
    'Do not continue substantive work or call another non-Todo tool until focus is restored.',
    '- If a pending leaf matches the next work, call todo_stack__focus with its id.',
    '- If only a pending parent remains after its children finished, complete the parent when its outcome is verified; otherwise expand it into the remaining concrete work and focus that child.',
    '- If no pending work remains, call todo_stack__create with one brief outcome to focus. Do not put tool steps, evidence, reporting, or final-answer requirements in the todo.',
    '- Skip this action only when the next action is the final response summarizing already completed work.',
  ].join('\n');
}

export function turnStartReflectionWasShown(session: any, turn: number): boolean {
  const start = turnStartSeq(session, turn);
  if (start === undefined) return false;
  for (const event of session.events as any[]) {
    if (event?.seq <= start
      || event?.type !== 'user/message'
      || event.data?.source?.kind !== 'plugin'
      || event.data.source.plugin !== SYSTEM_PROMPT_PLUGIN
      || !Array.isArray(event.data.source.sections)) continue;
    for (const section of event.data.source.sections) {
      if (section?.name === TODO_STACK_TURN_START_CONTEXT_NAME) return true;
    }
  }
  return false;
}

function turnHasStartedWorking(session: any, turn: number): boolean {
  const start = turnStartSeq(session, turn);
  if (start === undefined) return false;
  return session.events.some((event: any) => event?.seq > start && (
    event.type === 'assistant/message'
    || event.type === 'tool/result'
    || event.type === 'todo/write'
  ));
}

export function buildTurnStartReflectionContext(options: {
  session: any;
  state: TodoStackState;
  opening: boolean;
}): string {
  if (options.opening || options.state.focusId === null) return '';
  const turn = openTurnNumber(options.session);
  if (turn === null
    || turnStartReflectionWasShown(options.session, turn)
    || turnHasStartedWorking(options.session, turn)) return '';
  return [
    `Todo Stack check required — turn ${turn}`,
    'Synchronize the Todo Stack before the next work or final response:',
    '- [*] means focused and still pending; only [x] means completed. If the focused outcome is already verified, call todo_stack__complete before giving the final response.',
    '- Confirm that the focused leaf matches the next concrete outcome.',
    '- If the next work is more specific, call todo_stack__expand before continuing.',
    '- Record established later work below the relevant todo without losing the current focus.',
    '- If the stack already matches the work, continue without changing it.',
  ].join('\n');
}
