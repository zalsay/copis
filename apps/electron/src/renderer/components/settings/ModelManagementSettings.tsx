import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Activity, CheckCircle2, Crown, Loader2, Plus, Save, Sparkles, Trash2, XCircle } from 'lucide-react'
import type {
  AgentThinkingLevel,
  WorkingCustomModel,
  WorkingCustomModelProtocol,
  WorkingModelCatalogSaveInput,
} from '@copis/shared'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { persistWorkingModelCatalog, workingModelCatalogAtom } from '@/atoms/working-model-catalog-atoms'

const PROTOCOL_OPTIONS: Array<{ value: WorkingCustomModelProtocol; label: string }> = [
  { value: 'openai-responses', label: 'OpenAI 兼容协议 (Responses)' },
  { value: 'anthropic-messages', label: 'Anthropic 兼容协议 (Messages)' },
]

const THINKING_OPTIONS: Array<{ value: AgentThinkingLevel; label: string }> = [
  { value: 'off', label: '关闭思考' },
  { value: 'minimal', label: '极少思考 (Minimal)' },
  { value: 'low', label: '低度思考 (Low)' },
  { value: 'medium', label: '中度思考 (Medium)' },
  { value: 'high', label: '深度思考 (High - 推荐)' },
  { value: 'xhigh', label: '极高思考 (Very High)' },
  { value: 'max', label: '最大思考 (Max)' },
]

interface ModelDraft extends Omit<WorkingCustomModel, 'apiKeyConfigured'> {
  apiKey: string
  apiKeyConfigured: boolean
  clearApiKey: boolean
}

interface ModelTestState {
  status: 'testing' | 'success' | 'error'
  message: string
  latencyMs?: number
}

interface ModelManagementSettingsProps {
  isVip: boolean
  accountId?: string
  onOpenVip: () => void
  onNotice: (message: string) => void
}

