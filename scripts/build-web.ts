/** Build the compact web variant from the high-quality glTF.
 *
 * Pure functions plan texture semantics and JSON edits. The imperative shell
 * only decodes KTX2, invokes established image tools, and writes the result.
 * Run directly with Node 24+, which strips erasable TypeScript syntax.
 */

import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

type Semantic = 'color' | 'normal' | 'data';
type Json = Record<string, any>;

const profiles: Record<Semantic, { quality: number; cicp: string; tune: string; maxDimension?: number }> = {
  color: { quality: 70, cicp: '1/13/1', tune: 'iq' },
  normal: { quality: 75, cicp: '1/8/0', tune: 'ssim', maxDimension: 1024 },
  data: { quality: 82, cicp: '1/8/0', tune: 'ssim' },
};

// Functional core.

export function textureRoles(document: Json): Map<string, Semantic> {
  const byTexture = new Map<number, Set<Semantic>>();
  const add = (textureInfo: Json | undefined, role: Semantic) => {
    if (!textureInfo) return;
    const roles = byTexture.get(textureInfo.index) ?? new Set<Semantic>();
    roles.add(role);
    byTexture.set(textureInfo.index, roles);
  };

  for (const material of document.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    add(pbr.baseColorTexture, 'color');
    add(pbr.metallicRoughnessTexture, 'data');
    add(material.normalTexture, 'normal');
    add(material.occlusionTexture, 'data');
    add(material.emissiveTexture, 'color');
  }

  const byUri = new Map<string, Set<Semantic>>();
  for (const [textureIndex, roles] of byTexture) {
    if (roles.size !== 1) throw new Error(`texture ${textureIndex} has conflicting roles`);
    const texture = document.textures[textureIndex];
    const source = texture.source ?? texture.extensions?.KHR_texture_basisu?.source;
    if (source === undefined) throw new Error(`texture ${textureIndex} has no source`);
    const uri = document.images[source].uri;
    const uriRoles = byUri.get(uri) ?? new Set<Semantic>();
    uriRoles.add(roles.values().next().value as Semantic);
    byUri.set(uri, uriRoles);
  }

  return new Map([...byUri].map(([uri, roles]) => {
    if (roles.size !== 1) throw new Error(`${uri} has conflicting texture roles`);
    return [uri, roles.values().next().value as Semantic];
  }));
}

export function avifUri(uri: string): string {
  return uri.replace(/\.[^.]+$/, '.avif');
}

export function transformedDocument(
  source: Json,
  roles: Map<string, Semantic>,
  encoder: string,
): Json {
  const document = structuredClone(source);
  for (const scene of document.scenes ?? []) {
    if (!scene.extras?.environment) continue;
    delete scene.extras.environment;
    if (Object.keys(scene.extras).length === 0) delete scene.extras;
  }
  for (const image of document.images ?? []) {
    if (!roles.has(image.uri)) continue;
    image.uri = avifUri(image.uri);
    delete image.mimeType;
  }

  for (const texture of document.textures ?? []) {
    const extensions = texture.extensions ??= {};
    const sourceIndex = extensions.KHR_texture_basisu?.source ?? texture.source;
    if (sourceIndex === undefined) throw new Error('texture has no source');
    delete extensions.KHR_texture_basisu;
    delete texture.source;
    extensions.EXT_texture_avif = { source: sourceIndex };
  }

  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    const values = (document[key] ?? []).filter((value: string) => value !== 'KHR_texture_basisu');
    if (!values.includes('EXT_texture_avif')) values.push('EXT_texture_avif');
    document[key] = values;
  }

  document.asset.generator = 'bistro-gltf web conversion';
  const metadata = document.asset.extras ??= {};
  const project = metadata.bistro_gltf ??= {};
  const build = project.build ??= {};
  build.web = {
    geometry: {
      codec: 'KHR_draco_mesh_compression',
      compressor: 'glTF Transform 4.4.1 / Draco 1.5.7',
      simplificationRatio: 0.7,
      simplificationError: 0.005,
      permissiveSimplification: true,
      positionBits: 14,
      texcoordBits: 14,
      normalBits: 10,
    },
    animation: {
      resampling: false,
      translationBits: 16,
      rotationBits: 12,
      scaleBits: 16,
    },
    textures: {
      codec: 'AVIF',
      encoder,
      profiles,
      alphaQuality: 100,
      depth: 10,
      chroma: '4:4:4',
      resize: { normalMaxDimension: 1024 },
    },
  };
  return document;
}

// Imperative shell.

const execute = promisify(execFile);

interface Options {
  input: string;
  source: string;
  output: string;
  ktx: string;
  avifenc: string;
  magick: string;
  workers: number;
  encoderJobs: number;
  speed: number;
  reuse: boolean;
}

