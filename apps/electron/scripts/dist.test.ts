import { describe, expect, test } from 'bun:test'

const dist = await import('./dist')

describe('visual distribution build plan', () => {
  test('all visual variants build both preloads before renderer and electron-builder', () => {
    const plan = dist.createVisualDistributionBuildPlan()

    expect(plan.map((step) => step.command)).toEqual([
      'build:main',
      'build:preload',
      'build:web-javascript-prompt-preload',
      'build:renderer',
      'build:cli',
      'build:resources',
      'electron-builder',
    ])

    for (const variant of ['visual', 'fast', 'debug']) {
      expect(dist.getVisualDistributionBuildPlan(variant)).toEqual(plan)
    }

    const rendererIndex = plan.findIndex((step) => step.command === 'build:renderer')
    const builderIndex = plan.findIndex((step) => step.command === 'electron-builder')
    expect(plan.findIndex((step) => step.command === 'build:preload')).toBeLessThan(rendererIndex)
    expect(plan.findIndex((step) => step.command === 'build:web-javascript-prompt-preload')).toBeLessThan(rendererIndex)
    expect(plan.findIndex((step) => step.command === 'build:preload')).toBeLessThan(builderIndex)
    expect(plan.findIndex((step) => step.command === 'build:web-javascript-prompt-preload')).toBeLessThan(builderIndex)
  })
})
