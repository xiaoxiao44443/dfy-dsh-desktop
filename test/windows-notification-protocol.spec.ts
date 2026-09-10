import { beforeEach, describe, expect, it, vi } from 'vitest'

const commandMocks = vi.hoisted(() => ({
  responses: [] as Array<string | Error>,
  calls: [] as Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }>,
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn((file: string, args: readonly string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string) => void) => {
    commandMocks.calls.push({ file, args, options })
    const response = commandMocks.responses.shift()
    if (response === undefined) throw new Error('Unexpected subprocess')
    queueMicrotask(() => callback(response instanceof Error ? response : null, typeof response === 'string' ? response : ''))
  }),
}))

import { ensureWindowsNotificationProtocol } from '../src/main/windows-notification-protocol.js'
import type { WindowsNotificationProtocolDependencies } from '../src/main/windows-notification-protocol.js'

const options = {
  scheme: 'dfy-dsh-notification-dev',
  executablePath: 'C:\\Program Files\\Electron\\electron.exe',
  args: ['E:\\项目文件\\工作树 甲'],
}
const expectedCommand = '"C:\\Program Files\\Electron\\electron.exe" "E:\\项目文件\\工作树 甲" "%1"'
const absent = { userCommand: expectedCommand, machineExists: false, machineCommand: null, machineUrlProtocol: false }
const registered = { ...absent, machineExists: true, machineCommand: expectedCommand, machineUrlProtocol: true }

function fixture() {
  const dependencies = {
    platform: 'win32' as NodeJS.Platform,
    readEnvironment: vi.fn(async () => ({ enableLUA: 0 as number | null, isAdministrator: true })),
    readRegistration: vi.fn<WindowsNotificationProtocolDependencies['readRegistration']>()
      .mockResolvedValueOnce(absent).mockResolvedValue(registered),
    writeMachineRegistration: vi.fn(async () => undefined),
    warn: vi.fn(),
  }
  return dependencies
}

beforeEach(() => {
  commandMocks.responses.length = 0
  commandMocks.calls.length = 0
  vi.clearAllMocks()
})

