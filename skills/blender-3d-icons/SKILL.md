---
name: Blender 3D icons
description: Use when you need to render a bold, soft-3D (clay/porcelain) app icon or mascot prop with Blender headless on the user's computer, with brand colors passed in as a palette, then check the result against that palette.
---

---
name: Blender 3D icons
description: Use when you need to render a bold, soft-3D (clay/porcelain) app icon or mascot prop with Blender headless on the user's computer, with brand colors passed in as a palette, then check the result against that palette.
---
# Blender headless 3D icons

## Inputs
- PALETTE: a dict of brand hex colors and any forbidden colors. Nutrio example: navy #0C1221 (lines only), green #1BB897, purple #6F7FF3, sky #40B8F8, coral #F85868, orange #F26A06, plus white and tints. Forbidden: #F4B740 and #0E8C76.
- SUBJECT, SIZE (default 1024), OUTLINE color (default the darkest palette color).
- Blender path on the target machine, for example C:\Program Files\Blender Foundation\Blender X.Y\blender.exe.

## Steps
1. Find the desktop with ListMachines. Each machine Shell call needs approval, so keep calls few. Create %USERPROFILE%\<proj>_blender\ there once.
2. Write the script on the box. Start from template_icon.py, which is stored next to this skill.
   - Start with `read_factory_settings(use_empty=True)`.
   - Build shapes with bmesh: spheres, squashed spheres, a hemisphere bowl plus a Solidify wall, and a torus band with per-face material indices.
   - Write the output to an absolute path under the user's home.
   - Print a `WROTE <path>` marker at the end.
3. Use CopyFromBox to put the script on the machine. Do not run it in the same parallel batch: copies and runs can race and leave a stale file. In the run command, grep the script for a value you just changed.
4. Run `& "<blender.exe>" -b -P "<script>" 2>&1 | Select-String "Error|Traceback|WROTE"`. On Cycles CPU at 48 samples, 1024 px takes about 10 s.
5. Use CopyToBox to bring the PNG back to a versioned box path (v1, v2, ...). Make this copy only after the run has returned.
6. Verify the render (checklist below). Then iterate by editing values and repeating from step 3.

## Template essentials
- Color conversion: sRGB hex to linear for every Base Color and Emission:
  `f=lambda v: v/12.92 if v<=0.04045 else ((v+0.055)/1.055)**2.4`.
  Make tints by mixing toward white (mix_white 0.6 to 0.85).
- Set view_transform 'Standard', not AgX or Filmic. Otherwise the hex colors shift.
- Material: Principled BSDF with roughness 0.25 to 0.5 and Coat Weight 0.6 to 1.0 for a porcelain or clay look.
- Thick outline, using the inverted hull method:
  - Add a Solidify modifier as the LAST modifier: offset 1, use_flip_normals, material_offset pointing to an outline material.
  - Outline material: Geometry.Backfacing drives a Mix with Emission(outline) in slot 1 and Transparent in slot 2.
  - Wrap that in a second Mix driven by LightPath."Is Camera Ray", with Transparent in slot 1. Without this, the hull blocks all lighting and the render comes out as a black silhouette.
  - Thickness: about 0.035 for large forms, 0.02 to 0.06 for small parts.
- Smooth shading plus Subdivision Surface at level 1 or 2.
- Camera: orthographic, elevation 30 to 35°, ortho_scale about 2.6 for a subject about 2 units wide.
- Lights: three AREA lights aimed at the origin with to_track_quat('-Z','Y'). Key about 380 W, fill 120 W, rim 150 W. World white at strength 0.3. Brighter settings blow out whites and shift colors, for example green turning cyan.
- Render: Cycles, 48 samples, denoise on, film_transparent, PNG RGBA, square resolution. Eevee also works if a GPU is available.

