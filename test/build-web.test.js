import assert from 'node:assert/strict';
import test from 'node:test';
import { texturePlans, textureRoles, transformedDocument } from '../scripts/build-web.ts';

const fixture = {
  asset: { version: '2.0' },
  extensionsUsed: ['KHR_texture_basisu'],
  extensionsRequired: ['KHR_texture_basisu'],
  images: [{ uri: 'Textures/wall.ktx2' }],
  textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
  materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  scenes: [{ extras: { environment: { uri: 'unused.hdr' } } }],
};

test('texture semantics come from material slots', () => {
  assert.deepEqual([...textureRoles(fixture)], [['Textures/wall.ktx2', 'color']]);
  const plan = texturePlans(fixture).get('Textures/wall.ktx2');
  assert.equal(plan.alphaRequired, false);
  assert.deepEqual([...plan.channels], ['r', 'g', 'b']);
});

test('web transform replaces required BasisU textures with AVIF', () => {
  const roles = textureRoles(fixture);
  const result = transformedDocument(fixture, roles, 'avifenc test');
  assert.equal(result.images[0].uri, 'Textures/wall.avif');
  assert.equal(result.images[0].mimeType, undefined);
  assert.deepEqual(result.textures[0].extensions, { EXT_texture_avif: { source: 0 } });
  assert.deepEqual(result.extensionsRequired, ['EXT_texture_avif']);
  assert.equal(result.scenes[0].extras, undefined);
  assert.equal(result.asset.extras.bistro_gltf.build.web.geometry.lockedBorders, true);
  assert.equal(result.asset.extras.bistro_gltf.build.web.textures.speed, 6);
  assert.equal(result.asset.extras.bistro_gltf.build.web.geometry.permissiveSimplification, false);
  assert.equal(result.asset.extras.bistro_gltf.build.web.textures.profiles.color.quality, 60);
  assert.equal(result.asset.extras.bistro_gltf.build.web.textures.profiles.normal.quality, 60);
  assert.equal(result.asset.extras.bistro_gltf.build.web.textures.alphaQuality, 85);
  assert.equal(result.asset.extras.bistro_gltf.build.web.textures.chroma, '4:4:4');
  assert.equal(result.asset.extras.bistro_gltf.build.web.textures.stripUnusedChannels, true);
  assert.equal(fixture.images[0].uri, 'Textures/wall.ktx2');
});
