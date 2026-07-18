"""Build the high-fidelity Bistro glTF.

This stays in Python because Blender exposes its FBX and glTF APIs through bpy.
Keeping the remaining conversion steps here avoids an unnecessary wrapper.
"""

import argparse
import concurrent.futures
import copy
import hashlib
import json
import math
import mmap
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from urllib.parse import unquote

import bpy


SCENES = (
    ("Exterior", "BistroExterior.fbx"),
    ("Interior", "BistroInterior.fbx"),
    ("Interior Wine", "BistroInterior_Wine.fbx"),
)

NORMAL_Z_EXPRESSION = (
    "0.5+0.5*sqrt(max(0,1-(2*r-1)*(2*r-1)-(2*g-1)*(2*g-1)))"
)

TRANSMISSION_MATERIALS = {
    "TransparentGlass": {"ior": 1.55, "roughness": 0.0, "priority": 5},
    "TransparentGlassWine": {
        "ior": 1.55,
        "roughness": 0.0,
        "priority": 5,
        "absorption": (102.68063, 168.015, 246.80438),
    },
    "Water": {"ior": 1.33, "roughness": 0.0, "priority": 1},
    "Ice": {"ior": 1.31, "roughness": 0.1, "priority": 4},
    "White_Wine": {
        "ior": 1.33,
        "roughness": 0.0,
        "priority": 1,
        "absorption": (12.28758, 16.51818, 20.30273),
    },
    "Red_Wine": {
        "ior": 1.33,
        "roughness": 0.0,
        "priority": 1,
        "absorption": (117.13133, 251.91133, 294.33867),
    },
    "Beer": {
        "ior": 1.33,
        "roughness": 0.0,
        "priority": 1,
        "absorption": (11.78552, 25.45862, 58.37241),
    },
}

SOURCE = {
    "name": "Amazon Lumberyard Bistro v5.2",
    "page": "https://developer.nvidia.com/orca/amazon-lumberyard-bistro",
    "archive": "Bistro_v5_2.zip",
    "sha256": "0d50e3c724c6c5da19f8eb99ad3f53e36fec37ffa2df9621f9ccf0603f3934e1",
}


# Functional core: deterministic naming and glTF transformations.


def source_material_name(name):
    return re.sub(r"\.\d{3}$", "", name)


def texture_name(image):
    stem = Path(unquote(image["uri"])).stem
    match = re.match(
        r"^(.*?_(?:BaseColor|Normal|Specular|Emissive))(?:[-.]|$)",
        stem,
        flags=re.IGNORECASE,
    )
    name = match.group(1) if match else stem.split("-", 1)[0]
    name = re.sub(r"\.\d{3}$", "", name)
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", name)


def texture_semantic(name):
    lowered = name.lower()
    if lowered.endswith("_normal"):
        return "normal"
    if lowered.endswith("_specular"):
        return "data"
    return "color"


def add_extension(document, extension, *, required=False):
    used = set(document.get("extensionsUsed", []))
    used.add(extension)
    document["extensionsUsed"] = sorted(used)
    if required:
        required_extensions = set(document.get("extensionsRequired", []))
        required_extensions.add(extension)
        document["extensionsRequired"] = sorted(required_extensions)


def remove_extension(document, extension):
    for key in ("extensionsUsed", "extensionsRequired"):
        values = [value for value in document.get(key, []) if value != extension]
        if values:
            document[key] = values
        else:
            document.pop(key, None)


