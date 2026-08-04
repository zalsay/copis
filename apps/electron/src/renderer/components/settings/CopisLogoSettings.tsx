/**
 * CopisLogoSettings - Copis 品牌 Logo 下载
 *
 * 展示多个 Copis Logo 颜色变体网格，用户可下载用作机器人头像。
 */

import * as React from 'react'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { SettingsSection } from './primitives/SettingsSection'
import { SettingsCard } from './primitives/SettingsCard'
import { Button } from '@/components/ui/button'

// ===== Logo 资源导入 =====

// 基础色系
import copisBlackLogo from '@/assets/bots/copis-logos/copis-black.png'
import copisWhiteLogo from '@/assets/bots/copis-logos/copis-white.png'
import copisBlueLogo from '@/assets/bots/copis-logos/copis-blue.png'
import copisPurpleLogo from '@/assets/bots/copis-logos/copis-purple.png'
import copisGradientLogo from '@/assets/bots/copis-logos/copis-gradient.png'
import copisTransparentLogo from '@/assets/bots/copis-logos/copis-transparent.png'

// 潘通年度色
import copisCoralLogo from '@/assets/bots/copis-logos/copis-coral.png'
import copisVeriPeriLogo from '@/assets/bots/copis-logos/copis-veri-peri.png'
import copisVivaMagentaLogo from '@/assets/bots/copis-logos/copis-viva-magenta.png'
import copisMochaMousseLogo from '@/assets/bots/copis-logos/copis-mocha-mousse.png'
import copisEmeraldLogo from '@/assets/bots/copis-logos/copis-emerald.png'

// 科技风格
import copis8bitLogo from '@/assets/bots/copis-logos/copis-8bit.png'
import copisCyberpunkLogo from '@/assets/bots/copis-logos/copis-cyberpunk.png'
import copisFuturisticLogo from '@/assets/bots/copis-logos/copis-futuristic.png'

// ===== 类型 =====

interface LogoVariant {
  id: string
  name: string
  description: string
  src: string
  resourcePath: string
  previewBg: string
}

// ===== Logo 变体定义 =====

const LOGO_VARIANTS: readonly LogoVariant[] = [
  // 基础色系
  {
    id: 'black',
    name: '经典黑',
    description: '黑色背景，适合浅色界面',
    src: copisBlackLogo,
    resourcePath: 'copis-logos/copis-black.png',
    previewBg: 'bg-neutral-900',
  },
  {
    id: 'white',
    name: '纯白版',
    description: '白色背景，适合深色界面',
    src: copisWhiteLogo,
    resourcePath: 'copis-logos/copis-white.png',
    previewBg: 'bg-white',
  },
  {
    id: 'blue',
    name: '品牌蓝',
    description: '深蓝背景，适合正式场合',
    src: copisBlueLogo,
    resourcePath: 'copis-logos/copis-blue.png',
    previewBg: 'bg-blue-900',
  },
  {
    id: 'purple',
    name: '紫色版',
    description: '紫色调，个性风格',
    src: copisPurpleLogo,
    resourcePath: 'copis-logos/copis-purple.png',
    previewBg: 'bg-purple-900',
  },
  {
    id: 'gradient',
    name: '渐变版',
    description: '蓝紫渐变背景',
    src: copisGradientLogo,
    resourcePath: 'copis-logos/copis-gradient.png',
    previewBg: 'bg-gradient-to-br from-blue-600 to-purple-600',
  },
  {
    id: 'transparent',
    name: '透明底',
    description: '无背景，可叠加任意颜色',
    src: copisTransparentLogo,
    resourcePath: 'copis-logos/copis-transparent.png',
    previewBg: 'bg-[repeating-conic-gradient(#e5e7eb_0%_25%,#fff_0%_50%)] bg-[length:16px_16px]',
  },
  // 潘通年度色
  {
    id: 'coral',
    name: '珊瑚橘',
    description: 'Pantone 2019 Living Coral',
    src: copisCoralLogo,
    resourcePath: 'copis-logos/copis-coral.png',
    previewBg: 'bg-[#FF6F61]',
  },
  {
    id: 'veri-peri',
    name: '长春花蓝',
    description: 'Pantone 2022 Very Peri',
    src: copisVeriPeriLogo,
    resourcePath: 'copis-logos/copis-veri-peri.png',
    previewBg: 'bg-[#6667AB]',
  },
  {
    id: 'viva-magenta',
    name: '非凡洋红',
    description: 'Pantone 2023 Viva Magenta',
    src: copisVivaMagentaLogo,
    resourcePath: 'copis-logos/copis-viva-magenta.png',
    previewBg: 'bg-[#BB2649]',
  },
  {
    id: 'mocha-mousse',
    name: '摩卡慕斯',
    description: 'Pantone 2025 Mocha Mousse',
    src: copisMochaMousseLogo,
    resourcePath: 'copis-logos/copis-mocha-mousse.png',
    previewBg: 'bg-[#A47764]',
  },
  {
    id: 'emerald',
    name: '翡翠绿',
    description: 'Pantone 2013 Emerald',
    src: copisEmeraldLogo,
    resourcePath: 'copis-logos/copis-emerald.png',
    previewBg: 'bg-[#009473]',
  },
  // 科技风格
  {
    id: '8bit',
    name: '8bit 像素风',
    description: '复古像素游戏风格',
    src: copis8bitLogo,
    resourcePath: 'copis-logos/copis-8bit.png',
    previewBg: 'bg-[#1a1a2e]',
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    description: '霓虹赛博风格',
    src: copisCyberpunkLogo,
    resourcePath: 'copis-logos/copis-cyberpunk.png',
    previewBg: 'bg-[#0d0221]',
  },
  {
    id: 'futuristic',
    name: '未来质感',
    description: '金属全息科技风',
    src: copisFuturisticLogo,
    resourcePath: 'copis-logos/copis-futuristic.png',
    previewBg: 'bg-[#4a4a4a]',
  },
] as const

