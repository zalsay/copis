import * as React from 'react'
import { AppSelect, type AppSelectOption } from '@/components/ui/select'
import { LABEL_CLASS, DESCRIPTION_CLASS } from './SettingsUIConstants'
import { cn } from '@/lib/utils'

/** 选项定义 */
export type SelectOption = AppSelectOption

interface SettingsSelectProps {
  /** 标签文本 */
  label: string
  /** 描述文本（可选） */
  description?: string
  /** 当前值 */
  value: string
  /** 变更回调 */
  onValueChange: (value: string) => void
  /** 选项列表 */
  options: SelectOption[]
  /** 占位符 */
  placeholder?: string
  /** 是否禁用 */
  disabled?: boolean
}

export function SettingsSelect({
  label,
  description,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
}: SettingsSelectProps): React.ReactElement {
  return (
    <div className="space-y-2 px-4 py-3">
      <div>
        <div className={LABEL_CLASS}>{label}</div>
        {description && (
          <div className={cn(DESCRIPTION_CLASS, 'mt-0.5')}>{description}</div>
        )}
      </div>
      <AppSelect
        value={value}
        onValueChange={onValueChange}
        options={options}
        placeholder={placeholder}
        disabled={disabled}
        triggerClassName="w-full"
      />
    </div>
  )
}
