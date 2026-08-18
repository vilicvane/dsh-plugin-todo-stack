import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import {
  IconCheckOutline14,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
  IconChecklistOutline14,
  IconCloseFill14,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  PropsLocale,
  PropsRuntime,
  TranslateNS,
} from '@deepseek-ai/dsh-client-ui-slots';
import {
  createElement as h,
  useId,
  useState,
} from 'react';
import type { CSSProperties, ReactElement } from 'react';

import type {
  TodoStackNode,
  TodoStackState,
} from '../lib/types.ts';

const PLUGIN_ID = 'dsh-plugin-todo-stack';
const NS = 'todo-stack';
const STYLE_ID = `${PLUGIN_ID}/TodoStackDock.css`;

type LocaleKey =
  | 'title'
  | 'focus.current'
  | 'progress.pending'
  | 'progress.completed'
  | 'progress.dropped'
  | 'status.focused'
  | 'status.pending'
  | 'status.completed'
  | 'status.dropped';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'todo-stack': LocaleKey;
  }
}

const zh = {
  title: '任务栈',
  'focus.current': '当前：{content}',
  'progress.pending': '{count} 待处理',
  'progress.completed': '{count} 已完成',
  'progress.dropped': '{count} 已放弃',
  'status.focused': '当前任务',
  'status.pending': '待处理',
  'status.completed': '已完成',
  'status.dropped': '已放弃',
} satisfies Record<LocaleKey, string>;

const en = {
  title: 'Task Stack',
  'focus.current': 'Current: {content}',
  'progress.pending': '{count} pending',
  'progress.completed': '{count} completed',
  'progress.dropped': '{count} dropped',
  'status.focused': 'Current task',
  'status.pending': 'Pending',
  'status.completed': 'Completed',
  'status.dropped': 'Dropped',
} satisfies Record<LocaleKey, string>;

const css = `
.todoStackRoot{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex:none;margin:0 auto;overflow:hidden}
.todoStackBody{display:flex;flex-direction:column;padding:6px 8px}
.todoStackHeader{display:flex;align-items:center;gap:10px;width:100%;padding:0 4px;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:7px}
.todoStackHeader:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}
.todoStackLead,.todoStackChevron{display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);flex:none}
.todoStackTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:24px;flex:none}
.todoStackProgress{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:400;line-height:20px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;flex:auto}
.todoStackList{display:flex;flex-direction:column;gap:2px;max-height:240px;margin:4px 0 0;padding:0;list-style:none;overflow-y:auto}
.todoStackRow{--todo-indent:0px;box-sizing:border-box;position:relative;display:flex;align-items:center;min-width:0;min-height:28px;padding:3px 8px 3px calc(4px + var(--todo-indent));border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.todoStackRow[data-focused="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.todoStackBranch{box-sizing:border-box;width:11px;height:14px;margin:-7px 5px 0 0;border-inline-start:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);border-end-start-radius:4px;flex:none}
.todoStackGlyph{display:grid;place-items:center;width:16px;height:16px;margin-inline-end:8px;color:var(--dsw-alias-label-caption);flex:none}
.todoStackGlyph[data-status="focused"]{color:var(--dsw-alias-state-business-primary);animation:1s linear infinite todo-stack-spin}
.todoStackGlyph[data-status="completed"]{color:var(--dsw-alias-state-success-primary)}
.todoStackGlyph[data-status="dropped"]{color:var(--dsw-alias-label-caption)}
.todoStackContent{min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;flex:auto}
.todoStackRow[data-status="completed"] .todoStackContent,.todoStackRow[data-status="dropped"] .todoStackContent{color:var(--dsw-alias-label-tertiary)}
.todoStackRow[data-status="dropped"] .todoStackContent{text-decoration:line-through}
.todoStackCurrent{margin-inline-start:8px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:18px;flex:none}
@keyframes todo-stack-spin{to{transform:rotate(360deg)}}
`;

if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) === null) {
  const tag = document.createElement('style');
  tag.dataset.plugin = PLUGIN_ID;
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = css;
  document.head.appendChild(tag);
}

export interface TodoStackRow {
  node: TodoStackNode;
  depth: number;
}

export function flattenTodoStack(state: TodoStackState): TodoStackRow[] {
  const rows: TodoStackRow[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = state.nodes[id];
    if (node === undefined) return;
    rows.push({ node, depth });
    for (const childId of node.children) visit(childId, depth + 1);
  };
  for (const rootId of state.roots) visit(rootId, 0);
  return rows;
}

