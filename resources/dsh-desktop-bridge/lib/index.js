import { unwatchFile, watchFile } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'desktop-bridge'
export const inject = ['tools', 'systemPrompt', 'webServer']

export const RESTART_TOOL_NAME = 'desktop_restart_harness'
const PROFILE_FILES = ['package.json', 'cordis.patch.yml']
const NOTIFICATION_SETTINGS_PATH = '/api/dsh-desktop/notifications/settings'
const NOTIFICATION_SHOW_PATH = '/api/dsh-desktop/notifications/show'
const SHELL_OPEN_PATH = '/api/dsh-desktop/shell/open'
const SHELL_REVEAL_PATH = '/api/dsh-desktop/shell/reveal'
const MAX_PROXY_BODY_BYTES = 16_384
export const STATIC_GUIDANCE = `DeepSeek Harness is running inside DFY DSH Desktop. The tool schemas attached to the current model request are the authoritative callable set for this same turn. If the user names a tool that is present in that set, call it directly now: do not inspect the registry first, execute its implementation through a shell, import its source, simulate it, or claim it will only be callable on a later turn. After a Harness restart, the first resumed user turn already receives the rebuilt callable set. The desktop's optional Patch configuration is equivalent to adding \`dsh web --patch <file>\`: it overlays the normal web Profile after its bundle and user layers, and takes effect after Harness restarts. A Patch is useful for local plugin development, entry enable/disable, and configuration experiments, but it is not a separate debug runtime and does not install dependencies; any package or file inserted by the Patch must already be resolvable. For durable profile plugins, use \`dsh plugin --profile web add <package>\` with a package that declares a dsh bundle. The desktop also provides the ${RESTART_TOOL_NAME} tool. Only when a requested tool is absent because a Profile plugin was installed, removed, or changed after this Harness process started, verify the current tool catalog at most once, then use ${RESTART_TOOL_NAME} instead of creating a temporary duplicate or executing the missing tool indirectly. The restart requires user approval and ends the current turn.`
const STALE_CONTEXT = `DFY DSH Desktop detected that the active web Profile changed after this Harness process started. Newly installed or changed tools are not mounted in the current process. Use ${RESTART_TOOL_NAME} when the user wants those changes loaded.`

export function createRestartTool(controlUrl, controlToken, fetchImpl = fetch) {
  return {
    name: RESTART_TOOL_NAME,
    description: 'Request a user-approved restart of the Harness background process so newly installed or changed Profile plugins and tools are loaded. DFY DSH Desktop reconnects the current interface after restart.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Short user-facing reason for restarting Harness.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    async execute(args, exec) {
      const reason = typeof args.reason === 'string' && args.reason.trim().length > 0
        ? args.reason.trim()
        : '加载已变更的 Harness 插件配置'
      const response = await fetchImpl(controlUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${controlToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason }),
        signal: AbortSignal.timeout(5_000),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || payload.accepted !== true) {
        const message = typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`
        throw new Error(`Desktop rejected the Harness restart request: ${message}`)
      }
      exec.concludeTurn()
      return 'Harness 将立即重启并自动重新连接。重启完成后，请继续调用刚安装的工具。'
    },
  }
}

export async function apply(ctx, overrides = {}) {
  const controlUrl = overrides.controlUrl ?? process.env.DSH_DESKTOP_CONTROL_URL
  const controlToken = overrides.controlToken ?? process.env.DSH_DESKTOP_CONTROL_TOKEN
  const profilePath = overrides.profilePath ?? process.env.DSH_DESKTOP_PROFILE_PATH
  if (!controlUrl || !controlToken || !profilePath) {
    throw new Error('dsh-desktop-bridge requires the DFY DSH Desktop environment')
  }

  ctx.tools.register(createRestartTool(controlUrl, controlToken))
  registerDesktopRoutes(ctx, controlUrl, controlToken)
  ctx.systemPrompt.section({
    name: 'desktop:restart-guidance',
    order: 185,
    text: STATIC_GUIDANCE,
  })

  let baseline = await profileFingerprint(profilePath)
  let profileChanged = false
  ctx.systemPrompt.context({
    name: 'desktop:profile-restart-required',
    order: 80,
    text: () => profileChanged ? STALE_CONTEXT : '',
  })

  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.name !== RESTART_TOOL_NAME) return await next()
    const requestedReason = execution.arguments && typeof execution.arguments === 'object'
      && typeof execution.arguments.reason === 'string'
      ? execution.arguments.reason.trim().slice(0, 240)
      : ''
    return {
      kind: 'ask',
      reason: requestedReason.length > 0
        ? `Harness 需要重启：${requestedReason}`
        : 'Harness 需要重启以加载插件配置变更。',
    }
  })

  let refreshTimer
  const refresh = () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      void profileFingerprint(profilePath).then((current) => {
        const changed = current !== baseline
        if (changed === profileChanged) return
        profileChanged = changed
        ctx.emit('system-prompt/change')
      })
    }, 120)
    refreshTimer.unref?.()
  }

  // Poll the two relevant files directly instead of watching the directory.
  // On Windows, fs.watch can abort inside libuv when the directory path and its
  // resolved long-path form differ (for example in a temporary or 8.3 path).
  const watchedFiles = PROFILE_FILES.map((file) => join(profilePath, file))
  for (const file of watchedFiles) {
    watchFile(file, { persistent: false, interval: 250 }, refresh)
  }

  return () => {
    clearTimeout(refreshTimer)
    for (const file of watchedFiles) unwatchFile(file, refresh)
    baseline = ''
  }
}

function registerDesktopRoutes(ctx, controlUrl, controlToken) {
  ctx.webServer.register({
    kind: 'exact',
    path: NOTIFICATION_SETTINGS_PATH,
    async handler(request, response) {
      if (request.method !== 'GET' && request.method !== 'PUT') {
        response.writeHead(405, { allow: 'GET, PUT' })
        response.end()
        return
      }
      await proxyDesktopRequest(request, response, controlUrl, controlToken, '/v1/notifications/settings')
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: NOTIFICATION_SHOW_PATH,
    async handler(request, response) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      await proxyDesktopRequest(request, response, controlUrl, controlToken, '/v1/notifications/show')
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: SHELL_OPEN_PATH,
    async handler(request, response) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      await proxyDesktopRequest(request, response, controlUrl, controlToken, '/v1/shell/open')
    },
  })
  ctx.webServer.register({
    kind: 'exact',
    path: SHELL_REVEAL_PATH,
    async handler(request, response) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      await proxyDesktopRequest(request, response, controlUrl, controlToken, '/v1/shell/reveal')
    },
  })
}

async function proxyDesktopRequest(request, response, controlUrl, controlToken, pathname) {
  const endpoint = new URL(controlUrl)
  endpoint.pathname = pathname
  endpoint.search = ''
  endpoint.hash = ''
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await readProxyBody(request)
  const result = await fetch(endpoint, {
    method: request.method,
    headers: {
      authorization: `Bearer ${controlToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(5_000),
  })
  const payload = await result.text()
  response.writeHead(result.status, {
    'content-type': result.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(payload)
}

async function readProxyBody(request) {
  let body = ''
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    if (Buffer.byteLength(body, 'utf8') > MAX_PROXY_BODY_BYTES) throw new Error('Desktop request is too large')
  }
  return body.length === 0 ? '{}' : body
}

async function profileFingerprint(profilePath) {
  const contents = await Promise.all(PROFILE_FILES.map(async (file) => {
    try {
      return await readFile(join(profilePath, file), 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') return ''
      throw error
    }
  }))
  return contents.join('\u0000')
}
