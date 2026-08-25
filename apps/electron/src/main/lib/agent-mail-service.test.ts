import { describe, expect, mock, test } from 'bun:test'

mock.module('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  app: {
    isPackaged: true,
    getPath: () => '/tmp',
  },
}))

describe('AgentMailService', () => {
  test('Given AgentMailService instance When getStatus Then returns valid status object', async () => {
    const { AgentMailService } = await import('./agent-mail-service')
    const service = AgentMailService.getInstance()
    const status = await service.getStatus()

    expect(status).toHaveProperty('installed')
    expect(status).toHaveProperty('loggedIn')
    expect(status).toHaveProperty('status')
  })

  test('Given cancelLogin When called Then does not throw', async () => {
    const { AgentMailService } = await import('./agent-mail-service')
    const service = AgentMailService.getInstance()
    expect(() => service.cancelLogin()).not.toThrow()
  })
})
