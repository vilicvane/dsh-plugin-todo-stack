import { deriveEventMessage } from '@deepseek-ai/dsh-session';

export const TODO_STACK_REMINDER_CONTEXT_NAME = 'todo-stack:reminder';

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
    `This turn has crossed ${announceMilestone} nodes. If you think updating the current todo branch would make your work and progress clearer to the user, update it now; otherwise continue.`,
  );
  lines.push(
    'Keep each todo node to one short outcome; keep working details out of the tree.',
    '</todo-stack-reminder>',
  );
  return lines.join('\n');
}