describe('Windows notification machine protocol compatibility', () => {
  it.each(['darwin', 'linux'] as const)('leaves %s untouched', async (platform) => {
    const dependencies = fixture()
    dependencies.platform = platform
    expect(await ensureWindowsNotificationProtocol(options, dependencies)).toBe(true)
    expect(dependencies.readEnvironment).not.toHaveBeenCalled()
    expect(dependencies.writeMachineRegistration).not.toHaveBeenCalled()
  })

  it.each([
    { enableLUA: 1, isAdministrator: true },
    { enableLUA: 1, isAdministrator: false },
    { enableLUA: 0, isAdministrator: false },
    { enableLUA: null, isAdministrator: true },
    { enableLUA: 2, isAdministrator: true },
  ])('preserves ordinary HKCU handling when compatibility is not established: %o', async (environment) => {
    const dependencies = fixture()
    dependencies.readEnvironment.mockResolvedValue(environment)
    expect(await ensureWindowsNotificationProtocol(options, dependencies)).toBe(true)
    expect(dependencies.readRegistration).not.toHaveBeenCalled()
    expect(dependencies.writeMachineRegistration).not.toHaveBeenCalled()
  })

  it('does not disable the ordinary user handler when the compatibility check is unavailable', async () => {
    const dependencies = fixture()
    dependencies.readEnvironment.mockRejectedValue(new Error('private diagnostic content'))
    expect(await ensureWindowsNotificationProtocol(options, dependencies)).toBe(true)
    expect(dependencies.writeMachineRegistration).not.toHaveBeenCalled()
    expect(dependencies.warn).toHaveBeenCalledExactlyOnceWith('[desktop-notifications] Windows protocol compatibility check unavailable')
  })

  it('registers and verifies only the matching handler for elevated UAC-disabled Windows', async () => {
    const dependencies = fixture()
    expect(await ensureWindowsNotificationProtocol(options, dependencies)).toBe(true)
    expect(dependencies.writeMachineRegistration).toHaveBeenCalledExactlyOnceWith(options.scheme, expectedCommand)
    expect(dependencies.readRegistration).toHaveBeenCalledTimes(2)
    expect(dependencies.warn).not.toHaveBeenCalled()
  })

  it('supports the installed scheme and executable without development arguments', async () => {
    const dependencies = fixture()
    const installed = { scheme: 'dfy-dsh-notification', executablePath: 'C:\\Apps\\DFY DSH Desktop.exe', args: [] }
    const command = '"C:\\Apps\\DFY DSH Desktop.exe" "%1"'
    dependencies.readRegistration.mockReset().mockResolvedValueOnce({ ...absent, userCommand: command })
      .mockResolvedValue({ ...registered, userCommand: command, machineCommand: command })
    expect(await ensureWindowsNotificationProtocol(installed, dependencies)).toBe(true)
    expect(dependencies.writeMachineRegistration).toHaveBeenCalledExactlyOnceWith(installed.scheme, command)
  })

  it('treats an existing identical machine handler as an idempotent success', async () => {
    const dependencies = fixture()
    dependencies.readRegistration.mockReset().mockResolvedValue(registered)
    expect(await ensureWindowsNotificationProtocol(options, dependencies)).toBe(true)
    expect(dependencies.writeMachineRegistration).not.toHaveBeenCalled()
    expect(dependencies.readRegistration).toHaveBeenCalledOnce()
  })

  it('can repair a missing URL marker only when the existing machine command is identical', async () => {
    const dependencies = fixture()
    dependencies.readRegistration.mockReset().mockResolvedValueOnce({ ...registered, machineUrlProtocol: false })
      .mockResolvedValue(registered)
    expect(await ensureWindowsNotificationProtocol(options, dependencies)).toBe(true)
    expect(dependencies.writeMachineRegistration).toHaveBeenCalledExactlyOnceWith(options.scheme, expectedCommand)
  })

  it.each([
    '"D:\\Other App\\electron.exe" "E:\\项目文件\\工作树 甲" "%1"',
    '"C:\\Program Files\\Electron\\electron.exe" "E:\\项目文件\\工作树 乙" "%1"',
    null,
  ])('does not overwrite an existing foreign or unidentified machine handler: %s', async (machineCommand) => {
    const dependencies = fixture()
    dependencies.readRegistration.mockReset().mockResolvedValue({ ...registered, machineCommand })
    expect(await ensureWindowsNotificationProtocol(options, dependencies)).toBe(false)
    expect(dependencies.writeMachineRegistration).not.toHaveBeenCalled()
    expect(dependencies.warn).toHaveBeenCalledOnce()
  })

  it.each([null, '"C:\\Other.exe" "%1"', `${expectedCommand} --extra`])('does not copy an unexpected HKCU handler: %s', async (userCommand) => {
    const dependencies = fixture()
    dependencies.readRegistration.mockReset().mockResolvedValue({ ...absent, userCommand })
    expect(await ensureWindowsNotificationProtocol(options, dependencies)).toBe(false)
    expect(dependencies.writeMachineRegistration).not.toHaveBeenCalled()
  })

  it.each([
    { ...options, scheme: 'https' },
    { ...options, scheme: "dfy-dsh-notification-dev'; Remove-Item" },
    { ...options, executablePath: 'electron.exe' },
    { ...options, executablePath: 'C:\\Apps\\bad"name.exe' },
    { ...options, args: ['E:\\path\ncommand'] },
  ])('rejects invalid targets before accessing the registry: %o', async (invalid) => {
    const dependencies = fixture()
    expect(await ensureWindowsNotificationProtocol(invalid, dependencies)).toBe(false)
    expect(dependencies.readEnvironment).not.toHaveBeenCalled()
    expect(dependencies.writeMachineRegistration).not.toHaveBeenCalled()
  })

  it('reports required registration failure without logging commands or exception contents', async () => {
    const dependencies = fixture()
    dependencies.writeMachineRegistration.mockRejectedValue(new Error(`Access denied for ${expectedCommand}`))
    expect(await ensureWindowsNotificationProtocol(options, dependencies)).toBe(false)
    expect(dependencies.warn).toHaveBeenCalledExactlyOnceWith('[desktop-notifications] Windows notification machine handler registration unavailable')
    expect(dependencies.readRegistration).toHaveBeenCalledOnce()
  })

  it('does not claim success if the machine values fail verification', async () => {
    const dependencies = fixture()
    dependencies.readRegistration.mockReset().mockResolvedValue(absent)
    expect(await ensureWindowsNotificationProtocol(options, dependencies)).toBe(false)
    expect(dependencies.writeMachineRegistration).toHaveBeenCalledOnce()
    expect(dependencies.warn).toHaveBeenCalledExactlyOnceWith('[desktop-notifications] Windows notification machine handler verification failed')
  })
})

