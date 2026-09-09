import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const arch = process.argv[2]
assert.ok(arch === 'x64' || arch === 'arm64', 'Specify x64 or arm64')
assert.equal(process.platform, 'darwin')
assert.equal(process.arch, arch, 'Verify the package on its native architecture')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const app = join(root, 'release', arch === 'x64' ? 'mac' : 'mac-arm64', `${manifest.productName}.app`, 'Contents')
const executable = join(app, 'MacOS', manifest.productName)
const resources = join(app, 'Resources')
const runtime = join(resources, 'harness-runtime')
const receipt = JSON.parse(await readFile(join(runtime, '.desktop-runtime.json'), 'utf8'))
assert.equal(receipt.platform, 'darwin')
assert.equal(receipt.arch, arch)
assert.equal(receipt.version, manifest.devDependencies['@deepseek-ai/dsh'])

const home = await mkdtemp(join(tmpdir(), 'dfy-packaged-runtime-'))
try {
  const options = { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home } }
  const native = execFileSync(executable, ['-e', `
    const req = require('node:module').createRequire(${JSON.stringify(join(runtime, 'package.json'))});
    req('koffi');
    req('node-pty');
    process.stdout.write(process.arch);
  `], options)
  assert.equal(native.trim(), arch, 'Bundled Electron and native modules must match the package architecture')
  const version = execFileSync(executable, [
    '--expose-internals', join(resources, 'app.asar', 'dist', 'harness-bootstrap.cjs'),
    join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--version',
  ], options)
  assert.equal(version.trim(), receipt.version, 'The packaged desktop launcher must execute Harness')
  console.log(`Verified packaged macOS ${arch}: Electron, native modules, Harness ${receipt.version}`)
} finally {
  await rm(home, { recursive: true, force: true })
}
