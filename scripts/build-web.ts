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
import { variantSettings, type Semantic, type VariantSettings } from './variant-settings.ts';

type Json = Record<string, any>;
type Channel = 'r' | 'g' | 'b';
interface TexturePlan { role: Semantic; alphaRequired: boolean; channels: Set<Channel> }

// Functional core.

export function texturePlans(document: Json): Map<string, TexturePlan> {
  const byTexture = new Map<number, { roles: Set<Semantic>; alphaRequired: boolean; channels: Set<Channel> }>();
  const add = (
    textureInfo: Json | undefined,
    role: Semantic,
    channels: Channel[],
    alphaRequired = false,
  ) => {
    if (!textureInfo) return;
    const plan = byTexture.get(textureInfo.index) ?? {
      roles: new Set<Semantic>(),
      alphaRequired: false,
      channels: new Set<Channel>(),
    };
    plan.roles.add(role);
    plan.alphaRequired ||= alphaRequired;
    channels.forEach((channel) => plan.channels.add(channel));
    byTexture.set(textureInfo.index, plan);
  };

  for (const material of document.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    add(pbr.baseColorTexture, 'color', ['r', 'g', 'b'], material.alphaMode === 'MASK' || material.alphaMode === 'BLEND');
    add(pbr.metallicRoughnessTexture, 'data', ['g', 'b']);
    add(material.normalTexture, 'normal', ['r', 'g', 'b']);
    add(material.occlusionTexture, 'data', ['r']);
    add(material.emissiveTexture, 'color', ['r', 'g', 'b']);
  }

  const byUri = new Map<string, TexturePlan>();
  for (const [textureIndex, plan] of byTexture) {
    if (plan.roles.size !== 1) throw new Error(`texture ${textureIndex} has conflicting roles`);
    const texture = document.textures[textureIndex];
    const source = texture.source ?? texture.extensions?.KHR_texture_basisu?.source;
    if (source === undefined) throw new Error(`texture ${textureIndex} has no source`);
    const uri = document.images[source].uri;
    const role = plan.roles.values().next().value as Semantic;
    const uriPlan = byUri.get(uri) ?? { role, alphaRequired: false, channels: new Set<Channel>() };
    if (uriPlan.role !== role) throw new Error(`${uri} has conflicting texture roles`);
    uriPlan.alphaRequired ||= plan.alphaRequired;
    plan.channels.forEach((channel) => uriPlan.channels.add(channel));
    byUri.set(uri, uriPlan);
  }

  return byUri;
}

export function textureRoles(document: Json): Map<string, Semantic> {
  return new Map([...texturePlans(document)].map(([uri, plan]) => [uri, plan.role]));
}

export function avifUri(uri: string): string {
  return uri.replace(/\.[^.]+$/, '.avif');
}

function compactByKey<T>(values: T[], key: (value: T) => string): { values: T[]; indices: number[] } {
  const compacted: T[] = [];
  const byKey = new Map<string, number>();
  const indices = values.map((value) => {
    const identity = key(value);
    const existing = byKey.get(identity);
    if (existing !== undefined) return existing;
    const index = compacted.length;
    compacted.push(value);
    byKey.set(identity, index);
    return index;
  });
  return { values: compacted, indices };
}

function remapMaterialTextures(value: unknown, indices: number[], property = ''): void {
  if (!value || typeof value !== 'object') return;
  if (property.endsWith('Texture') && Number.isInteger((value as Json).index)) {
    (value as Json).index = indices[(value as Json).index];
  }
  for (const [key, child] of Object.entries(value)) remapMaterialTextures(child, indices, key);
}

export function deduplicateTextureResources(source: Json): Json {
  const document = structuredClone(source);
  const images = compactByKey<Json>(document.images ?? [], (image) => image.uri ?? JSON.stringify(image));
  document.images = images.values;

  for (const texture of document.textures ?? []) {
    if (Number.isInteger(texture.source)) texture.source = images.indices[texture.source];
    for (const extension of Object.values(texture.extensions ?? {}) as Json[]) {
      if (Number.isInteger(extension.source)) extension.source = images.indices[extension.source];
    }
  }

  const textures = compactByKey<Json>(document.textures ?? [], (texture) => {
    const { name: _name, ...identity } = texture;
    return JSON.stringify(identity);
  });
  document.textures = textures.values;
  for (const material of document.materials ?? []) remapMaterialTextures(material, textures.indices);
  return document;
}

