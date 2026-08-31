export interface PreviewTextResponse {
  resolvedPath: string
  content: string
  revision?: string
}

export interface PreviewTextLoaders {
  readViaHttp: () => Promise<PreviewTextResponse>
  readViaIpc: () => Promise<PreviewTextResponse | null>
  shouldAbort?: () => boolean
}

export type PreviewTextLoadResult =
  | (PreviewTextResponse & { source: 'http' | 'ipc' })
  | { source: 'error'; error: unknown }

export async function loadPreviewText(loaders: PreviewTextLoaders): Promise<PreviewTextLoadResult> {
  try {
    return { ...(await loaders.readViaHttp()), source: 'http' }
  } catch (httpError) {
    if (loaders.shouldAbort?.()) {
      return { source: 'error', error: httpError }
    }
    try {
      const result = await loaders.readViaIpc()
      return result ? { ...result, source: 'ipc' } : { source: 'error', error: httpError }
    } catch {
      return { source: 'error', error: httpError }
    }
  }
}
