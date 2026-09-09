import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

export class SessionFormatCompatibilityError extends Error {}

/** Inspect filenames only; opening a session through DSH can itself migrate it. */
export async function storedSessionFormat(home: string): Promise<number> {
  const root = join(home, 'sessions')
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  let maximum = 0
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    for (const session of await readdir(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      for (const file of await readdir(join(projectPath, session.name), { withFileTypes: true })) {
        if (!file.isFile()) continue
        const match = /^session\.v([1-9]\d*)\.jsonl(?:\.zstd)?$/u.exec(file.name)
        if (match !== null) maximum = Math.max(maximum, Number(match[1]))
      }
    }
  }
  return maximum
}

export async function assertSessionFormatCompatible(home: string, entryPath: string, version: string): Promise<void> {
  const stored = await storedSessionFormat(home)
  if (stored === 0) return
  let supported: number | undefined
  try {
    const entry = createRequire(entryPath).resolve('@deepseek-ai/dsh-session')
    const source = await readFile(entry, 'utf8')
    const match = /\b(?:const|let|var)\s+SESSION_FORMAT_VERSION\s*=\s*(\d+)\s*;/u.exec(source)
    if (match !== null) supported = Number(match[1])
  } catch {
    // An unknown reader must not fall back to historical logs and hide new data.
  }
  if (supported === undefined || supported < stored) {
    throw new SessionFormatCompatibilityError(
      `现有会话已使用 V${stored} 日志，Harness ${version} ${supported === undefined ? '无法确认支持此格式' : `仅支持 V${supported}`}。已停止切换，请使用支持现有会话格式的版本。`,
    )
  }
}