export function transformedDocument(
  source: Json,
  roles: Map<string, Semantic>,
  encoder: string,
  speed = 6,
  variant = 'web',
): Json {
  const settings = variantSettings(variant);
  const { geometry, textures } = settings;
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

  document.asset.generator = `bistro-gltf ${variant} conversion`;
  const metadata = document.asset.extras ??= {};
  const project = metadata.bistro_gltf ??= {};
  const build = project.build ??= {};
  build[variant] = {
    experimental: settings.experimental,
    geometry: {
      codec: 'KHR_draco_mesh_compression',
      compressor: 'gltfpack 1.2 / glTF Transform 4.4.1 / Draco 1.5.7',
      ...geometry,
      meshMerging: true,
      gpuInstancing: true,
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
      speed,
      ...textures,
      chroma: textures.chroma === '444' ? '4:4:4' : textures.chroma,
      resize: { normalMaxDimension: textures.profiles.normal.maxDimension },
    },
  };
  return deduplicateTextureResources(document);
}

// Imperative shell.

const execute = promisify(execFile);

interface Options {
  variant: string;
  settings: VariantSettings;
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
  if (!input) throw new Error('usage: build-web.ts --input GEOMETRY.gltf [--output variants/web/Bistro.gltf]');
  const variant = values.get('variant') ?? 'web';
  const settings = variantSettings(variant);
  const options = {
    variant,
    settings,
    input,
    source: values.get('source') ?? 'variants/hq/Bistro.gltf',
    output: values.get('output') ?? `variants/${variant}/Bistro.gltf`,
    ktx: values.get('ktx') ?? process.env.KTX ?? 'ktx',
    avifenc: values.get('avifenc') ?? process.env.AVIFENC ?? 'avifenc',
    magick: values.get('magick') ?? process.env.MAGICK ?? 'magick',
    workers: Number(values.get('workers') ?? 2),
    encoderJobs: Number(values.get('encoder-jobs') ?? 4),
    speed: Number(values.get('speed') ?? 6),
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
  plan: TexturePlan,
  sourceRoot: string,
  outputRoot: string,
  temporaryRoot: string,
  options: Options,
) {
  const { role } = plan;
  const textureSettings = options.settings.textures;
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
  const sourceOpaque = (await run(options.magick, [png, '-format', '%[opaque]', 'info:'])) === 'True';
  const opaque = sourceOpaque || (textureSettings.stripUnusedChannels && !plan.alphaRequired);
  if (opaque) await run(options.magick, [png, '-alpha', 'off', png]);
  if (textureSettings.stripUnusedChannels && role === 'data') {
    const unused = (['r', 'g', 'b'] as Channel[]).filter((channel) => !plan.channels.has(channel));
    if (unused.length > 0) {
      await run(options.magick, [
        png, '-channel', unused.join('').toUpperCase(), '-evaluate', 'set', '0', '+channel', png,
      ]);
    }
  }

  const profile = textureSettings.profiles[role];
  if (profile.maxDimension) {
    const bounds = `${profile.maxDimension}x${profile.maxDimension}>`;
    await run(options.magick, [png, '-resize', bounds, png]);
  }
  const arguments_ = [
    '-q', String(profile.quality), '-s', String(options.speed),
    '-j', String(options.encoderJobs), '-c', 'aom',
    '-a', `color:tune=${profile.tune}`, '-d', String(textureSettings.depth),
    '-y', profile.chroma ?? textureSettings.chroma,
    '--cicp', profile.cicp, '-r', 'full', '--ignore-profile',
  ];
  if (!opaque) arguments_.push('--qalpha', String(textureSettings.alphaQuality));
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
  const plans = texturePlans(source);
  const geometryPlans = texturePlans(geometry);
  const planEntries = (value: Map<string, TexturePlan>) => [...value]
    .map(([uri, plan]) => [uri, plan.role, plan.alphaRequired, [...plan.channels].sort()])
    .sort(([left], [right]) => String(left).localeCompare(String(right)));
  if (JSON.stringify(planEntries(plans)) !== JSON.stringify(planEntries(geometryPlans))) {
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
    await concurrentMap([...plans], options.workers, async ([uri, plan]) => {
      const result = await encodeTexture(uri, plan, sourceRoot, outputRoot, temporaryRoot, options);
      completed++;
      const suffix = result.opaque ? '' : ' (alpha)';
      console.log(
        `[${String(completed).padStart(3)}/${plans.size}] ${plan.role.padEnd(6)} `
        + `${(result.before / 1024).toFixed(1).padStart(8)} -> `
        + `${(result.after / 1024).toFixed(1).padStart(8)} KiB ${uri}${suffix}`,
      );
      return result;
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const version = (await run(options.avifenc, ['--version'])).split('\n')[0];
  const roles = new Map([...plans].map(([uri, plan]) => [uri, plan.role]));
  const document = transformedDocument(geometry, roles, version, options.speed, options.variant);
  const inputBinary = path.join(path.dirname(options.input), geometry.buffers[0].uri);
  const outputBinary = path.join(outputRoot, document.buffers[0].uri);
  await cp(inputBinary, outputBinary);
  await writeFile(options.output, JSON.stringify(document));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
