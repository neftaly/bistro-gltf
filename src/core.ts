export const variants = ['web', 'hq'] as const;
export type Variant = (typeof variants)[number];

export interface Selection {
  variant: Variant;
  scene: number;
}

export const defaultSelection: Selection = { variant: 'web', scene: 0 };

export function parseSelection(search: string): Selection {
  const parameters = new URLSearchParams(search);
  const requestedVariant = parameters.get('variant');
  const variant = variants.includes(requestedVariant as Variant)
    ? (requestedVariant as Variant)
    : defaultSelection.variant;
  const requestedScene = Number.parseInt(parameters.get('scene') ?? '', 10);
  return {
    variant,
    scene: Number.isInteger(requestedScene) && requestedScene >= 0 ? requestedScene : 0,
  };
}

export function modelUrl(base: string, variant: Variant): string {
  return `${base}${variant}/Bistro.gltf`;
}

export function sceneLabel(name: string, index: number): string {
  return name ? name.replaceAll('_', ' ') : `Scene ${index + 1}`;
}

export function selectionSearch(selection: Selection): string {
  const parameters = new URLSearchParams({
    variant: selection.variant,
    scene: String(selection.scene),
  });
  return `?${parameters}`;
}
