/** Build the web geometry with established gltfpack and Draco encoders. */

import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { variantSettings } from './variant-settings.ts';

const execute = promisify(execFile);
const root = process.cwd();
const values = new Map();
const arguments_ = process.argv.slice(2).filter((value) => value !== '--');
for (let index = 0; index < arguments_.length; index += 2) {
  const key = arguments_[index];
  const value = arguments_[index + 1];
  if (!key?.startsWith('--') || value === undefined) throw new Error('arguments must be --key value pairs');
  values.set(key.slice(2), value);
}

const variant = values.get('variant') ?? 'web';
const settings = variantSettings(variant);
const geometry = settings.geometry;
const source = path.resolve(values.get('source') ?? 'variants/hq/Bistro.gltf');
const output = path.resolve(values.get('output') ?? `.build/${variant}-geometry/Bistro.gltf`);
const gltfpack = values.get('gltfpack') ?? path.join(root, 'node_modules/.bin/gltfpack');
const gltfTransform = values.get('gltf-transform') ?? path.join(root, 'node_modules/.bin/gltf-transform');
if (path.dirname(output) === path.dirname(source)) throw new Error('refusing to overwrite the HQ source directory');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bistro-geometry-'));

async function run(command, commandArguments) {
  await execute(command, commandArguments.map(String), { maxBuffer: 32 * 1024 * 1024 });
}

try {
  const decoded = path.join(temporaryRoot, 'decoded', 'Bistro.gltf');
  const packed = path.join(temporaryRoot, 'packed', 'Bistro.gltf');
  const encoded = path.join(temporaryRoot, 'encoded', 'Bistro.gltf');
  await Promise.all([
    mkdir(path.dirname(decoded), { recursive: true }),
    mkdir(path.dirname(packed), { recursive: true }),
    mkdir(path.dirname(encoded), { recursive: true }),
  ]);
  await run(process.execPath, [path.join(root, 'scripts/decode-meshopt.mjs'), source, decoded]);
  await symlink(path.join(path.dirname(source), 'Textures'), path.join(path.dirname(decoded), 'Textures'), 'dir');
  const gltfpackArguments = [
    '-i', decoded, '-o', packed,
    '-si', geometry.simplificationRatio, '-se', geometry.simplificationError,
    '-vp', geometry.positionBits, '-vpf', '-vt', geometry.texcoordBits, '-vtf', '-vn', geometry.normalBits,
    '-km', '-ke', '-af', '0', '-at', '16', '-ar', '12', '-as', '16', '-ac',
    '-tr', '-mm', '-mi',
  ];
  if (geometry.permissiveSimplification) gltfpackArguments.push('-sp');
  if (geometry.lockedBorders) gltfpackArguments.push('-slb');
  if (geometry.keepAttributes) gltfpackArguments.push('-kv');
  await run(gltfpack, gltfpackArguments);
  await symlink(path.join(path.dirname(source), 'Textures'), path.join(path.dirname(packed), 'Textures'), 'dir');
  await run(gltfTransform, [
    'draco', packed, encoded,
    '--quantize-position', geometry.positionBits,
    '--quantize-texcoord', geometry.texcoordBits,
    '--quantize-normal', geometry.normalBits,
    '--quantize-color', '8', '--quantize-generic', '12', '--encode-speed', '5', '--decode-speed', '5',
  ]);

  const document = JSON.parse(await readFile(encoded, 'utf8'));
  const binary = document.buffers?.[0]?.uri;
  if (!binary) throw new Error('encoded glTF has no external binary');
  await mkdir(path.dirname(output), { recursive: true });
  await Promise.all([
    cp(encoded, output),
    cp(path.join(path.dirname(encoded), binary), path.join(path.dirname(output), binary)),
  ]);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
