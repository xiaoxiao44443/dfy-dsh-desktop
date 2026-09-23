import type { PluginCompatibilityIssue } from './contracts.js'

export function describePluginCompatibility(issue: PluginCompatibilityIssue): string {
  const requirements = Object.entries(issue.peers).map(([name, range]) => `${name} ${range}`).join('；')
  return `${issue.name}@${issue.version} 与当前 DSH ${issue.runtimeVersion} 不兼容；要求：${requirements}。`
}
