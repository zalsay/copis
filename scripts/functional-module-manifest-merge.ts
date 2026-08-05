import type { FunctionalModuleManifest } from '@copis/shared'

export function mergeFunctionalModuleManifests(
  existing: FunctionalModuleManifest | undefined,
  incoming: FunctionalModuleManifest,
): FunctionalModuleManifest {
  if (!existing) return incoming
  if (existing.schema !== incoming.schema) {
    throw new Error(`COS manifest schema 不一致：${existing.schema} !== ${incoming.schema}`)
  }
  if (existing.channel !== incoming.channel) {
    throw new Error(`COS manifest channel 不一致：${existing.channel} !== ${incoming.channel}`)
  }

  const platforms = { ...existing.platforms }
  for (const [platformKey, incomingPlatform] of Object.entries(incoming.platforms)) {
    const existingPlatform = platforms[platformKey]
    platforms[platformKey] = {
      modules: {
        ...(existingPlatform?.modules ?? {}),
        ...incomingPlatform.modules,
      },
    }
  }

  const client = existing.client ?? incoming.client
  return {
    ...incoming,
    ...(client ? { client } : {}),
    platforms,
  }
}
