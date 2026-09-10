// Role matching follows accessibility visibility, not pointer actionability:
// offscreen, transparent and display:contents elements may still have a role.
export const BROWSER_ROLE_VISIBILITY_HELPERS = String.raw`
  const accessibleByRole = (element) => {
    if (!element.isConnected) return false;
    const visibility = getComputedStyle(element).visibility;
    if (visibility === 'hidden' || visibility === 'collapse') return false;
    for (let current = element; current; current = current.parentElement ?? current.getRootNode()?.host ?? null) {
      if (String(current.getAttribute('aria-hidden') ?? '').trim().toLowerCase() === 'true' || current.inert) return false;
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.contentVisibility === 'hidden') return false;
    }
    return true;
  };
`