def patch_materials(document, opaque_by_image):
    texture_sources = [texture.get("source") for texture in document.get("textures", [])]

    for material in document.get("materials", []):
        extras = material.get("extras", {})
        source_name = extras.get("bistro_source_name", material.get("name", ""))
        source_scene = extras.get("bistro_source_scene")
        pbr = material.setdefault("pbrMetallicRoughness", {})

        extensions = material.get("extensions", {})
        specular = extensions.pop("KHR_materials_specular", None)
        if specular:
            orm_texture = specular.get("specularTexture") or specular.get("specularColorTexture")
            if orm_texture:
                pbr["metallicRoughnessTexture"] = dict(orm_texture)
                material["occlusionTexture"] = dict(orm_texture)
                pbr["metallicFactor"] = 1.0
                pbr["roughnessFactor"] = 1.0
        if not extensions:
            material.pop("extensions", None)

        base_texture = pbr.get("baseColorTexture")
        base_is_opaque = True
        if base_texture:
            image_index = texture_sources[base_texture["index"]]
            base_is_opaque = opaque_by_image.get(image_index, True)

        transmission = TRANSMISSION_MATERIALS.get(source_name)
        material["doubleSided"] = ".DoubleSided" in source_name or transmission is not None
        if not material["doubleSided"]:
            material.pop("doubleSided")

        if transmission:
            material.pop("alphaMode", None)
            material.pop("alphaCutoff", None)
            pbr["metallicFactor"] = 0.0
            pbr["roughnessFactor"] = transmission["roughness"]
            material.setdefault("extensions", {})["KHR_materials_transmission"] = {
                "transmissionFactor": 1.0
            }
            material["extensions"]["KHR_materials_ior"] = {"ior": transmission["ior"]}
            material.setdefault("extras", {})["nestedPriority"] = transmission["priority"]

            absorption = transmission.get("absorption")
            if absorption:
                material.pop("doubleSided", None)
                attenuation_distance = 0.01
                material["extensions"]["KHR_materials_volume"] = {
                    "attenuationColor": [
                        math.exp(-coefficient * attenuation_distance)
                        for coefficient in absorption
                    ],
                    "attenuationDistance": attenuation_distance,
                    "thicknessFactor": 1.0,
                }
        elif not base_is_opaque:
            lowered_name = source_name.lower()
            if "masked" in lowered_name:
                material["alphaMode"] = "MASK"
                material["alphaCutoff"] = 0.5
            elif any(word in lowered_name for word in ("glass", "window", "frozen")):
                material["alphaMode"] = "BLEND"
                material.pop("alphaCutoff", None)
            else:
                material["alphaMode"] = "MASK"
                material["alphaCutoff"] = 0.5
        else:
            material.pop("alphaMode", None)
            material.pop("alphaCutoff", None)

        if source_scene == "Interior Wine" and (
            material.get("emissiveTexture")
            or any(material.get("emissiveFactor", [0.0, 0.0, 0.0]))
        ):
            material.setdefault("extensions", {})["KHR_materials_emissive_strength"] = {
                "emissiveStrength": 1000.0
            }

        if source_name in ("CookieJar_Cookies", "ToffeeJar_Toffee"):
            material.setdefault("extras", {})["nestedPriority"] = 10

    remove_extension(document, "KHR_materials_specular")
    for extension in (
        "KHR_materials_emissive_strength",
        "KHR_materials_ior",
        "KHR_materials_transmission",
        "KHR_materials_volume",
    ):
        if any(extension in material.get("extensions", {}) for material in document.get("materials", [])):
            add_extension(document, extension)


