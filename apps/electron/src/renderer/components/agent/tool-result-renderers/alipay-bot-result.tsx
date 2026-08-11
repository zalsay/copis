/** 支付宝工具结果渲染器：安全展示本地 Rust API 传回的支付二维码。 */

import * as React from 'react'
import { X } from 'lucide-react'
import { DefaultResultRenderer } from './default-result'

interface AlipayBotResultRendererProps {
  result: string
  isError: boolean
}

interface ParsedAlipayBotResult {
  qrCodeImage?: string
  resultWithoutQrCode: string
}

const QR_CODE_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/

/** 仅接受 Rust API 签发的受限 data URL，拒绝远程地址和任意 SVG/脚本载荷。 */
export function isSafeAlipayQrCodeImage(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = value.match(QR_CODE_DATA_URL)
  if (!match?.[2]) return false
  return match[2].length % 4 === 0
}

export function parseAlipayBotResult(result: string): ParsedAlipayBotResult {
  try {
    const parsed: unknown = JSON.parse(result)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { resultWithoutQrCode: result }
    }
    const record = parsed as Record<string, unknown>
    const qrCodeImage = isSafeAlipayQrCodeImage(record.qrCodeImage)
      ? record.qrCodeImage
      : undefined
    if (!qrCodeImage) return { resultWithoutQrCode: result }

    const { qrCodeImage: _ignored, ...withoutQrCode } = record
    return {
      qrCodeImage,
      resultWithoutQrCode: JSON.stringify(withoutQrCode, null, 2),
    }
  } catch {
    return { resultWithoutQrCode: result }
  }
}

export function AlipayBotQrCode({ source }: { source: string }): React.ReactElement | null {
  const [expanded, setExpanded] = React.useState(false)

  React.useEffect(() => {
    if (!expanded) return undefined
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [expanded])

  if (!isSafeAlipayQrCodeImage(source)) return null

  return (
    <>
      <div className="mt-2 inline-flex max-w-full flex-col gap-2 rounded-md bg-muted/30 p-3">
        <button
          type="button"
          className="max-w-full cursor-zoom-in"
          onClick={() => setExpanded(true)}
          aria-label="放大支付宝支付二维码"
          title="点击放大"
        >
          <img
            src={source}
            alt="支付宝支付二维码"
            className="w-[min(20rem,calc(100vw-8rem))] aspect-square rounded-sm bg-white p-2 object-contain"
          />
        </button>
        <span className="text-center text-xs text-muted-foreground">请使用支付宝扫码</span>
      </div>
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="支付宝支付二维码大图"
          onClick={() => setExpanded(false)}
        >
          <button
            type="button"
            className="absolute right-5 top-5 grid size-10 place-items-center rounded-md bg-black/50 text-white hover:bg-black/70"
            aria-label="关闭二维码大图"
            title="关闭"
            onClick={() => setExpanded(false)}
          >
            <X className="size-5" aria-hidden="true" />
          </button>
          <img
            src={source}
            alt="支付宝支付二维码大图"
            className="max-h-full max-w-full rounded-md bg-white p-3 object-contain"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}

export function AlipayBotResultRenderer({ result, isError, showQrCodeImage = true }: AlipayBotResultRendererProps & { showQrCodeImage?: boolean }): React.ReactElement {
  const parsed = React.useMemo(() => parseAlipayBotResult(result), [result])

  if (isError) return <DefaultResultRenderer result={result} isError />

  return (
    <div className="space-y-1">
      {showQrCodeImage && parsed.qrCodeImage && <AlipayBotQrCode source={parsed.qrCodeImage} />}
      {parsed.resultWithoutQrCode !== '{}' && (
        <DefaultResultRenderer result={parsed.resultWithoutQrCode} isError={false} />
      )}
    </div>
  )
}
