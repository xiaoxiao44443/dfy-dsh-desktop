import { describe, expect, it } from 'vitest'
import { browserAddressForCopy, browserAddressForNavigation, formatBrowserAddress } from '../src/shared/browser-address-display.js'
import { normalizeBrowserAddress } from '../src/main/desktop-browser-utils.js'

describe('readable browser addresses', () => {
  it.each([
    ['file:///E:/%E9%A1%B9%E7%9B%AE/%E7%BD%91%E9%A1%B5.html', 'E:/项目/网页.html'],
    ['file:///Users/me/%E7%BD%91%E9%A1%B5.html', '/Users/me/网页.html'],
    ['http://localhost:8080/%E4%B8%AD%E6%96%87?q=1#part', 'localhost:8080/中文?q=1#part'],
    ['https://example.com/%E4%B8%AD%E6%96%87%20%23%25', 'example.com/中文 %23%25'],
  ])('hides the protocol for display but retains the complete URL for full copy and navigation: %s', (url, display) => {
    expect(formatBrowserAddress(url, { hideScheme: true })).toBe(display)
    expect(browserAddressForCopy(display, url, 0, display.length)).toBe(url)
    expect(browserAddressForNavigation(display, url)).toBe(url)
    expect(browserAddressForCopy(display, url, 0, display.length - 1)).toBe(display.slice(0, -1))
    expect(browserAddressForCopy(formatBrowserAddress(url), url, 0, formatBrowserAddress(url).length)).toBe(url)
  })

  it.each([
    ['file:///E:/%E9%A1%B9%E7%9B%AE%20%E6%96%87%E4%BB%B6/%E6%92%AD%E6%94%BE%E5%99%A8.html', 'file:///E:/项目 文件/播放器.html'],
    ['file:///Users/me/%E4%B8%AD%E6%96%87%20page.html', 'file:///Users/me/中文 page.html'],
    ['https://example.com/%F0%9F%98%80/%E4%B8%AD%E6%96%87?q=%E4%BD%A0%E5%A5%BD#%E7%AB%A0%E8%8A%82', 'https://example.com/😀/中文?q=你好#章节'],
  ])('shows readable Unicode while retaining the URL scheme: %s', (url, expected) => {
    expect(formatBrowserAddress(url)).toBe(expected)
    expect(browserAddressForNavigation(expected, url)).toBe(url)
    expect(normalizeBrowserAddress(expected, false)).toBe(url)
  })

  it('preserves literal percent signs, hashes and URL delimiters when displaying and editing a local path', () => {
    const url = 'file:///E:/%E4%B8%AD%E6%96%87%20%23%25%3F.html?mode=%2F%3F%26%3D%25#%E7%AB%A0%E8%8A%82'
    const display = 'file:///E:/中文 %23%25%3F.html?mode=%2F%3F%26%3D%25#章节'
    expect(formatBrowserAddress(url)).toBe(display)
    expect(browserAddressForNavigation(display, url)).toBe(url)
    expect(normalizeBrowserAddress(display.replace('中文', '新版'), false)).toBe(url.replace('%E4%B8%AD%E6%96%87', '%E6%96%B0%E7%89%88'))
  })

  it('does not decode ASCII escapes or double-decode a filename that resembles encoded Unicode', () => {
    const url = 'file:///E:/%25E4%25B8%25AD-%41%2f%5C%23%3f.html'
    expect(formatBrowserAddress(url)).toBe(url)
  })

  it.each(['%00', '%09', '%0A', '%0D', '%C2%80', '%C2%A0', '%E2%80%8B', '%E2%80%AE', '%EF%BB%BF', '%EF%B8%8F'])('keeps controls and invisible characters escaped: %s', (escaped) => {
    const url = `https://example.com/${escaped}/%E4%B8%AD%E6%96%87`
    expect(formatBrowserAddress(url)).toBe(`https://example.com/${escaped}/中文`)
  })

  it.each(['%FF', '%E4%B8', '%ZZ', '%ED%A0%80'])('retains malformed UTF-8 instead of throwing: %s', (escaped) => {
    expect(formatBrowserAddress(`https://example.com/${escaped}`)).toBe(`https://example.com/${escaped}`)
  })

  it('preserves terminal spaces in query/fragment values despite navigation trimming input', () => {
    const url = 'https://example.com/%E4%B8%AD%E6%96%87?q=hello%20world#end%20'
    const display = 'https://example.com/中文?q=hello world#end%20'
    expect(formatBrowserAddress(url)).toBe(display)
    expect(normalizeBrowserAddress(display, false)).toBe(url)
  })

  it('leaves edited user input and ordinary search text for the existing navigation normalizer', () => {
    expect(browserAddressForNavigation('example.com/新页面', 'https://example.com/old')).toBe('example.com/新页面')
    expect(browserAddressForNavigation('搜索词', 'file:///E:/page.html')).toBe('搜索词')
    expect(formatBrowserAddress('')).toBe('')
  })

  it('copies the exact original encoded address when the entire readable address is selected', () => {
    const url = 'file:///E:/%e9%a1%b9%e7%9b%ae%20%23%25.html?mode=%2f#%E7%AB%A0%E8%8A%82'
    const display = formatBrowserAddress(url)
    expect(browserAddressForCopy(display, url, 0, display.length)).toBe(url)
  })

  it('copies the visible text for partial Unicode, spaces, punctuation and emoji selections', () => {
    const url = 'https://example.com/%E9%A1%B9%E7%9B%AE%20%F0%9F%98%80%23%25.html#%E7%AB%A0%E8%8A%82'
    const display = formatBrowserAddress(url)
    for (const [selection, expected] of [
      ['项目 ', '项目 '],
      ['😀', '😀'],
      ['%23%25', '%23%25'],
      ['#章节', '#章节'],
      ['example.com', 'example.com'],
    ]) {
      const start = display.indexOf(selection!)
      expect(browserAddressForCopy(display, url, start, start + selection!.length)).toBe(expected)
    }
  })

  it('copies an edited valid URL as encoded text but preserves unsubmitted search text', () => {
    const edited = 'https://example.com/新页面%23.html'
    expect(browserAddressForCopy(edited, 'https://example.com/old', 0, edited.length)).toBe(new URL(edited).href)
    expect(browserAddressForCopy('搜索文字', 'https://example.com/', 0, 4)).toBe('搜索文字')
    const start = edited.indexOf('新页面')
    expect(browserAddressForCopy(edited, 'https://example.com/old', start, start + 3)).toBe('新页面')
  })

  it('encodes a fully selected edited URL containing both readable and already escaped Unicode', () => {
    const edited = 'https://example.com/新/%E4%B8%AD%23%25.html'
    expect(browserAddressForCopy(edited, 'https://example.com/old', 0, edited.length))
      .toBe('https://example.com/%E6%96%B0/%E4%B8%AD%23%25.html')
    const start = edited.indexOf('%E4')
    expect(browserAddressForCopy(edited, 'https://example.com/old', start, start + 9)).toBe('%E4%B8%AD')
  })
})