def transformed_document(document, results, image_to_group, args):
    transformed = copy.deepcopy(document)
    opaque_by_image = {}

    for image_index, image in enumerate(transformed.get("images", [])):
        result = results[image_to_group[image_index]]
        image["uri"] = result["uri"]
        image.pop("mimeType", None)
        if result["opaque"] is not None:
            opaque_by_image[image_index] = result["opaque"]

    patch_materials(transformed, opaque_by_image)

    for texture in transformed.get("textures", []):
        source = texture.pop("source")
        texture.setdefault("extensions", {})["KHR_texture_basisu"] = {"source": source}
    add_extension(transformed, "KHR_texture_basisu", required=True)
    asset = transformed.setdefault("asset", {})
    asset["generator"] = "bistro-gltf high-fidelity conversion"
    asset.setdefault("extras", {})["bistro_gltf"] = {
        "source": SOURCE,
        "build": {
            "blender": bpy.app.version_string,
            "ktx": run([args.ktx, "--version"], capture=True),
            "gltfpack": run([args.gltfpack, "-v"], capture=True),
            "textures": {
                "encoding": "UASTC",
                "quality": args.uastc_quality,
                "rdo": False,
                "zstd": 18,
                "mipmapWrap": "wrap",
            },
            "geometry": {
                "compression": "KHR_meshopt_compression",
                "version": 1,
                "positionBits": 16,
                "positionStorage": "FLOAT",
                "texcoordBits": 16,
                "texcoordStorage": "FLOAT",
                "normalBits": 12,
                "simplification": False,
            },
            "animation": {
                "resampling": False,
                "translationBits": 24,
                "rotationBits": 16,
                "scaleBits": 24,
            },
        },
    }
    return transformed


def normalized_tangent(tangent, normal):
    x, y, z, handedness = tangent
    length = math.sqrt(x * x + y * y + z * z)
    if math.isfinite(length) and length > 1e-12:
        direction = (x / length, y / length, z / length)
    else:
        nx, ny, nz = normal
        axis = (0.0, 0.0, 1.0) if abs(nz) < 0.999 else (0.0, 1.0, 0.0)
        direction = (
            axis[1] * nz - axis[2] * ny,
            axis[2] * nx - axis[0] * nz,
            axis[0] * ny - axis[1] * nx,
        )
        direction_length = math.sqrt(sum(value * value for value in direction))
        if not math.isfinite(direction_length) or direction_length <= 1e-12:
            direction = (1.0, 0.0, 0.0)
        else:
            direction = tuple(value / direction_length for value in direction)

    if not math.isfinite(handedness) or abs(handedness) < 0.5:
        handedness = 1.0
    else:
        handedness = -1.0 if handedness < 0.0 else 1.0
    return (*direction, handedness)


# Imperative shell: Blender, external tools, and filesystem assembly.


def accessor_layout(document, accessor_index, expected_type):
    accessor = document["accessors"][accessor_index]
    if (
        accessor.get("componentType") != 5126
        or accessor.get("type") != expected_type
        or "sparse" in accessor
    ):
        raise RuntimeError(f"Unsupported accessor layout at index {accessor_index}")
    view = document["bufferViews"][accessor["bufferView"]]
    if view.get("buffer", 0) != 0:
        raise RuntimeError("Geometry repair expects a single binary buffer")
    components = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[expected_type]
    element_size = components * 4
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return accessor, offset, view.get("byteStride", element_size)


