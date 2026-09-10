// Shared by locator actionability and coordinate actions in the page realm.
export const BROWSER_HIT_TARGET_HELPERS = String.raw`
  const composedParent = (element) => element.parentElement ?? element.getRootNode()?.host ?? null;
  const containsHit = (element, hit) => {
    for (let current = hit; current; current = composedParent(current)) {
      if (current === element) return true;
    }
    return false;
  };
  const hitElementAt = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    for (let depth = 0; hit?.shadowRoot && depth < 20; depth += 1) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  const clickablePoint = (element) => {
    const viewport = window.visualViewport;
    let left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    let right = left + (viewport?.width ?? innerWidth), bottom = top + (viewport?.height ?? innerHeight);
    const viewportBounds = { left, top, right, bottom };
    for (let parent = composedParent(element); parent; parent = composedParent(parent)) {
      const style = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (/(hidden|clip|auto|scroll)/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
      if (/(hidden|clip|auto|scroll)/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
    }
    let inViewport = false;
    for (const rect of element.getClientRects()) {
      // Fixed/absolute descendants can escape an ancestor's overflow clip.
      // Try its clipped region first, then let the browser hit test decide
      // whether any remaining viewport region is actually reachable.
      for (const bounds of [{ left, top, right, bottom }, viewportBounds]) {
        const x1 = Math.max(bounds.left, rect.left), x2 = Math.min(bounds.right, rect.right);
        const y1 = Math.max(bounds.top, rect.top), y2 = Math.min(bounds.bottom, rect.bottom);
        if (x2 - x1 < 1 || y2 - y1 < 1) continue;
        inViewport = true;
        const xs = [(x1 + x2) / 2, x1 + Math.min(1, (x2 - x1) / 4), x2 - Math.min(1, (x2 - x1) / 4)];
        const ys = [(y1 + y2) / 2, y1 + Math.min(1, (y2 - y1) / 4), y2 - Math.min(1, (y2 - y1) / 4)];
        for (const y of ys) for (const x of xs) {
          if (containsHit(element, hitElementAt(x, y))) return { x, y, inViewport: true, hitTarget: true };
        }
      }
    }
    return { inViewport, hitTarget: false };
  };
`
