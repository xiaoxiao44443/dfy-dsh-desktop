import { access, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Dirent } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import { valid } from 'semver'
import { DFY_PLUGINS, DFY_PLUGIN_CATALOG_URL, includedDfyPlugins, isDfyRegistrySource, normalizeDfySelection, parseDfyPluginCatalog } from '../shared/dfy-plugins.js'
import type {
  DfyPluginCatalog,
  DfyPluginDefinition,
  DfyPluginMutationRequest,
  ManagedPluginEntry,
  PluginActivationRequest,
  PluginInstallRequest,
  PluginInventory,
  PluginMutationResult,
  PluginProfileInventory,
  PluginRemoveRequest,
  PluginSourceType,
  PluginUpdateRequest,
} from '../shared/contracts.js'
import type { HarnessCommandResult } from './harness-process.js'
import { migrateLegacyPluginState } from './profile-upgrade.js'
import type { PluginActivationOutcome } from '../shared/contracts.js'

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
    }
  }
}

interface PackageMetadata {
  name?: string
  version?: string
  description?: string
  bundle: boolean
  includedPlugins?: ManagedPluginEntry['includedPlugins']
}

export interface PluginManagementActions {
  getWindow(): BrowserWindow | undefined
  runPnpm(profile: string, args: string[]): Promise<HarnessCommandResult>
  setBundleEnabled?(request: PluginActivationRequest): Promise<PluginActivationOutcome | undefined>
  fetch?: typeof fetch
  catalogFile?: string
}

export class PluginManagementService {
  private commandRunning = false
  private dfyPlugins: DfyPluginDefinition[] = DFY_PLUGINS
  private hasFetchedDfyDirectory = false
  private dfyCatalogRequest: Promise<DfyPluginCatalog> | undefined

  constructor(
    private readonly harnessHome: string,
    private readonly actions: PluginManagementActions,
  ) {}

  async getInventory(): Promise<PluginInventory> {
    const profilesRoot = join(this.harnessHome, 'profiles')
    let directories: Dirent<string>[]
    try {
      directories = await readdir(profilesRoot, { withFileTypes: true })
    } catch (error) {
      if (isMissingFileError(error)) return { profiles: [], scannedAt: new Date().toISOString() }
      throw error
    }

    const profileNames = (await Promise.all(directories
      .filter((entry) => entry.name !== 'node_modules' && (entry.isDirectory() || entry.isSymbolicLink()))
      .map(async (entry) => await hasProfileManifest(join(profilesRoot, entry.name)) ? entry.name : undefined)))
      .filter((name): name is string => name !== undefined)
      .sort((left, right) => left === 'web' ? -1 : right === 'web' ? 1 : left.localeCompare(right))
    const profiles = await Promise.all(profileNames.map((name) => this.readProfile(name)))
    return { profiles, scannedAt: new Date().toISOString() }
  }

  async chooseLocalDirectory(): Promise<string | undefined> {
    const owner = this.actions.getWindow()
    if (owner === undefined || owner.isDestroyed()) return undefined
    const result = await dialog.showOpenDialog(owner, {
      title: '选择本地 DSH 插件目录',
      properties: ['openDirectory'],
    })
    if (result.canceled) return undefined
    return result.filePaths[0]
  }

  getDfyCatalog(): Promise<DfyPluginCatalog> {
    if (this.dfyCatalogRequest === undefined) {
      this.dfyCatalogRequest = this.fetchDfyCatalog().finally(() => { this.dfyCatalogRequest = undefined })
    }
    return this.dfyCatalogRequest
  }

  getDfyRepositoryUrl(packageName: unknown): string {
    const entry = this.dfyPlugins.find((plugin) => plugin.name === packageName)
    if (entry === undefined) throw new Error('插件不在当前 DFY 目录中，请刷新列表。')
    return entry.repository
  }

