import * as React from 'react'
import { useAtom } from 'jotai'
import {
  ArrowLeft,
  HardDrive,
  HardDriveDownload,
  LogOut,
  Mic,
  Palette,
  RefreshCw,
  UserRound,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { WorkingUser } from '@copis/shared'
import { workingAuthStateAtom } from '@/atoms/working-atoms'
import { AppearanceSettings } from '@/components/settings/AppearanceSettings'
import { MigrationSettings } from '@/components/settings/MigrationSettings'
import { StorageSettings } from '@/components/settings/StorageSettings'
import { VoiceInputSettings } from '@/components/settings/VoiceInputSettings'
import './CopisWorkingSettingsPanel.css'

export type WorkingSettingsSectionId = 'voice-input' | 'migration' | 'storage' | 'appearance'

interface WorkingSettingsSection {
  id: WorkingSettingsSectionId
  label: string
  description: string
  icon: LucideIcon
}

export const WORKING_SETTINGS_SECTIONS: readonly WorkingSettingsSection[] = [
  {
    id: 'voice-input',
    label: '语音输入',
    description: '管理麦克风权限、语音服务和全局语音输入行为。',
    icon: Mic,
  },
  {
    id: 'migration',
    label: '数据迁移',
    description: '导入或导出 Copis 工作区、Skills 和 MCP 配置。',
    icon: HardDriveDownload,
  },
  {
    id: 'storage',
    label: '磁盘管理',
    description: '查看本地占用并清理临时文件和历史数据。',
    icon: HardDrive,
  },
  {
    id: 'appearance',
    label: '外观设置',
    description: '调整主题、界面风格、字体、预览和应用图标。',
    icon: Palette,
  },
] as const

interface CopisWorkingSettingsPanelProps {
  onClose: () => void
}

export function CopisWorkingSettingsPanel({ onClose }: CopisWorkingSettingsPanelProps): React.ReactElement {
  const [authState, setAuthState] = useAtom(workingAuthStateAtom)
  const [activeSection, setActiveSection] = React.useState<WorkingSettingsSectionId>('voice-input')
  const [loading, setLoading] = React.useState(true)
  const [loggingOut, setLoggingOut] = React.useState(false)
  const [error, setError] = React.useState('')

  const activeSectionDefinition = WORKING_SETTINGS_SECTIONS.find((section) => section.id === activeSection) ?? WORKING_SETTINGS_SECTIONS[0]!
  const user = authState?.user

  const loadAccount = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const currentUser = await window.electronAPI.getWorkingCurrentUser()
      setAuthState((current) => ({
        authenticated: true,
        user: currentUser,
        backendUrl: current?.backendUrl ?? '',
      }))
    } catch (loadError) {
      console.error('[Working 设置] 加载账户信息失败:', loadError)
      setError(loadError instanceof Error ? loadError.message : '加载 Working 账户信息失败')
    } finally {
      setLoading(false)
    }
  }, [setAuthState])

  React.useEffect(() => {
    void loadAccount()
  }, [loadAccount])

  React.useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      onClose()
    }
    window.addEventListener('keydown', handleWindowKeyDown)
    return () => window.removeEventListener('keydown', handleWindowKeyDown)
  }, [onClose])

  const handleLogout = async (): Promise<void> => {
    setLoggingOut(true)
    setError('')
    try {
      setAuthState(await window.electronAPI.logoutWorking())
      onClose()
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : '退出 Working 失败')
    } finally {
      setLoggingOut(false)
    }
  }

  const displayName = getWorkingUserDisplayName(user)
  const ActiveIcon = activeSectionDefinition.icon

  return (
    <div className="copis-working-settings-view">
      <div className="copis-working-settings-shell">
        <aside className="copis-working-settings-sidebar">
          <div className="copis-working-settings-account" aria-label="Working 账户">
            <div className="copis-working-settings-account-icon">
              <UserRound aria-hidden="true" />
            </div>
            <div className="copis-working-settings-account-copy">
              <strong>{displayName}</strong>
              <span>{user?.email || 'Working 账户'}</span>
            </div>
          </div>

          <nav className="copis-working-settings-nav" aria-label="Working 设置菜单">
            <button type="button" className="copis-working-settings-nav-button" onClick={onClose}>
              <ArrowLeft aria-hidden="true" />
              <span>返回对话</span>
            </button>
            {WORKING_SETTINGS_SECTIONS.map((section) => {
              const Icon = section.icon
              const isActive = section.id === activeSection
              return (
                <button
                  key={section.id}
                  type="button"
                  className={`copis-working-settings-nav-button ${isActive ? 'active' : ''}`}
                  onClick={() => setActiveSection(section.id)}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <Icon aria-hidden="true" />
                  <span>{section.label}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        <main className="copis-working-settings-main">
          <header className="copis-working-settings-header">
            <div className="copis-working-settings-heading">
              <div className="copis-working-settings-heading-title">
                <ActiveIcon aria-hidden="true" />
                <h1>{activeSectionDefinition.label}</h1>
              </div>
              <p>{activeSectionDefinition.description}</p>
            </div>
            <div className="copis-working-settings-actions">
              <button type="button" onClick={() => void loadAccount()} disabled={loading || loggingOut}>
                <RefreshCw aria-hidden="true" className={loading ? 'spinning' : undefined} />
                <span>{loading ? '同步中...' : '刷新账户'}</span>
              </button>
              <button type="button" className="danger" onClick={() => void handleLogout()} disabled={loggingOut}>
                <LogOut aria-hidden="true" />
                <span>{loggingOut ? '退出中...' : '退出登录'}</span>
              </button>
            </div>
          </header>

          {error && <div className="copis-working-settings-alert" role="alert">{error}</div>}

          <div className="copis-working-settings-content">
            {renderWorkingSettingsSection(activeSection)}
          </div>
        </main>
      </div>
    </div>
  )
}

function renderWorkingSettingsSection(section: WorkingSettingsSectionId): React.ReactElement {
  switch (section) {
    case 'voice-input':
      return <VoiceInputSettings />
    case 'migration':
      return <MigrationSettings />
    case 'storage':
      return <StorageSettings />
    case 'appearance':
      return <AppearanceSettings />
  }
}

function getWorkingUserDisplayName(user: WorkingUser | null | undefined): string {
  return user?.nickname?.trim() || user?.email?.trim() || 'Working 账户'
}
