import { useLayoutEffect, useRef, useState } from 'react'

/** Keep the pane at its full width while sliding it, so the page never squashes. */
export function useBrowserPanelTransition(
  open: boolean,
  overlay: boolean,
  animate: boolean,
  onLayout: () => void,
) {
  const paneRef = useRef<HTMLElement>(null)
  const progress = useRef(0)
  const layoutCallback = useRef(onLayout)
  const [retained, setRetained] = useState(open)
  const [phase, setPhase] = useState<'entering' | 'leaving'>()
  const mounted = open || retained

  useLayoutEffect(() => { layoutCallback.current = onLayout }, [onLayout])

  useLayoutEffect(() => {
    const pane = paneRef.current
    if (!mounted || pane === null) return
    if (open) setRetained(true)
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const from = progress.current
    const to = open ? 1 : 0
    const duration = (open ? 220 : 180) * Math.abs(to - from)
    let frame = 0

    const apply = (value: number): void => {
      progress.current = value
      const offset = pane.offsetWidth * (1 - value)
      // A split pane releases the same amount of space to the conversation.
      // Overlay panes move without changing the conversation's layout.
      pane.style.marginRight = overlay ? '' : `${-offset}px`
      pane.style.transform = overlay ? `translateX(${offset}px)` : ''
      layoutCallback.current()
    }
    const finish = (): void => {
      cancelAnimationFrame(frame)
      apply(to)
      if (open) {
        pane.style.removeProperty('margin-right')
        pane.style.removeProperty('transform')
      }
      setPhase(undefined)
      setRetained(open)
    }
    const onMotionChange = (): void => { if (motion.matches) finish() }

    if (!animate || motion.matches || duration < 1) {
      finish()
      return
    }
    setPhase(open ? 'entering' : 'leaving')
    apply(from)
    const started = performance.now()
    const tick = (now: number): void => {
      const elapsed = Math.max(0, Math.min(1, (now - started) / duration))
      if (elapsed >= 1) {
        finish()
        return
      }
      apply(from + (to - from) * (1 - (1 - elapsed) ** 3))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    motion.addEventListener('change', onMotionChange)
    return () => {
      cancelAnimationFrame(frame)
      motion.removeEventListener('change', onMotionChange)
    }
  }, [animate, mounted, open, overlay])

  return { paneRef, mounted, phase }
}
