import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MeshoptDecoder } from 'meshoptimizer';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  throw new Error('usage: decode-meshopt.mjs INPUT.gltf OUTPUT.gltf');
}

const inputDirectory = path.dirname(inputPath);
const outputDirectory = path.dirname(outputPath);
const document = JSON.parse(await readFile(inputPath, 'utf8'));
const extensionName = document.extensionsUsed?.includes('KHR_meshopt_compression')
  ? 'KHR_meshopt_compression'
  : 'EXT_meshopt_compression';
const fallbackIndex = document.buffers.findIndex(
  (buffer) => buffer.extensions?.[extensionName]?.fallback === true,
);

if (fallbackIndex < 0) throw new Error(`missing ${extensionName} fallback buffer`);

const sources = await Promise.all(document.buffers.map(async (buffer) => {
  if (!buffer.uri) return null;
  return new Uint8Array(await readFile(path.join(inputDirectory, buffer.uri)));
}));
const decoded = new Uint8Array(document.buffers[fallbackIndex].byteLength);

await MeshoptDecoder.ready;
for (const view of document.bufferViews) {
  const extension = view.extensions?.[extensionName];
  if (!extension) continue;
  const source = sources[extension.buffer];
  if (!source) throw new Error(`missing compressed buffer ${extension.buffer}`);

  MeshoptDecoder.decodeGltfBuffer(
    decoded.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength),
    extension.count,
    extension.byteStride,
    source.subarray(extension.byteOffset ?? 0, (extension.byteOffset ?? 0) + extension.byteLength),
    extension.mode,
    extension.filter,
  );

  view.buffer = 0;
  delete view.extensions[extensionName];
  if (Object.keys(view.extensions).length === 0) delete view.extensions;
}

document.buffers = [{ uri: path.basename(outputPath, '.gltf') + '.bin', byteLength: decoded.byteLength }];
for (const key of ['extensionsUsed', 'extensionsRequired']) {
  document[key] = document[key]?.filter((extension) => extension !== extensionName);
  if (document[key]?.length === 0) delete document[key];
}

await writeFile(outputPath, JSON.stringify(document));
await writeFile(path.join(outputDirectory, document.buffers[0].uri), decoded);
