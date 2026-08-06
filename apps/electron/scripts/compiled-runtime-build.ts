import { join } from 'node:path'

export const COPIS_PI_WORKER_SUBCOMMAND = '__pi-worker'

export type CompiledRuntimeMode = 'cli' | 'pi-worker'

export interface CreateCompiledRuntimeArgsOptions {
  entryFile: string
  outFile: string
  compileExecutablePath?: string
}

export interface CompiledRuntimeAsset {
  source: string
  destination: string
}

export function createCompiledRuntimeArgs(options: CreateCompiledRuntimeArgsOptions): string[] {
  return [
    'build',
    '--compile',
    ...(options.compileExecutablePath
      ? ['--compile-executable-path', options.compileExecutablePath]
      : []),
    '--outfile',
    options.outFile,
    options.entryFile,
  ]
}

export function resolveCompiledRuntimeMode(argv: readonly string[]): CompiledRuntimeMode {
  return argv[2] === COPIS_PI_WORKER_SUBCOMMAND ? 'pi-worker' : 'cli'
}

export function resolveCompiledRuntimeAssets(options: {
  photonWasmSource: string
  outDir: string
}): CompiledRuntimeAsset[] {
  return [{
    source: options.photonWasmSource,
    destination: join(options.outDir, 'photon_rs_bg.wasm'),
  }]
}
