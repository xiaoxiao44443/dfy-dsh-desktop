import { useEffect, useState } from 'react'
import type { PluginInitializationFailure } from '../shared/contracts.js'

export function PluginFailurePanel({ failures, pending, error, onRecover }: {
  failures: PluginInitializationFailure[]
  pending: boolean
  error: string | undefined
  onRecover(entryIds: string[]): void
}) {
  const available = failures.filter((failure) => failure.recoverable).map((failure) => failure.entryId)
  const selectionKey = available.join('\0')
  const [selected, setSelected] = useState(available)
  useEffect(() => { setSelected(selectionKey ? selectionKey.split('\0') : []) }, [selectionKey])
  const selectedIds = selected.filter((id) => available.includes(id))
  return <div className="plugin-failure-panel">
    <div className="plugin-failure-list">
      {failures.map((failure) => <article className="plugin-failure-card" key={`${failure.entryId}:${failure.pluginName}`}>
        <div className="plugin-failure-heading">
          {failure.recoverable ? <input type="checkbox" aria-label={`临时禁用 ${failure.displayName ?? failure.pluginName}`} checked={selectedIds.includes(failure.entryId)} disabled={pending} onChange={(event) => {
            setSelected((previous) => event.target.checked ? [...previous, failure.entryId] : previous.filter((id) => id !== failure.entryId))
          }} /> : null}
          <strong>{failure.displayName ?? failure.pluginName}</strong>
          {!failure.recoverable ? <span className="plugin-failure-protected">不能临时禁用</span> : null}
        </div>
        <dl>
          <dt>插件包</dt><dd><code>{failure.pluginName}</code></dd>
          {failure.bundleName ? <><dt>所属组合包</dt><dd>{failure.bundleTitle ? <span>{failure.bundleTitle}<br /></span> : null}<code>{failure.bundleName}</code></dd></> : null}
          <dt>插件条目</dt><dd><code>{failure.entryId}</code></dd>
          <dt>错误原因</dt><dd className="plugin-failure-reason">{failure.detail.split('\n')[0]}</dd>
        </dl>
        {failure.detail.includes('\n') ? <details className="plugin-failure-detail"><summary>完整错误</summary><pre>{failure.detail}</pre></details> : null}
      </article>)}
    </div>
    {available.length > 0 ? <div className="plugin-recovery-actions">
      <p>临时禁用所选插件后重启 Harness。组合包中的其他组件保留；修复后请在“开发工具 → 插件恢复”重新启用。</p>
      <div className="plugin-recovery-buttons">
        {available.length > 1 ? <button className="secondary-button" type="button" disabled={pending} onClick={() => setSelected(selectedIds.length === available.length ? [] : available)}>{selectedIds.length === available.length ? '取消全选' : '全选可禁用项'}</button> : null}
        <button className="secondary-button recovery-button" type="button" disabled={pending || selectedIds.length === 0} onClick={() => onRecover(selectedIds)}>{pending ? '正在禁用并重启…' : `临时禁用所选（${selectedIds.length}）并重启`}</button>
      </div>
    </div> : <p className="plugin-recovery-note">这些插件属于 Harness 内置组件，不能通过临时禁用恢复。请根据错误原因检查配置，或更新、修复相应的运行时。</p>}
    {error ? <p className="startup-action-error" role="alert">{error}</p> : null}
  </div>
}
