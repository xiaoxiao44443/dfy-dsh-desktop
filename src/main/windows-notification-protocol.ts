import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

export interface WindowsNotificationProtocolOptions {
  scheme: string
  executablePath: string
  args: readonly string[]
}

interface ProtocolEnvironment {
  enableLUA: number | null
  isAdministrator: boolean
}

interface ProtocolRegistration {
  userCommand: string | null
  machineExists: boolean
  machineCommand: string | null
  machineUrlProtocol: boolean
}

export interface WindowsNotificationProtocolDependencies {
  platform: NodeJS.Platform
  readEnvironment(): Promise<ProtocolEnvironment>
  readRegistration(scheme: string): Promise<ProtocolRegistration>
  writeMachineRegistration(scheme: string, command: string): Promise<void>
  warn(message: string): void
}

/** HKCU remains the normal handler; only elevated, UAC-disabled Windows needs this fallback. */
export async function ensureWindowsNotificationProtocol(
  options: WindowsNotificationProtocolOptions,
  overrides: Partial<WindowsNotificationProtocolDependencies> = {},
): Promise<boolean> {
  const dependencies: WindowsNotificationProtocolDependencies = {
    platform: process.platform,
    readEnvironment,
    readRegistration,
    writeMachineRegistration,
    warn: (message) => console.warn(message),
    ...overrides,
  }
  if (dependencies.platform !== 'win32') return true
  if (options.scheme !== 'dfy-dsh-notification' && options.scheme !== 'dfy-dsh-notification-dev') return false
  if (!win32.isAbsolute(options.executablePath)
    || [options.executablePath, ...options.args].some((value) => /["\r\n\0]/u.test(value))) return false

  let environment: ProtocolEnvironment
  try {
    environment = await dependencies.readEnvironment()
  } catch {
    // An unavailable compatibility check must not disable ordinary HKCU handlers.
    dependencies.warn('[desktop-notifications] Windows protocol compatibility check unavailable')
    return true
  }
  if (environment.enableLUA !== 0 || !environment.isAdministrator) return true

  const expectedCommand = [options.executablePath, ...options.args, '%1']
    .map((value) => `"${value.replace(/\\+$/u, (slashes) => slashes + slashes)}"`).join(' ')
  try {
    const existing = await dependencies.readRegistration(options.scheme)
    if (existing.userCommand !== expectedCommand) {
      dependencies.warn('[desktop-notifications] Windows notification user handler does not match this application')
      return false
    }
    if (existing.machineExists && existing.machineCommand !== expectedCommand) {
      dependencies.warn('[desktop-notifications] Windows notification machine handler belongs to another registration')
      return false
    }
    if (existing.machineCommand === expectedCommand && existing.machineUrlProtocol) return true
    await dependencies.writeMachineRegistration(options.scheme, expectedCommand)
    const registered = await dependencies.readRegistration(options.scheme)
    if (registered.machineExists && registered.machineCommand === expectedCommand && registered.machineUrlProtocol) return true
    dependencies.warn('[desktop-notifications] Windows notification machine handler verification failed')
    return false
  } catch {
    dependencies.warn('[desktop-notifications] Windows notification machine handler registration unavailable')
    return false
  }
}

const powershellPrelude = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
`

async function readEnvironment(): Promise<ProtocolEnvironment> {
  const value: unknown = JSON.parse(await runPowerShell(powershellPrelude + `
$machine = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
$policy = $null
$identity = $null
try {
  $policy = $machine.OpenSubKey('SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System')
  $enableLUA = if ($null -eq $policy) { $null } else { $policy.GetValue('EnableLUA', $null) }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  [pscustomobject]@{
    enableLUA = $enableLUA
    isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $identity) { $identity.Dispose() }
  if ($null -ne $policy) { $policy.Dispose() }
  $machine.Dispose()
}
`))
  if (!isRecord(value) || typeof value.isAdministrator !== 'boolean'
    || (value.enableLUA !== null && typeof value.enableLUA !== 'number')) throw new Error('Invalid environment result')
  return { enableLUA: value.enableLUA, isAdministrator: value.isAdministrator }
}

async function readRegistration(scheme: string): Promise<ProtocolRegistration> {
  const value: unknown = JSON.parse(await runPowerShell(powershellPrelude + `
function Read-Protocol([Microsoft.Win32.RegistryHive] $hive) {
  $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)
  $key = $null
  $commandKey = $null
  try {
    $key = $baseKey.OpenSubKey('SOFTWARE\\Classes\\${scheme}')
    if ($null -eq $key) { return @{ exists = $false; command = $null; urlProtocol = $false } }
    $commandKey = $key.OpenSubKey('shell\\open\\command')
    $command = if ($null -eq $commandKey) { $null } else { $commandKey.GetValue('', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    return @{ exists = $true; command = $command; urlProtocol = ($key.GetValueNames() -contains 'URL Protocol') }
  } finally {
    if ($null -ne $commandKey) { $commandKey.Dispose() }
    if ($null -ne $key) { $key.Dispose() }
    $baseKey.Dispose()
  }
}
$user = Read-Protocol ([Microsoft.Win32.RegistryHive]::CurrentUser)
$machine = Read-Protocol ([Microsoft.Win32.RegistryHive]::LocalMachine)
[pscustomobject]@{
  userCommand = $user.command
  machineExists = $machine.exists
  machineCommand = $machine.command
  machineUrlProtocol = $machine.urlProtocol
} | ConvertTo-Json -Compress
`))
  if (!isRecord(value) || (value.userCommand !== null && typeof value.userCommand !== 'string')
    || (value.machineCommand !== null && typeof value.machineCommand !== 'string')
    || typeof value.machineExists !== 'boolean' || typeof value.machineUrlProtocol !== 'boolean') {
    throw new Error('Invalid registration result')
  }
  return {
    userCommand: value.userCommand,
    machineExists: value.machineExists,
    machineCommand: value.machineCommand,
    machineUrlProtocol: value.machineUrlProtocol,
  }
}

async function writeMachineRegistration(scheme: string, command: string): Promise<void> {
  const key = `HKLM\\Software\\Classes\\${scheme}`
  const reg = systemExecutable('reg.exe')
  // Record the owning command first so interrupted setup can be safely retried.
  // The URL marker comes last, after the complete launch command is available.
  await runCommand(reg, ['add', `${key}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f', '/reg:64'])
  await runCommand(reg, ['add', key, '/ve', '/t', 'REG_SZ', '/d', 'URL:DFY DSH Desktop Notification', '/f', '/reg:64'])
  await runCommand(reg, ['add', key, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f', '/reg:64'])
}

async function runPowerShell(script: string): Promise<string> {
  return await runCommand(systemExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ])
}

function systemExecutable(...parts: string[]): string {
  return win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts)
}

async function runCommand(file: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout) => { if (error !== null) reject(error); else resolve(stdout) })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
