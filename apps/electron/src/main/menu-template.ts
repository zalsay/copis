export const COPIS_GITHUB_REPOSITORY_URL = 'https://github.com/zalsay/copis'

export interface CopisMenuHelpItem {
  label: string
  click: () => Promise<void>
}

/** Build the help submenu without coupling menu behavior tests to Electron. */
export function createCopisHelpSubmenu(
  openExternal: (url: string) => Promise<void> | void,
): CopisMenuHelpItem[] {
  return [
    {
      label: '了解更多',
      click: async () => {
        await openExternal(COPIS_GITHUB_REPOSITORY_URL)
      },
    },
  ]
}
