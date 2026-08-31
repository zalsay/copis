import * as React from 'react'
import type { WebJavascriptPromptRequest } from '@copis/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

declare global {
  interface Window {
    webJavascriptPrompt: {
      get: (requestId: string) => Promise<WebJavascriptPromptRequest | null>
      resolve: (input: { requestId: string; accept: boolean; promptText?: string }) => Promise<boolean>
      cancel: (requestId: string) => Promise<boolean>
    }
  }
}

/** 网页 prompt 的独立、最小权限渲染入口。 */
export function WebJavascriptPromptWindowApp(): React.ReactElement {
  const requestId = React.useMemo(() => new URLSearchParams(window.location.search).get('requestId') ?? '', [])
  const [request, setRequest] = React.useState<WebJavascriptPromptRequest | null>(null)
  const [value, setValue] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    let mounted = true
    if (!requestId) return () => { mounted = false }
    void window.webJavascriptPrompt.get(requestId).then((nextRequest) => {
      if (!mounted || !nextRequest) return
      setRequest(nextRequest)
      setValue(nextRequest.defaultPrompt)
    }).catch(() => {
      if (mounted) void window.webJavascriptPrompt.cancel(requestId)
    })
    return () => { mounted = false }
  }, [requestId])

  const cancel = React.useCallback((): void => {
    if (submitting || !requestId) return
    setSubmitting(true)
    void window.webJavascriptPrompt.cancel(requestId)
  }, [requestId, submitting])

  const resolve = React.useCallback((): void => {
    if (submitting || !requestId) return
    setSubmitting(true)
    void window.webJavascriptPrompt.resolve({ requestId, accept: true, promptText: value })
  }, [requestId, submitting, value])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      resolve()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
    }
  }

  return (
    <main className="flex h-screen w-screen flex-col gap-4 bg-background p-5 text-foreground">
      <div className="text-sm leading-6">{request?.message ?? '网页正在等待输入'}</div>
      <Input autoFocus value={value} disabled={submitting} onChange={(event) => setValue(event.target.value)} onKeyDown={handleKeyDown} aria-label="网页输入" />
      <div className="mt-auto flex justify-end gap-2">
        <Button type="button" variant="outline" disabled={submitting} onClick={cancel}>取消</Button>
        <Button type="button" disabled={!request || submitting} onClick={resolve}>确认</Button>
      </div>
    </main>
  )
}
