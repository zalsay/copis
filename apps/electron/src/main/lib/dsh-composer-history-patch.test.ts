import { expect, test } from 'bun:test'
import { patchDshComposerHistorySource } from './dsh-composer-history-patch'

const source = `var SessionInputShell = class {
  snapshot = { draft: '', phase: 'plain' };
  projection = { clipboardText: '' };
  imageIds = [];
  deps = {};
  setDraft(text) { this.snapshot.draft = text; }
  dispatchRun() { this.snapshot.draft = ''; }
  submit(mode = "queue") {
    this.dispatchRun({ type: "enter", mode, draft: this.projection.clipboardText });
  }
  arbitrate(key, composing) {
    return this.deps.inputTriggers?.()?.arbitrate(key, composing) ?? "pass";
  }
};
const arrow = (key) => (event) => { return false; };
return SessionInputShell;`

test('Given 已发送内容 When 新会话空 composer 按上键 Then 恢复原始多行文本', () => {
  const Shell = new Function(patchDshComposerHistorySource(source))()
  const first = new Shell()
  first.snapshot.draft = first.projection.clipboardText = '第一行\n第二行'
  first.submit()
  const next = new Shell()
  expect(next.arbitrate('up', false)).toBe('consumed')
  expect(next.snapshot.draft).toBe('第一行\n第二行')
})

test('Given 草稿、附件、输入法或补全菜单 When 按上键 Then 不覆盖当前内容', () => {
  const Shell = new Function(patchDshComposerHistorySource(source))()
  const shell = new Shell()
  shell.projection.clipboardText = shell.snapshot.draft = '历史输入'
  shell.submit()
  shell.snapshot.draft = '当前草稿'
  expect(shell.arbitrate('up', false)).toBe('pass')
  expect(shell.snapshot.draft).toBe('当前草稿')
  shell.snapshot.draft = ''
  expect(shell.arbitrate('up', true)).toBe('pass')
  shell.imageIds = ['image']
  expect(shell.arbitrate('up', false)).toBe('pass')
  shell.imageIds = []
  shell.deps.inputTriggers = () => ({ arbitrate: () => 'consumed' })
  expect(shell.arbitrate('up', false)).toBe('consumed')
  expect(shell.snapshot.draft).toBe('')
})

test('Given 已打补丁或不匹配的 bundle When 应用补丁 Then 幂等或明确报错', () => {
  const patched = patchDshComposerHistorySource(source)
  expect(patchDshComposerHistorySource(patched)).toBe(patched)
  expect(() => patchDshComposerHistorySource('unknown')).toThrow()
})
