import { readFile } from 'node:fs/promises';
import path from 'node:path';
import validator from 'gltf-validator';
import { variants } from './variant-settings.ts';

const files = process.argv.slice(2);
if (files.length === 0) {
  files.push('variants/hq/Bistro.gltf', 'variants/web/Bistro.gltf');
}
const sizeLimits = new Map([
  [path.resolve('variants/web/Bistro.gltf'), variants.web.sizeLimit],
]);

let failed = false;
for (const file of files) {
  const directory = path.resolve(path.dirname(file));
  const resources = new Map();
  const json = await readFile(file, 'utf8');
  const report = await validator.validateString(json, {
    uri: file,
    writeTimestamp: false,
    maxIssues: 0,
    ignoredIssues: ['IMAGE_UNRECOGNIZED_FORMAT'],
    externalResourceFunction: async (uri) => {
      const resource = path.resolve(directory, decodeURIComponent(uri));
      if (!resource.startsWith(`${directory}${path.sep}`)) throw new Error(`resource escapes variant: ${uri}`);
      if (!resources.has(resource)) resources.set(resource, readFile(resource).then((data) => new Uint8Array(data)));
      return resources.get(resource);
    },
  });
  const errors = report.issues.numErrors;
  const warnings = report.issues.numWarnings;
  const infos = report.issues.numInfos;
  const hints = report.issues.numHints;
  console.log(`${file}: ${errors} errors, ${warnings} warnings, ${infos} infos, ${hints} hints`);
  const resourcesSize = (await Promise.all([...resources.values()])).reduce((sum, data) => sum + data.byteLength, 0);
  const payloadSize = Buffer.byteLength(json) + resourcesSize;
  const sizeLimit = sizeLimits.get(path.resolve(file));
  console.log(`  payload: ${(payloadSize / 1_000_000).toFixed(3)} MB${sizeLimit ? ` / ${(sizeLimit / 1_000_000).toFixed(0)} MB limit` : ''}`);
  for (const message of report.issues.messages.filter((message) => message.severity <= 1).slice(0, 20)) {
    console.error(`  ${message.code}: ${message.message}`);
  }
  failed ||= errors > 0;
  if (sizeLimit && payloadSize >= sizeLimit) {
    console.error(`  payload exceeds limit by ${((payloadSize - sizeLimit) / 1_000_000).toFixed(3)} MB`);
    failed = true;
  }
}

if (failed) process.exitCode = 1;
