import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { DesktopBrowserService } from '../src/main/desktop-browser.js'
import type { BrowserTabRuntime } from '../src/main/desktop-browser-types.js'
import type { BrowserScreenshotMetadata, CssScreenshotRect } from '../src/main/browser-screenshot-store.js'

function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return png
}

function setup(viewport: { width: number; height: number }, imageSize: { width: number; height: number }, pngSize = imageSize) {
  const makeImage = (size: typeof imageSize, encodedSize = size): object => ({
    isEmpty: () => false,
    getSize: () => size,
    crop: (rect: CssScreenshotRect) => makeImage({ width: rect.width, height: rect.height }),
    toPNG: () => pngHeader(encodedSize.width, encodedSize.height),
  })
  const release = vi.fn()
  const debuggerCommandFor = vi.fn(async (_tab: BrowserTabRuntime, method: string, params?: { expression: string }) => {
    if (method === 'Runtime.evaluate') {
      return { result: { value: runInNewContext(params!.expression, {
        innerWidth: viewport.width,
        innerHeight: viewport.height,
        scrollX: 100,
        scrollY: 200,
      }) } }
    }
    // Chromium excludes classic scrollbars from both CDP client viewports,
    // whereas Electron's capturePage includes them in the image.
    if (method === 'Page.getLayoutMetrics') return {
      cssVisualViewport: { clientWidth: viewport.width - 15, clientHeight: viewport.height - 15, pageX: 100, pageY: 200 },
      cssLayoutViewport: { clientWidth: viewport.width - 15, clientHeight: viewport.height - 15, pageX: 100, pageY: 200 },
    }
    throw new Error(`Unexpected command: ${method}`)
  })
  const service = Object.assign(Object.create(DesktopBrowserService.prototype), {
    debuggerCommandFor,
    capturePageImage: async () => ({ image: makeImage(imageSize, pngSize), release }),
    screenshotStore: {
      save: async (_data: Buffer, metadata: BrowserScreenshotMetadata) => ({ ...metadata, resourceId: 'test-image' }),
    },
  }) as { captureScreenshot(tab: BrowserTabRuntime, kind: string, rect?: CssScreenshotRect): Promise<BrowserScreenshotMetadata> }
  const tab = { id: 'screenshot-test', url: 'https://example.com/', view: { webContents: { getURL: () => 'https://example.com/' } } } as unknown as BrowserTabRuntime
  return { service, tab, release }
}

describe('browser screenshot coordinate metadata', () => {
  it('maps a scaled full screenshot back to viewport CSS pixels without adding scroll offsets', async () => {
    const { service, tab, release } = setup({ width: 1280, height: 800 }, { width: 640, height: 400 })
    const result = await service.captureScreenshot(tab, 'viewport')
    expect(result).toMatchObject({
      width: 640, height: 400, viewportWidth: 1280, viewportHeight: 800,
      scrollX: 100, scrollY: 200,
      coordinateMapping: { originX: 0, originY: 0, cssPixelsPerImagePixelX: 2, cssPixelsPerImagePixelY: 2 },
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it('uses the encoded PNG dimensions when NativeImage reports a different DIP size', async () => {
    const { service, tab } = setup({ width: 1280, height: 800 }, { width: 640, height: 400 }, { width: 1280, height: 800 })
    const result = await service.captureScreenshot(tab, 'viewport')
    expect(result).toMatchObject({
      width: 1280, height: 800,
      coordinateMapping: { originX: 0, originY: 0, cssPixelsPerImagePixelX: 1, cssPixelsPerImagePixelY: 1 },
    })
  })

  it('maps screenshots including both scrollbars with the full CSS surface dimensions', async () => {
    const { service, tab } = setup({ width: 1280, height: 800 }, { width: 917, height: 574 })
    const result = await service.captureScreenshot(tab, 'viewport')
    expect(result).toMatchObject({
      viewportWidth: 1280, viewportHeight: 800,
      scrollX: 100, scrollY: 200,
      coordinateMapping: {
        originX: 0, originY: 0,
        cssPixelsPerImagePixelX: 1280 / 917,
        cssPixelsPerImagePixelY: 800 / 574,
      },
    })
    expect(129 * result.coordinateMapping!.cssPixelsPerImagePixelY).toBeCloseTo(180, 0)
  })

  it('rejects unavailable surface dimensions instead of returning a misleading coordinate mapping', async () => {
    const { service, tab, release } = setup({ width: 0, height: 800 }, { width: 917, height: 574 })
    await expect(service.captureScreenshot(tab, 'viewport')).rejects.toThrow('无法读取当前网页视口尺寸')
    expect(release).not.toHaveBeenCalled()
  })

  it('includes the actual rounded crop origin for element and rectangle screenshots', async () => {
    const { service, tab } = setup({ width: 800, height: 600 }, { width: 1600, height: 1200 })
    const result = await service.captureScreenshot(tab, 'rect', { x: 10.25, y: 20.25, width: 100.5, height: 50.5 })
    expect(result).toMatchObject({
      width: 202, height: 102,
      rect: { x: 10.25, y: 20.25, width: 100.5, height: 50.5 },
      coordinateMapping: { originX: 10, originY: 20, cssPixelsPerImagePixelX: 0.5, cssPixelsPerImagePixelY: 0.5 },
    })
  })
})
