import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'

interface KoffiLibrary {
  func(declaration: string): (...args: unknown[]) => unknown
}

interface KoffiModule {
  load(name: string): KoffiLibrary
}

const ATTACH_PARENT_PROCESS = 0xffffffff
const ERROR_ACCESS_DENIED = 5

function attachToHarnessConsole(runnerEntry: string): void {
  const requireFromRunner = createRequire(runnerEntry)
  const koffi = requireFromRunner('koffi') as KoffiModule
  const kernel32 = koffi.load('kernel32.dll')
  const getConsoleWindow = kernel32.func('void * __stdcall GetConsoleWindow()') as () => unknown
  const attachConsole = kernel32.func('bool __stdcall AttachConsole(uint32 processId)') as (processId: number) => boolean
  const freeConsole = kernel32.func('bool __stdcall FreeConsole()') as () => boolean
  const getLastError = kernel32.func('uint32 __stdcall GetLastError()') as () => number

  if (getConsoleWindow()) return
  if (attachConsole(ATTACH_PARENT_PROCESS)) return

  // A windowless ConPTY still counts as an attached console. Detach it before
  // retrying so the runner always joins the real hidden console owned by the
  // Harness process.
  const firstError = getLastError()
  if (firstError === ERROR_ACCESS_DENIED) {
    freeConsole()
    if (attachConsole(ATTACH_PARENT_PROCESS)) return
  }
  throw new Error(`AttachConsole failed (Win32 ${String(getLastError())})`)
}

// Loaded with --require so DSH retains its original entry point, arguments,
// import.meta.main and IPC channel. Both ordinary and ACL runners need a real
// console to prevent their native children from allocating a visible one.
if (process.platform === 'win32') {
  const runnerEntry = process.argv[1]
  if (runnerEntry === undefined || !isAbsolute(runnerEntry)) {
    throw new Error('Windows runner entry path must be absolute')
  }
  attachToHarnessConsole(runnerEntry)
}
