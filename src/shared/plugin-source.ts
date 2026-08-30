const GIT_SHORTCUT_HOSTS: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
}

function repositoryPath(path: string): string {
  return path
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/iu, '')
}

export function gitRepositoryWebUrl(source: string): string {
  const trimmed = source.trim()
  const withoutReference = trimmed.split('#', 1)[0] ?? trimmed
  const shortcut = /^(github|gitlab|bitbucket):(.+)$/iu.exec(withoutReference)
  if (shortcut !== null) {
    const kind = shortcut[1]?.toLocaleLowerCase()
    const path = shortcut[2]
    const host = kind === undefined ? undefined : GIT_SHORTCUT_HOSTS[kind]
    if (host !== undefined && path !== undefined) return `https://${host}/${repositoryPath(path)}`
  }

  const shorthand = /^([^/@:\s]+\/[^\s]+)$/u.exec(withoutReference)
  if (shorthand?.[1] !== undefined) return `https://github.com/${repositoryPath(shorthand[1])}`

  const scpStyle = /^git@([^:]+):(.+)$/iu.exec(withoutReference)
  if (scpStyle?.[1] !== undefined && scpStyle[2] !== undefined) {
    return `https://${scpStyle[1]}/${repositoryPath(scpStyle[2])}`
  }

  const urlValue = withoutReference.replace(/^git\+/iu, '')
  try {
    const url = new URL(urlValue)
    const path = repositoryPath(url.pathname)
    if (path.length === 0) return trimmed
    return `https://${url.hostname}${url.port.length > 0 ? `:${url.port}` : ''}/${path}`
  } catch {
    return trimmed
  }
}
