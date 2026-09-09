import childProcess from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerDfySessionFormatCompatibility } from './harness-session-format-compat.cjs'

const electronExecutable = process.execPath.toLowerCase()
const originalSpawn = childProcess.spawn
const directoryPickerWorkerShim = join(__dirname, 'directory-picker-worker.cjs')
const windowsAclRunnerWorkerShim = join(__dirname, 'windows-acl-runner-worker.cjs')
const DESKTOP_BRIDGE_PACKAGE = 'dsh-desktop-bridge'
const DESKTOP_BROWSER_PACKAGE = 'dsh-desktop-browser'

interface KoffiLibrary {
  func(declaration: string): (...args: unknown[]) => unknown
}

interface KoffiModule {
  load(name: string): KoffiLibrary
}

/**
 * DeepSeek Harness' Windows ACL runner deliberately makes restricted children
 * share their host console. Without one, PowerShell terminates during DLL
 * initialization with STATUS_DLL_INIT_FAILED (0xC0000142). A packaged Electron
 * GUI has no console by default, so create one for the background Harness Node
 * process and immediately hide its window. This preserves the ACL sandbox and
 * does not require weakening sessions to danger-full-access.
 */
function ensureHiddenHarnessConsole(harnessEntry: string): void {
  if (process.platform !== 'win32') return
  try {
    const requireFromHarness = createRequire(harnessEntry)
    const koffi = requireFromHarness('koffi') as KoffiModule
    const kernel32 = koffi.load('kernel32.dll')
    const user32 = koffi.load('user32.dll')
    const getConsoleWindow = kernel32.func('void * __stdcall GetConsoleWindow()') as () => unknown
    const allocConsole = kernel32.func('bool __stdcall AllocConsole()') as () => boolean
    const freeConsole = kernel32.func('bool __stdcall FreeConsole()') as () => boolean
    const getLastError = kernel32.func('uint32 __stdcall GetLastError()') as () => number
    const showWindow = user32.func('bool __stdcall ShowWindow(void *window, int command)') as (window: unknown, command: number) => boolean

    let consoleWindow = getConsoleWindow()
    if (!consoleWindow) {
      // A ConPTY-backed parent reports no console window but still counts as
      // attached, so AllocConsole alone fails with ERROR_ACCESS_DENIED. Detach
      // that windowless console first; FreeConsole is harmless when no console
      // is attached (the packaged GUI case).
      freeConsole()
      if (!allocConsole()) throw new Error(`AllocConsole failed (Win32 ${String(getLastError())})`)
      consoleWindow = getConsoleWindow()
      if (consoleWindow) showWindow(consoleWindow, 0)
    }
  } catch (error) {
    console.warn('[desktop] failed to prepare the hidden Harness console', error)
  }
}

function isHarnessDirectoryPickerWorker(entry: string | undefined): entry is string {
  if (entry === undefined) return false
  const normalized = entry.replaceAll('\\', '/').toLowerCase()
  return normalized.endsWith('/@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs')
}

function isWindowsAclRunner(entry: string | undefined): entry is string {
  if (entry === undefined) return false
  const normalized = entry.replaceAll('\\', '/').toLowerCase()
  return normalized.includes('/@deepseek-ai/dsh-sandbox-windows-acl/')
    && (normalized.endsWith('/runner.js') || normalized.endsWith('/runner.ts'))
}

/**
 * Harness occasionally launches a JavaScript worker through process.execPath
 * (for example, the Win32 directory picker). Since process.execPath is Electron
 * in the desktop bundle, only those self-spawned workers need Node mode. Other
 * applications such as VS Code must not inherit Electron's Node-mode flag.
 */
function desktopSpawn(command: string, args: readonly string[] = [], options: SpawnOptions = {}): ChildProcess {
  if (String(command).toLowerCase() === electronExecutable) {
    // Harness rc.6 disconnects the Win32 folder picker's IPC channel after
    // its non-terminal `showing` notice. The compatibility worker keeps that
    // channel alive until `done`/`error`. Matching the package entry instead
    // of a runtime root makes this apply to both bundled and updated Harness.
    let workerArgs = args
    if (process.platform === 'win32' && isHarnessDirectoryPickerWorker(args[0])) {
      workerArgs = [directoryPickerWorkerShim, args[0], ...args.slice(1)]
    } else if (process.platform === 'win32' && isWindowsAclRunner(args[0])) {
      workerArgs = [windowsAclRunnerWorkerShim, args[0], ...args.slice(1)]
    }
    const childEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      ELECTRON_RUN_AS_NODE: '1',
    }
    // The Windows ACL runner is one of these Electron-as-Node children. It
    // must attach to the hidden console allocated above so its restricted
    // PowerShell child can share that console. Forcing NO_ATTACH_CONSOLE here
    // makes even `Write-Output` terminate with STATUS_DLL_INIT_FAILED.
    delete childEnvironment.ELECTRON_NO_ATTACH_CONSOLE
    return originalSpawn(command, workerArgs, {
      ...options,
      env: childEnvironment,
    })
  }
  return originalSpawn(command, args, options)
}
childProcess.spawn = desktopSpawn as typeof childProcess.spawn
syncBuiltinESMExports()

/**
 * The active DSH Profile is the ESM import base for loader entries, so Node's
 * legacy NODE_PATH cannot expose an app-bundled package to it. Keep the bridge
 * package outside ~/.dsh and resolve only its three public entry points here.
 * The desktop launch also maintains Profile node_modules links for DSH's
 * filesystem-based package inventory. This resolver keeps client entry points
 * stable even while a package manager is replacing those links.
 */
function registerDesktopBridgeResolver(): void {
  const roots = [
    [DESKTOP_BRIDGE_PACKAGE, process.env.DSH_DESKTOP_BRIDGE_ROOT],
    [DESKTOP_BROWSER_PACKAGE, process.env.DSH_DESKTOP_BROWSER_ROOT],
  ] as const
  const entries = new Map<string, string>()
  for (const [packageName, root] of roots) {
    if (root === undefined) continue
    if (!isAbsolute(root)) throw new Error(`${packageName} root must be absolute`)
    entries.set(packageName, join(root, 'lib', 'index.js'))
    entries.set(`${packageName}/client`, join(root, 'lib', 'client.js'))
    entries.set(`${packageName}/package.json`, join(root, 'package.json'))
  }
  if (entries.size === 0) return
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const entry = entries.get(specifier)
      if (entry !== undefined) return { url: pathToFileURL(entry).href, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
}

/**
 * Electron is used as the bundled Node executable for Harness. The mode flag
 * is only needed while Electron boots; leaving it in the environment breaks
 * native openers when the selected editor is itself an Electron application.
 */
async function bootstrap(): Promise<void> {
  const harnessEntry = process.argv[2]
  if (harnessEntry === undefined) throw new Error('Harness entry path was not provided')

  const harnessArgs = process.argv.slice(3)
  ensureHiddenHarnessConsole(harnessEntry)
  registerDesktopBridgeResolver()
  registerDfySessionFormatCompatibility()
  delete process.env.ELECTRON_RUN_AS_NODE
  delete process.env.ELECTRON_NO_ATTACH_CONSOLE
  process.argv = [process.execPath, harnessEntry, ...harnessArgs]
  const cli = await import(pathToFileURL(harnessEntry).href)
  // Newer DSH entries only auto-run when import.meta.main is true. Older
  // entries run during import and do not export runCli, so never run them twice.
  if (typeof cli.runCli === 'function') await cli.runCli()
}

void bootstrap()
