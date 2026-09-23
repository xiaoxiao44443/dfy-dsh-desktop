import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { parseHarnessThemePreference, type ColorThemePreference } from '../shared/theme-sync.js'
export { parseHarnessThemePreference, type ColorThemePreference } from '../shared/theme-sync.js'

/** Read only the scalar theme override; never evaluate executable YAML tags. */
function themeOverride(patches: unknown): ColorThemePreference | undefined {
  if (!Array.isArray(patches)) return undefined
  let preference: ColorThemePreference | undefined
  for (const patch of patches) {
    if (patch === null || typeof patch !== 'object') continue
    if (patch.id === 'ui-theme' && !patch.insert
      && (!patch.name || patch.name === '@deepseek-ai/dsh-client-ui-theme')
      && Object.hasOwn(patch, 'config')) {
      // Cordis replaces an entry's config rather than merging its fields.
      preference = parseHarnessThemePreference(patch.config?.preference) ?? 'system'
    }
  }
  return preference
}

/** Official 0.1.7 precedence: Profile, home, then the extra --patch overlay. */
export async function readStartupThemePreference(harnessHome: string, patchPath?: string): Promise<ColorThemePreference> {
  const paths = [join(harnessHome, 'profiles', 'web', 'cordis.patch.yml'), join(harnessHome, 'cordis.patch.yml')]
  if (patchPath !== undefined) paths.push(patchPath)
  let preference: ColorThemePreference = 'system'
  for (const path of paths) {
    try {
      const document = parseDocument(await readFile(path, 'utf8'))
      if (document.errors.length > 0) continue
      preference = themeOverride(document.toJS({ maxAliasCount: 100 })) ?? preference
    } catch {
      // A missing/invalid configuration must not prevent the error UI from opening.
    }
  }
  return preference
}
