/**
 * CodexLogoIcon - 专业模式标志图标组件
 *
 * 采用项目内置的高清标志资产，支持设置自定义尺寸、样式与类名。
 */

import * as React from 'react'
import GPT5CodexLogo from '@/assets/models/gpt-5-codex.png'
import { cn } from '@/lib/utils'

export interface CodexLogoIconProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  size?: number | string
}

export const CodexLogoIcon = React.forwardRef<HTMLImageElement, CodexLogoIconProps>(
  ({ size = 16, className, alt = '专业模式', style, ...props }, ref) => {
    const dimensionStyle = {
      width: typeof size === 'number' ? `${size}px` : size,
      height: typeof size === 'number' ? `${size}px` : size,
      ...style,
    }

    return (
      <img
        ref={ref}
        src={GPT5CodexLogo}
        alt={alt}
        style={dimensionStyle}
        className={cn('inline-block shrink-0 rounded-sm object-contain select-none', className)}
        aria-hidden="true"
        {...props}
      />
    )
  },
)

CodexLogoIcon.displayName = 'CodexLogoIcon'
