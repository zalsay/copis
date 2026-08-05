export interface FunctionalModulePrefixOptions {
  cliPrefix?: string
  objectPrefixPath?: string
  legacyCosPrefix?: string
}

export function resolveFunctionalModulePrefix(options: FunctionalModulePrefixOptions): string {
  return firstNonEmpty(options.cliPrefix)
    ?? firstNonEmpty(options.objectPrefixPath)
    ?? firstNonEmpty(options.legacyCosPrefix)
    ?? 'copis/modules'
}

function firstNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}
