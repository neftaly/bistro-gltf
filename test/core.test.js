import assert from 'node:assert/strict';
import test from 'node:test';
import { modelUrl, parseSelection, sceneLabel, selectionSearch } from '../src/core.ts';

test('web is the default variant', () => {
  assert.deepEqual(parseSelection(''), { variant: 'web', scene: 0 });
});

test('selection accepts valid URL state and rejects invalid scene indices', () => {
  assert.deepEqual(parseSelection('?variant=hq&scene=2'), { variant: 'hq', scene: 2 });
  assert.deepEqual(parseSelection('?variant=nope&scene=-1'), { variant: 'web', scene: 0 });
});

test('asset and URL paths keep the deployment base', () => {
  assert.equal(modelUrl('/bistro-gltf/', 'web'), '/bistro-gltf/web/Bistro.gltf');
  assert.equal(selectionSearch({ variant: 'hq', scene: 1 }), '?variant=hq&scene=1');
});

test('scene labels are readable and retain a fallback', () => {
  assert.equal(sceneLabel('Interior_Wine', 2), 'Interior Wine');
  assert.equal(sceneLabel('', 2), 'Scene 3');
});
