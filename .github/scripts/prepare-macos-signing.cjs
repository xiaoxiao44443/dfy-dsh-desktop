// CI-only workaround for @electron/osx-sign 1.3.3's unbounded binary reads.
// https://github.com/electron/osx-sign/pull/286
// lstat also avoids traversing Framework aliases more than once.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createRequire, Module } = require('node:module');
const os = require('node:os');
const path = require('node:path');

const projectRequire = createRequire(path.resolve('package.json'));
const builderRequire = createRequire(projectRequire.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const signEntry = appBuilderRequire.resolve('@electron/osx-sign');
const signRequire = createRequire(signEntry);
const marker = '// DFY: bounded signing reads';

function patchSource(source) {
  source = source.replaceAll('\r\n', '\n');
  if (source.includes(marker)) return source;
  const pattern = /async function getFilePathIfBinary\(filePath\) \{\n([\s\S]*?)\n\}/g;
  assert.equal([...source.matchAll(pattern)].length, 1, 'Unexpected osx-sign binary reader');
  assert.equal(source.split('const stat = await fs.stat(filePath);').length, 2, 'Unexpected osx-sign walker');
  return source.replace(pattern, (_, body) => `${marker}
let activeBinaryReads = 0;
const waitingBinaryReads = [];
async function getFilePathIfBinary(filePath) {
    if (activeBinaryReads < 64) activeBinaryReads++;
    else await new Promise(resolve => waitingBinaryReads.push(resolve));
    try {
${body.split('\n').map(line => '    ' + line).join('\n')}
    } finally {
        const next = waitingBinaryReads.shift();
        if (next) next();
        else activeBinaryReads--;
    }
}`).replace('const stat = await fs.stat(filePath);', 'const stat = await fs.lstat(filePath);');
}

async function verifyWalker(source, filename) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'dfy-signing-'));
  const binary = signRequire('isbinaryfile');
  const originalRead = binary.isBinaryFile;
  let active = 0;
  let maximum = 0;
  binary.isBinaryFile = async (...args) => {
    active++;
    maximum = Math.max(maximum, active);
    try { return await originalRead(...args); }
    finally { active--; }
  };
  try {
    const framework = path.join(fixture, 'Sample.framework');
    const version = path.join(framework, 'Versions', 'A');
    await fs.mkdir(version, { recursive: true });
    const library = path.join(version, 'sample.dylib');
    const helper = path.join(fixture, 'Helper.app');
    await fs.mkdir(helper);
    const executable = path.join(helper, 'helper');
    const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
    await fs.writeFile(library, macho);
    await fs.writeFile(executable, macho);
    await Promise.all(Array.from({ length: 256 }, (_, i) => fs.writeFile(path.join(fixture, `${i}.txt`), 'source text')));
    // Directory junctions do not require Windows Developer Mode.
    await fs.symlink(version, path.join(framework, 'Current'), process.platform === 'win32' ? 'junction' : 'dir');
    if (process.platform !== 'win32') await fs.symlink('Versions/A/sample.dylib', path.join(framework, 'sample.dylib'));
    const temporary = path.join(fixture, 'old.cstemp');
    await fs.writeFile(temporary, macho);
    const loaded = new Module(filename);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(source, filename);
    const files = await loaded.exports.walkAsync(fixture);
    assert.deepEqual(files.toSorted(), [library, executable, framework, helper].toSorted());
    assert.ok(maximum > 1 && maximum <= 64, `Unexpected read concurrency: ${maximum}`);
    await assert.rejects(fs.access(temporary), { code: 'ENOENT' });
    console.log(`Signing traversal verified: max ${maximum} reads, Framework aliases skipped, nested bundles preserved.`);
  } finally {
    binary.isBinaryFile = originalRead;
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixture).startsWith('dfy-signing-'));
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

async function main() {
  const root = path.resolve(path.dirname(signEntry), '../..');
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(metadata.version, '1.3.3', 'Recheck the signing workaround after upgrading osx-sign');
  const files = ['cjs', 'esm'].map(format => path.join(root, 'dist', format, 'util.js'));
  const sources = await Promise.all(files.map(async file => patchSource(await fs.readFile(file, 'utf8'))));
  await verifyWalker(sources[0], files[0]);
  if (process.argv.includes('--check')) return;
  assert.equal(process.platform, 'darwin', 'Only macOS CI needs this workaround');
  for (let i = 0; i < files.length; i++) await fs.writeFile(files[i], sources[i]);
  console.log('Applied bounded macOS signing traversal.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