def repair_binary(document, source, destination):
    shutil.copy2(source, destination)
    tangent_pairs = {}
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            attributes = primitive.get("attributes", {})
            if "TANGENT" in attributes:
                tangent_pairs[attributes["TANGENT"]] = attributes["NORMAL"]

    repaired_tangents = 0
    shifted_animations = 0
    with destination.open("r+b") as handle, mmap.mmap(handle.fileno(), 0) as binary:
        for tangent_index, normal_index in tangent_pairs.items():
            tangent, tangent_offset, tangent_stride = accessor_layout(
                document, tangent_index, "VEC4"
            )
            normal, normal_offset, normal_stride = accessor_layout(
                document, normal_index, "VEC3"
            )
            if tangent["count"] != normal["count"]:
                raise RuntimeError("Tangent and normal accessor counts differ")

            for index in range(tangent["count"]):
                tangent_position = tangent_offset + index * tangent_stride
                values = struct.unpack_from("<4f", binary, tangent_position)
                length = math.sqrt(sum(value * value for value in values[:3]))
                handedness_is_valid = (
                    math.isfinite(values[3]) and abs(abs(values[3]) - 1.0) <= 1e-6
                )
                if math.isfinite(length) and abs(length - 1.0) <= 1e-4 and handedness_is_valid:
                    continue
                normal_position = normal_offset + index * normal_stride
                normal_values = struct.unpack_from("<3f", binary, normal_position)
                struct.pack_into(
                    "<4f",
                    binary,
                    tangent_position,
                    *normalized_tangent(values, normal_values),
                )
                repaired_tangents += 1

        animation_inputs = {
            sampler["input"]
            for animation in document.get("animations", [])
            for sampler in animation.get("samplers", [])
        }
        for accessor_index in animation_inputs:
            accessor, offset, stride = accessor_layout(document, accessor_index, "SCALAR")
            values = [
                struct.unpack_from("<f", binary, offset + index * stride)[0]
                for index in range(accessor["count"])
            ]
            minimum = min(values)
            if minimum >= 0.0:
                continue
            shifted = [value - minimum for value in values]
            for index, value in enumerate(shifted):
                struct.pack_into("<f", binary, offset + index * stride, value)
            accessor["min"] = [min(shifted)]
            accessor["max"] = [max(shifted)]
            shifted_animations += 1

    print(
        f"Repaired {repaired_tangents} tangents and shifted "
        f"{shifted_animations} animation timelines",
        flush=True,
    )


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--raw")
    parser.add_argument("--ktx", default=shutil.which("ktx"))
    parser.add_argument("--convert", default=shutil.which("convert"))
    parser.add_argument("--identify", default=shutil.which("identify"))
    parser.add_argument(
        "--gltfpack",
        default=shutil.which("gltfpack")
        or Path(__file__).parents[1] / "node_modules" / ".bin" / "gltfpack",
    )
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--uastc-quality", type=int, choices=range(5), default=2)
    parser.add_argument("--keep-work", action="store_true")
    script_args = sys.argv[sys.argv.index("--") + 1 :]
    return parser.parse_args(script_args)


def clear_scene(scene):
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def import_scenes(source_dir):
    initial_scene = bpy.context.scene
    clear_scene(initial_scene)

    for index, (scene_name, filename) in enumerate(SCENES):
        scene = initial_scene if index == 0 else bpy.data.scenes.new(scene_name)
        scene.name = scene_name
        bpy.context.window.scene = scene

        materials_before = set(bpy.data.materials)
        bpy.ops.import_scene.fbx(
            filepath=os.path.join(source_dir, filename),
            use_custom_normals=True,
        )

        for material in set(bpy.data.materials) - materials_before:
            original_name = source_material_name(material.name)
            material["bistro_source_name"] = original_name
            material["bistro_source_scene"] = scene_name
            material.use_backface_culling = ".DoubleSided" not in original_name

        if scene_name == "Exterior":
            scene["environment"] = {
                "intensity": 10.0,
                "uri": "san_giuseppe_bridge_4k.hdr",
            }


def triangulate_ngons_for_export():
    modified = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH" or not any(len(polygon.vertices) > 4 for polygon in obj.data.polygons):
            continue
        modifier = obj.modifiers.new(name="glTF n-gon triangulation", type="TRIANGULATE")
        modifier.min_vertices = 5
        modifier.keep_custom_normals = True
        modified += 1
    print(f"Added export-only n-gon triangulation to {modified} objects", flush=True)


def export_gltf(output_dir):
    os.makedirs(output_dir, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(output_dir, "Bistro.gltf"),
        check_existing=False,
        export_format="GLTF_SEPARATE",
        export_copyright="Amazon Lumberyard Bistro, CC BY 4.0",
        export_image_format="AUTO",
        export_keep_originals=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_materials="EXPORT",
        export_vertex_color="MATERIAL",
        export_all_vertex_colors=True,
        export_cameras=True,
        export_lights=True,
        export_extras=True,
        export_yup=True,
        export_apply=False,
        export_shared_accessors=True,
        export_animations=True,
        export_force_sampling=False,
        export_optimize_animation_size=False,
        export_skins=True,
        export_morph=True,
        export_morph_normal=True,
        export_try_sparse_sk=True,
        use_active_scene=False,
    )


