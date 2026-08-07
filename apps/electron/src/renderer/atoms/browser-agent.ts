import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { BrowserWorkflowStatus, BrowserWorkflowVersion } from '@copis/shared'

/** 当前网页宿主绑定的 AI浏览器 Pi 会话，保留最近一次有效会话以便重启后恢复。 */
export const browserAgentSessionIdAtom = atomWithStorage<string | null>(
  'copis-browser-agent-session-id',
  null,
  undefined,
  { getOnInit: true },
)

/** AI浏览器侧栏是否展开；收起不解除页面绑定。 */
export const browserAgentPanelOpenAtom = atom(false)

/** 当前网页 Workflow 的主进程状态。 */
export const browserWorkflowStatusAtom = atom<BrowserWorkflowStatus>({ state: 'idle' })

/** 当前待审核的 Workflow 草稿；原始操作 JSONL 不进入 Renderer。 */
export const browserWorkflowDraftAtom = atom<BrowserWorkflowVersion | null>(null)

/** AI浏览器分栏宽度，保留用户的拖拽布局偏好。 */
export const browserAgentPanelWidthAtom = atomWithStorage<number>('copis-browser-agent-panel-width', 400, undefined, { getOnInit: true })