## Verification checklist (box, PIL)
- Read the PNG yourself.
- Not blank or clipped: getbbox() has margin on all sides, and the subject fills about 70 to 90% of the frame.
- Palette: classify opaque pixels to the nearest PALETTE or forbidden color within distance 40. Forbidden hits should only be small shading regions. Large areas mean the lighting or tint is wrong.
- Outline color sits on the edges only. No text in the image.
- Make previews on white and on the darkest brand color, plus a side-by-side grid. Check legibility at about 96 px.
- Report the final path, previews, and problems. Keep the earlier versions.

## Lessons for premium / pro-level renders (learned 2026-10-15)
- At a pro level, primitive spheres, diamond leaves and thick toon outlines read as amateur. Build real forms instead:
  - Lathe the bowl profile with bmesh.ops.spin: rounded lip arc, inner wall, flat foot. Use 128 steps and Subsurf level 2.
  - Leaf: a grid with a sin-shaped width, a V-fold (z = fold*|y|), a curl along the length, a lighter midrib material on the centre columns, and Solidify at 0.012.
  - Tomato half: hemisphere plus holes_fill cap with a lighter flesh material, a core disc and a ring of small seed ellipsoids.
  - Citrus slice: half-disc prism with a rind material on the curved side, a flesh material on the flat faces, a Bevel modifier and pale pith spokes.
  - Base: about 1000 linked-duplicate grain ellipsoids scattered on a dome. Give each object its own material slot (link='OBJECT') for color variety.
  - Logo ring band: a torus with per-face material index. Use 2× repeats (10 segments for 5 colors) so all 5 colors face the camera.
- Dropping the outline looks more premium than a thin navy hull. On thin parts like leaves, the hull makes spiky artifacts.
- Lighting:
  - Shared base: key 260 W with size 2.5 to 4 (smaller gives a crisper ceramic highlight), fill 70 W tinted cool, rim 160 W, top 50 W.
  - World: gradient (Generated Z into a ColorRamp from grey-blue to white) at strength about 0.22.
  - About 3× those values blows out whites and pushes green toward cyan.
- Ceramic: base color tint 0.2 to 0.25 toward white, roughness 0.08 to 0.15, coat 1.0. Tints above 0.4 read as grey or white, not brand-colored.
- Fruit: subsurface weight 0.2 to 0.6 with subsurface scale about 0.05.
- Pale orange tints read pink. For cream or grain use 0.86 to 0.93 toward white, and keep green specks rare (about 1 in 14) and pale. Otherwise they look like confetti.
- Shadow catcher plus a transparent film plus a gradient world gave a hard grey disc over the whole catcher. Hide the catcher and composite a soft contact shadow in PIL instead: two blurred navy ellipses at low alpha under the base.
- Post-process in PIL: crop to the alpha bbox, add the shadow, then scale so the longest side is 80% of the canvas. That leaves 10% margins, centred.
- Camera: perspective 85 mm at 40° elevation, about 6.6 units from target (0,0,0.42), gave the best hero 3/4 view. 50 mm distorts the rim. 30° hides the food.
- Workflow:
  - Render every variant in ONE Blender call: loop over the variants and toggle modifier show_render.
  - Test at 32 samples. Final at 160 samples with denoise: about 20 s per frame on his GPU.
  - Make every file edit BEFORE the CopyFromBox call, in a separate step. Guard the run with a Select-String check for the new value: two races happened.
- Palette check: classify pixels to the palette plus white plus forbidden colors within distance 45. Expect small forbidden hits from shading, e.g. dark leaf shade lands near teal and orange highlights near gold. Report them, but only large areas are a fail.

## Lessons from v3 (hero-cluster food icon)
- Hero cluster: put 3 groups close together with height: an avocado half with its pit, 3 cherry tomatoes, and 3–4 blueberries with one stacked on top. That reads far better than toppings scattered to the edges. Fewer elements gave a cleaner silhouette at 96 px.
- Things that looked bad and were cut:
  - A cube-based "salmon" slab with wave stripes read as a candy box.
  - A thin cream NURBS drizzle on a pale base read as a stray string.
  - Tilted tomato halves read as pink cookies. Whole tomatoes with a 5-point green calyx (star polygon plus Solidify, sitting above the dented top) and a stem read instantly.
