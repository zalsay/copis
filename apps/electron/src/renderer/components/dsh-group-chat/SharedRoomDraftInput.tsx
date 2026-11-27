import { useRef, type RefObject } from 'react'
import type { HostAgent } from './shared-room-data'

interface Props {
  editorRef: RefObject<HTMLDivElement>
  agent?: HostAgent
  sending: boolean
  onDraft: (text: string, agentId?: string) => void
  onPasteImages: (files: File[]) => void
  onSend: () => void
}

/** Chromium 的光标既可能落在胶囊后的文本，也可能落在父节点的子节点间隙。 */
function removeMentionAtCaret(chip: HTMLElement, selection: Selection | null): boolean {
  const parent = chip.parentNode
  const node = selection?.anchorNode
  if (!parent || !selection?.isCollapsed || !node) return false
  const pos = selection.anchorOffset
  const tail = chip.nextSibling
  const previous = node === parent ? parent.childNodes[pos - 1] : null
  const afterChip = previous === chip || (previous === tail && tail?.nodeType === 3 && /^[ \u00a0]?$/.test(tail.textContent ?? ''))
  const inTail = node === tail && node.nodeType === 3 &&
    (pos === 0 || (pos === 1 && /^[ \u00a0]/.test(node.textContent ?? '')))
  if (!afterChip && !inTail) return false

  const index = Array.from(parent.childNodes).indexOf(chip)
  // 连同自动补出的一个分隔空格删除，但保留光标后已有的正文。
  if (tail?.nodeType === 3) tail.textContent = (tail.textContent ?? '').replace(/^[ \u00a0]/, '')
  chip.remove()
  selection.collapse(parent, index)
  return true
}

/** 浏览器管理光标和纯文本粘贴；只有当前编辑器亲自插入的胶囊才携带提及身份。 */
export function SharedRoomDraftInput({ editorRef, agent, sending, onDraft, onPasteImages, onSend }: Props) {
  const mention = useRef<{ chip: HTMLElement; id: string } | null>(null)
  return <div ref={editorRef} role="textbox" aria-multiline="true" aria-label="群消息"
    contentEditable={sending ? false : 'plaintext-only'} data-placeholder="向本群成员发送消息，输入 @智能体发起对话"
    className="dsh-room-draft min-w-0 flex-1 min-h-[50px] max-h-[140px] overflow-y-auto whitespace-pre-wrap break-words px-3.5 py-3 text-[13px] outline-none"
    onPaste={e => {
      // 仅接收本次粘贴事件携带的图片文件；普通文本仍由编辑器处理。
      const { files, items } = e.clipboardData
      let images = Array.from(files).filter(file => file.type.startsWith('image/'))
      if (!images.length) {
        images = Array.from(items).filter(item => item.kind === 'file' && item.type.startsWith('image/'))
          .map(item => item.getAsFile()).filter((file): file is File => file !== null)
      }
      if (!images.length) return
      e.preventDefault()
      if (!sending) onPasteImages(images)
    }}
    onKeyDown={e => {
      if (sending || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
      if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && mention.current &&
          removeMentionAtCaret(mention.current.chip, window.getSelection())) {
        e.preventDefault()
        mention.current = null
        onDraft(e.currentTarget.innerText)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); onSend()
      }
    }}
    onInput={e => {
      const editor = e.currentTarget
      const edit = e.nativeEvent as InputEvent
      if (mention.current && !editor.contains(mention.current.chip)) mention.current = null
      if (!mention.current && agent?.callable && !edit.isComposing && edit.inputType === 'insertText' &&
          (edit.data === '@' || edit.data === '＠')) {
        const selection = window.getSelection()
        const node = selection?.anchorNode
        const pos = selection?.anchorOffset ?? 0
        const text = node?.textContent ?? ''
        if (selection?.isCollapsed && node?.nodeType === 3 && editor.contains(node) &&
            text[pos - 1] === edit.data && !/[\w.%+-]/.test(text[pos - 2] ?? '')) {
          const doc = editor.ownerDocument
          const chip = doc.createElement('span')
          chip.className = 'dsh-room-mention-chip'
          chip.setAttribute('contenteditable', 'false')
          chip.textContent = `@${agent.name}`
          const tail = doc.createTextNode(' ' + text.slice(pos))
          ;(node as Text).replaceWith(text.slice(0, pos - 1), chip, tail)
          selection.collapse(tail, 1)
          mention.current = { chip, id: agent.id }
        }
      }
      onDraft(editor.innerText, mention.current?.id)
    }} />
}
