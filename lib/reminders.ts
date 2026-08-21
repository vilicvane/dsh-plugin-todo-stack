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
  if (afterSeq === undefined) return '';
  return [
    `<todo-stack-no-focus after-node="${afterSeq}">`,
    'I currently have no todo focus. Before I continue working, I need to restore one: choose a meaningful pending leaf, or create a new focused todo if more work remains. If I am only wrapping up and summarizing completed work, I can continue without one.',
    '</todo-stack-no-focus>',
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
    `<todo-stack-turn-start turn="${turn}">`,
    'I am starting a new turn, so I need to reflect on whether I am still synchronized with the todo stack:',
    '- Does the current focus still match the next concrete work?',
    '- Am I diving deeper? I should break down the focus when that would make the work structure clearer.',
    '- Did I identify something to handle later? I should add it below the relevant todo without losing my current focus.',
    '- If the stack already reflects the work accurately, I can continue without changing it.',
    '</todo-stack-turn-start>',
  ].join('\n');
}