- Leaves that stand up read as rabbit ears. Lay them nearly flat (rotation x/y within ±5°) and tuck them under or behind other items.
- Avocado half:
  - Lathe an egg profile (r = sqrt(1-z²)·(0.78-0.22z)), bisect it with clear_inner, holes_fill the cap and rotate the mesh data 90° about Y so the cap faces up.
  - Flesh: radial ColorRamp on object coordinates.
  - Pit: shade orange toward navy (brown).
  - Skin: shade green toward navy, plus noise bump.
- Blueberry:
  - Dent the top, add a 10-vertex star crown extruded with a bevel.
  - Material: shade purple about 0.3 toward navy, roughness about 0.6, Sheen 0.9 for the matte bloom.
  - Tilt it toward the camera (rot x 0.7–1.0) so the crown shows.
- Leaf vein bump: Math chain sin((x - 1.4|y|)·55), then abs, then pow 6, into a Bump node at strength 0.12. Use roughness 0.45 and SSS 0.35 for a less plastic look.
- Ceramic gradient: Object Z into a ColorRamp, from sky shaded 0.08 toward navy at the base to sky 0.5 toward white at the rim. For the inner glaze, mark inner faces (normal·radial < 0) with a lighter, glossier material. A rectangular rim strip light (5×0.6) behind plus a low front strip gives the lip highlights.
- Grains: lentil ellipsoids (0.028×0.028×0.011), about 2,600 of them. Any coral tint, or a pale dome showing through, reads pink. Use orange tints only (0.66–0.88 toward white) and a darker dome.
- Test at 48 samples, final at 160 samples: about 20 s per variant on his GPU.

## The gap vs AI image models, and techniques to close it (v4, 2026-10-15)
Reference: Higgsfield gpt_image_2_5 costs about 0.125 credit per image. A text-only prompt gave a clearly more professional result than procedural Blender. Why procedural Blender looks lower quality:
1. Modeling: primitives plus math curves have no organic irregularity. Real leaves (spinach or basil) have serrated or wavy edges and a midrib bend. The avocado needs a dark bumpy skin rim, a yellow-to-green flesh gradient and a matte, textured pit. Tomatoes need a cut half with gel and seeds.
2. Materials: everything shares one Principled setup, so it all looks like plastic. The reference varies materials: matte flesh, waxy leaves, dusty berries, glossy tomato skin and very glossy ceramic.
3. Color: brand-restricted tints look candy-like. The reference uses natural food colors (red tomato, yellow-green avocado, near-black blueberries) and saves the brand colors for the bowl and band. Keep food natural-ish: restrict brand colors to the vessel and accents, and ask the owner whether that's allowed.
4. Lighting: area lights give hard, separate highlights. The reference reads like a big softbox HDRI with a wrap-around gradient on the bowl. Use a real studio HDRI if one is available (Poly Haven "studio_small_09"), or one large overhead softbox plus a white bounce card.
5. Composition: low camera (15–20°), a deep bowl with a visible foot, and food piled ABOVE the rim, filling about 45% of the height. Leaves fan out behind as a backdrop and the avocado leans toward the camera.
6. Post: the reference has crisp local contrast. A PIL pass helps a little (saturation 1.15, contrast 1.08, unsharp radius 2 at 60%).
Pitfalls hit in v4:
- The domez() formula must match the base mesh, using the sphere profile sqrt(1-t²). Otherwise the grains sit inside the base and vanish.
- Read can show a CACHED image for a path it has already read. Save each comparison under a new filename.
- Grain flecks shaded toward coral read as confetti. Keep them under about 8% of grains, or leave them out.
Practical recommendation: for hero marketing art, generate with an image model (palette in the prompt) and verify the palette in PIL. Use Blender when you need consistent multi-angle or animated assets, or exact brand geometry.
