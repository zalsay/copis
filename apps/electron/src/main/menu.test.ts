import { describe, expect, test } from 'bun:test'
import { COPIS_GITHUB_REPOSITORY_URL, createCopisHelpSubmenu } from './menu-template'

describe('Copis application menu', () => {
  test('opens the Copis repository from the help menu', async () => {
    const openedUrls: string[] = []
    const submenu = createCopisHelpSubmenu((url) => {
      openedUrls.push(url)
    })

    await submenu[0]!.click()
    expect(openedUrls).toEqual([COPIS_GITHUB_REPOSITORY_URL])
  })
})
