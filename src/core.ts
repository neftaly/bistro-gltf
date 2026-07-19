export interface Selection {
  scene: number;
}

export interface PunctualLightLevel {
  type: 'directional' | 'local';
  intensity: number;
}

export const defaultSelection: Selection = { scene: 0 };

export function parseSelection(search: string): Selection {
  const parameters = new URLSearchParams(search);
  const requestedScene = Number.parseInt(parameters.get('scene') ?? '', 10);
  return {
    scene: Number.isInteger(requestedScene) && requestedScene >= 0 ? requestedScene : 0,
  };
}

export function modelUrl(base: string): string {
  return `${base}web/Bistro.gltf`;
}

export function sceneLabel(name: string, index: number): string {
  return name ? name.replaceAll('_', ' ') : `Scene ${index + 1}`;
}

export function authoredLightExposure(lights: PunctualLightLevel[]): number {
  const peak = lights.reduce((value, light) => {
    const reference = light.type === 'directional' ? 3 : 100;
    return Math.max(value, light.intensity / reference);
  }, 1);
  return 1 / peak;
}

export function selectionSearch(selection: Selection): string {
  const parameters = new URLSearchParams({ scene: String(selection.scene) });
  return `?${parameters}`;
}
