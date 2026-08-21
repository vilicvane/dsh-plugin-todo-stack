import { deriveEventMessage } from '@deepseek-ai/dsh-session';
import type { TodoStackState } from './types.ts';

export const TODO_STACK_REMINDER_CONTEXT_NAME = 'todo-stack:reminder';
export const TODO_STACK_NO_FOCUS_CONTEXT_NAME = 'todo-stack:no-focus';

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

function effectiveOpenTurnEvents(session: any, turn: number): any[] {
  const start = turnStartSeq(session, turn);
  if (start === undefined) throw new Error(`todo-stack reminder: open turn ${turn} has no matching turn/start`);
  const events: any[] = [];
  for (const seq of session.surface.nodes as number[]) {
    if (seq <= start) continue;
    const event = session.events[seq];
    if (event?.surfaceOp !== 'append' || isRuntimeContextSnapshot(event)) continue;
    if (deriveEventMessage(event) !== null) events.push(event);
  }
  return events;
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

export function countOpenTurnNodes(session: any, turn: number): number {
  return effectiveOpenTurnEvents(session, turn).length;
}

export function nodeMilestone(openTurnNodes: number, reminderIntervalNodes: number): number {
  return Math.floor(openTurnNodes / reminderIntervalNodes) * reminderIntervalNodes;
}

function numericMarkerAttribute(text: string, name: string): number | undefined {
  const match = new RegExp(`\\b${name}="(\\d+)"`).exec(text);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function latestAnnouncedNodeMilestone(session: any, turn: number): number {
  const start = turnStartSeq(session, turn);
  if (start === undefined) return 0;
  let latest = 0;
  for (const event of session.events as any[]) {
    if (event?.seq <= start
      || event?.type !== 'user/message'
      || event.data?.source?.kind !== 'plugin'
      || event.data.source.plugin !== SYSTEM_PROMPT_PLUGIN
      || !Array.isArray(event.data.source.sections)) continue;
    for (const section of event.data.source.sections) {
      if (section?.name !== TODO_STACK_REMINDER_CONTEXT_NAME || typeof section.text !== 'string') continue;
      if (numericMarkerAttribute(section.text, 'turn') !== turn) continue;
      const milestone = numericMarkerAttribute(section.text, 'milestone-nodes');
      if (milestone !== undefined) latest = Math.max(latest, milestone);
    }
  }
  return latest;
}

export function buildTodoStackReminderContext(options: {
  session: any;
  reminderIntervalNodes: number;
}): string {
  const turn = openTurnNumber(options.session);
  if (turn === null) return '';
  const events = effectiveOpenTurnEvents(options.session, turn);
  const openTurnNodes = events.length;
  const milestoneNodes = nodeMilestone(openTurnNodes, options.reminderIntervalNodes);
  const announceMilestone = milestoneNodes > latestAnnouncedNodeMilestone(options.session, turn)
    ? milestoneNodes
    : 0;
  if (announceMilestone === 0) return '';

  const attributes = [
    `turn="${turn}"`,
    `open-turn-nodes="${openTurnNodes}"`,
    `milestone-nodes="${announceMilestone}"`,
  ];
  const lines = [`<todo-stack-reminder ${attributes.join(' ')}>`];
  lines.push(
    `This turn has crossed ${announceMilestone} nodes. I need to reflect now on whether I am still synchronized with the todo stack:`,
  );
  lines.push(
    '- Am I diving deeper? I should break down the current focus and move focus to the next concrete step.',
    '- Did I remember something to handle later? I should add it below the relevant task without losing my current focus.',
    '- In any case, I need to keep the stack up to date. Otherwise I could lose focus during turn and session compaction, and the user would lose visibility into the structure of my plan.',
    '</todo-stack-reminder>',
  );
  return lines.join('\n');
}
