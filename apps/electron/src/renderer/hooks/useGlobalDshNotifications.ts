import { useEffect } from 'react'
import { useStore } from 'jotai'
import { applyDshNotificationEventAtom } from '@/atoms/dsh-notifications'
import { notificationsEnabledAtom, notificationSoundEnabledAtom, notificationSoundsAtom, sendDesktopNotification } from '@/atoms/notifications'
import { showDshConversationAtom } from '@/atoms/dsh-navigation'

/** 全局监听，公共页面打开时仍能收到后台 DSH 会话完成事件。 */
export function useGlobalDshNotifications(): void {
  const store = useStore()
  useEffect(() => window.electronAPI.dshCordis.onClientEvent((event) => {
    const firstCompletion = store.set(applyDshNotificationEventAtom, event)
    if (!firstCompletion || event.type !== 'COPIS_DSH_SESSION_COMPLETED') return
    const enabled = store.get(notificationsEnabledAtom)
    // 主渲染页面与 DSH 原生 View 的焦点相互独立，两端任一聚焦都表示应用在前台。
    const foreground = event.windowFocused || document.hasFocus()
    sendDesktopNotification('创造模式任务完成', `[${event.title}] 任务已完成`, enabled && !foreground, {
      playSound: enabled && store.get(notificationSoundEnabledAtom),
      soundType: 'taskComplete',
      sounds: store.get(notificationSoundsAtom),
      onNavigate: () => {
        store.set(showDshConversationAtom)
        void window.electronAPI.dshCordis.dispatchToClient({ type: 'COPIS_DSH_OPEN_SESSION', sessionId: event.sessionId })
          .catch((error: unknown) => console.error('[创造模式通知] 返回会话失败:', error))
      },
    })
  }), [store])
}
