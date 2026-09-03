import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { create as createTar } from 'tar'

const require = createRequire(import.meta.url)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtimeRoot = resolve(projectRoot, 'build', 'harness-runtime')
const archivePath = resolve(projectRoot, 'build', 'harness-runtime.tgz')
const storeRoot = resolve(projectRoot, 'build', 'pnpm-store')
const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const version = manifest.devDependencies?.['@deepseek-ai/dsh']
const pnpmVersion = manifest.devDependencies?.pnpm
const koffiVersion = '3.1.6'
const policyVersion = 6
const runtimePlatform = process.platform
const runtimeArch = process.arch
const installPolicy = {
  '@deepseek-ai/dsh-subprocess-local': true,
  '@google/genai': true,
  koffi: true,
  'node-pty': true,
  protobufjs: true,
}

if (typeof version !== 'string') throw new Error('Missing exact @deepseek-ai/dsh development dependency')
if (typeof pnpmVersion !== 'string') throw new Error('Missing exact pnpm development dependency')
if (!runtimeRoot.startsWith(`${projectRoot}${sep}`)) throw new Error('Invalid bundled runtime path')

const packagePath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const entryPath = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const pnpmEntryPath = join(runtimeRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
const receiptPath = join(runtimeRoot, '.desktop-runtime.json')

let installedVersion
let installedPolicyVersion
let installedPnpmVersion
let installedPlatform
let installedArch
try {
  installedVersion = JSON.parse(await readFile(packagePath, 'utf8')).version
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  installedPolicyVersion = receipt.policyVersion
  installedPnpmVersion = receipt.pnpmVersion
  installedPlatform = receipt.platform
  installedArch = receipt.arch
} catch {
  installedVersion = undefined
  installedPolicyVersion = undefined
  installedPnpmVersion = undefined
  installedPlatform = undefined
  installedArch = undefined
}

const runtimeReady = (
  installedVersion === version
  && installedPnpmVersion === pnpmVersion
  && installedPolicyVersion === policyVersion
  && installedPlatform === runtimePlatform
  && installedArch === runtimeArch
  && existsSync(entryPath)
  && existsSync(pnpmEntryPath)
)

if (!runtimeReady) {
  const canReuseHarness = installedVersion === version && installedPolicyVersion === policyVersion
  if (!canReuseHarness) await rm(runtimeRoot, { recursive: true, force: true })
  await Promise.all([
    mkdir(runtimeRoot, { recursive: true }),
    mkdir(storeRoot, { recursive: true }),
  ])
  await writeFile(join(runtimeRoot, 'package.json'), `${JSON.stringify({
    name: 'dfy-dsh-desktop-runtime',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh': version,
      koffi: koffiVersion,
      pnpm: pnpmVersion,
    },
  }, null, 2)}\n`, 'utf8')
  await writeFile(join(runtimeRoot, 'pnpm-workspace.yaml'), [
    'minimumReleaseAge: 0',
    'allowBuilds:',
    ...Object.entries(installPolicy).map(([name, allowed]) => `  ${JSON.stringify(name)}: ${String(allowed)}`),
    '',
  ].join('\n'), 'utf8')

  const pnpmCli = join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.cjs')
  const child = spawn(process.execPath, [
    pnpmCli,
    'install',
    '--dir', runtimeRoot,
    '--prod',
    '--no-lockfile',
    '--prefer-offline',
    '--store-dir', storeRoot,
    '--package-import-method', 'copy',
    '--config.node-linker=hoisted',
    '--config.minimum-release-age-exclude=*',
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      npm_config_update_notifier: 'false',
    },
    stdio: 'inherit',
    windowsHide: true,
  })

  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit(code ?? signal))
  })

  if (exitCode !== 0) throw new Error(`Bundled Harness installation failed (${String(exitCode)})`)
  if (!existsSync(entryPath)) throw new Error('Bundled Harness entry point was not installed')
  if (!existsSync(pnpmEntryPath)) throw new Error('Bundled pnpm entry point was not installed')
  await writeFile(receiptPath, `${JSON.stringify({
    version,
    pnpmVersion,
    koffiVersion,
    policyVersion,
    platform: runtimePlatform,
    arch: runtimeArch,
  }, null, 2)}\n`, 'utf8')
}

if (!runtimeReady || !existsSync(archivePath)) {
  await createTar({
    cwd: runtimeRoot,
    file: archivePath,
    gzip: true,
    portable: true,
  }, ['node_modules', 'package.json', '.desktop-runtime.json'])
}

console.log(`[runtime] bundled DeepSeek Harness ${version} for ${runtimePlatform}-${runtimeArch} and archive are ready`)
