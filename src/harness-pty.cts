import { registerHooks } from 'node:module'

interface PtyOptions {
  env?: NodeJS.ProcessEnv
  [key: string]: unknown
}
interface PtyModule {
  spawn(file: string, args?: string[] | string, options?: PtyOptions): unknown
}

const wrapped = new WeakSet<object>()

/** Fail visibly for the unsupported Electron ACL-in-ConPTY path; never weaken its sandbox. */
export function wrapDesktopPty(pty: PtyModule): void {
  if (wrapped.has(pty)) return
  const spawn = pty.spawn
  if (typeof spawn !== 'function') throw new Error('Unsupported node-pty spawn export')
  wrapped.add(pty)
  pty.spawn = function (file, args, options) {
    const entry = Array.isArray(args) ? args[0]?.replaceAll('\\', '/').toLowerCase() : undefined
    if (file.toLowerCase() === process.execPath.toLowerCase()
      && entry?.includes('/@deepseek-ai/dsh-sandbox-windows-acl/')
      && /\/runner\.(?:js|ts)$/u.test(entry)) {
      throw new Error('当前桌面端暂不支持 Windows 沙箱下的 Agent 可见终端。请使用普通命令工具，或手动打开内置终端。')
    }
    return spawn.call(this, file, args, options)
  }
}

/** Keep native PTY loading lazy and adapt each actual installed module instance. */
export function registerDesktopPtyCompatibility(): void {
  if (process.platform !== 'win32' || process.versions.electron === undefined) return
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (!url.startsWith('file:') || !url.endsWith('/node-pty/lib/index.js') || loaded.source == null) return loaded
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source as Uint8Array).toString('utf8')
      return { ...loaded, source: `${source}\nrequire(${JSON.stringify(__filename)}).wrapDesktopPty(module.exports);\n` }
    },
  })
}
