import { access, lstat, mkdir, readFile, realpath, symlink, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { HarnessDesktopBridgeLaunch } from './harness-desktop-bridge.js'

type DesktopPluginPaths = Pick<HarnessDesktopBridgeLaunch, 'profilePath' | 'pluginRootPath' | 'browserPluginRootPath'>
const pendingRepairs = new Map<string, Promise<void>>()

/** A desktop/Profile layout failure must not blacklist the selected DSH runtime. */
export class DesktopPluginLinkError extends Error {
  constructor(cause: unknown) {
    super(`桌面内置插件链接准备失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'DesktopPluginLinkError'
  }
}

/**
 * Expose the app-owned packages to DSH's filesystem-based package inventory as
 * well as the bootstrap import resolver. Keep them out of Profile dependencies:
 * the desktop app owns their version and lifecycle, not the package manager.
 */
export async function ensureDesktopPluginLinks(paths: DesktopPluginPaths): Promise<void> {
  const key = resolve(paths.profilePath)
  // Plugin commands and a restart can finish together. Serialize only repairs
  // for the same Profile so they cannot unlink each other's replacement link.
  const previous = pendingRepairs.get(key) ?? Promise.resolve()
  const repair = previous.catch(() => undefined).then(() => repairLinks(paths))
  pendingRepairs.set(key, repair)
  try {
    await repair
  } catch (error) {
    throw new DesktopPluginLinkError(error)
  } finally {
    if (pendingRepairs.get(key) === repair) pendingRepairs.delete(key)
  }
}

async function repairLinks(paths: DesktopPluginPaths): Promise<void> {
  if (!isAbsolute(paths.profilePath)) throw new Error('Desktop Profile path must be absolute')
  const packages = [
    { name: 'dsh-desktop-bridge', root: paths.pluginRootPath },
    { name: 'dsh-desktop-browser', root: paths.browserPluginRootPath },
  ]
  const plans: Array<{ path: string; target: string; replace: boolean }> = []
  // Validate both source packages and destinations before changing either link.
  for (const pkg of packages) {
    if (!isAbsolute(pkg.root)) throw new Error(`${pkg.name} root must be absolute`)
    const target = await realpath(pkg.root)
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (manifest.name !== pkg.name || typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
      throw new Error(`${pkg.name} 的安装包缺少有效的包名或版本：${target}`)
    }
    await access(join(target, 'lib', 'index.js'))
    await access(join(target, 'lib', 'client.js'))
    const path = join(paths.profilePath, 'node_modules', pkg.name)
    const existing = await lstat(path).catch((error: unknown) => {
      if (isMissing(error)) return undefined
      throw error
    })
    if (existing !== undefined) {
      if (!existing.isSymbolicLink()) {
        throw new Error(`“${path}”已存在同名文件或目录，未覆盖。请检查该路径后重试。`)
      }
      const current = await realpath(path).catch((error: unknown) => {
        if (isMissing(error)) return undefined
        throw error
      })
      if (current === target) continue
    }
    plans.push({ path, target, replace: existing !== undefined })
  }
  if (plans.length === 0) return
  await mkdir(join(paths.profilePath, 'node_modules'), { recursive: true })
  for (const plan of plans) {
    // Only the links at the two reserved desktop package names are replaced;
    // unlink never removes the old target directory or its contents.
    if (plan.replace) await unlink(plan.path)
    await symlink(plan.target, plan.path, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}
