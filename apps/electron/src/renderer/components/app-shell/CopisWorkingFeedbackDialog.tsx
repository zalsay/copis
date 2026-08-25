import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { AppSelect } from '@/components/ui/select'
import './CopisWorkingFeedbackDialog.css'

interface CopisWorkingFeedbackDialogProps {
  open: boolean
  onClose: () => void
}

const feedbackTypeOptions = [
  { value: 'bug', label: '问题' },
  { value: 'feature', label: '建议' },
  { value: 'content', label: '内容' },
] as const

const severityOptions = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const

export function CopisWorkingFeedbackDialog({ open, onClose }: CopisWorkingFeedbackDialogProps): React.ReactElement | null {
  const [feedbackType, setFeedbackType] = React.useState('bug')
  const [severity, setSeverity] = React.useState('medium')
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [success, setSuccess] = React.useState('')

  React.useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open, submitting])

  React.useEffect(() => {
    if (open) return
    setFeedbackType('bug')
    setSeverity('medium')
    setTitle('')
    setDescription('')
    setSubmitting(false)
    setError('')
    setSuccess('')
  }, [open])

  if (!open) return null

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const cleanTitle = title.trim()
    const cleanDescription = description.trim()
    if (!cleanTitle || !cleanDescription) {
      setError('请填写标题和问题描述。')
      return
    }

    setSubmitting(true)
    setError('')
    setSuccess('')
    try {
      const result = await window.electronAPI.createWorkingFeedback({
        pageKey: 'copis_working_desktop',
        moduleHint: 'working-sidebar',
        feedbackType,
        severity,
        title: cleanTitle,
        description: cleanDescription,
        route: 'copis://working',
        browser: {
          userAgent: navigator.userAgent,
          language: navigator.language,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        },
        runtimeContext: {
          platform: navigator.platform,
        },
        pageState: {
          source: 'working-sidebar-feedback',
        },
        clientLogs: [],
        attachments: [],
      })
      setSuccess(result.message || '反馈已提交。')
      setTitle('')
      setDescription('')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '提交反馈失败，请稍后再试。')
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      className="copis-working-feedback-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) onClose()
      }}
    >
      <form
        className="copis-working-feedback-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copis-working-feedback-title"
        onSubmit={(event) => void handleSubmit(event)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="copis-working-feedback-header">
          <div>
            <h2 id="copis-working-feedback-title">反馈问题</h2>
            <p>告诉我们遇到的问题或希望改进的地方。</p>
          </div>
          <button type="button" aria-label="关闭反馈" onClick={onClose} disabled={submitting}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="copis-working-feedback-grid">
          <div className="flex flex-col gap-1.5 text-xs text-foreground/80">
            <span>类型</span>
            <AppSelect
              value={feedbackType}
              onValueChange={setFeedbackType}
              disabled={submitting}
              triggerClassName="h-9 w-full bg-background"
              options={feedbackTypeOptions.map((o) => ({ value: o.value, label: o.label }))}
            />
          </div>
          <div className="flex flex-col gap-1.5 text-xs text-foreground/80">
            <span>严重程度</span>
            <AppSelect
              value={severity}
              onValueChange={setSeverity}
              disabled={submitting}
              triggerClassName="h-9 w-full bg-background"
              options={severityOptions.map((o) => ({ value: o.value, label: o.label }))}
            />
          </div>
        </div>

        <label className="copis-working-feedback-field">
          <span>标题</span>
          <input
            value={title}
            maxLength={256}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：任务执行后无法打开文件"
            disabled={submitting}
          />
        </label>

        <label className="copis-working-feedback-field">
          <span>描述</span>
          <textarea
            value={description}
            maxLength={5000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="请描述你看到的现象、触发步骤和期望结果"
            disabled={submitting}
          />
        </label>

        {error && <div className="copis-working-feedback-message error" role="alert">{error}</div>}
        {success && <div className="copis-working-feedback-message success" role="status">{success}</div>}

        <footer className="copis-working-feedback-actions">
          <button type="button" onClick={onClose} disabled={submitting}>取消</button>
          <button type="submit" disabled={submitting}>{submitting ? '提交中...' : '提交反馈'}</button>
        </footer>
      </form>
    </div>,
    document.body,
  )
}
