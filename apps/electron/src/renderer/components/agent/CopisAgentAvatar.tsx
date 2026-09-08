/**
 * CopisAgentAvatar - 对话区 Agent 回复的 Copis 头像
 *
 * 浅色模式下采用深灰色 Logo，深色模式下采用银白色 Logo。
 * 通过 Tailwind 的 dark:hidden 与 hidden dark:block 实现零 JS 延迟的瞬间主题切换。
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { CopisAgentLogo, CopisAgentDarkLogo } from '@/lib/model-logo'

export interface CopisAgentAvatarProps {
  className?: string
  alt?: string
}

export function CopisAgentAvatar({
  className,
  alt = 'Copis Agent',
}: CopisAgentAvatarProps): React.ReactElement {
  return (
    <>
      <img
        src={CopisAgentDarkLogo}
        alt={alt}
        className={cn('size-[35px] rounded-[25%] object-cover dark:hidden', className)}
      />
      <img
        src={CopisAgentLogo}
        alt={alt}
        className={cn('size-[35px] rounded-[25%] object-cover hidden dark:block', className)}
      />
    </>
  )
}

export { CopisAgentAvatar as AssistantLogo }
