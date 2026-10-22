---
name: blender-3d
description: Model, script, render or export 3D scenes with Blender from the command line (headless). Use when the user asks for a 3D model, a car/character/object design, a render, or a GLB/STL/OBJ export.
---

# Blender from the command line

Blender is scriptable: drive everything with a Python script through `blender --background --python <file.py>`. Never try to model by clicking the GUI.

## 1. Find it first

```bat
where blender
dir "C:\Program Files\Blender Foundation" /b
```
Typical path: `C:\Program Files\Blender Foundation\Blender <version>\blender.exe` (the folder name contains a space — always quote it).

## 2. Smoke test before any real work

```python
# smoke.py
import bpy, sys
print("BLENDER", bpy.app.version_string)
print("OBJECTS", [o.name for o in bpy.data.objects])
```
```
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --python smoke.py
```
If it prints a version and the default three objects (Cube, Camera, Light), the install works. Do this once, then continue.

## 3. Reset the scene, then build from primitives

```python
import bpy, math
# start clean
bpy.ops.wm.read_factory_settings(use_empty=True)

def cube(name, loc, scale, rot=(0,0,0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = scale
    return ob

body  = cube("body",  (0, 0, 0.55), (4.2, 1.9, 0.75))
cabin = cube("cabin", (0.15, 0, 1.15), (2.1, 1.7, 0.7))
for i, x in enumerate((-1.4, 1.4)):
    for j, y in enumerate((-0.95, 0.95)):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.42, depth=0.3,
            location=(x, y, 0.42), rotation=(math.radians(90), 0, 0))
```

## 4. Make it look intentional (not a default cube)

- **Bevel + subdivision** for readable form: add a Bevel modifier (`ob.modifiers.new("bev","BEVEL")`) with `width=0.06, segments=3`, and `SUBSURF` with `levels=2` for organic shapes.
- **Boolean** for windows/wheel arches: `BOOL` modifier with an `operation='DIFFERENCE'` object.
- **Materials** carry most of the realism: `mat = bpy.data.materials.new("paint"); mat.use_nodes = True` then set `Principled BSDF` base colour + metallic 0.6 + roughness 0.25. Assign with `ob.data.materials.append(mat)`.
- **Lighting + camera**: one area light at 45°, a soft fill, and `camera.data.lens = 50`; frame with `bpy.ops.view3d.camera_to_view_selected()`.

## 5. Render to verify (always do this)

```python
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE_NEXT'   # or 'CYCLES' for quality
sc.render.resolution_x, sc.render.resolution_y = 1280, 720
sc.render.filepath = r"workspace\render.png"
bpy.ops.render.render(write_still=True)
```
Then look at it: `file_view_image { "path": "render.png" }`. If it does not obviously match the request, fix the model and re-render. **A single cube is never an acceptable answer to "design a car".**

## 6. Export the deliverable

```python
bpy.ops.export_scene.gltf(filepath=r"workspace\model.glb", export_format='GLB')
```
Also offer `.obj`/`.stl` (`bpy.ops.wm.obj_export`, `bpy.ops.export_mesh.stl`) when the user's target app needs them.

## Pitfalls

- Spaces in the executable path: quote it, and pass the script path as an absolute path.
- `bpy.ops.*` needs the right context: in `--background` mode prefer `bpy.ops.wm.read_factory_settings(use_empty=True)` at the top, and set `bpy.context.view_layer.objects.active` before operators that need a selection.
- Blender never prints progress to stdout the way you expect; write your own `print()` markers and check `exit_code`.
- Renders are slow at high samples — start with EEVEE + 64 samples to iterate, then switch to Cycles for the final image.
- Save the working recipe with `skill_patch` if this file was missing a step you needed.