function progressLabel(state: TodoStackState, t: TranslateNS<'todo-stack'>): string {
  let pending = 0;
  let completed = 0;
  let dropped = 0;
  for (const node of Object.values(state.nodes)) {
    if (node.status === 'pending') pending += 1;
    else if (node.status === 'completed') completed += 1;
    else dropped += 1;
  }
  const parts: string[] = [];
  const focused = state.focusId === null ? undefined : state.nodes[state.focusId];
  if (focused !== undefined) parts.push(t('focus.current', { content: focused.content }));
  if (pending > 0) parts.push(t('progress.pending', { count: pending }));
  if (completed > 0) parts.push(t('progress.completed', { count: completed }));
  if (dropped > 0) parts.push(t('progress.dropped', { count: dropped }));
  return parts.join(' · ');
}

function ProgressGlyph(): ReactElement {
  const gradientId = useId();
  return h('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 14 14',
    fill: 'none',
    'aria-hidden': true,
  },
  h('defs', null,
    h('linearGradient', {
      id: gradientId,
      x1: '2.5',
      y1: '12',
      x2: '10.5',
      y2: '3.5',
      gradientUnits: 'userSpaceOnUse',
    },
    h('stop', { stopColor: 'currentColor' }),
    h('stop', { offset: '1', stopColor: 'currentColor', stopOpacity: '0' }))),
  h('circle', {
    cx: '7',
    cy: '7',
    r: '6.4',
    stroke: `url(#${gradientId})`,
    strokeWidth: '1.2',
  }));
}

function PendingGlyph(): ReactElement {
  return h('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 14 14',
    fill: 'none',
    'aria-hidden': true,
  }, h('circle', {
    cx: '7',
    cy: '7',
    r: '6.4',
    stroke: 'currentColor',
    strokeWidth: '1.2',
    strokeDasharray: '2.4 2.4',
  }));
}

function StatusGlyph({ node, focused }: { node: TodoStackNode; focused: boolean }): ReactElement {
  if (focused) return h(ProgressGlyph);
  if (node.status === 'completed') return h(IconCheckOutline14);
  if (node.status === 'dropped') return h(IconCloseFill14);
  return h(PendingGlyph);
}

export interface TodoStackPanelProps {
  state: TodoStackState;
  t: TranslateNS<'todo-stack'>;
  /** Test and embedding seam; the dock itself starts collapsed. */
  defaultCollapsed?: boolean;
}

export function TodoStackPanel({
  state,
  t,
  defaultCollapsed = true,
}: TodoStackPanelProps): ReactElement | null {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const rows = flattenTodoStack(state);
  if (rows.length === 0) return null;

  return h('section', {
    className: 'todoStackRoot',
    'data-testid': 'todo-stack-panel',
    'aria-label': t('title'),
  }, h('div', { className: 'todoStackBody' },
    h('button', {
      type: 'button',
      className: 'todoStackHeader',
      'aria-expanded': !collapsed,
      onClick: () => setCollapsed((value) => !value),
    },
    h('span', { className: 'todoStackLead', 'aria-hidden': true }, h(IconChecklistOutline14)),
    h('span', { className: 'todoStackTitle' }, t('title')),
    h('span', { className: 'todoStackProgress' }, progressLabel(state, t)),
    h('span', { className: 'todoStackChevron', 'aria-hidden': true },
      collapsed ? h(IconChevronUpOutline14) : h(IconChevronDownOutline14))),
    !collapsed && h('ul', { className: 'todoStackList' },
      ...rows.map(({ node, depth }) => {
        const focused = node.id === state.focusId;
        const visualStatus = focused ? 'focused' : node.status;
        const statusLabel = t(`status.${visualStatus}`);
        const rowStyle = { '--todo-indent': `${depth * 18}px` } as CSSProperties;
        return h('li', {
          key: node.id,
          className: 'todoStackRow',
          style: rowStyle,
          'data-depth': depth,
          'data-status': node.status,
          'data-focused': focused,
          'aria-current': focused ? 'step' : undefined,
        },
        depth > 0 ? h('span', { className: 'todoStackBranch', 'aria-hidden': true }) : null,
        h('span', {
          className: 'todoStackGlyph',
          'data-status': visualStatus,
          'aria-label': statusLabel,
          title: statusLabel,
        }, h(StatusGlyph, { node, focused })),
        h('span', { className: 'todoStackContent' }, node.content),
        focused ? h('span', { className: 'todoStackCurrent' }, t('status.focused')) : null);
      }))));
}

export type TodoStackDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'todo-stack'>;

export function TodoStackDock({ useProjection, t }: TodoStackDockProps): ReactElement {
  const state = useProjection('todoStack');
  return h(TodoStackPanel, {
    state: state ?? {
      version: 1,
      revision: 0,
      roots: [],
      nodes: {},
      focusId: null,
    },
    t,
  });
}

export const inject = ['slots', 'locale'];

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'todo-stack: dictionaries');
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'todo',
    order: 0,
    priority: -10,
    locale: NS,
  }, TodoStackDock));
}
