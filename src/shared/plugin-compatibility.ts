import type { PluginCompatibilityIssue } from './contracts.js'

export function describePluginCompatibility(issue: PluginCompatibilityIssue): string {
  const requirements = Object.entries(issue.requirements ?? issue.peers ?? {})
    .map(([name, range]) => `${name === 'engines.dsh' ? 'DSH' : name} ${range}`).join('；') || '未提供版本范围'
  return `${issue.name}@${issue.version} 与当前 DSH ${issue.runtimeVersion} 不兼容；要求：${requirements}。`
}
