import React, { useEffect, useRef, useState } from 'react'
import { Copy, Download, LoaderCircle, FilePlus2, ImagePlus, Paperclip, Plus, X } from 'lucide-react'
import { DSH_ROOM_ATTACHMENT_MAX_BYTES, DSH_ROOM_ATTACHMENT_MAX_COUNT } from '@copis/shared/types'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from '@/components/ui/context-menu'
import { copyImageSourceToClipboard } from '@/lib/image-clipboard'
import type { OutgoingAttachmentMessage } from './shared-room-outbox'
import { toast } from 'sonner'

const isPreviewImage = (type: string) => /^image\/(png|jpeg|webp|gif|avif|bmp)$/i.test(type)
const sizeLabel = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    if (!blob) { setUrl(''); return }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}

export function DraftAttachment({file, disabled, remove}: {file: File; disabled?: boolean; remove?: () => void}) {
  const thumb = useBlobUrl(isPreviewImage(file.type) ? file : undefined)
  return <div className="flex min-w-0 max-w-64 items-center gap-2 rounded-lg bg-white/5 px-2 py-1 text-xs">
    {thumb ? <img src={thumb} alt="" className="size-9 rounded object-cover" /> : <Paperclip size={15} />}
    <span className="min-w-0"><span className="block truncate" title={file.name}>{file.name}</span><small>{sizeLabel(file.size)}</small></span>
    {remove && <button type="button" disabled={disabled} onClick={remove} aria-label={`移除 ${file.name}`}><X size={14} /></button>}
  </div>
}

export function OutgoingAttachments({row, retry}: {row: OutgoingAttachmentMessage; retry: () => void}) {
  return <>
    <div aria-label="发送中的附件" className="flex flex-wrap gap-1.5">
      {row.files.map((file, index) => <DraftAttachment key={index} file={file} />)}
    </div>
    {row.phase === 'failed' ? <div role="alert" className="mt-1 flex items-center gap-2 text-xs">
      <span>发送失败：{row.error}</span><button type="button" aria-label="重试发送" className="underline" onClick={retry}>重试</button>
    </div> : <small role="status" className="mt-1 flex items-center gap-1.5 dsh-room-secondary">
      <LoaderCircle size={12} className="motion-safe:animate-spin" />{row.phase === 'uploading' ? '附件上传中…' : '消息发送中…'}
    </small>}
  </>
}

export function attachmentLimitError(currentCount: number, added: File[]): string {
  if (currentCount + added.length > DSH_ROOM_ATTACHMENT_MAX_COUNT) return `每条消息最多 ${DSH_ROOM_ATTACHMENT_MAX_COUNT} 个附件`
  if (added.some(f => f.size > DSH_ROOM_ATTACHMENT_MAX_BYTES)) return `单个附件不能超过 ${sizeLabel(DSH_ROOM_ATTACHMENT_MAX_BYTES)}`
  return ''
}

export function RoomAttachmentPicker({disabled, onAdd}: {disabled: boolean; onAdd: (added: File[]) => void}) {
  const images = useRef<HTMLInputElement>(null), documents = useRef<HTMLInputElement>(null)
  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const added = Array.from(e.target.files ?? [])
    e.target.value = ''
    onAdd(added)
  }
  return <>
    <input ref={images} hidden type="file" multiple accept="image/*" aria-label="选择图片" onChange={pick} />
    <input ref={documents} hidden type="file" multiple aria-label="选择文件" onChange={pick} />
    <DropdownMenu><DropdownMenuTrigger asChild><button type="button" disabled={disabled} aria-label="添加群附件"
      className="grid size-7 place-items-center rounded-md hover:bg-white/10"><Plus size={17} /></button></DropdownMenuTrigger>
      {/* 菜单挂在 body，需高于主内容区（z-60）且低于模态框。 */}
      <DropdownMenuContent side="top" align="start" className="z-[90] bg-[var(--copis-search-panel-bg)]">
        <DropdownMenuItem onSelect={() => images.current?.click()}><ImagePlus />上传图片</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => documents.current?.click()}><FilePlus2 />上传文件</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </>
}

export type RoomDownload = (id: string) => Promise<File>

/** 消息只有附件 ID；接近视口时再按群权限读取，避免打开群时下载整段历史。 */
export function ReceivedAttachment({id, index, download}: {id: string; index: number; download: RoomDownload}) {
  const host = useRef<HTMLDivElement>(null)
  const [file, setFile] = useState<File>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0)
  const url = useBlobUrl(file)
  useEffect(() => {
    let active = true
    async function load() {
      try {
        const result = await download(id)
        if (active) setFile(result)
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : '附件读取失败')
      }
    }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return
      observer?.disconnect(); void load()
    }, {rootMargin: '160px'})
    if (observer) observer.observe(host.current!)
    else void load()
    return () => { active = false; observer?.disconnect() }
  }, [id, download, attempt])

  return <div ref={host} className="my-1">
    {file && url ? isPreviewImage(file.type) ? <ContextMenu>
      <ContextMenuTrigger asChild><img src={url} alt={file.name} tabIndex={0} aria-haspopup="menu"
        className="max-h-64 max-w-full rounded object-contain" /></ContextMenuTrigger>
      <ContextMenuContent className="z-[90] bg-[var(--copis-search-panel-bg)]">
        <ContextMenuItem onSelect={async () => {
          const result = await copyImageSourceToClipboard(url, window.electronAPI.copyImageToClipboard)
          if (!result.success) toast.error(result.message ?? '复制图片失败')
        }}><Copy className="mr-2 size-4" />复制图片</ContextMenuItem>
        <ContextMenuItem asChild><a href={url} download={file.name}><Download className="mr-2 size-4" />保存图片</a></ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu> : <a download={file.name} href={url} className="inline-flex items-center gap-1.5 text-xs underline">
      <Paperclip size={14} />{file.name} · {sizeLabel(file.size)}</a>
    : error ? <button type="button" title={error} onClick={() => { setError(''); setAttempt(n => n + 1) }}>重试加载附件 {index + 1}</button>
    : <small>正在加载附件…</small>}
  </div>
}
