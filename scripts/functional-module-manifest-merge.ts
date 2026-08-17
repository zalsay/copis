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

  const client = mergeClientConfig(existing.client, incoming.client)
  return {
    ...incoming,
    ...(client ? { client } : {}),
    platforms,
  }
}

function mergeClientConfig(
  existing: FunctionalModuleManifest['client'],
  incoming: FunctionalModuleManifest['client'],
): FunctionalModuleManifest['client'] {
  const minVersion = pickMinimumClientVersion(existing?.minVersion, incoming?.minVersion)
  const update = incoming?.update ?? existing?.update
  if (!minVersion && !update) return undefined
  return {
    ...(minVersion ? { minVersion } : {}),
    ...(update ? { update } : {}),
  }
}

function pickMinimumClientVersion(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (!existing) return incoming
  if (!incoming) return existing
  return compareVersions(existing, incoming) >= 0 ? existing : incoming
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  const partCount = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < partCount; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
