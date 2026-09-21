export interface BrowserPointerPoint {
  x: number
  y: number
}

// This only paints the agent indicator. Page input is dispatched separately,
// once the indicator arrives; intermediate frames must never become input.
export class BrowserPointerMotion {
  private position: BrowserPointerPoint | undefined
  private generation = 0

  constructor(private readonly paint: (point: BrowserPointerPoint, pressed: boolean) => void) {}

  reset(): void {
    this.generation += 1
    this.position = undefined
  }

  place(point: BrowserPointerPoint, pressed: boolean): void {
    this.generation += 1
    this.position = { ...point }
    this.paint(point, pressed)
  }

  async move(target: BrowserPointerPoint, isValid: () => boolean): Promise<void> {
    const generation = ++this.generation
    const origin = this.position
    const distance = origin === undefined ? 0 : Math.hypot(target.x - origin.x, target.y - origin.y)
    const duration = distance < 1 ? 0 : Math.min(350, 150 + distance * 0.22)
    const started = performance.now()

    for (;;) {
      if (generation !== this.generation || !isValid()) {
        throw new Error('指针移动已取消：页面、标签状态或当前操作已改变。')
      }
      const progress = duration === 0 ? 1 : Math.min(1, (performance.now() - started) / duration)
      // Smoothstep gives a straight path with acceleration and deceleration.
      const eased = progress * progress * (3 - 2 * progress)
      const point = origin === undefined || progress === 1 ? { ...target } : {
        x: origin.x + (target.x - origin.x) * eased,
        y: origin.y + (target.y - origin.y) * eased,
      }
      this.position = point
      this.paint(point, false)
      if (progress === 1) return
      await new Promise<void>((resolve) => setTimeout(resolve, 16))
    }
  }
}
