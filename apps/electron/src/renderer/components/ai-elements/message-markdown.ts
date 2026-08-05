/** Markdown mention 解析工具，与 React 消息组件分离以保持 Fast Refresh 边界稳定。 */

export type MentionType = 'file' | 'skill' | 'mcp' | 'session' | 'todo' | 'calendar_event'

interface MdastTextNode {
  type: 'text'
  value: string
}

interface MdastLinkNode {
  type: 'link'
  url: string
  children: MdastNode[]
}

interface MdastBreakNode {
  type: 'break'
}

interface MdastGenericNode {
  type: string
  children?: MdastNode[]
  value?: string
}

type MdastNode = MdastTextNode | MdastLinkNode | MdastBreakNode | MdastGenericNode

interface MdastParent {
  type: string
  children: MdastNode[]
}

/** 递归遍历 mdast text 节点（自动跳过 code / inlineCode 子树）。 */
function walkMdastText(
  node: MdastParent,
  visitor: (node: MdastTextNode, index: number, parent: MdastParent) => number | void,
): void {
  if (!node.children) return
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    if (child.type === 'text') {
      const result = visitor(child as MdastTextNode, i, node)
      if (typeof result === 'number') i = result - 1
    } else if (child.type !== 'code' && child.type !== 'inlineCode') {
      const asParent = child as MdastParent
      if (asParent.children) walkMdastText(asParent, visitor)
    }
  }
}

export function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** 仅在普通文本中转换旧引用，避免改写 inline code、fenced code 和缩进代码块。 */
export function normalizeNamedReferenceDelimiters(markdown: string): string {
  const normalizeText = (text: string): string => text.replace(
    /(&(?:session|todo|calendar_event):[A-Za-z0-9-]+)~(\S+)/g,
    '$1::$2',
  )
  const normalizeInlineCodeSafeText = (text: string): string => {
    let normalized = ''
    let cursor = 0

    while (cursor < text.length) {
      const openingIndex = text.indexOf('`', cursor)
      if (openingIndex === -1) return normalized + normalizeText(text.slice(cursor))
      const delimiter = text.slice(openingIndex).match(/^`+/)?.[0]
      if (!delimiter) return normalized + normalizeText(text.slice(cursor))
      const closingIndex = text.indexOf(delimiter, openingIndex + delimiter.length)
      if (closingIndex === -1) return normalized + normalizeText(text.slice(cursor))

      normalized += normalizeText(text.slice(cursor, openingIndex))
      normalized += text.slice(openingIndex, closingIndex + delimiter.length)
      cursor = closingIndex + delimiter.length
    }

    return normalized
  }

  const lines = markdown.split('\n')
  let inFence: { marker: '`' | '~'; length: number } | null = null
  return lines.map((line) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    const indentedCode = !inFence && /^(?: {4}|\t)/.test(line)
    const isCode = Boolean(inFence || indentedCode || fenceMatch)
    const result = isCode ? line : normalizeInlineCodeSafeText(line)

    if (fenceMatch) {
      const markerText = fenceMatch[1] ?? ''
      const marker = markerText[0] as '`' | '~'
      if (!inFence) {
        inFence = { marker, length: markerText.length }
      } else if (marker === inFence.marker && markerText.length >= inFence.length) {
        inFence = null
      }
    }

    return result
  }).join('\n')
}

/** 将消息中的文件、Skill、MCP 和计划引用转换为 mention:// 链接节点。 */
export function remarkMentions() {
  return (tree: MdastParent) => {
    walkMdastText(tree, (node, index, parent) => {
      const text = node.value
      const mentionPattern = /@file:(\S+)|\/skill:(\S+)|#mcp:(\S+)|&session:([A-Za-z0-9-]+)(?:(?:~|::)(\S+))?|&todo:([A-Za-z0-9-]+)(?:(?:~|::)(\S+))?|&calendar_event:([A-Za-z0-9-]+)(?:(?:~|::)(\S+))?/g
      if (!mentionPattern.test(text)) return
      mentionPattern.lastIndex = 0

      const parts: MdastNode[] = []
      let lastIdx = 0
      let match: RegExpExecArray | null

      while ((match = mentionPattern.exec(text)) !== null) {
        if (match.index > lastIdx) {
          parts.push({ type: 'text', value: text.slice(lastIdx, match.index) })
        }
        const type: MentionType = match[1]
          ? 'file'
          : match[2]
            ? 'skill'
            : match[3]
              ? 'mcp'
              : match[4]
                ? 'session'
                : match[6]
                  ? 'todo'
                  : 'calendar_event'
        const referenceId = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[6] ?? match[8] ?? ''
        const encodedLabel = match[5] ?? match[7] ?? match[9]
        const rawValue = encodedLabel ? `${referenceId}::${safeDecode(encodedLabel)}` : referenceId
        const alreadyEncoded = !encodedLabel && /%[0-9A-Fa-f]{2}/.test(referenceId)
        const safeValue = alreadyEncoded ? referenceId : encodeURIComponent(rawValue)
        parts.push({
          type: 'link',
          url: `mention://${type}/${safeValue}`,
          children: [{ type: 'text', value: match[0] }],
        })
        lastIdx = match.index + match[0].length
      }

      if (lastIdx < text.length) {
        parts.push({ type: 'text', value: text.slice(lastIdx) })
      }

      parent.children.splice(index, 1, ...parts)
      return index + parts.length
    })
  }
}

/** 在普通文本节点中保留换行，跳过代码块。 */
export function remarkPreserveBreaks() {
  return (tree: MdastParent) => {
    walkMdastText(tree, (node, index, parent) => {
      const text = node.value
      if (!text.includes('\n')) return

      const lines = text.split('\n')
      const parts: MdastNode[] = []
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) parts.push({ type: 'break' })
        if (lines[i]) parts.push({ type: 'text', value: lines[i] })
      }

      parent.children.splice(index, 1, ...parts)
      return index + parts.length
    })
  }
}

export type RemarkPluginFn = () => (tree: MdastParent) => void
