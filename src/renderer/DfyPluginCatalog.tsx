import { ChevronRight, Download, Link2, RefreshCw } from 'lucide-react'
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { gt, valid } from 'semver'
import type { DfyPluginCatalog as Catalog, DfyPluginMutationRequest, ManagedPluginEntry } from '../shared/contracts.js'
import { DFY_PLUGINS, isDfyRegistrySource } from '../shared/dfy-plugins.js'

interface Props {
  plugins: ManagedPluginEntry[]
  query: string
  disabled: boolean
  catalog?: Catalog
  loading: boolean
  onReload: () => void
  onOpenRepository: (packageName: string) => void
  onMutate: (action: DfyPluginMutationRequest['action'], packageNames: string[]) => Promise<boolean>
  onManage: (packageName: string) => void
}

export function DfyPluginCatalog({ plugins, query, disabled, catalog, loading, onReload, onOpenRepository, onMutate, onManage }: Props): ReactNode {
  const [selected, setSelected] = useState<string[]>([])
  const [pending, setPending] = useState<string[]>([])
  const busy = useRef(false)

  const installed = new Map(plugins.map((plugin) => [plugin.name, plugin]))
  const entries = catalog?.plugins ?? DFY_PLUGINS
  const versions = new Map(catalog?.releases.map((release) => [release.name, release.version]))
  const registry = (plugin: ManagedPluginEntry): boolean => plugin.sourceType === 'npm' && isDfyRegistrySource(plugin.source)
  const linked = (plugin: ManagedPluginEntry): boolean => plugin.sourceType === 'local' && /^link:/iu.test(plugin.source)
  const installable = (name: string): boolean => {
    const plugin = installed.get(name)
    return plugin === undefined || (registry(plugin) && plugin.status === 'missing')
  }
  const matching = entries.filter((plugin) => `${plugin.title} ${plugin.name} ${plugin.description} ${plugin.category}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const selectable = matching.filter((plugin) => installable(plugin.name)).map((plugin) => plugin.name)
  const selection = selected.filter((name) => entries.some((entry) => entry.name === name) && installable(name))
  const readyPlugins = entries.map(({ name }) => installed.get(name)).filter((plugin): plugin is ManagedPluginEntry => plugin?.status === 'ready')
  const linkCount = readyPlugins.filter(linked).length
  const showSelection = selectable.length > 0 || selection.length > 0
  const updates = entries.filter(({ name }) => {
    const plugin = installed.get(name)
    return plugin !== undefined && registry(plugin) && plugin.status === 'ready'
  }).map(({ name }) => name)
  const locked = disabled || pending.length > 0

  const mutate = async (action: DfyPluginMutationRequest['action'], names: string[]): Promise<void> => {
    if (locked || busy.current || names.length === 0) return
    busy.current = true
    setPending(names)
    try {
      if (await onMutate(action, names)) setSelected((previous) => previous.filter((name) => !names.includes(name)))
    } finally {
      setPending([])
      busy.current = false
    }
  }

  return <section className="dfy-catalog" aria-label="DFY 插件目录">
    <div className="dfy-catalog-toolbar">
      <div className="dfy-selection-actions">
        {showSelection ? <>
          <button type="button" disabled={locked || selectable.length === 0} onClick={() => setSelected((previous) => [...new Set([...previous, ...selectable])])}>选择未安装</button>
          {selection.length > 0 ? <button type="button" disabled={locked} onClick={() => setSelected([])}>取消选择</button> : null}
          <span>已选 {selection.length} 个</span>
        </> : <span>已安装 {readyPlugins.length} / {entries.length} 个{linkCount > 0 ? ` · 本地链接 ${linkCount} 个` : ''}</span>}
      </div>
      {updates.length > 0 || showSelection ? <div className="dfy-batch-actions">
        {updates.length > 0 ? <button className="compact-button" type="button" disabled={locked} onClick={() => void mutate('update', updates)}><RefreshCw />更新 npm 插件 ({updates.length})</button> : null}
        {showSelection ? <button className="dialog-button primary" type="button" disabled={locked || selection.length === 0} onClick={() => void mutate('install', selection)}><Download />安装所选{selection.length > 0 ? ` (${selection.length})` : ''}</button> : null}
      </div> : linkCount > 0 ? <span className="dfy-local-note"><Link2 aria-hidden="true" />本地链接请在源码目录更新</span> : null}
    </div>
    {catalog?.error ? <div className="dfy-catalog-notice" role="status"><span>{catalog.error}</span><button type="button" disabled={loading} onClick={onReload}>重试</button></div> : null}
    <div className="dfy-plugin-grid" aria-busy={loading || pending.length > 0}>
      {matching.map((entry) => {
        const plugin = installed.get(entry.name)
        const latest = versions.get(entry.name)
        const canInstall = installable(entry.name)
        const fromNpm = plugin !== undefined && registry(plugin)
        const fromLink = plugin !== undefined && linked(plugin)
        const hasUpdate = fromNpm && latest !== undefined && valid(plugin.version) !== null && gt(latest, plugin.version!)
        const sameVersion = fromNpm && latest !== undefined && plugin.version === latest
        const active = pending.includes(entry.name)
        const sourceLabel = fromLink ? '本地链接' : plugin?.sourceType === 'local' ? '本地来源' : plugin?.sourceType === 'git' ? 'Git 来源' : plugin?.sourceType === 'workspace' ? '工作区来源' : '其他来源'
        const stateLabel = active ? '处理中…' : plugin === undefined ? '未安装' : plugin.status === 'missing' ? fromLink ? '链接失效' : '来源失效' : hasUpdate ? '可更新' : plugin.active ? '已启用' : '已停用'
        return <article className={`dfy-plugin-card${selection.includes(entry.name) ? ' selected' : ''}`} key={entry.name}>
          <div className="dfy-plugin-card-title">
            {canInstall ? <label><input type="checkbox" aria-label={`选择${entry.title}`} checked={selection.includes(entry.name)} disabled={locked} onChange={(event) => setSelected((previous) => event.target.checked ? [...new Set([...previous, entry.name])] : previous.filter((name) => name !== entry.name))} /><strong>{entry.title}</strong></label> : <strong className="dfy-plugin-title">{entry.title}</strong>}
            <span className="dfy-plugin-category">{entry.category}</span>
          </div>
          <p className="dfy-plugin-description">{entry.description}</p>
          <code className="dfy-plugin-package" title={entry.name}>{entry.name}</code>
          {'note' in entry ? <p className="dfy-plugin-note">{entry.note}</p> : null}
          <div className="dfy-plugin-card-footer">
            <div className="dfy-plugin-version">
              {plugin && !fromNpm ? <>
                <span className="dfy-plugin-source" title={plugin.source}>{fromLink ? <Link2 aria-hidden="true" /> : null}{sourceLabel}</span>
                <span>{plugin.version ? `v${plugin.version}` : '版本未知'}</span>
                {latest && latest !== plugin.version ? <span title="npm 发布版本；本地与 Git 来源需通过各自来源更新">npm {latest}</span> : null}
              </> : <><span>npm {latest ?? (loading ? '查询中…' : '版本未知')}</span>{plugin ? <span>当前 {plugin.version ?? '版本未知'}</span> : null}</>}
              <span className={`dfy-plugin-state${hasUpdate ? ' update' : ''}${plugin?.status === 'missing' ? ' error' : ''}${plugin?.status === 'ready' && !hasUpdate && !active ? plugin.active ? ' enabled' : ' inactive' : ''}`}>{stateLabel}</span>
            </div>
            <div className="dfy-plugin-actions">
              <button className="dfy-github-button" type="button" aria-label={`在 GitHub 查看${entry.title}`} title={`在 GitHub 查看${entry.title}`} onClick={() => onOpenRepository(entry.name)}>
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 .297C5.37 .297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.087-.744.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.467-1.334-5.467-5.931 0-1.31.469-2.381 1.236-3.221-.124-.303-.536-1.524.117-3.176 0 0 1.008-.322 3.301 1.23a11.52 11.52 0 0 1 3.003-.404c1.02.005 2.047.138 3.003.404 2.291-1.552 3.297-1.23 3.297-1.23.655 1.652.243 2.873.12 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.628-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.015 2.898-.015 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
              </button>
            {canInstall ? <button className="compact-button" type="button" disabled={locked} onClick={() => void mutate('install', [entry.name])}>{active ? '处理中…' : plugin ? '重新安装' : '安装'}</button>
              : fromNpm ? <button className="compact-button" type="button" disabled={locked || sameVersion} onClick={() => void mutate('update', [entry.name])}>{active ? '更新中…' : sameVersion ? '已是最新' : '更新'}</button>
                : <button className="dfy-manage-button" type="button" disabled={locked} onClick={() => onManage(entry.name)}><span>管理</span><ChevronRight aria-hidden="true" /></button>}
            </div>
          </div>
        </article>
      })}
      {matching.length === 0 ? <div className="plugin-empty">没有匹配的 DFY 插件。</div> : null}
    </div>
  </section>
}
