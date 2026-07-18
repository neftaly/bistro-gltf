import { readFile } from 'node:fs/promises';
import path from 'node:path';
import validator from 'gltf-validator';

const files = process.argv.slice(2);
if (files.length === 0) files.push('variants/hq/Bistro.gltf', 'variants/web/Bistro.gltf');

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
  for (const message of report.issues.messages.filter((message) => message.severity <= 1).slice(0, 20)) {
    console.error(`  ${message.code}: ${message.message}`);
  }
  failed ||= errors > 0;
}

if (failed) process.exitCode = 1;
