import * as React from 'react'
import { ArrowLeft, ArrowRight, Bot, Check, CheckCircle2, FileText, Globe2, Sparkles } from 'lucide-react'
import { CopisAppLogo } from '@/lib/model-logo'
import './CopisWorkingLoginShowcase.css'

export interface CopisWorkingLoginShowcaseSlide {
  id: 'hero' | 'browser' | 'workflow'
  kicker: string
  title: string
  emphasis: string
  description: string
  tags: readonly string[]
  metricLabel: string
}

export const COPIS_WORKING_LOGIN_SHOWCASE_SLIDES: readonly [
  CopisWorkingLoginShowcaseSlide,
  CopisWorkingLoginShowcaseSlide,
  CopisWorkingLoginShowcaseSlide,
] = [
  {
    id: 'hero',
    kicker: '本地优先的智能工作台',
    title: '给长期工作，',
    emphasis: '一个能持续推进的智能体。',
    description: '从一句任务开始，把模型、文件、技能和工具连接成自己的工作流。',
    tags: ['多模型对话', '本地智能体', '技能与工具'],
    metricLabel: '从任务开始',
  },
  {
    id: 'browser',
    kicker: 'AI 浏览器自动化',
    title: '看见页面，',
    emphasis: '再替你推进。',
    description: '在每一步都可见的浏览器里观察页面状态，并在授权后完成连续操作。',
    tags: ['打开页面', '观察状态', '执行操作'],
    metricLabel: '每一步可追踪',
  },
  {
    id: 'workflow',
    kicker: '工作流与自动化',
    title: '让重复工作，',
    emphasis: '自己向前走。',
    description: '将常用技能、工具服务和远程机器人组合成可重复推进的流程。',
    tags: ['研究与判断', '文件与交付', '团队自动化'],
    metricLabel: '持续推进',
  },
]

function ShowcaseVisual({ slide }: { slide: CopisWorkingLoginShowcaseSlide }): React.ReactElement {
  if (slide.id === 'hero') {
    return (
      <div className="copis-working-login-showcase-visual copis-working-login-showcase-visual-hero" aria-hidden="true">
        <div className="copis-working-showcase-orbit orbit-one" />
        <div className="copis-working-showcase-orbit orbit-two" />
        <div className="copis-working-showcase-hero-mark">
          <img src={CopisAppLogo} alt="" />
          <span>Copis</span>
        </div>
        <div className="copis-working-showcase-task-card task-card-main">
          <span className="showcase-card-label"><Bot size={14} />智能体正在工作</span>
          <strong>整理本周产品反馈</strong>
          <span className="showcase-card-status"><CheckCircle2 size={13} />工作区已连接</span>
        </div>
        <div className="copis-working-showcase-task-card task-card-side">
          <Sparkles size={15} />
          <span>上下文持续保留</span>
        </div>
      </div>
    )
  }

  if (slide.id === 'browser') {
    return (
      <div className="copis-working-login-showcase-visual copis-working-login-showcase-visual-browser" aria-hidden="true">
        <div className="showcase-browser-window">
          <div className="showcase-browser-toolbar">
            <span className="showcase-browser-dots"><i /><i /><i /></span>
            <span className="showcase-browser-address"><Globe2 size={12} />工作区 / 产品反馈</span>
            <span className="showcase-browser-badge">AI 浏览器</span>
          </div>
          <div className="showcase-browser-page">
            <span className="showcase-browser-kicker">产品反馈</span>
            <strong>本周反馈清单</strong>
            <div className="showcase-browser-row is-target"><b>1</b><span>首次配置路径太长</span><em>待处理</em></div>
            <div className="showcase-browser-row"><b>2</b><span>导入文件时缺少进度提示</span><em>已读</em></div>
            <div className="showcase-browser-row"><b>3</b><span>希望支持导出为文档</span><em>已读</em></div>
          </div>
          <div className="showcase-browser-status"><span />正在观察页面，准备下一步操作</div>
        </div>
      </div>
    )
  }

  return (
    <div className="copis-working-login-showcase-visual copis-working-login-showcase-visual-workflow" aria-hidden="true">
      <div className="showcase-workflow-window">
        <div className="showcase-workflow-heading"><FileText size={15} /><span>每周反馈汇总</span><strong>按计划运行</strong></div>
        <div className="showcase-workflow-path">
          <span><FileText size={14} />收集反馈</span><i /><span><Sparkles size={14} />归纳主题</span><i /><span><Bot size={14} />发送摘要</span>
        </div>
        <div className="showcase-workflow-result"><Check size={14} /><span><b>最近一次运行完成</b><small>摘要已发送到团队空间</small></span></div>
        <div className="showcase-workflow-footer"><span>下次运行：周一 09:00</span><CheckCircle2 size={16} /></div>
      </div>
    </div>
  )
}

