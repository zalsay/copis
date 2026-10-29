import React, { useState, type ReactElement } from 'react'
import {
  Users,
  UserCheck,
  Bot,
  CheckCircle2,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  ArrowLeft,
  Sparkles,
  Layers,
  FileCheck,
  ShieldAlert,
} from 'lucide-react'
import type { TeamMemberInfo, TeamTaskInfo } from './inspectorTypes'

interface TeamInspectorTabProps {
  sessionId?: string
  sessionCwd?: string
}

const DEFAULT_MEMBERS: TeamMemberInfo[] = [
  {
    id: 'lead',
    name: '创造模式主智能体 (Lead)',
    role: 'lead',
    status: 'running',
    description: '负责整体任务规划、多智能体协同分工与核心业务推进',
    skills: ['全局规划', '任务分发', '代码综合'],
  },
  {
    id: 'expert-ui',
    name: 'UI 设计大师 (Dashi Design)',
    role: 'expert',
    status: 'idle',
    description: '专精 ShadcnUI、WorkBuddy 浅灰高光风格与现代毛玻璃视觉',
    skills: ['组件设计', '毛玻璃视觉', 'CSS微动效'],
  },
  {
    id: 'expert-arch',
    name: '系统架构师 (Arch Expert)',
    role: 'expert',
    status: 'ready',
    description: '负责模块间解耦、IPC通信链路保障与状态原子化治理',
    skills: ['Jotai原子管理', 'IPC安全桥接', 'BDD契约'],
  },
  {
    id: 'worker-review',
    name: '代码审查员 (Code Reviewer)',
    role: 'worker',
    status: 'idle',
    description: '负责排查潜在空指针、异步竞态与代码重构建议',
    skills: ['静态检查', 'TypeScript严格类型', '规范审查'],
  },
]

const DEFAULT_TASKS: TeamTaskInfo[] = [
  {
    id: 'task-1',
    subject: '移植 cc-sandbox 侧边 Inspector 多页签系统架构',
    description: '实现顶部 Tab 导航、加号下拉菜单、关闭策略以及多面板分发容器',
    ownerName: '创造模式主智能体 (Lead)',
    status: 'completed',
    ready: true,
    writeScopes: ['src/inspector/CopisInspectorPanel.tsx', 'src/inspector/inspectorTypes.ts'],
  },
  {
    id: 'task-2',
    subject: '升级工作区文件检查器（双栏/可折叠文件树+高亮预览）',
    description: '复刻 FilesInspectorTab，支持面包屑、系统定位、快速复制及代码行统计',
    ownerName: 'UI 设计大师 (Dashi Design)',
    status: 'completed',
    ready: true,
    writeScopes: ['src/inspector/FilesInspectorTab.tsx'],
  },
  {
    id: 'task-3',
    subject: '构建轻量侧边聊天通道（Side Chat）',
    description: '实现独立上下文提问流、预设快捷推荐、首条消息动态更新 Tab 标题',
    ownerName: '创造模式主智能体 (Lead)',
    status: 'completed',
    ready: true,
    writeScopes: ['src/inspector/SideChatInspectorTab.tsx'],
  },
  {
    id: 'task-4',
    subject: '协同团队面板与任务编排看板（Team & Tasks）',
    description: '展现团队成员状态（处理中/空闲/待命）、任务依赖看板及智能体会话回溯',
    ownerName: '系统架构师 (Arch Expert)',
    status: 'in_progress',
    ready: true,
    writeScopes: ['src/inspector/TeamInspectorTab.tsx'],
  },
  {
    id: 'task-5',
    subject: '全仓 BDD 契约测试验证与最终验收准备',
    description: '编写覆盖文件、侧边聊天与团队三大面板的自动化测试，执行类型检查与构建',
    ownerName: '代码审查员 (Code Reviewer)',
    status: 'pending',
    ready: false,
    blockedBy: ['task-4'],
    writeScopes: ['src/client.test.ts'],
  },
]

