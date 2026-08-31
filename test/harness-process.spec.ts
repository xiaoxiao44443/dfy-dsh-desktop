import { describe, expect, it } from 'vitest'
import {
  buildHarnessArguments,
  isHarnessHealthStatus,
  parseHarnessPublishedUrl,
  withHarnessStartupOutput,
} from '../src/main/harness-process.js'

describe('Harness launch arguments', () => {
  it('keeps every DSH launcher patch before web application options', () => {
    expect(buildHarnessArguments('desktop.patch.yml', 'recovery.patch.yml', {
      patchPath: 'development.patch.yml',
    })).toEqual([
      'web',
      '--patch', 'desktop.patch.yml',
      '--patch', 'development.patch.yml',
      '--patch', 'recovery.patch.yml',
      '--no-open',
      '--port', '0',
    ])
  })
})

describe('Harness startup diagnostics', () => {
  it('preserves alpha authentication parameters from the published URL', () => {
    expect(parseHarnessPublishedUrl(
      'dsh web: http://127.0.0.1:62751/?token=secret-token\n',
    )).toBe('http://127.0.0.1:62751/?token=secret-token')
    expect(parseHarnessPublishedUrl('dsh web: http://localhost:62751/?token=secret')).toBeUndefined()
  })

  it('accepts the alpha token-to-cookie redirect as a healthy response', () => {
    expect(isHarnessHealthStatus(200)).toBe(true)
    expect(isHarnessHealthStatus(303)).toBe(true)
    expect(isHarnessHealthStatus(401)).toBe(false)
    expect(isHarnessHealthStatus(500)).toBe(false)
  })

  it('keeps the captured process error with the generic exit message', () => {
    const error = withHarnessStartupOutput(
      new Error('Harness exited before startup (1)'),
      '\u001b[31mError: EPERM: operation not permitted, stat runtime-link\u001b[0m\n',
    )

    expect(error.message).toContain('Harness exited before startup (1)')
    expect(error.message).toContain('Error: EPERM: operation not permitted, stat runtime-link')
    expect(error.message).not.toContain('\u001b[31m')
  })
})