describe('Windows registry command transport', () => {
  it('uses hidden shell-free subprocesses, UTF8 JSON reads, and exact Unicode registry value arguments', async () => {
    commandMocks.responses.push(JSON.stringify({ enableLUA: 0, isAdministrator: true }), JSON.stringify(absent), '', '', '', JSON.stringify(registered))
    const warn = vi.fn()
    expect(await ensureWindowsNotificationProtocol(options, { platform: 'win32', warn })).toBe(true)
    expect(commandMocks.responses).toHaveLength(0)
    expect(commandMocks.calls).toHaveLength(6)
    const reads = commandMocks.calls.filter((call) => call.file.endsWith('powershell.exe'))
    expect(reads).toHaveLength(3)
    for (const read of reads) {
      expect(read.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
      const script = Buffer.from(read.args[4]!, 'base64').toString('utf16le')
      expect(script).toContain('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)')
      expect(script).toContain('ConvertTo-Json -Compress')
      expect(script).not.toMatch(/SetValue|CreateSubKey|DeleteSubKey|RunAs|Set-Item|Remove-Item/u)
    }
    const writes = commandMocks.calls.filter((call) => call.file.endsWith('reg.exe'))
    const key = `HKLM\\Software\\Classes\\${options.scheme}`
    expect(writes.map((call) => call.args)).toEqual([
      ['add', `${key}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', expectedCommand, '/f', '/reg:64'],
      ['add', key, '/ve', '/t', 'REG_SZ', '/d', 'URL:DFY DSH Desktop Notification', '/f', '/reg:64'],
      ['add', key, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f', '/reg:64'],
    ])
    for (const call of commandMocks.calls) {
      expect(call.file).toMatch(/^[A-Za-z]:\\Windows\\System32\\/iu)
      expect(call.options).toMatchObject({ windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000 })
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it('stops machine writes at the first subprocess failure', async () => {
    commandMocks.responses.push(JSON.stringify({ enableLUA: 0, isAdministrator: true }), JSON.stringify(absent), new Error('reg.exe private failure output'))
    const warn = vi.fn()
    expect(await ensureWindowsNotificationProtocol(options, { platform: 'win32', warn })).toBe(false)
    expect(commandMocks.calls.filter((call) => call.file.endsWith('reg.exe'))).toHaveLength(1)
    expect(warn).toHaveBeenCalledExactlyOnceWith('[desktop-notifications] Windows notification machine handler registration unavailable')
  })

  it('recovers an interrupted registration using the already recorded owning command', async () => {
    const environment = JSON.stringify({ enableLUA: 0, isAdministrator: true })
    commandMocks.responses.push(environment, JSON.stringify(absent), '', new Error('interrupted after command write'))
    const warn = vi.fn()
    expect(await ensureWindowsNotificationProtocol(options, { platform: 'win32', warn })).toBe(false)
    const initialWrites = commandMocks.calls.filter((call) => call.file.endsWith('reg.exe'))
    expect(initialWrites).toHaveLength(2)
    expect(initialWrites[0]!.args[1]).toBe(`HKLM\\Software\\Classes\\${options.scheme}\\shell\\open\\command`)
    expect(initialWrites.some((call) => call.args.includes('URL Protocol'))).toBe(false)
    commandMocks.responses.push(environment, JSON.stringify({ ...registered, machineUrlProtocol: false }), '', '', '', JSON.stringify(registered))
    expect(await ensureWindowsNotificationProtocol(options, { platform: 'win32', warn })).toBe(true)
    const finalWrite = commandMocks.calls.filter((call) => call.file.endsWith('reg.exe')).at(-1)!
    expect(finalWrite.args).toContain('URL Protocol')
  })

  it('does not proceed from malformed policy JSON to machine writes', async () => {
    commandMocks.responses.push(JSON.stringify({ enableLUA: '0', isAdministrator: true }))
    const warn = vi.fn()
    expect(await ensureWindowsNotificationProtocol(options, { platform: 'win32', warn })).toBe(true)
    expect(commandMocks.calls).toHaveLength(1)
    expect(warn).toHaveBeenCalledOnce()
  })
})
