import { access, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { c as createTar } from 'tar'
import { describe, expect, it, vi } from 'vitest'
import {
  bundledArchiveProgress,
  HarnessRuntimeManager,
  pnpmInstallProgress,
  repairWindowsPnpmArchiveLinks,
  RUNTIME_PREPARATION_PROGRESS_EVENT,
  runtimeCommandErrorDetail,
} from '../src/main/harness-runtime.js'

async function writeRuntimeFixture(root: string, version: string): Promise<void> {
  const dshRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(dshRoot, 'lib'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pnpm', 'bin'), { recursive: true })
  await writeFile(join(dshRoot, 'package.json'), JSON.stringify({ version }))
  await writeFile(join(dshRoot, 'lib', 'bin.js'), 'export {}\n')
  await writeFile(join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '#!/usr/bin/env node\n')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('bundled Harness archive progress', () => {
  it('reports compressed bytes while reserving 100% for validation and activation', () => {
    expect(bundledArchiveProgress(0, 1_000)).toBe(0)
    expect(bundledArchiveProgress(425, 1_000)).toBe(42)
    expect(bundledArchiveProgress(1_000, 1_000)).toBe(99)
    expect(bundledArchiveProgress(2_000, 1_000)).toBe(99)
  })

  it('handles invalid byte totals safely', () => {
    expect(bundledArchiveProgress(100, 0)).toBe(0)
    expect(bundledArchiveProgress(Number.NaN, 1_000)).toBe(0)
  })

  it('streams a bundled archive and emits progress through final activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-progress-'))
    try {
      const source = join(root, 'source')
      const dshRoot = join(source, 'node_modules', '@deepseek-ai', 'dsh')
      await mkdir(join(dshRoot, 'lib'), { recursive: true })
      await mkdir(join(source, 'node_modules', 'pnpm', 'bin'), { recursive: true })
      await writeFile(join(dshRoot, 'package.json'), JSON.stringify({ version: '0.1.0' }))
      await writeFile(join(dshRoot, 'lib', 'bin.js'), 'export {}\n')
      await writeFile(join(source, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), '#!/usr/bin/env node\n')

      const archivePath = join(root, 'runtime.tgz')
      await createTar({ cwd: source, file: archivePath, gzip: true }, ['.'])
      const bundledRoot = join(root, 'bundled')
      const manager = new HarnessRuntimeManager(
        join(root, 'user-data'),
        process.execPath,
        bundledRoot,
        archivePath,
      )
      const progress: number[] = []
      manager.on(RUNTIME_PREPARATION_PROGRESS_EVENT, (value: number) => progress.push(value))

      await manager.initialize()

      expect(progress[0]).toBe(0)
      expect(progress).toContain(99)
      expect(progress.at(-1)).toBe(100)
      await expect(access(join(bundledRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))
        .resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('managed Harness install progress', () => {
  it('maps pnpm package installation into the download stage', () => {
    const output = [
      'Packages: +500',
      'Progress: resolved 560, reused 0, downloaded 100, added 25',
      'Progress: resolved 560, reused 0, downloaded 300, added 250',
    ].join('\n')

    expect(pnpmInstallProgress(output)).toBe(49)
    expect(pnpmInstallProgress(`${output}\nProgress: resolved 560, reused 0, downloaded 500, added 500`)).toBe(80)
    expect(pnpmInstallProgress('Progress: resolved 10, added 2')).toBeUndefined()
  })

  it('removes pnpm progress noise from command errors', () => {
    const stdout = [
      '++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++',
      'Packages are copied from the content-addressable store to the virtual store.',
      'Content-addressable store is at: /tmp/package-store/v11',
      'Virtual store is at: node_modules/.pnpm',
      'Progress: resolved 1, reused 0, downloaded 0, added 0',
      'Packages: +500',
      'Progress: resolved 560, reused 400, downloaded 12, added 390',
    ].join('\r')
    const stderr = [
      '\u001B[31mERR_PNPM_META_FETCH_FAIL\u001B[39m GET https://registry.example/package',
      'request failed: socket hang up',
    ].join('\n')

    expect(runtimeCommandErrorDetail(stdout, stderr)).toBe([
      'ERR_PNPM_META_FETCH_FAIL GET https://registry.example/package',
      'request failed: socket hang up',
    ].join('\n'))
    expect(runtimeCommandErrorDetail(stdout, '')).toBe('命令异常退出，未返回具体错误；请重试。')
  })
})

describe('Windows bundled runtime links', () => {
  it.runIf(process.platform === 'win32')('repairs pnpm directory links as executable junctions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-links-'))
    try {
      const packageRoot = join(root, 'node_modules', '.pnpm', 'package', 'node_modules', 'package')
      const packageLink = join(root, 'node_modules', 'package')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'index.js'), 'export {}\n')
      await symlink(packageRoot, packageLink, 'junction')

      expect((await lstat(packageLink)).isSymbolicLink()).toBe(true)
      await expect(stat(packageLink)).resolves.toMatchObject({})

      expect(await repairWindowsPnpmArchiveLinks(root)).toBe(1)
      await expect(stat(packageLink)).resolves.toMatchObject({})
      await expect(readFile(join(packageLink, 'index.js'), 'utf8')).resolves.toBe('export {}\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Harness runtime storage cleanup', () => {
  it('keeps the current bundle and referenced updates while removing duplicates, stale bundles, and npm cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-cleanup-'))
    try {
      const userData = join(root, 'user-data')
      const runtimeRoot = join(userData, 'harness-runtime')
      const bundledRoot = join(runtimeRoot, 'bundled')
      const currentBundle = join(bundledRoot, 'desktop-0.1.0-rc.7')
      const oldBundle = join(bundledRoot, 'desktop-0.1.0')
      const versionsRoot = join(runtimeRoot, 'versions')
      const duplicateVersion = join(versionsRoot, '0.1.0-rc.7')
      const pendingVersion = join(versionsRoot, '0.2.0')
      const orphanedVersion = join(versionsRoot, '0.3.0')
      const npmCache = join(runtimeRoot, 'npm-cache')
      const packageStore = join(runtimeRoot, 'package-store')
      const stagingRoot = join(runtimeRoot, 'staging')

      await Promise.all([
        writeRuntimeFixture(currentBundle, '0.1.0-rc.7'),
        writeRuntimeFixture(oldBundle, '0.1.0-rc.6'),
        writeRuntimeFixture(duplicateVersion, '0.1.0-rc.7'),
        writeRuntimeFixture(pendingVersion, '0.2.0'),
        writeRuntimeFixture(orphanedVersion, '0.3.0'),
        mkdir(join(npmCache, '_cacache'), { recursive: true }),
        mkdir(join(packageStore, 'v11'), { recursive: true }),
        mkdir(join(stagingRoot, 'abandoned-install'), { recursive: true }),
      ])
      await writeFile(join(npmCache, '_cacache', 'content'), 'cached package')
      await writeFile(join(packageStore, 'v11', 'index.db'), 'cached package')
      await writeFile(join(stagingRoot, 'abandoned-install', 'package.json'), '{}')
      await writeFile(join(runtimeRoot, 'state.json'), `${JSON.stringify({
        schemaVersion: 1,
        activeVersion: '0.1.0-rc.7',
        pendingVersion: '0.2.0',
        badVersions: {
          '0.1.0-rc.6': { failedAt: '2026-08-01T00:00:00.000Z', reason: 'old failure' },
          '0.4.0': { failedAt: '2026-08-02T00:00:00.000Z', reason: 'future failure' },
        },
      }, null, 2)}\n`)

      const manager = new HarnessRuntimeManager(userData, process.execPath, currentBundle)
      await manager.initialize()

      expect(await pathExists(currentBundle)).toBe(true)
      expect(await pathExists(oldBundle)).toBe(false)
      expect(await pathExists(duplicateVersion)).toBe(false)
      expect(await pathExists(pendingVersion)).toBe(true)
      expect(await pathExists(orphanedVersion)).toBe(false)
      expect(await pathExists(npmCache)).toBe(false)
      expect(await pathExists(packageStore)).toBe(false)
      expect(await pathExists(stagingRoot)).toBe(false)

      const state = JSON.parse(await readFile(join(runtimeRoot, 'state.json'), 'utf8')) as {
        activeVersion?: string
        pendingVersion?: string
        badVersions: Record<string, unknown>
      }
      expect(state.activeVersion).toBeUndefined()
      expect(state.pendingVersion).toBe('0.2.0')
      expect(state.badVersions['0.1.0-rc.6']).toBeUndefined()
      expect(state.badVersions['0.4.0']).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Harness runtime update policy', () => {
  it('detects automatic updates without downloading until manually requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-update-policy-'))
    try {
      const userData = join(root, 'user-data')
      const bundledRoot = join(root, 'bundled')
      await writeRuntimeFixture(bundledRoot, '0.1.0-rc.8')
      const manager = new HarnessRuntimeManager(userData, process.execPath, bundledRoot)
      await manager.initialize()
      const installVersion = vi.fn(async () => undefined)
      ;(manager as unknown as { installVersion: typeof installVersion }).installVersion = installVersion
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          'dist-tags': {
            latest: '0.1.0-rc.9',
            next: '0.1.0-rc.9',
            alpha: '0.1.0-rc.8',
            preview: '0.1.0-rc.8',
          },
          versions: {
            '0.1.0-rc.7': {},
            '0.1.0-rc.8': {},
            '0.1.0-rc.9': {},
          },
          time: {
            '0.1.0-rc.7': '2026-08-17T00:00:00.000Z',
            '0.1.0-rc.8': '2026-08-18T00:00:00.000Z',
            '0.1.0-rc.9': '2026-08-19T00:00:00.000Z',
          },
        }),
      })))

      await manager.checkForUpdates({ download: false })

      expect(manager.updateState).toMatchObject({
        status: 'available',
        version: '0.1.0-rc.9',
        latestVersion: '0.1.0-rc.9',
        versions: [
          { version: '0.1.0-rc.9', publishedAt: '2026-08-19T00:00:00.000Z', distTags: ['latest', 'next'] },
          { version: '0.1.0-rc.8', publishedAt: '2026-08-18T00:00:00.000Z', distTags: ['alpha', 'preview'] },
          { version: '0.1.0-rc.7', publishedAt: '2026-08-17T00:00:00.000Z' },
        ],
        message: '发现新版本，可选择版本下载安装',
      })
      expect(installVersion).not.toHaveBeenCalled()
      let state = JSON.parse(await readFile(join(userData, 'harness-runtime', 'state.json'), 'utf8')) as {
        pendingVersion?: string
      }
      expect(state.pendingVersion).toBeUndefined()

      await manager.checkForUpdates()

      expect(installVersion).toHaveBeenCalledWith('0.1.0-rc.9', expect.any(Function))
      expect(manager.updateState).toMatchObject({ status: 'ready', version: '0.1.0-rc.9' })
      await manager.markHealthy({
        version: '0.1.0-rc.9',
        entryPath: '/managed/dsh/lib/bin.js',
        source: 'managed',
        pending: true,
      })
      expect(manager.updateState).toMatchObject({
        status: 'current',
        version: '0.1.0-rc.9',
        message: '当前正在使用这个版本',
      })
      state = JSON.parse(await readFile(join(userData, 'harness-runtime', 'state.json'), 'utf8')) as {
        pendingVersion?: string
      }
      expect(state.pendingVersion).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps an explicitly selected older managed version active across later launches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-version-selection-'))
    try {
      const userData = join(root, 'user-data')
      const bundledRoot = join(root, 'bundled')
      await writeRuntimeFixture(bundledRoot, '0.1.0-rc.8')
      const manager = new HarnessRuntimeManager(userData, process.execPath, bundledRoot)
      await manager.initialize()
      ;(manager as unknown as { installVersion: (version: string, onProgress: (progress: number, message: string) => void) => Promise<void> }).installVersion = async (version, onProgress) => {
        onProgress(82, '下载完成，正在检查运行时文件…')
        await writeRuntimeFixture(join(userData, 'harness-runtime', 'versions', version), version)
      }
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({
          'dist-tags': { latest: '0.1.0-rc.9' },
          versions: {
            '0.1.0-rc.7': {},
            '0.1.0-rc.8': {},
            '0.1.0-rc.9': {},
          },
        }),
      })))

      await manager.checkForUpdates({ download: false })
      await manager.installHarnessVersion('0.1.0-rc.7')

      expect(manager.updateState).toMatchObject({
        status: 'ready',
        version: '0.1.0-rc.7',
        progress: 100,
      })

      const restarted = new HarnessRuntimeManager(userData, process.execPath, bundledRoot)
      await restarted.initialize()
      let candidates = await restarted.launchCandidates()
      expect(candidates[0]).toMatchObject({ version: '0.1.0-rc.7', source: 'managed', pending: true })
      await restarted.markHealthy(candidates[0])

      const launchedAgain = new HarnessRuntimeManager(userData, process.execPath, bundledRoot)
      await launchedAgain.initialize()
      candidates = await launchedAgain.launchCandidates()
      expect(candidates[0]).toMatchObject({ version: '0.1.0-rc.7', source: 'managed', pending: false })
    } finally {
      vi.unstubAllGlobals()
      await rm(root, { recursive: true, force: true })
    }
  })
})
