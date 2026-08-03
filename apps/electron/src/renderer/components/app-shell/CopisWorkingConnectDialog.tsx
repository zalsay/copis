import * as React from 'react'
import { createPortal } from 'react-dom'
import { Check, FolderOpen, X } from 'lucide-react'
import './CopisWorkingConnectDialog.css'

export interface WorkingFolderSelection {
  path: string
  name: string
}

interface CopisWorkingConnectDialogProps {
  busy: boolean
  onClose: () => void
  onConfirm: (selection: WorkingFolderSelection, allowWorkspaceWrite: boolean) => Promise<void>
}

export function CopisWorkingConnectDialog({
  busy,
  onClose,
  onConfirm,
}: CopisWorkingConnectDialogProps): React.ReactElement {
  const [selection, setSelection] = React.useState<WorkingFolderSelection | null>(null)
  const [allowWorkspaceWrite, setAllowWorkspaceWrite] = React.useState(false)

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose])

  const handleSelectFolder = async (): Promise<void> => {
    const folder = await window.electronAPI.openFolderDialog()
    if (folder) setSelection(folder)
  }

  return createPortal(
    <div
      className="copis-working-connect-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        className="copis-working-connect-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copis-working-connect-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="copis-working-connect-header">
          <div>
            <strong id="copis-working-connect-title">创建工作区</strong>
            <span>选择一个目录作为 Agent 的工作区。</span>
          </div>
          <button type="button" aria-label="关闭创建工作区" onClick={onClose} disabled={busy}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="copis-working-connect-location" role="group" aria-label="工作区位置">
          <div className="active">
            <FolderOpen aria-hidden="true" />
            <span>本地目录</span>
          </div>
          {selection?.path && (
            <span className="copis-working-connect-location-note" title={selection.path}>{selection.path}</span>
          )}
        </div>

        <button type="button" className="copis-working-connect-picker" onClick={() => void handleSelectFolder()} disabled={busy}>
          <FolderOpen aria-hidden="true" />
          <span>{selection?.path || '选择目录'}</span>
        </button>

        <label className="copis-working-connect-check">
          <input
            type="checkbox"
            checked={allowWorkspaceWrite}
            onChange={(event) => setAllowWorkspaceWrite(event.target.checked)}
            disabled={busy}
          />
          <span className="copis-working-connect-check-box" aria-hidden="true"><Check /></span>
          <span>
            <strong>允许 Agent 写入工作区目录</strong>
          </span>
        </label>

        <div className="copis-working-connect-note">
          {allowWorkspaceWrite ? '已授权写入所选目录，Agent 可以执行文件修改。' : '将自动创建 copis 作为 Agent 的输出目录，原始文件保持只读。'}
        </div>

        <footer className="copis-working-connect-actions">
          <button type="button" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" onClick={() => selection && void onConfirm(selection, allowWorkspaceWrite)} disabled={busy || !selection}>
            {busy ? '创建中...' : '创建'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
