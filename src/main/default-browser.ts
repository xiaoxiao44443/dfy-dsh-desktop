import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { normalizeBrowserPageUrl, normalizeLocalHtmlUrl } from '../shared/browser-address.js'

interface BrowserOpenerDependencies {
  platform: NodeJS.Platform
  openExternal(url: string): Promise<void>
  applicationPathForProtocol(url: string): Promise<string>
  isFile(path: string): Promise<boolean>
  run(command: string, args: string[], waitForExit: boolean): Promise<string>
}

const executeFile = promisify(execFile)

async function run(command: string, args: string[], waitForExit: boolean): Promise<string> {
  if (waitForExit) {
    const result = await executeFile(command, args, {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000,
    })
    return result.stdout
  }
  // A browser can keep running after this app exits. Only wait for its process to start.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true, stdio: 'ignore', windowsHide: true, shell: false,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
  return ''
}

/** Resolve the HTTPS handler, so an HTML file association with an editor is irrelevant. */
export function createDefaultBrowserOpener(overrides: Partial<BrowserOpenerDependencies> = {}): (url: string) => Promise<void> {
  const dependencies: BrowserOpenerDependencies = {
    platform: process.platform,
    openExternal: (url) => shell.openExternal(url),
    applicationPathForProtocol: async (url) => (await app.getApplicationInfoForProtocol(url)).path,
    isFile: async (path) => (await stat(path)).isFile(),
    run,
    ...overrides,
  }
  return async (value) => {
    const url = normalizeBrowserPageUrl(value)
    if (url === undefined) throw new Error('只支持 HTTP、HTTPS 和本地 HTML 网页。')
    if (normalizeLocalHtmlUrl(url) === undefined) {
      await dependencies.openExternal(url)
      return
    }
    try {
      const path = fileURLToPath(url, { windows: dependencies.platform === 'win32' })
      if (!await dependencies.isFile(path)) throw new Error('本地网页不是普通文件。')

      if (dependencies.platform === 'win32' || dependencies.platform === 'darwin') {
        const browserPath = await dependencies.applicationPathForProtocol('https://')
        if (dependencies.platform === 'win32') {
          if (!win32.isAbsolute(browserPath) || !/\.exe$/iu.test(browserPath)) {
            throw new Error('无法确定系统默认浏览器的可执行文件。')
          }
          await dependencies.run(browserPath, [url], false)
        } else {
          if (!posix.isAbsolute(browserPath) || !/\.app\/?$/iu.test(browserPath)) {
            throw new Error('无法确定系统默认浏览器的应用路径。')
          }
          await dependencies.run('/usr/bin/open', ['-a', browserPath, url], true)
        }
      } else if (dependencies.platform === 'linux') {
        const desktopId = (await dependencies.run('xdg-settings', ['get', 'default-web-browser'], true)).trim()
        if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.desktop$/u.test(desktopId)) {
          throw new Error('无法确定系统默认浏览器的桌面应用。')
        }
        await dependencies.run('gtk-launch', [desktopId, url], true)
      } else {
        throw new Error('当前平台不支持在默认浏览器中打开本地网页。')
      }
    } catch (error) {
      throw new Error(`无法在系统默认浏览器中打开本地网页：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
}

export const openInDefaultBrowser = createDefaultBrowserOpener()
