/**
 * generate_image 工具结果渲染器
 *
 * 工具结果文本末尾带有 <generated_images> JSON 元数据（本地附件路径），
 * 这里读取附件并以缩略图展示，同时保留原始文本说明。
 */

import * as React from 'react'
import { Download } from 'lucide-react'
import { ImageLightbox, type LightboxImage } from '@/components/ui/image-lightbox'

interface GeneratedImageMeta {
  filename: string
  path: string
  mediaType: string
}

interface GenerateImageResultRendererProps {
  result: string
  isError: boolean
}

function parseGeneratedImages(result: string): GeneratedImageMeta[] {
  const match = result.match(/<generated_images>\s*(\[[\s\S]*?\])\s*<\/generated_images>/)
  if (!match) return []
  const raw = match[1]
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is GeneratedImageMeta => {
      if (!item || typeof item !== 'object') return false
      const record = item as Record<string, unknown>
      return typeof record.path === 'string'
        && typeof record.filename === 'string'
        && typeof record.mediaType === 'string'
    })
  } catch {
    return []
  }
}

function stripGeneratedImagesMeta(result: string): string {
  return result.replace(/\n*<generated_images>\s*\[[\s\S]*?\]\s*<\/generated_images>\s*$/, '').trimEnd()
}

function GeneratedImageThumb({
  image,
  index,
  onOpen,
  onLoaded,
}: {
  image: GeneratedImageMeta
  index: number
  onOpen: (index: number) => void
  onLoaded: (path: string, src: string) => void
}): React.ReactElement {
  const [src, setSrc] = React.useState<string | null>(null)

  React.useEffect(() => {
    let alive = true
    window.electronAPI
      .readAttachment(image.path)
      .then((base64) => {
        if (alive) {
          const dataUrl = `data:${image.mediaType};base64,${base64}`
          setSrc(dataUrl)
          onLoaded(image.path, dataUrl)
        }
      })
      .catch((error: unknown) => {
        console.error('[生图结果] 读取图片失败:', error)
      })
    return () => {
      alive = false
    }
  }, [image.path, image.mediaType, onLoaded])

  if (!src) {
    return <div className="h-[140px] w-[200px] shrink-0 animate-pulse rounded-lg bg-muted/30" />
  }

  return (
    <div className="group relative inline-block shrink-0">
      <img
        src={src}
        alt={image.filename}
        className="max-h-[200px] max-w-[300px] cursor-pointer rounded-lg object-contain"
        onClick={() => onOpen(index)}
      />
      <button
        type="button"
        onClick={() => {
          void window.electronAPI.saveImageAs(image.path, image.filename)
        }}
        className="absolute bottom-2 right-2 rounded-md bg-black/50 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/70"
        title="保存图片"
      >
        <Download className="size-4" />
      </button>
    </div>
  )
}

export function GenerateImageResultRenderer({
  result,
  isError,
}: GenerateImageResultRendererProps): React.ReactElement {
  const images = React.useMemo(() => parseGeneratedImages(result), [result])
  const text = React.useMemo(() => stripGeneratedImagesMeta(result), [result])

  const [lightboxOpen, setLightboxOpen] = React.useState(false)
  const [lightboxIndex, setLightboxIndex] = React.useState(0)
  const [loadedMap, setLoadedMap] = React.useState<Map<string, string>>(() => new Map())

  const handleImageLoaded = React.useCallback((path: string, src: string): void => {
    setLoadedMap((prev) => {
      const next = new Map(prev)
      next.set(path, src)
      return next
    })
  }, [])

  const lightboxImages: LightboxImage[] = React.useMemo(
    () =>
      images
        .map((img) => ({
          src: loadedMap.get(img.path) ?? '',
          filename: img.filename,
          path: img.path,
        }))
        .filter((img) => Boolean(img.src)),
    [images, loadedMap],
  )

  const handleOpenLightbox = React.useCallback((index: number) => {
    setLightboxIndex(index)
    setLightboxOpen(true)
  }, [])

  if (isError) {
    return (
      <pre className="whitespace-pre-wrap break-all rounded-md bg-destructive/5 p-3 font-mono text-[12px] text-destructive/80">
        {result}
      </pre>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {text && <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/80">{text}</p>}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {images.map((image, index) => (
            <GeneratedImageThumb
              key={image.path}
              image={image}
              index={index}
              onOpen={handleOpenLightbox}
              onLoaded={handleImageLoaded}
            />
          ))}
        </div>
      )}
      {lightboxImages.length > 0 && (
        <ImageLightbox
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          images={lightboxImages}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
        />
      )}
    </div>
  )
}
