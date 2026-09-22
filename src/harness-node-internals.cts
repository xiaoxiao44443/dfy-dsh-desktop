import { registerHooks, syncBuiltinESMExports } from 'node:module'
import workerThreads from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'

const NATIVE_LOOKUP = 'const addon = createRequire(import.meta.url)("node-addon-require-builtin");'
const EXPOSED_LOOKUP = 'const addon = { requireBuiltin: createRequire(import.meta.url) };'
const RESOLUTION_KEY = '@deepseek-ai/dsh-app-boot/profile-resolution'

/** Use Node's explicit --expose-internals path, as Cordis itself already does. */
export function withExposedNodeInternals(source: string): string {
  if (!source.includes(NATIVE_LOOKUP)) return source
  if (source.split(NATIVE_LOOKUP).length !== 2 || !source.includes('function internalModules() {')) {
    throw new Error('DSH module loader: unsupported internalModules layout')
  }
  // The original loader's interface checks and package-resolution rules remain intact.
  return source.replace(NATIVE_LOOKUP, EXPOSED_LOOKUP)
}

function install(): void {
  if (!process.execArgv.includes('--expose-internals')) return
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (!url.startsWith('file:') || ![
        '/@deepseek-ai/dsh-app-boot/lib/index.js',
        '/@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js',
      ].some(path => url.endsWith(path))) return loaded
      if (loaded.source === null || loaded.source === undefined) return loaded
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source as Uint8Array).toString('utf8')
      return { ...loaded, source: withExposedNodeInternals(source) }
    },
  })

  const OriginalWorker = workerThreads.Worker
  workerThreads.Worker = class extends OriginalWorker {
    constructor(filename: string | URL, options?: WorkerOptions) {
      // DSH publishes this only for workers inheriting its package resolver.
      // Its migration worker clears execArgv, so explicitly carry the same
      // Node entry path and this in-memory adapter into that worker as well.
      if (workerThreads.getEnvironmentData(RESOLUTION_KEY) !== undefined) {
        const execArgv = [...(options?.execArgv ?? process.execArgv)]
        if (!execArgv.includes('--expose-internals')) execArgv.push('--expose-internals')
        if (!execArgv.includes(__filename)) execArgv.push('--require', __filename)
        options = { ...options, execArgv }
      }
      super(filename, options)
    }
  }
  syncBuiltinESMExports()
}

install()
