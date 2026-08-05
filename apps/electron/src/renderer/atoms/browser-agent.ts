import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { BrowserWorkflowStatus, BrowserWorkflowVersion } from '@copis/shared'

/** 当前网页宿主绑定的 Browser Agent Pi 会话。 */
export const browserAgentSessionIdAtom = atom<string | null>(null)

/** Browser Agent 侧栏是否展开；收起不解除页面绑定。 */
export const browserAgentPanelOpenAtom = atom(false)

/** 当前网页 Workflow 的主进程状态。 */
export const browserWorkflowStatusAtom = atom<BrowserWorkflowStatus>({ state: 'idle' })

/** 当前待审核的 Workflow 草稿；原始操作 JSONL 不进入 Renderer。 */
export const browserWorkflowDraftAtom = atom<BrowserWorkflowVersion | null>(null)

/** Browser Agent 分栏宽度，保留用户的拖拽布局偏好。 */
export const browserAgentPanelWidthAtom = atomWithStorage<number>('copis-browser-agent-panel-width', 400, undefined, { getOnInit: true })
