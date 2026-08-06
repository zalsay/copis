import * as React from 'react'
import type { MemoryPolicy } from '@copis/shared'

interface MemoryGlobalSettingsProps {
  policy: MemoryPolicy
  onChange: (policy: MemoryPolicy) => void
  saving?: boolean
}

function policyLabel(policy: MemoryPolicy): string {
  if (policy === 'off') return '关闭'
  if (policy === 'visible') return '只读'
  return '可写'
}

export function MemoryGlobalSettings({ policy, onChange, saving = false }: MemoryGlobalSettingsProps): React.ReactElement {
  return (
    <section className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-3xl px-8 py-7">
        <h2 className="text-lg font-semibold text-foreground">全局设置</h2>
        <p className="mt-1 text-sm text-foreground/50">没有项目覆盖策略时，Memory 会使用这里的默认值。</p>

        <div className="mt-6 rounded-lg bg-card/55 p-5 shadow-sm ring-1 ring-border/35">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium text-foreground">默认 Memory 策略</span>
              <span className="mt-1 block text-xs leading-5 text-foreground/45">项目设置为“继承全局”时生效。当前值：{policyLabel(policy)}。</span>
            </span>
            <select
              aria-label="全局默认 Memory 策略"
              value={policy}
              disabled={saving}
              onChange={(event) => onChange(event.target.value as MemoryPolicy)}
              className="h-9 shrink-0 rounded-lg bg-muted/65 px-2.5 text-sm text-foreground/80 outline-none focus:ring-1 focus:ring-primary/40 disabled:opacity-60"
            >
              <option value="writable">可写</option>
              <option value="visible">只读</option>
              <option value="off">关闭</option>
            </select>
          </label>
        </div>

        <div className="mt-4 space-y-3 text-sm leading-6 text-foreground/55">
          <p>关闭：不向 Agent 注入 Memory context，也不注册 Memory 工具。</p>
          <p>只读：允许读取当前可见范围，但 Agent 不会自动写入。</p>
          <p>可写：允许读取，并允许 Agent 写入当前项目记忆。</p>
          <p>自动捕获和维护规则由 Memory 运行时固定执行，页面不会修改这些运行参数。</p>
        </div>
      </div>
    </section>
  )
}
