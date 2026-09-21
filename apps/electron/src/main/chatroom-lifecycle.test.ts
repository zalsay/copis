import { expect, test } from 'bun:test'

test('Given lifecycle phases When quitting Then the required order is explicit', () => {
  const order = ['coordinator.stopAll:app_quit', 'agents.stopAll', 'httpApi.stop', 'coordinator.dispose']
  expect(order).toEqual(['coordinator.stopAll:app_quit', 'agents.stopAll', 'httpApi.stop', 'coordinator.dispose'])
})
