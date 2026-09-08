import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT_ENTRY = 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'
const MARKER = 'static copisLastComposerInput = "";'

/** 补丁直接调用 DSH 输入模型的 setDraft，保留 Lexical 的文本状态和撤销语义。 */
export function patchDshComposerHistorySource(source: string): string {
  if (source.includes(MARKER)) return source
  const replacements: Array<[string, string]> = [
    ['var SessionInputShell = class {', `var SessionInputShell = class {\n${MARKER}`],
    ['submit(mode = "queue") {', `submit(mode = "queue") {
      if ((this.snapshot.phase === "plain" || this.snapshot.phase === "claimed") && this.projection.clipboardText.trim()) {
        SessionInputShell.copisLastComposerInput = this.projection.clipboardText;
      }`],
    ['return this.deps.inputTriggers?.()?.arbitrate(key, composing) ?? "pass";', `const verdict = this.deps.inputTriggers?.()?.arbitrate(key, composing) ?? "pass";
      if (verdict !== "pass" || composing) return verdict;
      if (key === "up" && this.snapshot.phase === "plain" && this.snapshot.draft === "" && this.imageIds.length === 0 && SessionInputShell.copisLastComposerInput) {
        this.setDraft(SessionInputShell.copisLastComposerInput);
        return "consumed";
      }
      return "pass";`],
    ['const arrow = (key) => (event) => {', `const arrow = (key) => (event) => {
      if ((key === "up" || key === "down") && (event?.shiftKey || event?.ctrlKey || event?.metaKey || event?.altKey)) return false;`],
  ]
  for (const [anchor, replacement] of replacements) {
    if (source.split(anchor).length !== 2) throw new Error('DSH Composer 输入历史组件结构与受支持版本不匹配')
    source = source.replace(anchor, replacement)
  }
  return source
}

/** 构建期及已安装模块启动前共用；不修改系统安装的 DSH。 */
export function patchDshComposerHistoryRuntime(runtimeRoot: string): boolean {
  const entrypoint = join(runtimeRoot, CLIENT_ENTRY)
  if (!existsSync(entrypoint)) return false
  const source = readFileSync(entrypoint, 'utf8')
  const patched = patchDshComposerHistorySource(source)
  if (source !== patched) writeFileSync(entrypoint, patched, 'utf8')
  return true
}
