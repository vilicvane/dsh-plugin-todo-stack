import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCompleteTodoTree,
  renderTodoStackContext,
  renderTodoStackSiblingContext,
} from '../lib/view.ts';
import type { TodoStackNode, TodoStackState } from '../lib/types.ts';

function node(
  id: string,
  content: string,
  parentId: string | null,
  children: string[],
  status: TodoStackNode['status'] = 'pending',
): TodoStackNode {
  return { id, content, parentId, children, status };
}

function fixture(): TodoStackState {
  return {
    version: 1,
    revision: 12,
    roots: ['t1'],
    nodes: {
      t1: node('t1', '开发 A 功能', null, ['t2', 't3', 't7']),
      t2: node('t2', '调研 A1 特性', 't1', [], 'completed'),
      t3: node('t3', '调研 A2 特性', 't1', ['t4', 't5', 't6']),
      t4: node('t4', '验证接口', 't3', [], 'completed'),
      t5: node('t5', '验证异常路径', 't3', []),
      t6: node('t6', '整理结论', 't3', []),
      t7: node('t7', '技术验证', 't1', []),
    },
    focusId: 't5',
  };
}

test('runtime snapshot shows only the focus branch and leaf-level siblings', () => {
  assert.equal(renderTodoStackContext(fixture(), 8), [
    'Todo stack (revision 12):',
    '- [ ] t1 开发 A 功能',
    '  - [ ] t3 调研 A2 特性',
    '    - [x] t4 验证接口',
    '    - [*] t5 验证异常路径',
    '    - [ ] t6 整理结论',
  ].join('\n'));
});

test('a non-leaf focus is rejected by the view invariant', () => {
  const state = fixture();
  state.focusId = 't3';
  assert.throws(() => renderTodoStackContext(state, 8), /leaf node/);
});

test('a temporary no-focus state exposes pending roots', () => {
  const state = fixture();
  state.revision = 15;
  state.focusId = null;

  assert.equal(renderTodoStackContext(state, 8), [
    'Todo stack (revision 15):',
    '- [ ] t1 开发 A 功能',
  ].join('\n'));
});

test('complete tree view returns all nested branches without truncation', () => {
  const tree = buildCompleteTodoTree(fixture());
  assert.equal(tree.revision, 12);
  assert.equal(tree.focusId, 't5');
  assert.equal(tree.roots[0]?.children.length, 3);
  assert.equal(tree.roots[0]?.children[0]?.status, 'completed');
  assert.equal(tree.roots[0]?.children[1]?.children[1]?.focused, true);
});

test('a completed todo result exposes its ancestor path and every sibling', () => {
  const state = fixture();
  state.revision = 13;
  state.nodes.t5.status = 'completed';
  state.focusId = null;

  assert.equal(renderTodoStackSiblingContext(state, 't5'), [
    'Todo stack (revision 13):',
    '- [ ] t1 开发 A 功能',
    '  - [ ] t3 调研 A2 特性',
    '    - [x] t4 验证接口',
    '    - [x] t5 验证异常路径',
    '    - [ ] t6 整理结论',
  ].join('\n'));
});

test('a completed root result exposes terminal and pending root siblings', () => {
  const state = fixture();
  state.revision = 13;
  state.roots.push('t8');
  state.nodes.t8 = node('t8', '发布 B 功能', null, [], 'completed');
  state.focusId = null;

  assert.equal(renderTodoStackSiblingContext(state, 't8'), [
    'Todo stack (revision 13):',
    '- [ ] t1 开发 A 功能',
    '- [x] t8 发布 B 功能',
  ].join('\n'));
});

test('a completed todo result does not truncate a crowded sibling level', () => {
  const state = fixture();
  for (let number = 8; number <= 20; number += 1) {
    const id = `t${number}`;
    state.nodes[id] = node(id, `同级 ${number}`, 't3', []);
    state.nodes.t3.children.push(id);
  }
  state.nodes.t5.status = 'completed';
  state.focusId = null;

  const context = renderTodoStackSiblingContext(state, 't5');
  assert.match(context, /\[x\] t5 验证异常路径/);
  assert.match(context, /\[ \] t20 同级 20/);
  assert.doesNotMatch(context, /…/);
});

test('a crowded frontier keeps the current leaf inside the bounded window', () => {
  const state = fixture();
  for (let number = 8; number <= 15; number += 1) {
    const id = `t${number}`;
    state.nodes[id] = node(id, `同级 ${number}`, 't3', []);
    state.nodes.t3.children.push(id);
  }
  state.focusId = 't12';

  const context = renderTodoStackContext(state, 4);
  assert.match(context, /\[\*\] t12 同级 12/);
  assert.match(context, /… [0-9]+ earlier/);
  assert.match(context, /… [0-9]+ more/);
});

test('an ended stack contributes no runtime snapshot', () => {
  const state = fixture();
  state.focusId = null;
  for (const item of Object.values(state.nodes)) item.status = 'completed';
  assert.equal(renderTodoStackContext(state, 8), '');
});