def run(command, *, capture=False):
    result = subprocess.run(
        [str(part) for part in command],
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def encode_texture(group, texture_dir, prepared_dir, args):
    name = group["name"]
    semantic = texture_semantic(name)
    source = group["source"]
    prepared = prepared_dir / f"{name}.png"
    output = texture_dir / f"{name}.ktx2"

    if semantic == "normal":
        run(
            [
                args.convert,
                source,
                "-channel",
                "G",
                "-negate",
                "+channel",
                "(",
                "+clone",
                "-fx",
                NORMAL_Z_EXPRESSION,
                ")",
                "-compose",
                "CopyBlue",
                "-composite",
                prepared,
            ]
        )
    else:
        run([args.convert, source, prepared])

    opaque = None
    if name.lower().endswith("_basecolor"):
        opaque = run([args.identify, "-format", "%[opaque]", prepared], capture=True) == "True"

    width, height = (
        int(value)
        for value in run(
            [args.identify, "-format", "%w %h", prepared], capture=True
        ).split()
    )
    compatible_width = max(4, (width + 3) // 4 * 4)
    compatible_height = max(4, (height + 3) // 4 * 4)

    ktx_command = [
        args.ktx,
        "create",
        "--testrun",
        "--format",
        "R8G8B8A8_SRGB" if semantic == "color" else "R8G8B8A8_UNORM",
        "--assign-tf",
        "srgb" if semantic == "color" else "linear",
        "--generate-mipmap",
        "--mipmap-wrap",
        "wrap",
        "--encode",
        "uastc",
        "--uastc-quality",
        str(args.uastc_quality),
        "--zstd",
        "18",
    ]
    if semantic != "color":
        ktx_command.extend(["--assign-primaries", "none"])
    if (compatible_width, compatible_height) != (width, height):
        ktx_command.extend(
            ["--width", str(compatible_width), "--height", str(compatible_height)]
        )
    if semantic == "normal":
        ktx_command.append("--normalize")
    ktx_command.extend([prepared, output])
    run(ktx_command)

    return {"name": name, "opaque": opaque, "uri": f"Textures/{name}.ktx2"}


def deduplicate_textures(results, texture_dir):
    canonical_by_digest = {}
    original_size = 0
    removed_size = 0

    for name in sorted(results):
        path = texture_dir / f"{name}.ktx2"
        size = path.stat().st_size
        original_size += size
        digest = hashlib.sha256(path.read_bytes()).digest()
        canonical = canonical_by_digest.setdefault(digest, name)
        results[name]["uri"] = f"Textures/{canonical}.ktx2"
        if canonical != name:
            path.unlink()
            removed_size += size

    print(
        f"Deduplicated {len(results)} textures to {len(canonical_by_digest)} "
        f"({removed_size / 1024 / 1024:.2f} MiB removed from "
        f"{original_size / 1024 / 1024:.2f} MiB)",
        flush=True,
    )


def compress_geometry(staging_dir, args):
    packed_dir = staging_dir / "packed"
    packed_dir.mkdir()
    report = packed_dir / "report.json"
    run(
        [
            args.gltfpack,
            "-i",
            staging_dir / "Bistro.gltf",
            "-o",
            packed_dir / "Bistro.gltf",
            "-cz",
            "-ce",
            "khr",
            "-vp",
            "16",
            "-vpf",
            "-vt",
            "16",
            "-vtf",
            "-vn",
            "12",
            "-kn",
            "-km",
            "-ke",
            "-kv",
            "-af",
            "0",
            "-at",
            "24",
            "-ar",
            "16",
            "-as",
            "24",
            "-ac",
            "-tr",
            "-r",
            report,
        ]
    )
    shutil.move(packed_dir / "Bistro.gltf", staging_dir / "Bistro.gltf")
    shutil.move(packed_dir / "Bistro.bin", staging_dir / "Bistro.bin")
    shutil.rmtree(packed_dir)


def assemble(raw_dir, source_dir, staging_dir, args):
    with (raw_dir / "Bistro.gltf").open(encoding="utf-8") as handle:
        document = json.load(handle)

    texture_dir = staging_dir / "Textures"
    prepared_dir = raw_dir / "prepared"
    texture_dir.mkdir(parents=True)
    prepared_dir.mkdir(exist_ok=True)

    source_textures = {}
    source_texture_files = sorted(
        (source_dir / "Textures").iterdir(),
        key=lambda path: (path.suffix.casefold() != ".dds", path.name.casefold()),
        reverse=True,
    )
    for source_texture in source_texture_files:
        if source_texture.suffix.casefold() in (".dds", ".tga"):
            source_textures[source_texture.stem.casefold()] = source_texture

    groups = {}
    image_to_group = {}
    for image_index, image in enumerate(document.get("images", [])):
        name = texture_name(image)
        source_texture = source_textures.get(name.casefold())
        if source_texture is None:
            raise RuntimeError(f"No source texture found for {name}")
        group = groups.setdefault(
            name,
            {"name": name, "image": image, "indices": [], "source": source_texture},
        )
        group["indices"].append(image_index)
        image_to_group[image_index] = name

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.jobs)) as executor:
        futures = {
            executor.submit(
                encode_texture,
                group,
                texture_dir,
                prepared_dir,
                args,
            ): name
            for name, group in groups.items()
        }
        try:
            for completed, future in enumerate(concurrent.futures.as_completed(futures), start=1):
                name = futures[future]
                results[name] = future.result()
                print(f"Encoded {completed}/{len(futures)}: {name}", flush=True)
        except BaseException:
            for future in futures:
                future.cancel()
            raise

    deduplicate_textures(results, texture_dir)
    document = transformed_document(document, results, image_to_group, args)
    buffers = [buffer for buffer in document.get("buffers", []) if "uri" in buffer]
    if len(buffers) != 1:
        raise RuntimeError("Geometry repair expects exactly one external buffer")
    buffer_uri = unquote(buffers[0]["uri"])
    repair_binary(document, raw_dir / buffer_uri, staging_dir / buffer_uri)

    with (staging_dir / "Bistro.gltf").open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    compress_geometry(staging_dir, args)

    shutil.copy2(source_dir / "san_giuseppe_bridge_4k.hdr", staging_dir)


def validate_tools(args):
    for name in ("ktx", "convert", "identify", "gltfpack"):
        if not getattr(args, name):
            raise SystemExit(f"Missing required tool: {name}")


def build(args):
    validate_tools(args)
    source_dir = Path(args.source).resolve()
    output_dir = Path(args.output).resolve()
    if output_dir == Path.cwd().resolve() or output_dir == Path(output_dir.anchor):
        raise SystemExit("Refusing to replace a broad output directory")

    work_dir = Path(
        tempfile.mkdtemp(prefix="bistro-gltf-", dir=str(output_dir.parent))
    )
    raw_dir = Path(args.raw).resolve() if args.raw else work_dir / "raw"
    staging_dir = work_dir / "Bistro"
    if not args.raw:
        raw_dir.mkdir()
    staging_dir.mkdir()

    try:
        if not args.raw:
            import_scenes(source_dir)
            triangulate_ngons_for_export()
            export_gltf(raw_dir)
        assemble(raw_dir, source_dir, staging_dir, args)

        if output_dir.exists():
            shutil.rmtree(output_dir)
        staging_dir.rename(output_dir)
        print(f"Built {output_dir}")
    finally:
        if args.keep_work:
            print(f"Kept intermediate files at {work_dir}")
        elif work_dir.exists():
            shutil.rmtree(work_dir)


if __name__ == "__main__":
    args = parse_args()
    build(args)
