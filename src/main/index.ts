import { app, dialog, nativeTheme, shell, systemPreferences } from 'electron'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { HarnessProcess } from './harness-process.js'
import { DESKTOP_PNPM_VERSION, HarnessRuntimeManager } from './harness-runtime.js'
import { WindowController } from './window-controller.js'
import { DirectoryPickerBridge } from './directory-picker-bridge.js'
import { HarnessToolchainManager } from './harness-toolchain.js'
import { DevelopmentService } from './development-service.js'
import type { DevelopmentSettings } from './development-settings.js'
import { HarnessDesktopBridgeHost } from './harness-desktop-bridge.js'
import { DesktopNotificationService } from './desktop-notifications.js'
import { PluginInitializationError, PluginRecoveryService } from './plugin-recovery.js'
import { DesktopBrowserService } from './desktop-browser.js'
import { DshCliIntegration } from './dsh-cli-integration.js'
import { PluginManagementService } from './plugin-management.js'

// Chromium may not propagate macOS' dark color-scheme media query into the
// cross-origin Harness iframe. Preserve explicit Harness light/dark choices,
// but make its default `system` preference resolve to the current dark OS
// appearance from the first paint.
const macSystemDark = process.platform === 'darwin'
  && (() => {
    try {
      return systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark'
    } catch {
      return nativeTheme.shouldUseDarkColors
    }
  })()
if (macSystemDark) {
  app.commandLine.appendSwitch('force-dark-mode')
}

app.setName('DFY DSH Desktop')
if (process.platform === 'win32') app.setAppUserModelId('com.saltfish.dfy-dsh-desktop')

const desktopDataRoot = join(app.getPath('home'), '.saltfish')
const desktopUserDataPath = join(
  desktopDataRoot,
  'dfy-dsh-desktop',
)
const legacyDesktopUserDataPath = join(desktopDataRoot, 'deepseek-harness-desktop')

// Keep desktop-owned state portable and clearly separate from Harness' official
// ~/.dsh home on Windows, macOS, and Linux. Preserve existing installations by
// moving the legacy product directory before Electron opens Chromium state.
if (!existsSync(desktopUserDataPath) && existsSync(legacyDesktopUserDataPath)) {
  try {
    renameSync(legacyDesktopUserDataPath, desktopUserDataPath)
  } catch {
    // The old directory may be locked or live on a different filesystem. In
    // that case the new product starts clean and leaves legacy data untouched.
  }
}
mkdirSync(desktopUserDataPath, { recursive: true })
app.setPath('userData', desktopUserDataPath)
app.setPath('sessionData', desktopUserDataPath)

// GUI applications may inherit a short-lived terminal pipe when launched by a
// package runner. Once that runner exits, writing to stdout/stderr emits EPIPE.
// Never let a diagnostic stream take down the desktop main process.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') {
      // There is deliberately no fallback write here: it could recurse through
      // the same broken stream. Runtime failures are surfaced in the window.
    }
  })
}

const debugLog = (...values: unknown[]): void => {
  if (!app.isPackaged) console.log(...values)
}

