import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Crown, Loader2, Plus, Save, Trash2 } from 'lucide-react'
import type {
  AgentThinkingLevel,
  WorkingCustomModel,
  WorkingCustomModelCategory,
  WorkingCustomModelProtocol,
  WorkingModelCatalogSaveInput,
} from '@copis/shared'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { persistWorkingModelCatalog, workingModelCatalogAtom } from '@/atoms/working-model-catalog-atoms'

const NONE_CATEGORY = '__none__'

const PROTOCOL_OPTIONS: Array<{ value: WorkingCustomModelProtocol; label: string }> = [
  { value: 'openai-responses', label: 'Responses' },
  { value: 'anthropic-messages', label: 'Messages' },
]

const THINKING_OPTIONS: Array<{ value: AgentThinkingLevel; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极少' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最大' },
]

interface ModelDraft extends Omit<WorkingCustomModel, 'apiKeyConfigured'> {
  apiKey: string
  apiKeyConfigured: boolean
  clearApiKey: boolean
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
  return error instanceof Error && error.message.trim() ? error.message : '保存模型配置失败，请稍后重试'
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
  className?: string
}): React.ReactElement {
  return (
    <label className={`min-w-0 space-y-1.5 ${className ?? ''}`}>
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
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
  const [categories, setCategories] = React.useState<WorkingCustomModelCategory[]>([])
  const [models, setModels] = React.useState<ModelDraft[]>([])
  const [newCategoryName, setNewCategoryName] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!isVip) return
    let disposed = false
    setCategories([])
    setModels([])
    setLoading(true)
    void window.electronAPI.getWorkingModelCatalog()
      .then((catalog) => {
        if (disposed) return
        setCategories(catalog.categories)
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

  const addCategory = (): void => {
    const name = newCategoryName.trim()
    if (!name) return
    const id = `category-${Date.now().toString(36)}`
    setCategories((current) => [...current, { id, name }])
    setNewCategoryName('')
  }

  const removeCategory = (categoryId: string): void => {
    setCategories((current) => current.filter((category) => category.id !== categoryId))
    setModels((current) => current.map((model) => (
      model.categoryId === categoryId ? { ...model, categoryId: undefined } : model
    )))
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const payload: WorkingModelCatalogSaveInput = {
        categories,
        models: models.map(({ apiKey, apiKeyConfigured, clearApiKey, ...model }) => ({
          ...model,
          ...(clearApiKey ? { apiKey: '' } : apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        })),
      }
      const saved = await persistWorkingModelCatalog(setCatalog, payload)
      setCategories(saved.categories)
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
          <h2 className="text-base font-semibold">模型管理仅对 VIP 开放</h2>
          <p className="max-w-md text-sm leading-6 text-muted-foreground">开通 VIP 后，可在 Composer 中使用自定义分类和模型。</p>
        </div>
        <Button type="button" onClick={onOpenVip}>
          <Crown aria-hidden="true" className="size-4" />
          升级 VIP
        </Button>
      </section>
    )
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">自定义分类</h2>
            <p className="mt-1 text-xs text-muted-foreground">Composer 会按这里的分类分组显示模型。</p>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <Input
              value={newCategoryName}
              onChange={(event) => setNewCategoryName(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') addCategory() }}
              placeholder="分类名称"
              className="w-[170px]"
              aria-label="新分类名称"
            />
            <Button type="button" variant="outline" size="icon" onClick={addCategory} aria-label="添加分类" title="添加分类">
              <Plus aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
        {categories.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {categories.map((category) => (
              <span key={category.id} className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs text-foreground">
                {category.name}
                <button type="button" onClick={() => removeCategory(category.id)} aria-label={`删除分类 ${category.name}`} title="删除分类" className="text-muted-foreground hover:text-destructive">
                  <Trash2 aria-hidden="true" className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">暂无分类，模型将显示在“未分类”中。</p>
        )}
      </section>

      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">模型配置</h2>
          <p className="mt-1 text-xs text-muted-foreground">默认协议为 Responses，也可以切换到 Messages。</p>
        </div>
        <Button type="button" variant="outline" onClick={() => setModels((current) => [...current, createModelDraft()])}>
          <Plus aria-hidden="true" className="size-4" />
          添加模型
        </Button>
      </div>

      {loading ? (
        <div className="flex min-h-[180px] items-center justify-center text-sm text-muted-foreground">
          <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />正在读取模型配置...
        </div>
      ) : models.length > 0 ? (
        <div className="space-y-3">
          {models.map((model, index) => (
            <section key={model.id} className="rounded-lg border bg-card p-4 shadow-sm">
              <div className="mb-4 flex items-center justify-between gap-3">
                <strong className="min-w-0 truncate text-sm">{model.name.trim() || '未命名模型'}</strong>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setModels((current) => current.filter((_, modelIndex) => modelIndex !== index))}
                  aria-label={`删除模型 ${model.name || '未命名模型'}`}
                  title="删除模型"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="模型名称" value={model.name} onChange={(value) => updateModel(index, { name: value })} placeholder="例如：长文写作" />
                <SelectField
                  label="分类"
                  value={model.categoryId ?? NONE_CATEGORY}
                  options={[{ value: NONE_CATEGORY, label: '未分类' }, ...categories.map((category) => ({ value: category.id, label: category.name }))]}
                  onChange={(value) => updateModel(index, { categoryId: value === NONE_CATEGORY ? undefined : value })}
                />
                <Field label="Base URL" value={model.baseUrl} onChange={(value) => updateModel(index, { baseUrl: value })} placeholder="https://api.example.com/v1" />
                <Field label="Model ID" value={model.modelId} onChange={(value) => updateModel(index, { modelId: value })} placeholder="模型服务商提供的 ID" />
                <SelectField label="接口协议" value={model.protocol} options={PROTOCOL_OPTIONS} onChange={(value) => updateModel(index, { protocol: value as WorkingCustomModelProtocol })} />
                <SelectField label="思考深度" value={model.thinkingLevel} options={THINKING_OPTIONS} onChange={(value) => updateModel(index, { thinkingLevel: value as AgentThinkingLevel })} />
                <label className="min-w-0 space-y-1.5 md:col-span-2">
                  <span className="text-xs font-medium text-foreground/80">API Key</span>
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      value={model.apiKey}
                      onChange={(event) => updateModel(index, { apiKey: event.target.value, clearApiKey: false })}
                      placeholder={model.apiKeyConfigured ? '已配置，留空保持不变' : '请输入 API Key'}
                    />
                    {model.apiKeyConfigured && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => updateModel(index, { apiKey: '', clearApiKey: !model.clearApiKey })}
                        aria-label={model.clearApiKey ? '取消清除 API Key' : '清除 API Key'}
                        title={model.clearApiKey ? '取消清除 API Key' : '清除 API Key'}
                        className={model.clearApiKey ? 'text-destructive' : 'text-muted-foreground'}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </Button>
                    )}
                  </div>
                  <span className="text-[11px] text-muted-foreground">API Key 只会加密保存在本机，不会显示在模型列表中。</span>
                </label>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <section className="rounded-lg border border-dashed bg-card/60 px-4 py-12 text-center text-sm text-muted-foreground">
          还没有自定义模型，点击“添加模型”开始配置。
        </section>
      )}

      <div className="flex justify-end">
        <Button type="button" onClick={() => void save()} disabled={loading || saving}>
          {saving ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Save aria-hidden="true" className="size-4" />}
          {saving ? '保存中...' : '保存模型配置'}
        </Button>
      </div>
    </div>
  )
}
