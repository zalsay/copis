#!/usr/bin/env bun
import { resolveCompiledRuntimeMode } from './compiled-runtime-build'

if (resolveCompiledRuntimeMode(process.argv) === 'pi-worker') {
  await import('../src/main/pi-rpc-worker')
} else {
  await import('../../cli/src/index')
}
