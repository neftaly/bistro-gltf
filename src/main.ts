import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  authoredLightExposure,
  modelUrl,
  parseSelection,
  sceneLabel,
  selectionSearch,
  type PunctualLightLevel,
  type Selection,
} from './core';
import './style.css';

const requiredElement = <T extends Element>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
};

const container = requiredElement<HTMLElement>('#viewer');
const sceneSelect = requiredElement<HTMLSelectElement>('#scene');
const cameraSelect = requiredElement<HTMLSelectElement>('#camera');
const lightingSelect = requiredElement<HTMLSelectElement>('#lighting');
const status = requiredElement<HTMLOutputElement>('#status');
const base = import.meta.env.BASE_URL;
let selection = parseSelection(location.search);
let loaded: GLTF | undefined;
let mixer: THREE.AnimationMixer | undefined;
let generation = 0;

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(1);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
container.append(renderer.domElement);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10_000);
const world = new THREE.Scene();
world.background = new THREE.Color(0x17191d);
const neutralLighting = new THREE.Group();
neutralLighting.add(new THREE.HemisphereLight(0xffffff, 0x3a414a, 2));
const comparisonLight = new THREE.DirectionalLight(0xffffff, 3);
comparisonLight.position.set(-1, 2, 1);
neutralLighting.add(comparisonLight);
world.add(neutralLighting);
const environmentGenerator = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const environment = environmentGenerator.fromScene(room, 0.04);
room.dispose();
environmentGenerator.dispose();
world.environment = environment.texture;
const controls = new OrbitControls(camera, renderer.domElement);

const draco = new DRACOLoader();
const loader = new GLTFLoader().setDRACOLoader(draco);
const timer = new THREE.Timer();
timer.connect(document);

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

function authoredCamera(scene: THREE.Object3D): THREE.Camera | undefined {
  let result: THREE.Camera | undefined;
  scene.traverse((object) => {
    if (!result && object instanceof THREE.Camera) result = object;
  });
  return result;
}

function viewCamera(): THREE.Camera {
  if (cameraSelect.value === 'authored' && loaded) {
    return authoredCamera(loaded.scenes[selection.scene]) ?? camera;
  }
  return camera;
}

function playSceneAnimations(scene: THREE.Object3D) {
  mixer?.stopAllAction();
  mixer = new THREE.AnimationMixer(scene);
  for (const clip of loaded?.animations ?? []) {
    const applies = clip.tracks.some((track) => {
      const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
      return Boolean(scene.getObjectByName(nodeName));
    });
    if (applies) mixer.clipAction(clip).play();
  }
}

function applyLighting(scene: THREE.Object3D) {
  const authored = lightingSelect.value === 'authored';
  neutralLighting.visible = !authored;
  const lights: PunctualLightLevel[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Light)) return;
    object.visible = authored;
    lights.push({
      type: object instanceof THREE.DirectionalLight ? 'directional' : 'local',
      intensity: object.intensity,
    });
  });
  renderer.toneMappingExposure = authored ? authoredLightExposure(lights) : 1;
}

function updateLightingAvailability(scene: THREE.Object3D) {
  let available = false;
  scene.traverse((object) => {
    available ||= object instanceof THREE.Light;
  });
  if (!available) lightingSelect.value = 'neutral';
  lightingSelect.disabled = !available;
}

function showScene(index: number) {
  if (!loaded) return;
  const bounded = Math.min(index, loaded.scenes.length - 1);
  for (const scene of loaded.scenes) world.remove(scene);
  world.add(loaded.scenes[bounded]);
  selection = { ...selection, scene: bounded };
  sceneSelect.value = String(bounded);
  cameraSelect.disabled = !authoredCamera(loaded.scenes[bounded]);
  updateLightingAvailability(loaded.scenes[bounded]);
  updateUrl(selection);
  frame(loaded.scenes[bounded]);
  playSceneAnimations(loaded.scenes[bounded]);
  applyLighting(loaded.scenes[bounded]);
}

async function loadModel() {
  const request = ++generation;
  status.value = 'Loading…';
  sceneSelect.disabled = true;
  try {
    const next = await loader.loadAsync(modelUrl(base));
    if (request !== generation) {
      disposeGltf(next);
      return;
    }

    if (loaded) {
      for (const scene of loaded.scenes) world.remove(scene);
      disposeGltf(loaded);
    }
    loaded = next;

    sceneSelect.replaceChildren(...next.scenes.map((scene, index) =>
      new Option(sceneLabel(scene.name, index), String(index)),
    ));
    sceneSelect.disabled = false;
    selection = { scene: Math.min(selection.scene, next.scenes.length - 1) };
    showScene(selection.scene);
    status.value = '';
  } catch (error) {
    if (request !== generation) return;
    status.value = error instanceof Error ? error.message : String(error);
    console.error(error);
  }
}

sceneSelect.addEventListener('change', () => showScene(Number(sceneSelect.value)));
cameraSelect.addEventListener('change', () => {
  controls.enabled = cameraSelect.value === 'orbit';
});
lightingSelect.addEventListener('change', () => {
  if (loaded) applyLighting(loaded.scenes[selection.scene]);
});

function resize() {
  const width = container.clientWidth;
  const height = container.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  const authored = loaded && authoredCamera(loaded.scenes[selection.scene]);
  if (authored instanceof THREE.PerspectiveCamera) {
    authored.aspect = width / height;
    authored.updateProjectionMatrix();
  }
}

new ResizeObserver(resize).observe(container);
renderer.setAnimationLoop(() => {
  timer.update();
  mixer?.update(timer.getDelta());
  renderer.render(world, viewCamera());
});
void loadModel();

window.addEventListener('pagehide', () => {
  generation++;
  if (loaded) disposeGltf(loaded);
  renderer.setAnimationLoop(null);
  timer.dispose();
  environment.dispose();
  draco.dispose();
  renderer.dispose();
});
