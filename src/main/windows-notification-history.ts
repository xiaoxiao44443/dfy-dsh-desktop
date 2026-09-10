import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

export const DESKTOP_NOTIFICATION_APP_ID = 'com.saltfish.dfy-dsh-desktop'

interface WindowsNotificationHistoryDriver {
  platform?: NodeJS.Platform
  runPowerShell?: (script: string) => Promise<string>
}

/** Remove one known toast without depending on Electron's dismissed native object. */
export async function removeWindowsNotification(
  id: string,
  groupId: string,
  driver: WindowsNotificationHistoryDriver = {},
): Promise<void> {
  if ((driver.platform ?? process.platform) !== 'win32') return
  if (typeof id !== 'string' || id.length === 0 || id.length > 1024
    || typeof groupId !== 'string' || groupId.length > 1024 || /[\r\n\0]/u.test(id + groupId)) {
    throw new Error('Windows notification history target is invalid')
  }
  const payload = Buffer.from(JSON.stringify({ id, groupId }), 'utf8').toString('base64')
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$history = [Windows.UI.Notifications.ToastNotificationManager]::History
$history.Remove([string]$target.id, [string]$target.groupId, '${DESKTOP_NOTIFICATION_APP_ID}')
[Console]::Write('{"removed":true}')
`
  try {
    const output = await (driver.runPowerShell ?? runPowerShell)(script)
    const result: unknown = JSON.parse(output)
    if (result === null || typeof result !== 'object' || !('removed' in result) || result.removed !== true) {
      throw new Error('Missing history removal acknowledgement')
    }
  } catch {
    // execFile errors can embed the encoded command and its notification target.
    throw new Error('Windows notification history removal failed')
  }
}

async function runPowerShell(script: string): Promise<string> {
  const executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return await new Promise((resolve, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 64 * 1024,
    }, (error, stdout) => { if (error !== null) reject(error); else resolve(stdout) })
  })
}
