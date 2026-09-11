/**
 * FeedbackSettings — 意见反馈设置页
 *
 * 允许用户在设置面板中直接提交问题或改进建议。
 */

import * as React from 'react'
import { CheckCircle2, Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'
import { AppSelect } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsSection } from './primitives'

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

export function FeedbackSettings(): React.ReactElement {
  const [feedbackType, setFeedbackType] = React.useState('bug')
  const [severity, setSeverity] = React.useState('medium')
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState('')
  const [success, setSuccess] = React.useState('')

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
        moduleHint: 'working-settings-feedback',
        feedbackType,
        severity,
        title: cleanTitle,
        description: cleanDescription,
        route: 'copis://working/settings/feedback',
        browser: {
          userAgent: navigator.userAgent,
          language: navigator.language,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        },
        runtimeContext: {
          platform: navigator.platform,
        },
        pageState: {
          source: 'working-settings-feedback',
        },
        clientLogs: [],
        attachments: [],
      })
      const msg = result.message || '反馈已成功提交，感谢您的支持与建议！'
      setSuccess(msg)
      toast.success(msg)
      setTitle('')
      setDescription('')
    } catch (submitError) {
      const msg = submitError instanceof Error ? submitError.message : '提交反馈失败，请稍后再试。'
      setError(msg)
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="意见反馈"
        description="告诉我们遇到的问题或希望改进的地方，我们会认真对待每一条反馈。"
      >
        <SettingsCard>
          <form className="p-5 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
            {success && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 text-xs">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{success}</span>
              </div>
            )}
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive border border-destructive/20 text-xs">
                <span>{error}</span>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80">类型</label>
                <AppSelect
                  value={feedbackType}
                  onValueChange={setFeedbackType}
                  disabled={submitting}
                  triggerClassName="h-9 w-full bg-background"
                  options={feedbackTypeOptions.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/80">严重程度</label>
                <AppSelect
                  value={severity}
                  onValueChange={setSeverity}
                  disabled={submitting}
                  triggerClassName="h-9 w-full bg-background"
                  options={severityOptions.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground/80">标题</label>
              <input
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="用简短的一句话概括您的问题或建议"
                disabled={submitting}
                className="h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ui-primary)]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground/80">详细描述</label>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="请详细描述发生问题的场景步骤、期望的体验或具体的建议..."
                rows={5}
                disabled={submitting}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ui-primary)] resize-y min-h-[120px]"
              />
            </div>

            <div className="flex justify-end pt-2">
              <Button type="submit" disabled={submitting} className="min-w-[100px]">
                {submitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    <span>提交中...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-3.5 h-3.5 mr-1.5" />
                    <span>提交反馈</span>
                  </>
                )}
              </Button>
            </div>
          </form>
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}