function createModelId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function createModelDraft(model?: WorkingCustomModel): ModelDraft {
  if (model) {
    return {
      id: model.id,
      name: model.name,
      ...(model.categoryId ? { categoryId: model.categoryId } : {}),
      baseUrl: model.baseUrl,
      modelId: model.modelId,
      protocol: model.protocol,
      thinkingLevel: model.thinkingLevel,
      apiKey: '',
      apiKeyConfigured: model.apiKeyConfigured,
      clearApiKey: false,
    }
  }
  return {
    id: createModelId(),
    name: '',
    baseUrl: '',
    modelId: '',
    protocol: 'openai-responses',
    thinkingLevel: 'high',
    apiKey: '',
    apiKeyConfigured: false,
    clearApiKey: false,
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : '保存配置失败，请稍后重试'
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = 'text',
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: string
  type?: string
  className?: string
}): React.ReactElement {
  return (
    <label className={`min-w-0 space-y-1.5 ${className ?? ''}`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground/80">{label}</span>
      </div>
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  hint?: string
}): React.ReactElement {
  return (
    <label className="min-w-0 space-y-1.5">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function ModelManagementSettings({
  isVip,
  accountId,
  onOpenVip,
  onNotice,
}: ModelManagementSettingsProps): React.ReactElement {
  const setCatalog = useSetAtom(workingModelCatalogAtom)
  const [models, setModels] = React.useState<ModelDraft[]>([])
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testResults, setTestResults] = React.useState<Record<string, ModelTestState>>({})

  React.useEffect(() => {
    if (!isVip) return
    let disposed = false
    setModels([])
    setTestResults({})
    setLoading(true)
    void window.electronAPI.getWorkingModelCatalog()
      .then((catalog) => {
        if (disposed) return
        setModels(catalog.models.map(createModelDraft))
      })
      .catch((error: unknown) => {
        if (!disposed) onNotice(getErrorMessage(error))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => { disposed = true }
  }, [accountId, isVip, onNotice])

  const updateModel = (index: number, patch: Partial<ModelDraft>): void => {
    setModels((current) => current.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model))
  }

  const handleTestConnection = async (): Promise<void> => {
    if (models.length === 0) {
      onNotice('暂无可测试的自定义模型，请先添加模型')
      return
    }

    setTesting(true)
    const nextResults: Record<string, ModelTestState> = {}
    let successCount = 0
    let failCount = 0

    for (const model of models) {
      if (!model.baseUrl.trim() || !model.modelId.trim()) {
        nextResults[model.id] = {
          status: 'error',
          message: '请先完善服务地址和模型标识',
        }
        failCount += 1
        continue
      }
      if (!model.apiKey.trim() && !model.apiKeyConfigured) {
        nextResults[model.id] = {
          status: 'error',
          message: '尚未填写 API 密钥',
        }
        failCount += 1
        continue
      }

      setTestResults((prev) => ({
        ...prev,
        [model.id]: { status: 'testing', message: '正在测试连接...' },
      }))

      try {
        const startTime = Date.now()
        const result = await window.electronAPI.testWorkingModelConnection({
          id: model.id,
          name: model.name,
          protocol: model.protocol,
          baseUrl: model.baseUrl,
          modelId: model.modelId,
          apiKey: model.apiKey,
        })
        const latencyMs = Date.now() - startTime
        if (result.success) {
          successCount += 1
          nextResults[model.id] = {
            status: 'success',
            message: result.message || '连接正常',
            latencyMs,
          }
        } else {
          failCount += 1
          nextResults[model.id] = {
            status: 'error',
            message: result.message || '连接失败',
          }
        }
      } catch (error: unknown) {
        failCount += 1
        nextResults[model.id] = {
          status: 'error',
          message: error instanceof Error ? error.message : '连接异常',
        }
      }
    }

    setTestResults(nextResults)
    setTesting(false)

    if (failCount === 0 && successCount > 0) {
      onNotice(`测试完成：全部 ${successCount} 个模型连接成功！`)
    } else if (successCount > 0 && failCount > 0) {
      onNotice(`测试完成：${successCount} 个成功，${failCount} 个失败，请查看卡片提示`)
    } else if (failCount > 0) {
      onNotice(`测试失败：${failCount} 个模型连接异常，请检查配置`)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const payload: WorkingModelCatalogSaveInput = {
        categories: [],
        models: models.map(({ apiKey, apiKeyConfigured, clearApiKey, ...model }) => ({
          ...model,
          ...(clearApiKey ? { apiKey: '' } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        })),
      }
      const saved = await persistWorkingModelCatalog(setCatalog, payload)
      setModels(saved.models.map(createModelDraft))
      onNotice('模型配置已保存')
    } catch (error: unknown) {
      onNotice(getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  if (!isVip) {
    return (
      <section className="flex min-h-[260px] flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-primary/35 bg-card/70 p-8 text-center shadow-sm">
        <span className="grid size-12 place-items-center rounded-full bg-primary/12 text-primary">
          <Crown aria-hidden="true" className="size-6" />
        </span>
        <div className="space-y-1.5">
          <h2 className="text-base font-semibold">自定义模型仅对 VIP 开放</h2>
          <p className="max-w-md text-sm leading-6 text-muted-foreground">开通 VIP 会员后，可添加你的第三方模型 API Key，在对话与工作区中随心使用自定义大模型。</p>
        </div>
        <Button type="button" onClick={onOpenVip}>
          <Crown aria-hidden="true" className="size-4" />
          升级 VIP
        </Button>
      </section>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">自定义模型</h2>
          <p className="mt-1 text-xs text-muted-foreground">添加兼容 OpenAI 或 Anthropic 接口标准的第三方大模型，配置后可在对话模型选择器中直接调用。</p>
        </div>
        <Button type="button" variant="outline" onClick={() => setModels((current) => [...current, createModelDraft()])}>
          <Plus aria-hidden="true" className="size-4" />
          添加模型
        </Button>
      </div>

      {loading ? (
        <div className="flex min-h-[180px] items-center justify-center text-sm text-muted-foreground">
          <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />正在加载模型配置...
        </div>
      ) : models.length > 0 ? (
        <div className="space-y-4">
          {models.map((model, index) => {
            const testState = testResults[model.id]
            return (
              <section key={model.id} className="rounded-lg border bg-card p-4 shadow-sm space-y-4">
                <div className="flex items-center justify-between gap-3 border-b pb-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Sparkles className="size-4 text-primary shrink-0" />
                    <strong className="min-w-0 truncate text-sm">{model.name.trim() || '未命名模型'}</strong>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {model.protocol === 'anthropic-messages' ? 'Anthropic 协议' : 'OpenAI 协议'}
                    </span>
                    {testState && (
                      <div className={cn(
                        'flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                        testState.status === 'testing' && 'bg-muted text-muted-foreground animate-pulse',
                        testState.status === 'success' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
                        testState.status === 'error' && 'bg-destructive/10 text-destructive',
                      )}>
                        {testState.status === 'testing' && <Loader2 className="size-3 animate-spin" />}
                        {testState.status === 'success' && <CheckCircle2 className="size-3 shrink-0" />}
                        {testState.status === 'error' && <XCircle className="size-3 shrink-0" />}
                        <span className="truncate max-w-[200px]">
                          {testState.status === 'success' && testState.latencyMs
                            ? `连接正常 (${testState.latencyMs}ms)`
                            : testState.message}
                        </span>
                      </div>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setModels((current) => current.filter((_, modelIndex) => modelIndex !== index))
                      setTestResults((prev) => {
                        const next = { ...prev }
                        delete next[model.id]
                        return next
                      })
                    }}
                    aria-label={`删除模型 ${model.name || '未命名模型'}`}
                    title="删除模型"
                    className="text-muted-foreground hover:text-destructive size-8"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </div>
                <div className="grid gap-3.5 md:grid-cols-2">
                  <Field
                    label="模型名称"
                    value={model.name}
                    onChange={(value) => updateModel(index, { name: value })}
                    placeholder="例如：Claude 3.7、DeepSeek R1、本地大模型"
                    hint="在对话模型选择菜单中显示的友好名称"
                  />
                  <Field
                    label="模型标识 (Model ID)"
                    value={model.modelId}
                    onChange={(value) => updateModel(index, { modelId: value })}
                    placeholder="例如：claude-3-7-sonnet-20250219、deepseek-reasoner、gpt-4o"
                    hint="大模型服务商提供的实际模型代号"
                  />
                  <SelectField
                    label="接口协议"
                    value={model.protocol}
                    options={PROTOCOL_OPTIONS}
                    onChange={(value) => updateModel(index, { protocol: value as WorkingCustomModelProtocol })}
                    hint="主流兼容中转与本地大模型大多采用 OpenAI 协议"
                  />
                  <SelectField
                    label="思考深度 (Thinking Level)"
                    value={model.thinkingLevel}
                    options={THINKING_OPTIONS}
                    onChange={(value) => updateModel(index, { thinkingLevel: value as AgentThinkingLevel })}
                    hint="仅对支持深度思考的推理模型生效"
                  />
                  <Field
                    label="服务地址 (Base URL)"
                    value={model.baseUrl}
                    onChange={(value) => updateModel(index, { baseUrl: value })}
                    placeholder="例如：https://api.openai.com/v1 或兼容端点"
                    hint="接口服务的完整地址，请确保包含版本号路径（如 /v1）"
                    className="md:col-span-2"
                  />
                  <label className="min-w-0 space-y-1.5 md:col-span-2">
                    <span className="text-xs font-medium text-foreground/80">API 密钥 (API Key)</span>
                    <div className="flex items-center gap-2">
                      <Input
                        type="password"
                        value={model.apiKey}
                        onChange={(event) => updateModel(index, { apiKey: event.target.value, clearApiKey: false })}
                        placeholder={model.apiKeyConfigured ? '已配置，留空保持不变' : '请输入 API 密钥'}
                      />
                      {model.apiKeyConfigured && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => updateModel(index, { apiKey: '', clearApiKey: !model.clearApiKey })}
                          aria-label={model.clearApiKey ? '取消清除 API Key' : '清除 API Key'}
                          title={model.clearApiKey ? '取消清除 API Key' : '清除 API Key'}
                          className={model.clearApiKey ? 'text-destructive shrink-0' : 'text-muted-foreground shrink-0'}
                        >
                          <Trash2 aria-hidden="true" className="mr-1 size-3.5" />
                          {model.clearApiKey ? '已标记清除' : '清除密钥'}
                        </Button>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground">API Key 仅加密保存在你的本机安全存储中，不会明文上传或泄露。</span>
                  </label>
                </div>
              </section>
            )
          })}
        </div>
      ) : (
        <section className="rounded-lg border border-dashed bg-card/60 px-4 py-12 text-center text-sm text-muted-foreground">
          暂无自定义模型，点击右上角「添加模型」按钮开始配置。
        </section>
      )}

      <div className="flex items-center justify-end gap-3 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleTestConnection()}
          disabled={loading || saving || testing || models.length === 0}
        >
          {testing ? <Loader2 aria-hidden="true" className="mr-1.5 size-4 animate-spin" /> : <Activity aria-hidden="true" className="mr-1.5 size-4" />}
          {testing ? '测试中...' : '测试连接'}
        </Button>
        <Button
          type="button"
          onClick={() => void save()}
          disabled={loading || saving || testing}
        >
          {saving ? <Loader2 aria-hidden="true" className="mr-1.5 size-4 animate-spin" /> : <Save aria-hidden="true" className="mr-1.5 size-4" />}
          {saving ? '保存中...' : '保存'}
        </Button>
      </div>
    </div>
  )
}