function parseArguments(arguments_: string[]): Options {
  const values = new Map<string, string>();
  arguments_ = arguments_.filter((value) => value !== '--');
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('arguments must be --key value pairs');
    values.set(key.slice(2), value);
  }
  const input = values.get('input');
  if (!input) throw new Error('usage: build-web.ts --input GEOMETRY.gltf [--output web/Bistro.gltf]');
  const options = {
    input,
    source: values.get('source') ?? 'hq/Bistro.gltf',
    output: values.get('output') ?? 'web/Bistro.gltf',
    ktx: values.get('ktx') ?? process.env.KTX ?? 'ktx',
    avifenc: values.get('avifenc') ?? process.env.AVIFENC ?? 'avifenc',
    magick: values.get('magick') ?? process.env.MAGICK ?? 'magick',
    workers: Number(values.get('workers') ?? 2),
    encoderJobs: Number(values.get('encoder-jobs') ?? 4),
    speed: Number(values.get('speed') ?? 4),
    reuse: values.get('reuse') === 'true',
  };
  if (!Number.isInteger(options.workers) || options.workers < 1) throw new Error('--workers must be a positive integer');
  if (!Number.isInteger(options.encoderJobs) || options.encoderJobs < 1) {
    throw new Error('--encoder-jobs must be a positive integer');
  }
  if (!Number.isInteger(options.speed) || options.speed < 0 || options.speed > 10) {
    throw new Error('--speed must be an integer from 0 to 10');
  }
  return options;
}

async function run(command: string, arguments_: string[]): Promise<string> {
  const { stdout } = await execute(command, arguments_.map(String), { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function encodeTexture(
  uri: string,
  role: Semantic,
  sourceRoot: string,
  outputRoot: string,
  temporaryRoot: string,
  options: Options,
) {
  const source = path.join(sourceRoot, uri);
  const png = path.join(temporaryRoot, avifUri(uri).replace(/\.avif$/, '.png'));
  const output = path.join(outputRoot, avifUri(uri));
  await Promise.all([mkdir(path.dirname(png), { recursive: true }), mkdir(path.dirname(output), { recursive: true })]);
  if (options.reuse) {
    const existing = await stat(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) {
      const before = await stat(source);
      return { uri, role, before: before.size, after: existing.size, opaque: true };
    }
  }
  await run(options.ktx, ['extract', '--transcode', 'rgba8', '--level', '0', source, png]);
  const opaque = (await run(options.magick, [png, '-format', '%[opaque]', 'info:'])) === 'True';
  if (opaque) await run(options.magick, [png, '-alpha', 'off', png]);

  const profile = profiles[role];
  if (profile.maxDimension) {
    const bounds = `${profile.maxDimension}x${profile.maxDimension}>`;
    await run(options.magick, [png, '-resize', bounds, png]);
  }
  const arguments_ = [
    '-q', String(profile.quality), '-s', String(options.speed),
    '-j', String(options.encoderJobs), '-c', 'aom',
    '-a', `color:tune=${profile.tune}`, '-d', '10', '-y', '444',
    '--cicp', profile.cicp, '-r', 'full', '--ignore-profile',
  ];
  if (!opaque) arguments_.push('--qalpha', '100');
  arguments_.push(png, output);
  await run(options.avifenc, arguments_);
  const [before, after] = await Promise.all([stat(source), stat(output)]);
  return { uri, role, before: before.size, after: after.size, opaque };
}

async function concurrentMap<T, R>(values: T[], concurrency: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await work(values[index]);
    }
  }));
  return results;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [source, geometry] = await Promise.all([
    readFile(options.source, 'utf8').then(JSON.parse),
    readFile(options.input, 'utf8').then(JSON.parse),
  ]);
  const roles = textureRoles(source);
  const geometryRoles = textureRoles(geometry);
  const roleEntries = (value: Map<string, Semantic>) => [...value].sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(roleEntries(roles)) !== JSON.stringify(roleEntries(geometryRoles))) {
    throw new Error('geometry pass changed texture semantics');
  }

  const outputRoot = path.dirname(options.output);
  const sourceRoot = path.dirname(options.source);
  if (path.resolve(outputRoot) === path.resolve(sourceRoot)) {
    throw new Error('refusing to overwrite the HQ source directory');
  }
  await mkdir(outputRoot, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'bistro-avif-'));
  try {
    let completed = 0;
    await concurrentMap([...roles], options.workers, async ([uri, role]) => {
      const result = await encodeTexture(uri, role, sourceRoot, outputRoot, temporaryRoot, options);
      completed++;
      const suffix = result.opaque ? '' : ' (alpha)';
      console.log(
        `[${String(completed).padStart(3)}/${roles.size}] ${role.padEnd(6)} `
        + `${(result.before / 1024).toFixed(1).padStart(8)} -> `
        + `${(result.after / 1024).toFixed(1).padStart(8)} KiB ${uri}${suffix}`,
      );
      return result;
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const version = (await run(options.avifenc, ['--version'])).split('\n')[0];
  const document = transformedDocument(geometry, roles, version);
  const inputBinary = path.join(path.dirname(options.input), geometry.buffers[0].uri);
  const outputBinary = path.join(outputRoot, document.buffers[0].uri);
  await cp(inputBinary, outputBinary);
  await writeFile(options.output, JSON.stringify(document));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
