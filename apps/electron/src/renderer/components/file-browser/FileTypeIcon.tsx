/**
 * FileTypeIcon — 根据文件名/文件夹名渲染对应的 VS Code 风格图标
 *
 * 封装 @react-symbols/icons，统一尺寸和样式。
 */

import * as React from 'react'
import { FileIcon } from '@react-symbols/icons/utils'
import { useAtomValue } from 'jotai'
import { appModeAtom, type AppMode } from '@/atoms/app-mode'

export interface FileTypeIconProps {
  /** 文件名或文件夹名（如 "index.ts"、"node_modules"） */
  name: string
  /** 是否为目录 */
  isDirectory: boolean
  /** 目录是否展开（仅目录有效） */
  isOpen?: boolean
  /** 图标尺寸（像素），默认 16 */
  size?: number
  /** 额外 className */
  className?: string
  /** 显式指定模式（默认跟随当前应用模式：Agent 模式使用 --ui-primary，创造模式使用 --creation-ui-primary） */
  mode?: AppMode
}

export const FileTypeIcon = React.memo(function FileTypeIcon({
  name,
  isDirectory,
  isOpen = false,
  size = 16,
  className,
  mode,
}: FileTypeIconProps): React.ReactElement {
  const currentAppMode = useAtomValue(appModeAtom)
  const effectiveMode = mode ?? currentAppMode

  if (isDirectory) {
    const strokeColor = effectiveMode === 'creation'
      ? 'var(--creation-ui-primary, #6C00CC)'
      : 'var(--ui-primary, #f09a43)'

    return (
      <span
        className={className}
        style={{
          width: size,
          height: size,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
          aria-hidden="true"
        >
          <path
            d={
              isOpen
                ? 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'
                : 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 8 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'
            }
          />
        </svg>
      </span>
    )
  }

  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <FileIcon fileName={name} autoAssign width={size} height={size} />
    </span>
  )
})
