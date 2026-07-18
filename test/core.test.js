import assert from 'node:assert/strict';
import test from 'node:test';
import { modelUrl, parseSelection, sceneLabel, selectionSearch } from '../src/core.ts';

test('the first scene is selected by default', () => {
  assert.deepEqual(parseSelection(''), { scene: 0 });
});

test('selection accepts valid scene state and ignores the removed variant parameter', () => {
  assert.deepEqual(parseSelection('?variant=hq&scene=2'), { scene: 2 });
  assert.deepEqual(parseSelection('?variant=nope&scene=-1'), { scene: 0 });
});

test('asset and URL paths keep the deployment base', () => {
  assert.equal(modelUrl('/bistro-gltf/'), '/bistro-gltf/web/Bistro.gltf');
  assert.equal(selectionSearch({ scene: 1 }), '?scene=1');
});

test('scene labels are readable and retain a fallback', () => {
  assert.equal(sceneLabel('Interior_Wine', 2), 'Interior Wine');
  assert.equal(sceneLabel('', 2), 'Scene 3');
});