export function CopisWorkingLoginShowcase(): React.ReactElement {
  const [defaultSlide] = COPIS_WORKING_LOGIN_SHOWCASE_SLIDES
  const [activeIndex, setActiveIndex] = React.useState(0)
  const [isPaused, setIsPaused] = React.useState(false)
  const [reducedMotion, setReducedMotion] = React.useState(false)

  React.useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const updateMotionPreference = (): void => setReducedMotion(mediaQuery.matches)
    updateMotionPreference()
    mediaQuery.addEventListener?.('change', updateMotionPreference)
    return () => mediaQuery.removeEventListener?.('change', updateMotionPreference)
  }, [])

  React.useEffect(() => {
    if (reducedMotion || isPaused) return undefined
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % COPIS_WORKING_LOGIN_SHOWCASE_SLIDES.length)
    }, 6200)
    return () => window.clearInterval(timer)
  }, [isPaused, reducedMotion])

  const selectSlide = (index: number): void => {
    const count = COPIS_WORKING_LOGIN_SHOWCASE_SLIDES.length
    setActiveIndex((index + count) % count)
  }

  const activeSlide = COPIS_WORKING_LOGIN_SHOWCASE_SLIDES[activeIndex] ?? defaultSlide

  return (
    <section
      className="copis-working-login-showcase"
      aria-label="Copis 产品介绍"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocusCapture={() => setIsPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsPaused(false)
      }}
    >
      <header className="copis-working-login-showcase-header">
        <div className="copis-working-login-showcase-brand">
          <img src={CopisAppLogo} alt="" />
          <span>Copis</span>
        </div>
        <span className="copis-working-login-showcase-context">智能工作台</span>
      </header>

      <div className="copis-working-login-showcase-viewport" aria-live="polite">
        {COPIS_WORKING_LOGIN_SHOWCASE_SLIDES.map((slide, index) => {
          const isActive = index === activeIndex
          return (
            <article
              key={slide.id}
              className={`copis-working-login-showcase-slide${isActive ? ' is-active' : ''}`}
              aria-hidden={!isActive}
              hidden={!isActive}
            >
              <div className="copis-working-login-showcase-copy">
                <span className="copis-working-login-showcase-kicker">{slide.kicker}</span>
                <h1><span>{slide.title}</span><strong>{slide.emphasis}</strong></h1>
                <p>{slide.description}</p>
                <div className="copis-working-login-showcase-tags">
                  {slide.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
              </div>
              <ShowcaseVisual slide={slide} />
            </article>
          )
        })}
      </div>

      <footer className="copis-working-login-showcase-footer">
        <div className="copis-working-login-showcase-progress">
          <span>{String(activeIndex + 1).padStart(2, '0')}</span>
          <i />
          <span>{String(COPIS_WORKING_LOGIN_SHOWCASE_SLIDES.length).padStart(2, '0')}</span>
          <small>{activeSlide.metricLabel}</small>
        </div>
        <div className="copis-working-login-showcase-controls">
          <button type="button" aria-label="上一张产品介绍" onClick={() => selectSlide(activeIndex - 1)}><ArrowLeft size={16} /></button>
          <div className="copis-working-login-showcase-dots" aria-label="产品介绍分页">
            {COPIS_WORKING_LOGIN_SHOWCASE_SLIDES.map((slide, index) => (
              <button
                key={slide.id}
                type="button"
                className={index === activeIndex ? 'is-active' : ''}
                aria-label={`查看${slide.kicker}`}
                aria-pressed={index === activeIndex}
                onClick={() => selectSlide(index)}
              />
            ))}
          </div>
          <button type="button" aria-label="下一张产品介绍" onClick={() => selectSlide(activeIndex + 1)}><ArrowRight size={16} /></button>
        </div>
      </footer>
    </section>
  )
}