export function TeamInspectorTab({}: TeamInspectorTabProps): ReactElement {
  const [members] = useState<TeamMemberInfo[]>(DEFAULT_MEMBERS)
  const [tasks] = useState<TeamTaskInfo[]>(DEFAULT_TASKS)
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>('task-4')

  const selectedMember = members.find((m) => m.id === selectedMemberId)

  // 状态统计
  const completedCount = tasks.filter((t) => t.status === 'completed').length
  const inProgressCount = tasks.filter((t) => t.status === 'in_progress').length
  const pendingCount = tasks.filter((t) => t.status === 'pending').length

  // 若处于某个成员的历史子智能体会话回溯视图
  if (selectedMember) {
    return (
      <div className="copis-inspector-team-container" data-testid="copis-inspector-subagent-view">
        <div className="copis-inspector-team-topbar">
          <button
            type="button"
            className="copis-team-back-btn"
            onClick={() => setSelectedMemberId(null)}
          >
            <ArrowLeft size={13} />
            <span>返回团队看板</span>
          </button>
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#f4f4f5' }}>
            {selectedMember.name}
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px' }}>
          {/* 成员详细名片 */}
          <div className="copis-team-member-card" style={{ marginBottom: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="copis-team-avatar-box">
                <Bot size={18} style={{ color: '#cbd5e1' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#f4f4f5' }}>
                  {selectedMember.name}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', marginTop: '2px' }}>
                  {selectedMember.description}
                </div>
              </div>
            </div>

            {selectedMember.skills && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '12px' }}>
                {selectedMember.skills.map((skill) => (
                  <span key={skill} className="copis-team-skill-chip">
                    <Sparkles size={10} style={{ color: '#cbd5e1' }} />
                    {skill}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 会话与动作记录展示 */}
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#a1a1aa', marginBottom: '8px' }}>
            智能体执行上下文与记录
          </div>
          <div className="copis-team-subagent-log-box">
            <div className="copis-team-subagent-log-item">
              <span className="copis-team-log-time">14:48:20</span>
              <span className="copis-team-log-text">智能体已就绪并加载专精规则集</span>
            </div>
            <div className="copis-team-subagent-log-item">
              <span className="copis-team-log-time">14:50:05</span>
              <span className="copis-team-log-text">接收任务指令：执行模块功能拓展与样式微调</span>
            </div>
            <div className="copis-team-subagent-log-item">
              <span className="copis-team-log-time">14:52:12</span>
              <span className="copis-team-log-text" style={{ color: '#e4e4e7' }}>
                ✓ 已完成上下文检查，正在待命监听新指令
              </span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="copis-inspector-team-container" data-testid="copis-inspector-team-panel">
      {/* 顶部团队概要栏 */}
      <div className="copis-inspector-team-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 500 }}>
          <Users size={14} style={{ color: '#cbd5e1' }} />
          <span>团队概览</span>
        </div>
        <div className="copis-team-stats-badge">
          <span>{members.length} 位成员</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>{tasks.length} 项任务</span>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px' }}>
        {/* 第一部分：团队成员 */}
        <div style={{ marginBottom: '20px' }}>
          <div className="copis-team-section-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <UserCheck size={13} style={{ color: '#cbd5e1' }} />
              <span>协同成员</span>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #71717a)' }}>
              {members.length}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {members.map((member) => {
              const isRunning = member.status === 'running'
              const isReady = member.status === 'ready'
              return (
                <div
                  key={member.id}
                  className="copis-team-member-item"
                  onClick={() => setSelectedMemberId(member.id)}
                  title="点击查看执行上下文"
                >
                  <div className="copis-team-avatar-mini">
                    <Bot size={14} style={{ color: member.role === 'lead' ? '#ffffff' : '#a1a1aa' }} />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 500, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {member.name}
                      </span>
                      {member.role === 'lead' && (
                        <span className="copis-team-role-tag">LEAD</span>
                      )}
                    </div>
                    {member.description && (
                      <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                        {member.description}
                      </div>
                    )}
                  </div>

                  <div className={`copis-team-status-chip ${isRunning ? 'copis-team-status--running' : isReady ? 'copis-team-status--ready' : 'copis-team-status--idle'}`}>
                    {isRunning ? '处理中' : isReady ? '就绪' : '空闲'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 第二部分：任务编排看板 */}
        <div>
          <div className="copis-team-section-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Layers size={13} style={{ color: '#cbd5e1' }} />
              <span>任务编排</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', fontSize: '11px' }}>
              <span style={{ color: '#22c55e' }}>{completedCount} 已完成</span>
              <span style={{ color: '#e4e4e7' }}>{inProgressCount} 进行中</span>
              <span style={{ color: '#a1a1aa' }}>{pendingCount} 待处理</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {tasks.map((task) => {
              const isExpanded = expandedTaskId === task.id
              const isCompleted = task.status === 'completed'
              const isInProgress = task.status === 'in_progress'

              return (
                <div key={task.id} className="copis-team-task-item">
                  <div
                    className="copis-team-task-header"
                    onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', width: '12px', color: '#a1a1aa' }}>
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>

                    <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: '2px' }}>
                      {isCompleted ? (
                        <CheckCircle2 size={13} style={{ color: '#22c55e' }} />
                      ) : isInProgress ? (
                        <Clock size={13} style={{ color: '#e4e4e7' }} />
                      ) : (
                        <AlertCircle size={13} style={{ color: '#71717a' }} />
                      )}
                    </span>

                    <span style={{ flex: 1, fontSize: '12px', fontWeight: 500, color: '#f4f4f5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {task.subject}
                    </span>

                    <span
                      className={`copis-team-status-chip ${isCompleted ? 'copis-team-status--ready' : isInProgress ? 'copis-team-status--running' : 'copis-team-status--idle'}`}
                      style={{ fontSize: '10px' }}
                    >
                      {isCompleted ? '已完成' : isInProgress ? '进行中' : task.ready ? '待领取' : '等待依赖'}
                    </span>
                  </div>

                  {isExpanded && (
                    <div className="copis-team-task-details">
                      {task.description && (
                        <div style={{ marginBottom: '6px', color: 'var(--dsw-alias-label-secondary, #d4d4d8)' }}>
                          {task.description}
                        </div>
                      )}

                      <div className="copis-team-task-meta-grid">
                        <div className="copis-team-meta-row">
                          <span className="copis-team-meta-key">负责人:</span>
                          <span className="copis-team-meta-val">{task.ownerName || '未分配'}</span>
                        </div>

                        {task.blockedBy && task.blockedBy.length > 0 && (
                          <div className="copis-team-meta-row">
                            <span className="copis-team-meta-key">阻塞依赖:</span>
                            <span className="copis-team-meta-val" style={{ color: '#fb923c' }}>
                              <ShieldAlert size={11} style={{ display: 'inline', marginRight: '4px' }} />
                              {task.blockedBy.join(', ')}
                            </span>
                          </div>
                        )}

                        {task.writeScopes && task.writeScopes.length > 0 && (
                          <div className="copis-team-meta-row">
                            <span className="copis-team-meta-key">写入范围:</span>
                            <span className="copis-team-meta-val" style={{ color: '#93c5fd' }}>
                              <FileCheck size={11} style={{ display: 'inline', marginRight: '4px' }} />
                              {task.writeScopes.join(', ')}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
