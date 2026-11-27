import React from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { openLink } from '@/lib/open-link'

const plugins = [remarkGfm]
// 群成员收到的是 DSH 已完成的文本块，不加载本机文件、远程图片或交互式工具卡片。
const components: Components = {
  img: ({ alt }) => <>{alt}</>,
  a: ({ href, children }) => /^https?:\/\//i.test(href ?? '')
    ? <a href={href} onClick={event => { event.preventDefault(); void openLink(href) }}>{children}</a>
    : <>{children}</>,
  table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
}

export const SharedAgentMarkdown = React.memo(function SharedAgentMarkdown({ text }: { text: string }) {
  return <div className="dsh-room-markdown prose prose-sm prose-invert max-w-none text-[13px] leading-relaxed prose-p:my-1.5 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
    <Markdown remarkPlugins={plugins} components={components} skipHtml>{text}</Markdown>
  </div>
})