const debugError = (...values: unknown[]): void => {
  if (!app.isPackaged) console.error(...values)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let harness: HarnessProcess | undefined
  let windows: WindowController | undefined
  let runtime: HarnessRuntimeManager | undefined
  let directoryPicker: DirectoryPickerBridge | undefined
  let development: DevelopmentService | undefined
  let desktopBridge: HarnessDesktopBridgeHost | undefined
  let browser: DesktopBrowserService | undefined
  let quitting = false

  app.on('second-instance', () => windows?.focus())
  app.on('before-quit', () => {
    quitting = true
    runtime?.stopAutomaticChecks()
    void harness?.stop()
    void directoryPicker?.stop()
    void desktopBridge?.stop()
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('activate', () => { if (!quitting) void windows?.create() })

  const bootstrap = async (): Promise<void> => {
    debugLog('[desktop] waiting for Electron ready')
    await app.whenReady()
    debugLog('[desktop] Electron ready; resolving Harness runtime')
    const usesPackagedRuntimeDirectory = app.isPackaged && process.platform === 'darwin'
    const bundledRuntimeRoot = app.isPackaged
      ? usesPackagedRuntimeDirectory
        ? join(process.resourcesPath, 'harness-runtime')
        : join(app.getPath('userData'), 'harness-runtime', 'bundled', app.getVersion())
      : undefined
    const bundledArchivePath = app.isPackaged && !usesPackagedRuntimeDirectory
      ? join(process.resourcesPath, 'harness-runtime.tgz')
      : undefined
    const packagedPnpmCli = app.isPackaged
      ? join(bundledRuntimeRoot as string, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
      : undefined
    runtime = new HarnessRuntimeManager(
      app.getPath('userData'),
      process.execPath,
      bundledRuntimeRoot,
      bundledArchivePath,
      packagedPnpmCli,
    )
    const pluginRecovery = new PluginRecoveryService(
      join(app.getPath('userData'), 'plugin-recovery.patch.json'),
    )
    await pluginRecovery.initialize()
    const toolchain = new HarnessToolchainManager(app.getPath('userData'), process.execPath)
    const cliIntegration = new DshCliIntegration(toolchain.binPath, toolchain.dshCommandPath)
    const launchHarness = async (settings: DevelopmentSettings): Promise<void> => {
      if (runtime === undefined || windows === undefined || harness === undefined) {
        throw new Error('桌面运行时尚未准备完成。')
      }
      let started = false
      const failures: string[] = []
      let pluginFailure: PluginInitializationError | undefined
      for (const candidate of await runtime.launchCandidates()) {
        windows.setHarnessStarting(candidate.version)
        try {
          const running = await harness.start(candidate, settings)
          await runtime.markHealthy(candidate)
          development?.setHarnessVersion(candidate.version)
          await development?.refreshCli()
          await windows.showHarness(running.url, candidate.version)
          debugLog(`[desktop] Harness ${candidate.version} ready at ${running.url}`)
          started = true
          break
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`${candidate.version} (${candidate.source}): ${message}`)
          if (error instanceof PluginInitializationError) {
            pluginFailure = error
            break
          }
          // A user-supplied patch can fail independently from the runtime. Do
          // not blacklist an otherwise healthy auto-updated Harness version.
          if (settings.patchPath === undefined) await runtime.markFailed(candidate, message)
        }
      }
      if (!started) {
        const message = pluginFailure === undefined
          ? `无法启动 DeepSeek Harness。${failures.join('；')}`
          : `插件“${pluginFailure.failure.pluginName}”初始化失败：${pluginFailure.failure.detail}`
        windows.setHarnessError(message, pluginFailure?.failure)
        throw new Error(message)
      }
    }

    development = new DevelopmentService(
      join(app.getPath('userData'), 'development.json'),
      DESKTOP_PNPM_VERSION,
      {
        getWindow: () => windows?.getBrowserWindow(),
        restartHarness: launchHarness,
        runPlugin: async (profile, args) => {
          if (harness === undefined) throw new Error('Harness 尚未启动。')
          return await harness.runPlugin(profile, args)
        },
      },
      cliIntegration,
    )
    await development.initialize()
    browser = new DesktopBrowserService(join(app.getPath('userData'), 'browser'))
    await browser.initialize()
    const pluginManagement = new PluginManagementService(runtime.harnessHome, {
      getWindow: () => windows?.getBrowserWindow(),
      runPnpm: async (profile, args) => {
        if (harness === undefined) throw new Error('Harness 尚未启动。')
        return await harness.runPnpm(profile, args)
      },
    })
    debugLog('[desktop] creating startup window')
    windows = new WindowController(runtime, development, pluginRecovery, browser, pluginManagement)
    windows.setRuntimePreparing()
    await windows.create()
    debugLog('[desktop] startup window created; resolving Harness runtime')
    await runtime.initialize()
    debugLog('[desktop] Harness runtime resolved; starting Harness')

    directoryPicker = new DirectoryPickerBridge(
      () => windows?.getBrowserWindow(),
      join(app.getPath('userData'), 'last-workspace-directory.txt'),
    )
    const directoryPickerUrl = await directoryPicker.start()
    const desktopBridgePluginRoot = app.isPackaged
      ? join(process.resourcesPath, 'dsh-desktop-bridge')
      : join(app.getAppPath(), 'resources', 'dsh-desktop-bridge')
    const desktopBrowserPluginRoot = app.isPackaged
      ? join(process.resourcesPath, 'dsh-desktop-browser')
      : join(app.getAppPath(), 'resources', 'dsh-desktop-browser')
    const notifications = new DesktopNotificationService(
      join(app.getPath('userData'), 'notifications.json'),
      {
        getWindow: () => windows?.getBrowserWindow(),
        openSession: (sessionId) => windows?.focusHarnessSession(sessionId),
      },
    )
    await notifications.initialize()
    desktopBridge = new HarnessDesktopBridgeHost({
      userDataPath: app.getPath('userData'),
      pluginName: 'dsh-desktop-bridge',
      pluginRootPath: desktopBridgePluginRoot,
      browserPluginName: 'dsh-desktop-browser',
      browserPluginRootPath: desktopBrowserPluginRoot,
      profilePath: join(runtime.harnessHome, 'profiles', 'web'),
      notifications,
      browser,
      revealPath: (path) => shell.showItemInFolder(path),
      restartHarness: async () => {
        if (development === undefined) throw new Error('Harness 开发服务尚未准备完成。')
        await development.restartHarness()
      },
    })
    const desktopBridgeLaunch = await desktopBridge.start()
    harness = new HarnessProcess(
      process.execPath,
      app.getPath('home'),
      directoryPickerUrl,
      toolchain,
      desktopBridgeLaunch,
      pluginRecovery.patchPath,
    )
    harness.on('log', (stream: string, message: string) => {
      const output = `[harness:${stream}] ${message.trimEnd()}`
      if (stream === 'stderr') debugError(output)
      else debugLog(output)
    })
    harness.on('exit', ({ expected }: { expected: boolean }) => {
      if (!expected && !quitting) windows?.setHarnessError('Harness 后台进程已意外退出。请重新启动应用。')
    })

    try {
      await launchHarness(development.currentSettings)
      runtime.scheduleAutomaticChecks(2_000)
    } catch {
      // launchHarness already surfaced a recoverable error in the shell. The
      // development dialog remains available so a bad patch can be cleared.
    }
  }

  void bootstrap().catch((error: unknown) => {
    debugError('[desktop] fatal startup error', error)
    if (app.isPackaged) {
      const message = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox('DeepSeek Harness 启动失败', message)
    }
    app.quit()
  })
}
