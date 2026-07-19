export type Semantic = 'color' | 'normal' | 'data';

export interface VariantSettings {
  experimental: boolean;
  sizeLimit: number;
  geometry: {
    simplificationRatio: number;
    simplificationError: number;
    permissiveSimplification: boolean;
    lockedBorders: boolean;
    keepAttributes: boolean;
    positionBits: number;
    texcoordBits: number;
    normalBits: number;
  };
  textures: {
    profiles: Record<Semantic, {
      quality: number;
      cicp: string;
      tune: string;
      chroma?: string;
      maxDimension?: number;
    }>;
    alphaQuality: number;
    depth: number;
    chroma: string;
    stripUnusedChannels: boolean;
  };
}

export const variants: Record<string, VariantSettings> = {
  web: {
    experimental: false,
    sizeLimit: 80_000_000,
    geometry: {
      simplificationRatio: 0.25,
      simplificationError: 0.005,
      permissiveSimplification: false,
      lockedBorders: true,
      keepAttributes: true,
      positionBits: 14,
      texcoordBits: 14,
      normalBits: 10,
    },
    textures: {
      profiles: {
        color: { quality: 60, cicp: '1/13/1', tune: 'iq' },
        normal: { quality: 60, cicp: '1/8/0', tune: 'ssim', maxDimension: 1024 },
        data: { quality: 82, cicp: '1/8/0', tune: 'ssim' },
      },
      alphaQuality: 85,
      depth: 10,
      chroma: '444',
      stripUnusedChannels: true,
    },
  },
};

export function variantSettings(name: string): VariantSettings {
  const settings = variants[name];
  if (!settings) throw new Error(`unknown variant: ${name}`);
  return settings;
}