  private async fetchDfyCatalog(): Promise<DfyPluginCatalog> {
    const errors: string[] = []
    try {
      let directory: string
      if (this.actions.catalogFile !== undefined) {
        directory = await readFile(this.actions.catalogFile, 'utf8')
      } else {
        const response = await (this.actions.fetch ?? fetch)(DFY_PLUGIN_CATALOG_URL, { signal: AbortSignal.timeout(7_000), cache: 'no-cache' })
        if (!response.ok) throw new Error('Catalog request failed')
        directory = await response.text()
      }
      if (directory.length > 128_000) throw new Error('Catalog is too large')
      this.dfyPlugins = parseDfyPluginCatalog(JSON.parse(directory))
      this.hasFetchedDfyDirectory = true
    } catch {
      errors.push(this.hasFetchedDfyDirectory ? '插件目录暂时无法更新，正在显示上次读取的列表。' : '插件目录暂时无法获取，正在显示内置备用列表。')
    }
    const plugins = this.dfyPlugins
    const releases = await Promise.all(plugins.map(async ({ name }) => {
      try {
        const response = await (this.actions.fetch ?? fetch)(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
          signal: AbortSignal.timeout(7_000),
        })
        if (!response.ok) throw new Error('Registry request failed')
        const metadata = await response.json() as { name?: unknown; version?: unknown }
        if (metadata.name !== name || typeof metadata.version !== 'string' || valid(metadata.version) === null) {
          throw new Error('Invalid package metadata')
        }
        return { name, version: metadata.version }
      } catch {
        return { name }
      }
    }))
    const failed = releases.filter((entry) => entry.version === undefined).length
    if (failed > 0) errors.push(`${failed} 个插件的最新版本暂时无法获取，可重试。`)
    return { plugins, releases, ...(errors.length > 0 ? { error: errors.join(' ') } : {}) }
  }

  async mutateDfyPlugins(request: DfyPluginMutationRequest): Promise<PluginMutationResult> {
    if (request === null || typeof request !== 'object') throw new Error('DFY 插件操作无效。')
    const profile = validateProfileName(request.profile)
    if (request.action !== 'install' && request.action !== 'update') throw new Error('DFY 插件操作无效。')
    const allowed = new Set(this.dfyPlugins.map(({ name }) => name))
    if (!Array.isArray(request.packageNames) || request.packageNames.length === 0
      || request.packageNames.length > allowed.size || request.packageNames.some((name) => !allowed.has(name))) {
      throw new Error('请选择列表中的 DFY 插件。')
    }
    const names = normalizeDfySelection(request.packageNames, this.dfyPlugins)
    const args = request.action === 'install'
      ? ['add', ...names.map((name) => `${name}@latest`), '--registry=https://registry.npmjs.org']
      : ['update', ...names, '--latest', '--registry=https://registry.npmjs.org']
    return await this.run(profile, args, async (before) => {
      const inventory = await this.readProfile(profile)
      const included = includedDfyPlugins(inventory.plugins)
      for (const name of names) {
        if (request.action === 'install') {
          const owner = included.get(name)
          if (owner !== undefined) throw new Error(`“${name}”已由“${owner.bundle.name}”提供，请管理或更新组合包。`)
          this.assertBundleCanInstall(this.dfyPlugins.find(entry => entry.name === name)?.includes, before)
        }
        const source = before.dependencies?.[name]
        if (source !== undefined && !isDfyRegistrySource(source)) {
          throw new Error(`“${name}”使用本地、Git 或其他来源，请在“已安装”中管理。`)
        }
        if (request.action === 'update' && source === undefined) throw new Error(`“${name}”尚未安装。`)
        if (request.action === 'install' && source !== undefined
          && await this.readPackageMetadata(join(this.harnessHome, 'profiles', profile), name, source) !== undefined) {
          throw new Error(`“${name}”已经安装，请使用更新操作。`)
        }
      }
    })
  }

  async install(request: PluginInstallRequest): Promise<PluginMutationResult> {
    const profile = validateProfileName(request.profile)
    const source = request.source.trim()
    if (source.length === 0) throw new Error('请填写 npm 包名、Git 仓库地址或本地插件目录。')
    if (source.length > 2_000 || /[\r\n\0]/u.test(source)) throw new Error('插件来源无效。')
    return await this.run(profile, ['add', source], async (before) => {
      const profileDir = join(this.harnessHome, 'profiles', profile)
      const path = resolveLocalSource(profileDir, source)
      const metadata = path === undefined ? undefined : await readMetadataFile(join(path, 'package.json'))
      const name = metadata?.name ?? source.match(/^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:@[^\s]+)?$/iu)?.[1]
      if (name === undefined) return
      const owner = includedDfyPlugins((await this.readProfile(profile)).plugins).get(name)
      if (owner !== undefined) throw new Error(`“${name}”已由“${owner.bundle.name}”提供，请管理或更新组合包。`)
      this.assertBundleCanInstall(metadata?.includedPlugins?.map(member => member.name)
        ?? this.dfyPlugins.find(entry => entry.name === name)?.includes, before)
    })
  }

  private assertBundleCanInstall(members: string[] | undefined, manifest: ProfileManifest): void {
    const existing = members?.filter(name => manifest.dependencies?.[name] !== undefined) ?? []
    if (existing.length > 0) throw new Error(`已单独安装 ${existing.length} 个组件（${existing.join('、')}）。请先迁移到组合包，保留配置和停用状态后移除这些单独安装项，避免重复加载。`)
  }

  async remove(request: PluginRemoveRequest): Promise<PluginMutationResult> {
    const profile = validateProfileName(request.profile)
    const packageName = request.packageName.trim()
    if (!PACKAGE_NAME_PATTERN.test(packageName)) throw new Error('插件包名无效。')
    const manifest = await this.readManifest(join(this.harnessHome, 'profiles', profile, 'package.json'))
    if (manifest.dependencies?.[packageName] === undefined) {
      throw new Error(`“${packageName}”不是 ${profile} Profile 中可移除的外部插件。`)
    }
    return await this.run(profile, ['remove', packageName])
  }

  async update(request: PluginUpdateRequest): Promise<PluginMutationResult> {
    const profile = validateProfileName(request.profile)
    const packageName = request.packageName.trim()
    if (!PACKAGE_NAME_PATTERN.test(packageName)) throw new Error('插件包名无效。')
    const manifest = await this.readManifest(join(this.harnessHome, 'profiles', profile, 'package.json'))
    const dependencySpec = manifest.dependencies?.[packageName]
    if (dependencySpec === undefined) {
      throw new Error(`“${packageName}”不是 ${profile} Profile 中可更新的外部插件。`)
    }
    const sourceType = classifyPluginSource(dependencySpec)
    if (sourceType !== 'git' && sourceType !== 'npm') {
      throw new Error(`“${packageName}”使用${sourceType === 'local' ? '本地 Link' : '不可更新的'}来源，无需在线更新。`)
    }
    return await this.run(profile, ['update', packageName])
  }

  async setActive(request: PluginActivationRequest): Promise<PluginMutationResult> {
    const profile = validateProfileName(request.profile)
    const packageName = request.packageName.trim()
    if (!PACKAGE_NAME_PATTERN.test(packageName)) throw new Error('插件包名无效。')
    if (typeof request.active !== 'boolean') throw new Error('插件启用状态无效。')
    if (this.commandRunning) throw new Error('已有插件操作正在运行。')

    this.commandRunning = true
    try {
      const profileDir = join(this.harnessHome, 'profiles', profile)
      await migrateLegacyPluginState(profileDir)
      const manifestPath = join(profileDir, 'package.json')
      const manifest = await this.readManifest(manifestPath)
      const dependencySpec = manifest.dependencies?.[packageName]
      if (dependencySpec === undefined) {
        throw new Error(`“${packageName}”不是 ${profile} Profile 中可管理的外部插件。`)
      }

      const bundles = validStringList(manifest.dsh?.profile?.bundles)
      const currentlyActive = bundles.includes(packageName)
      if (request.active) {
        const metadata = await this.readPackageMetadata(profileDir, packageName, dependencySpec)
        if (metadata === undefined) throw new Error(`“${packageName}”的插件来源已失效，无法启用。`)
        if (!metadata.bundle) throw new Error(`“${packageName}”没有声明 DSH bundle，无法作为插件启用。`)
      }

      // The running Profile uses the same manager, lock, reload and diagnostics
      // as DSH's own Plugins page. Never silently fall back after a live error.
      const outcome = await this.actions.setBundleEnabled?.(request)
      if (outcome !== undefined) {
        return {
          inventory: await this.getInventory(),
          command: `pluginManager.setBundleEnabled(${JSON.stringify(packageName)}, ${request.active})`,
          output: activationMessage(packageName, request.active, outcome),
          exitCode: outcome.application === 'failed' || outcome.application === 'cancelled' ? 1 : 0,
          restartRequired: outcome.application === 'restart-required',
        }
      }

      // An inactive Profile has no live manager. Its durable switch is still
      // the official ordered selection: disabling retains the dependency and
      // re-enabling appends the bundle, exactly as PluginManager does.
      if (currentlyActive !== request.active) {
        const nextBundles = request.active
          ? [...bundles, packageName]
          : bundles.filter(name => name !== packageName)
        manifest.dsh = {
          ...manifest.dsh,
          profile: { ...manifest.dsh?.profile, bundles: nextBundles },
        }
        await this.writeManifest(manifestPath, manifest)
      }

      return {
        inventory: await this.getInventory(),
        command: `Profile ${formatDisplayArgument(profile)}: ${request.active ? 'enable' : 'disable'} ${formatDisplayArgument(packageName)}`,
        output: currentlyActive === request.active
          ? `“${packageName}”已经${request.active ? '启用' : '停用'}。`
          : `已${request.active ? '启用' : '停用'}“${packageName}”；下次启动此 Profile 时生效。`,
        exitCode: 0,
        restartRequired: currentlyActive !== request.active,
      }
    } finally {
      this.commandRunning = false
    }
  }

  private async readProfile(name: string): Promise<PluginProfileInventory> {
    const profileDir = join(this.harnessHome, 'profiles', name)
    try {
      await migrateLegacyPluginState(profileDir)
      const manifest = await this.readManifest(join(profileDir, 'package.json'))
      const dependencies = manifest.dependencies ?? {}
      const bundles = manifest.dsh?.profile?.bundles?.filter((entry): entry is string => typeof entry === 'string') ?? []
      const dependencyOnly = Object.keys(dependencies).filter((entry) => !bundles.includes(entry)).sort()
      const names = [...new Set([...bundles, ...dependencyOnly])]
      const plugins = await Promise.all(names.map((packageName) => this.readPlugin(
        profileDir,
        packageName,
        dependencies[packageName],
        bundles.includes(packageName),
      )))
      return { name, plugins }
    } catch (error) {
      return {
        name,
        plugins: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async readPlugin(
    profileDir: string,
    packageName: string,
    dependencySpec: string | undefined,
    active: boolean,
  ): Promise<ManagedPluginEntry> {
    const sourceType = classifyPluginSource(dependencySpec)
    const metadata = await this.readPackageMetadata(profileDir, packageName, dependencySpec)
    return {
      name: packageName,
      ...(metadata?.version === undefined ? {} : { version: metadata.version }),
      ...(metadata?.description === undefined ? {} : { description: metadata.description }),
      sourceType,
      source: dependencySpec ?? '随 Harness 提供',
      active,
      toggleable: dependencySpec !== undefined && (metadata?.bundle === true || active),
      removable: dependencySpec !== undefined,
      status: dependencySpec !== undefined && metadata === undefined ? 'missing' : 'ready',
      ...(metadata?.includedPlugins === undefined ? {} : { includedPlugins: metadata.includedPlugins }),
    }
  }

  private async readPackageMetadata(
    profileDir: string,
    packageName: string,
    dependencySpec: string | undefined,
  ): Promise<PackageMetadata | undefined> {
    if (PACKAGE_NAME_PATTERN.test(packageName)) {
      const installed = await readMetadataFile(join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json'))
      if (installed !== undefined) return installed
    }
    const localPath = resolveLocalSource(profileDir, dependencySpec)
    if (localPath === undefined) return undefined
    return await readMetadataFile(join(localPath, 'package.json'))
  }

  private async readManifest(path: string): Promise<ProfileManifest> {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Profile 配置不是有效对象：${path}`)
    }
    return parsed as ProfileManifest
  }

  private async writeManifest(path: string, manifest: ProfileManifest): Promise<void> {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  private async reconcileInstalledBundles(profile: string, before: ProfileManifest): Promise<void> {
    const profileDir = join(this.harnessHome, 'profiles', profile)
    const path = join(profileDir, 'package.json')
    const manifest = await this.readManifest(path)
    const dependencies = manifest.dependencies ?? {}
    const dependencyNames = new Set(Object.keys(dependencies))
    const previousDependencies = new Set(Object.keys(before.dependencies ?? {}))
    const bundleDependencies = new Set<string>()
    await Promise.all(Object.entries(dependencies).map(async ([packageName, dependencySpec]) => {
      const metadata = await this.readPackageMetadata(profileDir, packageName, dependencySpec)
      if (metadata?.bundle === true) bundleDependencies.add(packageName)
    }))

    const bundles = validStringList(manifest.dsh?.profile?.bundles)
    const nextBundles = bundles.filter((packageName) => {
      if (dependencyNames.has(packageName)) return bundleDependencies.has(packageName)
      return !previousDependencies.has(packageName)
    })
    for (const packageName of Object.keys(dependencies)) {
      if (bundleDependencies.has(packageName)
        && !previousDependencies.has(packageName)
        && !nextBundles.includes(packageName)) nextBundles.push(packageName)
    }
    if (sameStrings(nextBundles, bundles)) return
    manifest.dsh = {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: nextBundles },
    }
    await this.writeManifest(path, manifest)
  }

  private async run(profile: string, args: string[], validate?: (before: ProfileManifest) => Promise<void>): Promise<PluginMutationResult> {
    if (this.commandRunning) throw new Error('已有插件操作正在运行。')
    this.commandRunning = true
    try {
      await migrateLegacyPluginState(join(this.harnessHome, 'profiles', profile))
      const before = await this.readManifest(join(this.harnessHome, 'profiles', profile, 'package.json'))
      await validate?.(before)
      const result = await this.actions.runPnpm(profile, args)
      if (result.exitCode === 0) {
        await this.reconcileInstalledBundles(profile, before)
      }
      return {
        inventory: await this.getInventory(),
        command: `pnpm ${args.map(formatDisplayArgument).join(' ')} (Profile ${formatDisplayArgument(profile)})`,
        output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n') || '(没有输出)',
        exitCode: result.exitCode,
      }
    } finally {
      this.commandRunning = false
    }
  }
}

export function classifyPluginSource(spec: string | undefined): PluginSourceType {
  if (spec === undefined) return 'builtin'
  if (/^(?:link|file):/iu.test(spec) || isAbsolute(spec)) return 'local'
  if (/^workspace:/iu.test(spec)) return 'workspace'
  if (/^(?:git(?:\+[^:]+)?|github|gitlab|bitbucket):/iu.test(spec)
    || /^git@[^:]+:/iu.test(spec)
    || /^(?:https?|ssh):\/\//iu.test(spec) && /(?:github|gitlab|bitbucket|\.git(?:#|$))/iu.test(spec)
    || /^[^/@\s]+\/[^/\s]+(?:#.*)?$/u.test(spec)) return 'git'
  if (spec.length > 0) return 'npm'
  return 'unknown'
}

function resolveLocalSource(profileDir: string, spec: string | undefined): string | undefined {
  if (spec === undefined) return undefined
  const match = /^(?:link|file):(.*)$/iu.exec(spec)
  const candidate = match?.[1] ?? (isAbsolute(spec) ? spec : undefined)
  if (candidate === undefined || candidate.length === 0) return undefined
  return isAbsolute(candidate) ? candidate : resolve(profileDir, candidate)
}

async function readMetadataFile(path: string, readMembers = true): Promise<PackageMetadata | undefined> {
  try {
    await access(path)
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const dsh = isRecord(parsed.dsh) ? parsed.dsh : undefined
    const bundle = dsh !== undefined && isRecord(dsh.bundle) ? dsh.bundle : undefined
    const isBundle = (typeof bundle?.patch === 'string' && bundle.patch.length > 0)
      || (Array.isArray(bundle?.patch) && bundle.patch.length > 0 && bundle.patch.every(file => typeof file === 'string' && file.length > 0))
    const dfy = isRecord(parsed.dfy) ? parsed.dfy : undefined
    const dependencies = isRecord(parsed.dependencies) ? parsed.dependencies : {}
    const names = readMembers && isBundle ? [...new Set(validStringList(dfy?.includes))].filter(name => name !== parsed.name
      && /^@dfy-plugins\/[a-z0-9][a-z0-9._-]*$/u.test(name) && typeof dependencies[name] === 'string').slice(0, 100) : []
    const require = names.length === 0 ? undefined : createRequire(await realpath(path))
    const includedPlugins = await Promise.all(names.map(async name => {
      let member: PackageMetadata | undefined
      try { member = await readMetadataFile(require!.resolve(`${name}/package.json`), false) } catch {}
      return { name, ...(member?.version === undefined ? {} : { version: member.version }), status: member?.bundle === true ? 'ready' as const : 'missing' as const }
    }))
    return {
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
      ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
      bundle: isBundle,
      ...(includedPlugins.length === 0 ? {} : { includedPlugins }),
    }
  } catch {
    return undefined
  }
}

function activationMessage(name: string, enabled: boolean, result: PluginActivationOutcome): string {
  const action = enabled ? '启用' : '停用'
  const messages = {
    applied: `已${action}“${name}”，已通过 DSH 官方插件管理器生效。`,
    'restart-required': `已保存“${name}”的${action}状态；此 Profile 未启用热更新，需要重启。`,
    overridden: `已保存“${name}”的${action}状态，但被更高优先级的配置覆盖。`,
    failed: `DSH 未能${action}“${name}”：${result.error?.diagnostic ?? result.error?.code ?? '未知错误'}`,
    cancelled: `“${name}”的${action}操作已取消。`,
  }
  return [messages[result.application], ...(result.warnings ?? [])].join('\n')
}

function validStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function hasProfileManifest(profileDir: string): Promise<boolean> {
  try {
    await access(join(profileDir, 'package.json'))
    return true
  } catch (error) {
    return !isMissingFileError(error)
  }
}

function validateProfileName(value: string): string {
  const profile = value.trim()
  if (profile.length === 0) throw new Error('请选择 Profile。')
  if (profile.length > 120 || /[\\/\r\n\0]/u.test(profile) || profile === '.' || profile === '..') {
    throw new Error('Profile 名称无效。')
  }
  return profile
}

function formatDisplayArgument(value: string): string {
  return /\s|["']/u.test(value) ? JSON.stringify(value) : value
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
