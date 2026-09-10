import { beforeEach, describe, expect, it, vi } from 'vitest'

const commandMocks = vi.hoisted(() => ({
  output: '{"removed":true}',
  error: null as Error | null,
  calls: [] as Array<{ file: string; args: readonly string[]; options: Record<string, unknown> }>,
}))

vi.mock('node:child_process', () => ({
  execFile: vi.fn((file: string, args: readonly string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string) => void) => {
    commandMocks.calls.push({ file, args, options })
    queueMicrotask(() => callback(commandMocks.error, commandMocks.output))
  }),
}))

import { DESKTOP_NOTIFICATION_APP_ID, removeWindowsNotification } from '../src/main/windows-notification-history.js'

beforeEach(() => {
  commandMocks.output = '{"removed":true}'
  commandMocks.error = null
  commandMocks.calls.length = 0
  vi.clearAllMocks()
})

describe('Windows notification history removal', () => {
  it('removes only the exact tag and Unicode group for our fixed application through a hidden process', async () => {
    const id = 'toast-"\'); Clear(); $x = $(whoami); (\''
    const groupId = '对话 & "审批" \'😀'
    await expect(removeWindowsNotification(id, groupId, { platform: 'win32' })).resolves.toBeUndefined()
    expect(commandMocks.calls).toHaveLength(1)
    const command = commandMocks.calls[0]!
    expect(command.file).toMatch(/^[a-z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu)
    expect(command.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(command.options).toEqual({ encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 64 * 1024 })
    const script = Buffer.from(command.args[4]!, 'base64').toString('utf16le')
    expect(script).toContain('[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)')
    const payload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(script)![1]!
    expect(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))).toEqual({ id, groupId })
    expect(script).toContain(`$history.Remove([string]$target.id, [string]$target.groupId, '${DESKTOP_NOTIFICATION_APP_ID}')`)
    expect(script).not.toContain(id)
    expect(script).not.toContain(groupId)
    expect(script).not.toMatch(/\.Clear\(|RemoveGroup\(|RemoveAll\(/u)
    expect(DESKTOP_NOTIFICATION_APP_ID).toBe('com.saltfish.dfy-dsh-desktop')
  })

  it.each(['darwin', 'linux'] as const)('does not invoke Windows history on %s', async (platform) => {
    const runPowerShell = vi.fn()
    await expect(removeWindowsNotification('toast-id', '', { platform, runPowerShell })).resolves.toBeUndefined()
    expect(runPowerShell).not.toHaveBeenCalled()
    expect(commandMocks.calls).toHaveLength(0)
  })

  it('preserves an empty group for a known ungrouped toast', async () => {
    const runPowerShell = vi.fn(async () => '{"removed":true}')
    await removeWindowsNotification('toast-id', '', { platform: 'win32', runPowerShell })
    const payload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(runPowerShell.mock.calls[0]![0]!)![1]!
    expect(JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))).toEqual({ id: 'toast-id', groupId: '' })
  })

  it('rejects an empty or control-character target without launching a subprocess', async () => {
    for (const [id, groupId] of [['', 'Notifications'], ['bad\0id', 'Notifications'], ['toast', 'bad\ngroup']]) {
      await expect(removeWindowsNotification(id!, groupId!, { platform: 'win32' })).rejects.toThrow('Windows notification history target is invalid')
    }
    expect(commandMocks.calls).toHaveLength(0)
  })

  it.each(['timeout', 'access denied'])('returns a fixed error after %s without disclosing subprocess diagnostics', async (reason) => {
    commandMocks.error = Object.assign(new Error(`${reason}: private-toast-nonce and encoded command`), { killed: reason === 'timeout' })
    await expect(removeWindowsNotification('private-toast-nonce', 'Notifications', { platform: 'win32' }))
      .rejects.toThrow(/^Windows notification history removal failed$/u)
    expect(commandMocks.calls).toHaveLength(1)
  })

  it('requires a successful removal acknowledgement', async () => {
    for (const output of ['', '{"removed":false}', '{"other":true}']) {
      const runPowerShell = vi.fn(async () => output)
      await expect(removeWindowsNotification('toast-id', 'Notifications', { platform: 'win32', runPowerShell }))
        .rejects.toThrow(/^Windows notification history removal failed$/u)
    }
  })
})
