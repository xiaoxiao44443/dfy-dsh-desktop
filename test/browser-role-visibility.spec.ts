import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { BROWSER_ROLE_VISIBILITY_HELPERS } from '../src/main/browser-role-visibility.js'

interface RoleElement {
  isConnected: boolean
  parentElement: RoleElement | null
  inert: boolean
  attributes: Record<string, string>
  style: Record<string, string>
  getRootNode(): { host: RoleElement | null }
  getAttribute(name: string): string | null
}

function element(options: { style?: Record<string, string>; attributes?: Record<string, string>; parent?: RoleElement; inert?: boolean } = {}): RoleElement {
  return {
    isConnected: true, parentElement: options.parent ?? null, inert: options.inert ?? false,
    attributes: options.attributes ?? {}, style: { display: 'block', visibility: 'visible', ...options.style },
    getRootNode: () => ({ host: null }), getAttribute(name) { return this.attributes[name] ?? null },
  }
}

function accessible(target: RoleElement): boolean {
  return vm.runInNewContext(`(() => { ${BROWSER_ROLE_VISIBILITY_HELPERS}; return accessibleByRole(target); })()`, {
    target, getComputedStyle: (current: RoleElement) => current.style,
  }) as boolean
}

describe('role locator accessibility visibility', () => {
  it.each([
    { style: { display: 'none' } },
    { style: { visibility: 'hidden' } },
    { style: { visibility: 'collapse' } },
    { style: { contentVisibility: 'hidden' } },
    { attributes: { 'aria-hidden': 'true' } },
    { inert: true },
  ])('excludes inaccessible elements: %o', (options) => {
    expect(accessible(element(options))).toBe(false)
  })

  it('excludes display:none and aria-hidden ancestors, including shadow hosts', () => {
    expect(accessible(element({ parent: element({ style: { display: 'none' } }) }))).toBe(false)
    expect(accessible(element({ attributes: { 'aria-hidden': 'false' }, parent: element({ attributes: { 'aria-hidden': 'true' } }) }))).toBe(false)
    const child = element()
    child.getRootNode = () => ({ host: element({ attributes: { 'aria-hidden': 'true' } }) })
    expect(accessible(child)).toBe(false)
  })

  it('keeps opacity:0, display:contents and offscreen elements without consulting rectangles', () => {
    expect(accessible(element({ style: { opacity: '0' } }))).toBe(true)
    expect(accessible(element({ style: { display: 'contents' } }))).toBe(true)
    expect(accessible(element({ style: { position: 'fixed', left: '3000px' } }))).toBe(true)
  })

  it('uses the target computed visibility so visible descendants can override hidden ancestors', () => {
    expect(accessible(element({ style: { visibility: 'visible' }, parent: element({ style: { visibility: 'hidden' } }) }))).toBe(true)
  })
})
