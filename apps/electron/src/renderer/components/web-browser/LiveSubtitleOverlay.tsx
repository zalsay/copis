import * as React from 'react'
import { useAtomValue } from 'jotai'
import {
  liveTranslateActiveAtom,
  liveTranslateBilingualAtom,
  liveTranslateCurrentSubtitleAtom,
  liveTranslateFloatingBannerAtom,
} from '@/atoms/live-translate-atoms'
import { cn } from '@/lib/utils'

export function LiveSubtitleOverlay(): React.ReactElement | null {
  const isActive = useAtomValue(liveTranslateActiveAtom)
  const isEnabled = useAtomValue(liveTranslateFloatingBannerAtom)
  const isBilingual = useAtomValue(liveTranslateBilingualAtom)
  const current = useAtomValue(liveTranslateCurrentSubtitleAtom)

  if (!isEnabled || (!isActive && !current.translated && !current.original)) {
    return null
  }

  const hasContent = Boolean(current.translated || current.original || current.interim)

  return (
    <div className="pointer-events-none absolute bottom-8 inset-x-0 z-40 flex justify-center px-8 transition-all duration-300">
      <div
        className={cn(
          'pointer-events-auto relative max-w-3xl min-w-[320px] rounded-2xl border px-6 py-4 text-center shadow-2xl backdrop-blur-2xl transition-all duration-300',
          'border-white/[0.12] bg-zinc-950/85 text-zinc-100 shadow-[0_16px_48px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1)]',
          hasContent
            ? 'opacity-100 translate-y-0 scale-100'
            : 'opacity-75 translate-y-1 scale-[0.98]',
        )}
      >
        {/* Ambient Top Glow Line using ui-primary */}
        <div
          className="absolute inset-x-6 top-0 h-[1.5px]"
          style={{
            background: 'linear-gradient(90deg, transparent 0%, var(--ui-primary) 50%, transparent 100%)',
          }}
        />

        {isBilingual && current.original ? (
          <div className="mb-1.5 text-xs font-normal text-zinc-400/90 tracking-wide line-clamp-2 select-text leading-relaxed">
            {current.original}
          </div>
        ) : null}

        {current.translated ? (
          <div
            className="text-base font-bold tracking-tight select-text leading-snug drop-shadow-sm"
            style={{ color: 'var(--ui-primary)' }}
          >
            {current.translated}
          </div>
        ) : null}

        {current.interim ? (
          <div className="mt-1 flex items-center justify-center gap-1.5 text-xs font-normal italic text-zinc-400 select-text">
            <span
              className="size-1.5 rounded-full animate-pulse"
              style={{ backgroundColor: 'var(--ui-primary)' }}
            />
            <span>{current.interim}...</span>
          </div>
        ) : null}

        {!hasContent ? (
          <div className="flex items-center justify-center gap-2.5 py-0.5 text-xs font-medium text-zinc-400">
            <span className="relative flex size-2">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
                style={{ backgroundColor: 'var(--ui-primary)' }}
              />
              <span
                className="relative inline-flex size-2 rounded-full"
                style={{ backgroundColor: 'var(--ui-primary)' }}
              />
            </span>
            <span className="tracking-wide">Gemini 实时双向同传监听中...</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
