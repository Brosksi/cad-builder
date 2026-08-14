---
name: cad-builder
description: CAD Builder — model-friendly CAD compiler. Write YAML specs, get STLs + annotated screenshots. No GUI, no coordinate math bugs, no booleans.
license: MIT
compatibility: opencode
metadata:
  category: cad
  version: "1.0"
---

# CAD Builder Skill

## When to use

Any task that requires creating 3D models for 3D printing, assembly design, or mechanical parts. The model writes a structured YAML spec, the compiler generates geometry, exports STLs, and produces annotated screenshots.

## How it works

```
model writes YAML spec → cad_compile.py → FreeCAD geometry + STLs
                                    ↓
                            cad_render.py → annotated screenshots
```

The model never:
- Computes edge selections for fillets
- Manages boolean operation ordering
- Debugs FreeCAD viewport rendering
- Tracks intermediate object state

The model ONLY:
1. Defines part geometries via primitives
2. Lays out the assembly via explicit (x,y,z) positions
3. Reviews the output screenshots and iterates

## DSL Reference

The spec is a single YAML file. All geometry is declarative.

### Full Example

```yaml
# design.yaml
meta:
  name: "MyDesign"
  output_dir: "./output"

parts:
  - name: PencilBin
    geometry:
      type: hollow_container        # box → fillet → hollow → optional tab
      outer: [60, 60, 200]          # width, depth, height in mm
      wall: 3                       # wall thickness
      top_fillet: 5                 # radius on all top edges
    features:
      - type: friction_tab          # tab for press-fit into base
        at: bottom
        size: [59, 59, 10]
        clearance: 0.5              # per side

  - name: BasePlate
    geometry:
      type: solid_block
      size: [300, 300, 30]
      top_fillet: 5

assembly:                           # part_name: [x, y, z] in mm
  BasePlate: [0, 0, 0]
  PencilBin#1: [48.5, 25, 0]
  PencilBin#2: [119.5, 25, 0]

output:
  stl:
    per_part: true                  # one STL per part
    combined: true                  # full assembly STL
  screenshots:
    per_part: true                  # screenshot per part (isometric)
    assembly: true                  # screenshot of assembly
    views: [isometric, front, top]  # additional views
    annotate: dimensions            # draw dimension arrows + values
    background: white
```

### Geometry Primitives

| Type | Params | Description |
|------|--------|-------------|
| `solid_block` | `size: [w,d,h]`, `top_fillet: R` | Simple block with optional top-edge fillets |
| `hollow_container` | `outer: [w,d,h]`, `wall: t`, `top_fillet: R` | Box → fillet top → hollow with `t` walls → optional tab |
| `cylinder` | `radius: R`, `height: h` | Solid cylinder |
| `extrusion` | `profile: [...]`, `height: h` | Extrude a 2D polygon |
| `revolved_body` | `profile: [[r,z], ...]`, `wall: t` | 2D half-profile revolved around Z axis. Creates round/radial bodies (pumpkins, bowls, vases). If `wall>0`, hollows out with `t` mm wall thickness. Interpolates inner profile and adds floor disk automatically. |

### Features

| Type | Params | Description |
|------|--------|-------------|
| `friction_tab` | `at: bottom`, `size: [w,d,h]`, `clearance: c` | Tab for press-fit. Compiler applies clearance and fillets |
| `slot` | `at: [x,y]`, `size: [w,d,h]` | Rectangular pocket cut from the part. Used on bases |
| `slot_array` | `slots: [...]` | Multiple slots from an array of `{instance, size, at}` |
| `fillet` | `edges: type`, `radius: R` | Explicit fillet (`top`, `bottom`, `all`, `vertical`) |
| `hole` | `at: [x,y]`, `radius: R`, `through: true` | Through hole. Position relative to part origin |
| `cutout` | `shape: triangle|mouth`, `size: [w,h]`, `at: [x,y,z]`, `depth: d` | Face cutout through the wall of a revolved body. Extrudes a 2D profile inward (-Y direction) and boolean-cuts from the part. For triangle: isosceles with top vertex at `z + h/2`. For mouth: rounded rectangle with 15% corner fillet. |

### Assembly Positioning

The `assembly` block maps instance names to absolute positions:

```yaml
assembly:
  PartName: [x, y, z]                    # single instance
  PartName#InstanceID: [x, y, z]         # named instance (for multiple of same part)
```

Positions are in mm. Z=0 means the part bottom sits on the build plane.

## Running the Compiler

```bash
# Compile a design spec
cad_compile design.yaml

# The compiler:
# 1. Validates the spec against the schema
# 2. Creates a FreeCAD document with all parts
# 3. Cuts features (slots, holes)
# 4. Assembles parts at the specified positions
# 5. Exports STLs to output_dir/STLs/
# 6. Returns a summary of what was built

# Render screenshots
cad_render output_dir/design.FCStd

# The renderer:
# 1. Opens the compiled FreeCAD document
# 2. Captures each part in the specified views
# 3. Overlays dimension annotation arrows
# 4. Saves to output_dir/screenshots/
# 5. Returns image paths
```

### Pumpkin / Round Container Example

```yaml
# round_pumpkin.yaml
meta:
  name: "Jackolantern"
  output_dir: "./output"

parts:
  - name: PumpkinBody
    geometry:
      type: revolved_body
      profile:
        - [0, 0]      # center bottom (flat base)
        - [88, 0]     # bottom edge
        - [90, 30]    # outward to max width
        - [90, 70]    # maintain max width
        - [88, 100]   # taper inward
        - [82, 125]   # shoulder
        - [74, 140]   # upper curve
        - [66, 150]   # neck
        - [63, 155]   # rim outer
        - [0, 155]    # center of opening
      wall: 3                    # 3mm shell wall
    features:
      - type: cutout
        shape: triangle
        size: [30, 40]           # eye size w×h
        at: [-18, 89, 105]       # left eye (x on face, y at surface, z height)
        depth: 15
      - type: cutout
        shape: triangle
        size: [30, 40]
        at: [18, 89, 105]        # right eye
        depth: 15
      - type: cutout
        shape: triangle
        size: [20, 25]
        at: [0, 90, 70]          # nose
        depth: 15
      - type: cutout
        shape: mouth
        size: [90, 35]
        at: [0, 90, 35]          # mouth
        depth: 15

  - name: Lid
    geometry:
      type: solid_block
      size: [174, 174, 4]        # fits inside body rim
      top_fillet: 2
    features:
      - type: friction_tab
        at: bottom
        size: [174, 174, 4]
        clearance: 0.5

  - name: Stem
    geometry:
      type: solid_block
      size: [35, 35, 25]
      top_fillet: 6

assembly:
  PumpkinBody: [0, 0, 0]
  Lid: [0, 0, 156]
  Stem: [0, 0, 160]
```

**Profile design for pumpkins**: The `profile` is a half-cross-section \[radius, height\] in the XZ plane, revolved around Z. For an oblate pumpkin: flat bottom, widest at 20-50% height, taper to rim at ~95% height. Adjust radius values for wider/narrower pumpkins.

**Cutout positioning**: The `at: [x, y, z]` places the cutout center on the front (+Y) surface. `y` should match the outer radius at the given `z` height. `depth` must exceed `wall` thickness to cut through.

## Iteration Workflow

```
1. Write spec → run cad_compile → inspect STLs/summary
2. Run cad_render → inspect screenshots
3. Identify issues (wrong position, bad dimension, missing feature)
4. Edit YAML spec → re-run compile + render
5. Repeat until verified
```

No FreeCAD GUI interaction needed at any step.
