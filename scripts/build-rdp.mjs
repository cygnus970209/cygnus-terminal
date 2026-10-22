import { spawnSync, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.TAURI_ENV_TARGET_TRIPLE || execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
if (!/^[a-zA-Z0-9_-]+$/.test(target)) throw new Error('Invalid RDP build target');
const release = process.argv.includes('--release') && process.env.TAURI_ENV_DEBUG !== 'true';
const profile = release ? 'release' : 'debug';
const targets = target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [target];
const extension = target.includes('windows') ? '.exe' : '';
const binary = `cygnus-rdp${extension}`;
const binaries = join(root, 'src-tauri', 'binaries');
mkdirSync(binaries, { recursive: true });
const output = join(binaries, `cygnus-rdp-${target}${extension}`);
const built = [];
for (const architecture of targets) {
  const args = ['build', '--locked', '--manifest-path', join(root, 'rdp-engine', 'Cargo.toml'), '--target', architecture, '--target-dir', join(root, 'rdp-engine', 'target')];
  if (release) args.push('--release');
  const result = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  built.push(join(root, 'rdp-engine', 'target', architecture, profile, binary));
}
if (built.length === 2) {
  const result = spawnSync('lipo', ['-create', ...built, '-output', output], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
} else copyFileSync(built[0], output);
// Cargo-only development builds resolve the helper next to the application too.
const appTarget = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, 'src-tauri', 'target');
for (const directory of [join(appTarget, profile), join(appTarget, target, profile)]) {
  mkdirSync(directory, { recursive: true });
  copyFileSync(output, join(directory, binary));
}
console.log(`RDP engine ready: ${target} (${profile})`);
