import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { PluginFailurePanel } from '../src/renderer/PluginFailurePanel.js'

it('distinguishes refused bundles from failed components and only offers to disable actual failures', () => {
  const html = renderToStaticMarkup(createElement(PluginFailurePanel, {
    failures: [
      { entryId: '@example/bundle', pluginName: '@example/bundle', scope: 'bundle', blockedByCompatibility: true,
        recoverable: false, detail: '插件版本不兼容' },
      { entryId: 'broken', pluginName: '@example/broken', recoverable: true, detail: 'apply failed' },
    ], pending: false, error: undefined, onRecover: () => {},
  }))
  expect(html).toContain('已阻止加载')
  expect(html).toContain('<dt>组合包</dt>')
  expect(html).toContain('无需再次临时禁用')
  expect(html).toContain('临时禁用所选（1）并重启')
  expect(html.match(/type="checkbox"/gu)).toHaveLength(1)
  expect(html).not.toContain('这些插件属于 Harness 内置组件')
})
