import { validRange } from 'semver'
import type { DfyPluginDefinition } from './contracts.js'

const DFY_PLUGIN_REPOSITORY_URL = 'https://github.com/xiaoxiao44443/dfy-dsh-plugins'
export const DFY_PLUGIN_CATALOG_URL = 'https://raw.githubusercontent.com/xiaoxiao44443/dfy-dsh-plugins/main/catalog.json'

// Used until the remote directory is available, including on a first offline launch.
export const DFY_PLUGINS: DfyPluginDefinition[] = [
  { name: '@dfy-plugins/dsh-wallpaper', title: '壁纸', category: '界面', description: '为主界面、设置面板和右侧栏分别设置背景图片与显示效果。' },
  { name: '@dfy-plugins/dsh-appearance', title: '外观', category: '界面', description: '调整对话字号、过程轨迹折叠和本地文件的打开方式。' },
  { name: '@dfy-plugins/dsh-archive-manager', title: '归档管理', category: '对话', description: '按项目浏览归档对话，支持恢复和永久删除。' },
  { name: '@dfy-plugins/dsh-media-blocks', title: '媒体内容', category: '图片', description: '展示持久图片内容，并为视觉和生图插件提供媒体增强。' },
  { name: '@dfy-plugins/dsh-vision', title: '视觉理解', category: '图片', description: '使用独立视觉模型分析图片，让文本模型也能理解图片。', note: '安装后需配置视觉模型。' },
  { name: '@dfy-plugins/dsh-image-generation', title: '图像生成', category: '图片', description: '在对话中生成和编辑图片，支持参考图与结果预览。', note: '安装后需配置图片模型。' },
  { name: '@dfy-plugins/dsh-visualize', title: '交互可视化', category: '工具', description: '将工作区 HTML 展示为对话内可交互的可视化内容。' },
  { name: '@dfy-plugins/dsh-turn-guard', title: '任务守卫', category: '工具', description: '提供任务收敛提醒、重复调用检测和单轮执行预算。' },
  { name: '@dfy-plugins/dsh-codex-bridge', title: 'Codex 连接', category: '连接', description: '让 Codex 访问 Harness 的活动会话、工具与 Skills。', note: 'Codex 端还需安装 DFY DSH 伴生插件。' },
].map((entry) => ({ ...entry, repository: `${DFY_PLUGIN_REPOSITORY_URL}/tree/main/plugins/${entry.name.replace('@dfy-plugins/dsh-', '')}` }))

export function parseDfyPluginCatalog(value: unknown): DfyPluginDefinition[] {
  const record = (entry: unknown): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  if (!record(value) || value.version !== 1 || !Array.isArray(value.plugins) || value.plugins.length > 100) {
    throw new Error('插件目录格式无效。')
  }
  const names = new Set<string>()
  const field = (entry: Record<string, unknown>, key: string, maxLength: number): string => {
    const text = entry[key]
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > maxLength) throw new Error('插件目录字段无效。')
    return text.trim()
  }
  return value.plugins.map((entry: unknown) => {
    if (!record(entry)) throw new Error('插件目录条目无效。')
    const name = field(entry, 'name', 214)
    if (!/^@dfy-plugins\/[a-z0-9][a-z0-9._-]*$/u.test(name) || names.has(name)) throw new Error('插件目录包名无效或重复。')
    names.add(name)
    const repository = new URL(field(entry, 'repository', 500))
    if (repository.protocol !== 'https:' || repository.hostname !== 'github.com' || repository.port || repository.username || repository.password || !/^\/[^/]+\/[^/]+(?:\/|$)/u.test(repository.pathname)) {
      throw new Error('插件目录 GitHub 地址无效。')
    }
    return {
      name,
      repository: repository.href,
      title: field(entry, 'title', 48),
      category: field(entry, 'category', 16),
      description: field(entry, 'description', 400),
      ...(entry.note === undefined ? {} : { note: field(entry, 'note', 200) }),
    }
  })
}

export function isDfyRegistrySource(source: string): boolean {
  // A catalog action must not replace Git, directory, tarball or npm alias sources.
  return source.length > 0 && (validRange(source) !== null || /^[a-z][a-z0-9._-]*$/iu.test(source))
}
