const COPIS_REPO_URL = 'https://github.com/ErlichLiu/Copis'

let _copisVersion = '0.0.0'

export function setCopisVersion(version: string): void {
  _copisVersion = version
}

export function getCopisVersion(): string {
  return _copisVersion
}

export function getCopisUserAgent(version?: string): string {
  const v = version ?? _copisVersion
  return `Copis/${v} (+${COPIS_REPO_URL})`
}