// ===== 组件 =====

function LogoCard({ logo }: { logo: LogoVariant }): React.ReactElement {
  const handleDownload = React.useCallback(async () => {
    try {
      const saved = await window.electronAPI.saveResourceFileAs(
        logo.resourcePath,
        `copis-${logo.id}.png`,
      )
      if (saved) {
        toast.success(`${logo.name} 已保存`)
      }
    } catch {
      toast.error('保存失败，请重试')
    }
  }, [logo])

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={cn(
          'w-20 h-20 rounded-xl overflow-hidden border border-border/50 flex items-center justify-center',
          logo.previewBg,
        )}
      >
        <img
          src={logo.src}
          alt={logo.name}
          className="w-full h-full object-contain"
          draggable={false}
        />
      </div>
      <div className="text-center">
        <div className="text-xs font-medium">{logo.name}</div>
        <div className="text-[10px] text-muted-foreground">{logo.description}</div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="w-full gap-1.5 h-7 text-xs"
        onClick={handleDownload}
      >
        <Download size={12} />
        下载
      </Button>
    </div>
  )
}

export function CopisLogoSettings(): React.ReactElement {
  return (
    <>
      <SettingsSection
        title="品牌 Logo"
        description="下载 Copis Logo 用作机器人头像，让用户一眼认出你的 AI 助手"
      >
        <div className="grid grid-cols-3 gap-4">
          {LOGO_VARIANTS.map((logo) => (
            <LogoCard key={logo.id} logo={logo} />
          ))}
        </div>
      </SettingsSection>

      <div className="my-6 border-t border-border/50" />

      <SettingsSection
        title="使用提示"
        description="在机器人平台设置头像时参考"
      >
        <SettingsCard divided={false}>
          <div className="px-4 py-3 space-y-1.5 text-sm text-muted-foreground">
            <p>建议使用 PNG 格式，飞书/钉钉头像推荐 200x200 以上。</p>
            <p>透明背景版本适合需要自定义背景色的平台。</p>
            <p>渐变版和科技风格在社交平台头像中辨识度最高。</p>
          </div>
        </SettingsCard>
      </SettingsSection>
    </>
  )
}
