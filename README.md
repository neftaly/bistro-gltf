# Bistro glTF

A self-contained conversion of Amazon Lumberyard Bistro v5.2 for testing 3D engines.

- `variants/hq/Bistro.gltf` is the high-quality source of truth: conservatively quantized meshopt geometry and high-quality UASTC KTX2 textures. “HQ” means visually faithful, not bit-exact or mathematically lossless.
- `variants/web/Bistro.gltf` is the compact lossy distribution: simplified and quantized Draco geometry with role-aware AVIF textures.

Run the minimal web viewer with `pnpm install && pnpm dev`. Bistro is © Amazon and [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
