import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { modelUrl, parseSelection, sceneLabel, selectionSearch, variants, type Selection } from './core';
import './style.css';

const requiredElement = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
};

const container = requiredElement<HTMLElement>('#viewer');
const variantSelect = requiredElement<HTMLSelectElement>('#variant');
const sceneSelect = requiredElement<HTMLSelectElement>('#scene');
const status = requiredElement<HTMLOutputElement>('#status');
const base = import.meta.env.BASE_URL;
let selection = parseSelection(location.search);
let loaded: GLTF | undefined;
let generation = 0;

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
container.append(renderer.domElement);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000);
const world = new THREE.Scene();
world.background = new THREE.Color(0x17191d);
world.add(new THREE.HemisphereLight(0xffffff, 0x3a414a, 2));
const comparisonLight = new THREE.DirectionalLight(0xffffff, 3);
comparisonLight.position.set(-1, 2, 1);
world.add(comparisonLight);
const environmentGenerator = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environment = environmentGenerator.fromScene(room, 0.04);
room.dispose();
environmentGenerator.dispose();
world.environment = environment.texture;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const ktx2 = new KTX2Loader().detectSupport(renderer);
const draco = new DRACOLoader();
const loader = new GLTFLoader()
  .setKTX2Loader(ktx2)
  .setDRACOLoader(draco)
  .setMeshoptDecoder(MeshoptDecoder);

for (const variant of variants) {
  variantSelect.add(new Option(variant.toUpperCase(), variant, false, variant === selection.variant));
}

function updateUrl(next: Selection) {
  history.replaceState(null, '', `${location.pathname}${selectionSearch(next)}`);
}

function frame(object: THREE.Object3D) {
  const sphere = new THREE.Box3().setFromObject(object).getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 0.01);
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).add(new THREE.Vector3(-1, 0.55, 1).normalize().multiplyScalar(radius * 2.5));
  camera.near = Math.max(radius / 10_000, 0.001);
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.update();
}

function disposeMaterial(material: THREE.Material) {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}

function disposeGltf(gltf: GLTF) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  for (const scene of gltf.scenes) scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const values = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of values) materials.add(material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach(disposeMaterial);
}

function useNeutralLighting(gltf: GLTF) {
  for (const scene of gltf.scenes) scene.traverse((object) => {
    if (object instanceof THREE.Light) object.visible = false;
  });
}

function showScene(index: number) {
  if (!loaded) return;
  const bounded = Math.min(index, loaded.scenes.length - 1);
  for (const scene of loaded.scenes) world.remove(scene);
  world.add(loaded.scenes[bounded]);
  selection = { ...selection, scene: bounded };
  sceneSelect.value = String(bounded);
  updateUrl(selection);
  frame(loaded.scenes[bounded]);
}

async function loadVariant(variant: Selection['variant']) {
  const request = ++generation;
  status.value = `Loading ${variant.toUpperCase()}…`;
  sceneSelect.disabled = true;
  try {
    const next = await loader.loadAsync(modelUrl(base, variant), (event) => {
      if (request !== generation) return;
      const percent = event.total ? ` ${Math.round(event.loaded / event.total * 100)}%` : '';
      status.value = `Loading ${variant.toUpperCase()}${percent}`;
    });
    if (request !== generation) {
      disposeGltf(next);
      return;
    }

    if (loaded) {
      for (const scene of loaded.scenes) world.remove(scene);
      disposeGltf(loaded);
    }
    loaded = next;
    useNeutralLighting(next);

    sceneSelect.replaceChildren(...next.scenes.map((scene, index) =>
      new Option(sceneLabel(scene.name, index), String(index)),
    ));
    sceneSelect.disabled = false;
    selection = { variant, scene: Math.min(selection.scene, next.scenes.length - 1) };
    showScene(selection.scene);
    status.value = `${variant.toUpperCase()} · ${next.scenes.length} scenes`;
  } catch (error) {
    if (request !== generation) return;
    status.value = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
}

variantSelect.addEventListener('change', () => {
  selection = { variant: variantSelect.value as Selection['variant'], scene: 0 };
  updateUrl(selection);
  void loadVariant(selection.variant);
});
sceneSelect.addEventListener('change', () => showScene(Number(sceneSelect.value)));

function resize() {
  const width = container.clientWidth;
  const height = container.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

new ResizeObserver(resize).observe(container);
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(world, camera);
});
void loadVariant(selection.variant);

window.addEventListener('pagehide', () => {
  generation++;
  if (loaded) disposeGltf(loaded);
  environment.dispose();
  ktx2.dispose();
  draco.dispose();
  renderer.dispose();
});
