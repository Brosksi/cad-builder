#!/usr/bin/env python3
"""
CAD Compiler: reads a YAML design spec → generates FreeCAD geometry → exports STLs.
Usage: freecadcmd cad_compile.py design.yaml
"""

import json, os, sys, yaml, traceback
import FreeCAD as App

# === Primitives ===

def build_revolved_body(doc, name, params):
    """Build a revolved_body primitive: 2D half-profile rotated around Z axis.

    YAML:
      geometry:
        type: revolved_body
        profile: [[r, z], [r, z], ...]   # half-cross-section (radius, height)
        wall: 3                            # 0 = solid, >0 = hollow with wall thickness
    """
    import FreeCAD, Part
    profile = params["profile"]  # list of [radius, height]
    wall = params.get("wall", 0)

    # Build outer profile as closed polygon in XZ plane (y=0)
    outer_pts = [FreeCAD.Vector(r, 0, z) for r, z in profile]
    outer_wire = Part.makePolygon(outer_pts + [outer_pts[0]])
    outer_face = Part.Face(outer_wire)
    outer_solid = outer_face.revolve(
        FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(0, 0, 1), 360)

    if wall > 0:
        max_z = max(z for r, z in profile)
        inner_z_max = max_z - wall

        # Build inner profile: offset radii inward by wall, cap at inner_z_max
        inner_pts = []
        prev_r, prev_z = None, None
        for r, z in profile:
            ir = max(0, r - wall)
            if z <= inner_z_max:
                inner_pts.append(FreeCAD.Vector(ir, 0, z))
                prev_r, prev_z = ir, z
            elif prev_z is not None and prev_z < inner_z_max:
                # Interpolate at the cap height
                ratio = (inner_z_max - prev_z) / (z - prev_z) if z != prev_z else 0
                interp_r = prev_r + (ir - prev_r) * ratio
                inner_pts.append(FreeCAD.Vector(interp_r, 0, inner_z_max))

        # Close inner profile: (end_radius, inner_z_max) → (0, inner_z_max) → (0, 0)
        end = inner_pts[-1]
        inner_pts.append(FreeCAD.Vector(0, 0, end.z))
        inner_pts.append(FreeCAD.Vector(0, 0, profile[0][1]))  # back to bottom center

        inner_wire = Part.makePolygon(inner_pts)
        inner_face = Part.Face(inner_wire)
        inner_solid = inner_face.revolve(
            FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(0, 0, 1), 360)

        # Core hollow: subtract inner from outer
        result = outer_solid.cut(inner_solid)

        # Add floor disk at bottom
        min_z = profile[0][1]
        max_r_bottom = max(r for r, z in profile if abs(z - min_z) < 0.01)
        floor_r = max(0, max_r_bottom - wall)
        if floor_r > 0:
            floor = Part.makeCylinder(floor_r, wall)
            result = result.fuse(floor)
    else:
        result = outer_solid

    o = doc.addObject("Part::Feature", name)
    o.Shape = result
    return o


def build_cylinder(doc, name, params):
    """Build a cylinder primitive."""
    import Part
    r = params["radius"]
    h = params["height"]
    cyl = Part.makeCylinder(r, h)
    fillet_r = params.get("top_fillet", 0)
    if fillet_r > 0:
        te = [e for e in cyl.Edges if len(e.Vertexes) == 2
              and abs(e.Vertexes[0].Z - h) < 0.01
              and abs(e.Vertexes[1].Z - h) < 0.01]
        try:
            cyl = cyl.makeFillet(fillet_r, te)
        except Exception:
            pass
    o = doc.addObject("Part::Feature", name)
    o.Shape = cyl
    return o


def build_sphere(doc, name, params):
    """Build a sphere or ellipsoid."""
    import Part
    radius = params.get("radius", 10)
    size = params.get("size", None)
    if size:
        sph = Part.makeSphere(size[2])  # base radius
        # Scale to ellipsoid via transform
        from FreeCAD import Base
        mat = Base.Matrix()
        mat.scale(Base.Vector(size[0]/size[2] if size[2] else 1,
                              size[1]/size[2] if size[2] else 1, 1))
        sph = sph.transformGeometry(mat)
    else:
        sph = Part.makeSphere(radius)
    o = doc.addObject("Part::Feature", name)
    o.Shape = sph
    return o


def build_cone(doc, name, params):
    """Build a cone or pyramid frustum."""
    import Part
    r_bottom = params.get("radius_bottom", 10)
    r_top = params.get("radius_top", 5)
    h = params.get("height", 20)
    size = params.get("size", None)
    if size:
        # Square pyramid frustum: bottom and top face sizes
        from FreeCAD import Base
        bw, bd = size[0]/2, size[1]/2
        tw, td = (size[2]/2 if len(size) > 2 else bw/2), (size[3]/2 if len(size) > 3 else bd/2)
        pts = [
            Base.Vector(-bw, -bd, 0), Base.Vector(bw, -bd, 0),
            Base.Vector(bw, bd, 0), Base.Vector(-bw, bd, 0),
            Base.Vector(-tw, -td, h), Base.Vector(tw, -td, h),
            Base.Vector(tw, td, h), Base.Vector(-tw, td, h),
        ]
        import Mesh
        import FreeCAD
        # Use Part.makeLoft between top and bottom faces
        bot_wire = Part.makePolygon([pts[0], pts[1], pts[2], pts[3], pts[0]])
        top_wire = Part.makePolygon([pts[4], pts[5], pts[6], pts[7], pts[4]])
        bot_face = Part.Face(bot_wire)
        top_face = Part.Face(top_wire)
        try:
            cone = Part.makeLoft([bot_wire, top_wire], True, True)
        except Exception:
            # Fallback: simple box
            cone = Part.makeBox(size[0], size[1], h)
    else:
        cone = Part.makeCone(r_bottom, r_top, h)
    o = doc.addObject("Part::Feature", name)
    o.Shape = cone
    return o


def build_torus(doc, name, params):
    """Build a torus."""
    import Part
    major = params.get("major_radius", 20)
    minor = params.get("minor_radius", 5)
    torus = Part.makeTorus(major, minor)
    o = doc.addObject("Part::Feature", name)
    o.Shape = torus
    o.Placement = App.Placement(
        App.Vector(0, 0, minor), App.Rotation())
    return o


def build_lshape(doc, name, params):
    """Build an L-shaped extrusion (corner bracket/angle)."""
    import FreeCAD, Part
    leg1 = params.get("leg1", [20, 20, 10])
    leg2 = params.get("leg2", [20, 20, 10])
    thick = params.get("thickness", 3)
    # L-shape: two boxes fused
    box1 = Part.makeBox(leg1[0], leg1[1], leg1[2])
    box2 = Part.makeBox(leg2[0], leg2[1], leg2[2])
    # Position leg2 at the end of leg1
    if leg1[0] >= leg2[0]:
        box2.translate(FreeCAD.Vector(0, leg1[1], 0))
    else:
        box2.translate(FreeCAD.Vector(leg1[0], 0, 0))
    shape = box1.fuse(box2)
    o = doc.addObject("Part::Feature", name)
    o.Shape = shape
    return o


def build_solid_block(doc, name, params):
    """Build a solid_block primitive."""
    import Part
    sz = params["size"]
    box = Part.makeBox(sz[0], sz[1], sz[2])
    fillet_r = params.get("top_fillet", 0)
    if fillet_r > 0:
        h = sz[2]
        te = [e for e in box.Edges if len(e.Vertexes)==2
              and abs(e.Vertexes[0].Z - h) < 0.01
              and abs(e.Vertexes[1].Z - h) < 0.01]
        try: box = box.makeFillet(fillet_r, te)
        except: pass
    o = doc.addObject("Part::Feature", name)
    o.Shape = box
    return o

def build_hollow_container(doc, name, params):
    """Build a hollow_container primitive: box → fillet top → hollow → tab."""
    import FreeCAD, Part
    outer = params["outer"]
    w, d, h = outer
    wall = params["wall"]
    fillet_r = params.get("top_fillet", 5)

    box = Part.makeBox(w, d, h)
    te = [e for e in box.Edges if len(e.Vertexes)==2
          and abs(e.Vertexes[0].Z - h) < 0.01
          and abs(e.Vertexes[1].Z - h) < 0.01]
    try: box = box.makeFillet(fillet_r, te)
    except: pass

    inner = Part.makeBox(w - 2*wall, d - 2*wall, h - wall)
    inner.translate(FreeCAD.Vector(wall, wall, wall))
    shell = box.cut(inner)

    # floor
    floor = Part.makeBox(w - 2*wall, d - 2*wall, wall)
    floor.translate(FreeCAD.Vector(wall, wall, wall))
    result = shell.fuse(floor)

    o = doc.addObject("Part::Feature", name)
    o.Shape = result
    return o

def build_ellipsoid(doc, name, params):
    """Build an ellipsoid: sphere scaled to [w, d, h] via size param.

    YAML:
      geometry:
        type: ellipsoid
        size: [w, d, h]   # full widths in X, Y, Z
    """
    import Part
    from FreeCAD import Base
    sz = params["size"]
    sph = Part.makeSphere(1.0)
    mat = Base.Matrix()
    mat.scale(Base.Vector(sz[0], sz[1], sz[2]))
    sph = sph.transformGeometry(mat)
    o = doc.addObject("Part::Feature", name)
    o.Shape = sph
    return o


def build_multi_layer(doc, name, params):
    """Build stacked extrusions from layers list.

    YAML:
      geometry:
        type: multi_layer
        layers:
          - size: [w, d, h]
            at: [x, y, z]     # position
          - size: [w, d, h]
            at: [x, y, z]
    """
    import FreeCAD, Part
    layers = params["layers"]
    result = None
    for layer in layers:
        sz = layer["size"]
        at = layer.get("at", [0, 0, 0])
        box = Part.makeBox(sz[0], sz[1], sz[2])
        box.translate(FreeCAD.Vector(at[0], at[1], at[2]))
        if result is None:
            result = box
        else:
            result = result.fuse(box)
    o = doc.addObject("Part::Feature", name)
    o.Shape = result
    return o


def build_button_round(doc, name, params):
    """Build a flat-bottomed dome: cylinder + hemisphere fused.

    YAML:
      geometry:
        type: button_round
        radius: 10
        height: 15
    """
    import Part, FreeCAD
    radius = params["radius"]
    height = params["height"]
    dome_height = min(radius, max(0, height))
    cyl_height = max(0, height - dome_height)
    cyl = Part.makeCylinder(radius, cyl_height)
    dome = Part.makeSphere(radius)
    # Keep upper hemisphere via intersection with a box
    upper = Part.makeBox(radius * 2, radius * 2, radius)
    upper.translate(FreeCAD.Vector(-radius, -radius, 0))
    dome = dome.common(upper)
    dome.translate(FreeCAD.Vector(0, 0, cyl_height))
    result = cyl.fuse(dome)
    o = doc.addObject("Part::Feature", name)
    o.Shape = result
    return o


def build_lshape_tshape(doc, name, params):
    """Build a T-shaped extrusion: two boxes fused.

    YAML:
      geometry:
        type: lshape_tshape
        stem: [w, d, h]          # vertical bar
        bar: [w, d, h]           # cross piece
        config: centered          # centered, top, bottom
    """
    import FreeCAD, Part
    stem = params.get("stem", [10, 10, 20])
    bar = params.get("bar", [30, 10, 10])
    config = params.get("config", "centered")
    box1 = Part.makeBox(stem[0], stem[1], stem[2])
    box2 = Part.makeBox(bar[0], bar[1], bar[2])
    bx = (stem[0] - bar[0]) / 2
    by = (stem[1] - bar[1]) / 2
    if config == "top":
        box2.translate(FreeCAD.Vector(bx, by, stem[2]))
    elif config == "bottom":
        box2.translate(FreeCAD.Vector(bx, by, -bar[2]))
    else:  # centered
        box2.translate(FreeCAD.Vector(bx, by, (stem[2] - bar[2]) / 2))
    shape = box1.fuse(box2)
    o = doc.addObject("Part::Feature", name)
    o.Shape = shape
    return o


def build_wedge(doc, name, params):
    """Build a wedge (triangular prism): triangle extruded along Y.

    YAML:
      geometry:
        type: wedge
        size: [w, d, h]   # base width, depth (Y extrusion), height
    """
    import FreeCAD, Part
    sz = params["size"]
    pts = [
        FreeCAD.Vector(0, 0, 0),
        FreeCAD.Vector(sz[0], 0, 0),
        FreeCAD.Vector(0, 0, sz[2]),
    ]
    wire = Part.makePolygon(pts + [pts[0]])
    face = Part.Face(wire)
    prism = face.extrude(FreeCAD.Vector(0, sz[1], 0))
    o = doc.addObject("Part::Feature", name)
    o.Shape = prism
    return o


def apply_friction_tab(doc, obj, params):
    """Add a friction tab to the bottom of a part."""
    import FreeCAD, Part
    sz = params["size"]
    clearance = params.get("clearance", 0.5)
    tw, td, th = sz
    # The part is (w, d, h). Tab centered on bottom face.
    sh = obj.Shape
    bbox = sh.BoundBox
    pw, pd, ph = bbox.XMax - bbox.XMin, bbox.YMax - bbox.YMin, bbox.ZMax - bbox.ZMin

    tab = Part.makeBox(tw, td, th)
    tx = (pw - tw) / 2
    ty = (pd - td) / 2
    tab.translate(FreeCAD.Vector(tx, ty, 0))

    merged = sh.fuse(tab)
    obj.Shape = merged

    return {"tab_center": [tx + tw/2, ty + td/2, th/2],
            "tab_bounds": [tx, ty, 0, tx+tw, ty+td, th]}

def apply_cutout(doc, obj, params):
    """Cut a face opening (jack-o-lantern eye/nose/mouth) through a shell wall.

    Creates a pocket on the front (+Y) face of a revolved body. The pocket
    is extruded inward along -Y and boolean-cut from the part.
    """
    import FreeCAD, Part
    shape = params.get("shape", "triangle")
    size = params.get("size", [30, 40])
    at = params.get("at", [0, 90, 100])
    depth = params.get("depth", 20)

    if shape == "triangle":
        w, h = size
        pts = [
            FreeCAD.Vector(at[0],      at[1], at[2] + h/2),   # top vertex
            FreeCAD.Vector(at[0] - w/2, at[1], at[2] - h/2),  # bottom-left
            FreeCAD.Vector(at[0] + w/2, at[1], at[2] - h/2),  # bottom-right
        ]
        wire = Part.makePolygon(pts + [pts[0]])
        pocket = Part.Face(wire).extrude(FreeCAD.Vector(0, -depth, 0))
        obj.Shape = obj.Shape.cut(pocket)

    elif shape in ("mouth", "rounded_rect"):
        w, h = size
        pocket = Part.makeBox(w, depth, h)
        pocket.translate(FreeCAD.Vector(at[0] - w/2, at[1] - depth, at[2] - h/2))
        try:
            vert_edges = [e for e in pocket.Edges if len(e.Vertexes) == 2]
            pocket = pocket.makeFillet(min(w, h) * 0.15, vert_edges)
        except Exception:
            pass
        obj.Shape = obj.Shape.cut(pocket)

    return obj


def cut_slot(doc, obj, params):
    """Cut a slot/pocket from a part."""
    import FreeCAD, Part
    sz = params["size"]
    at = params["at"]
    sw, sd, sh = sz
    slot = Part.makeBox(sw, sd, sh)
    slot.translate(FreeCAD.Vector(at[0], at[1], 0))
    obj.Shape = obj.Shape.cut(slot)

def cut_hole(doc, obj, params):
    """Cut a cylindrical hole through a part."""
    import FreeCAD, Part
    radius = params.get("radius", 3)
    depth = params.get("depth", 50)
    at = params.get("at", [0, 0])
    direction = params.get("direction", "z")
    hole = Part.makeCylinder(radius, depth)
    if direction == "z":
        hole.translate(FreeCAD.Vector(at[0], at[1], -1))
    elif direction == "y":
        # Rotate cylinder to align with Y
        hole2 = Part.makeCylinder(radius, depth)
        hole2.rotate(FreeCAD.Vector(0,0,0), FreeCAD.Vector(0,0,1), 90)
        hole2.translate(FreeCAD.Vector(at[0], at[1] - depth/2, at[2]))
        hole = hole2
    elif direction == "x":
        hole2 = Part.makeCylinder(radius, depth)
        hole2.rotate(FreeCAD.Vector(0,0,0), FreeCAD.Vector(0,0,1), 90)
        hole2.rotate(FreeCAD.Vector(0,0,0), FreeCAD.Vector(0,1,0), 90)
        hole2.translate(FreeCAD.Vector(at[0] - depth/2, at[1], at[2]))
        hole = hole2
    try:
        obj.Shape = obj.Shape.cut(hole)
    except Exception as e:
        print(f"  [{name}] hole cut failed: {e}")

def add_boss(doc, obj, params):
    """Add a cylindrical boss (raised pad) to a part surface."""
    import FreeCAD, Part
    radius = params.get("radius", 5)
    height = params.get("height", 5)
    at = params.get("at", [0, 0, 0])
    boss = Part.makeCylinder(radius, height)
    boss.translate(FreeCAD.Vector(at[0], at[1], at[2]))
    obj.Shape = obj.Shape.fuse(boss)

def apply_features(doc, obj, name, features, log):
    """Apply feature list to a part."""
    tab_info = None
    for feat in (features or []):
        ft = feat["type"]
        if ft == "friction_tab":
            tab_info = apply_friction_tab(doc, obj, feat)
            log(f"  [{name}] friction_tab: {feat['size']}")
        elif ft == "slot":
            cut_slot(doc, obj, feat)
            log(f"  [{name}] slot: {feat['size']} at {feat['at']}")
        elif ft == "slot_array":
            for s in feat.get("slots", []):
                cut_slot(doc, obj, s)
                log(f"  [{name}] slot for {s['instance']}: {s['size']} at {s['at']}")
        elif ft == "hole":
            cut_hole(doc, obj, feat)
            log(f"  [{name}] hole: r={feat.get('radius')} at {feat.get('at')}")
        elif ft == "boss":
            add_boss(doc, obj, feat)
            log(f"  [{name}] boss: r={feat.get('radius')} h={feat.get('height')} at {feat.get('at')}")
        elif ft == "cutout":
            apply_cutout(doc, obj, feat)
            log(f"  [{name}] cutout: {feat.get('shape')} {feat.get('size')} at {feat.get('at')}")
        elif ft == "fillet":
            obj.Shape = apply_fillet(obj.Shape, feat)
            log(f"  [{name}] fillet: {feat}")
    return tab_info

def apply_fillet(shape, params):
    import Part
    edges_type = params.get("edges", "top")
    r = params.get("radius", 5)
    bbox = shape.BoundBox
    h = bbox.ZMax
    if edges_type == "top":
        te = [e for e in shape.Edges if len(e.Vertexes)==2
              and abs(e.Vertexes[0].Z - h) < 0.01
              and abs(e.Vertexes[1].Z - h) < 0.01]
        try: return shape.makeFillet(r, te)
        except: return shape
    return shape

# === Main Compiler ===

def compile_spec(spec_path):
    with open(spec_path) as f:
        spec = yaml.safe_load(f)

    meta = spec.get("meta", {})
    output_dir = meta.get("output_dir", "./output")
    os.makedirs(output_dir, exist_ok=True)

    import FreeCAD, Part, Mesh
    doc = FreeCAD.newDocument("Design")
    doc.Label = meta.get("name", "Design")

    logs = []
    log = lambda s: logs.append(s) or print(s)

    log(f"Compiling: {meta.get('name', 'Untitled')}")
    log(f"Output: {output_dir}")

    # Track created objects for slot mapping
    part_objects = {}
    slot_map = {}

    # Build parts
    parts_def = spec.get("parts", [])
    for pdef in parts_def:
        name = pdef["name"]
        geom = pdef.get("geometry", {})
        gtype = geom.get("type", "solid_block")
        features = pdef.get("features", [])

        if gtype == "solid_block":
            obj = build_solid_block(doc, name, geom)
        elif gtype == "hollow_container":
            obj = build_hollow_container(doc, name, geom)
        elif gtype == "revolved_body":
            obj = build_revolved_body(doc, name, geom)
        elif gtype == "cylinder":
            obj = build_cylinder(doc, name, geom)
        elif gtype == "sphere":
            obj = build_sphere(doc, name, geom)
        elif gtype == "cone":
            obj = build_cone(doc, name, geom)
        elif gtype == "torus":
            obj = build_torus(doc, name, geom)
        elif gtype == "lshape":
            obj = build_lshape(doc, name, geom)
        elif gtype == "ellipsoid":
            obj = build_ellipsoid(doc, name, geom)
        elif gtype == "multi_layer":
            obj = build_multi_layer(doc, name, geom)
        elif gtype == "button_round":
            obj = build_button_round(doc, name, geom)
        elif gtype == "lshape_tshape":
            obj = build_lshape_tshape(doc, name, geom)
        elif gtype == "wedge":
            obj = build_wedge(doc, name, geom)
        else:
            log(f"  ⚠ Unknown geometry type: {gtype}")
            continue

        doc.recompute()
        tab_info = apply_features(doc, obj, name, features, log)
        doc.recompute()
        part_objects[name] = obj
        if tab_info:
            slot_map[name] = tab_info

    # Build assembly (slot cuts into base, then position parts)
    assembly = spec.get("assembly", {})
    base_obj = None
    for inst_name, pos in assembly.items():
        base_part = inst_name.split("#")[0]
        if base_part in part_objects:
            obj = part_objects[base_part]
            # Set placement
            obj.Placement = FreeCAD.Placement(
                FreeCAD.Vector(pos[0], pos[1], pos[2]),
                FreeCAD.Rotation())
            doc.recompute()
            log(f"  Placed {inst_name} at ({pos[0]}, {pos[1]}, {pos[2]})")

    # Export STLs
    out_config = spec.get("output", {})
    stl_config = out_config.get("stl", {})
    if stl_config.get("per_part", True):
        stl_dir = os.path.join(output_dir, stl_config.get("directory", "STLs"))
        os.makedirs(stl_dir, exist_ok=True)
        for pdef in parts_def:
            name = pdef["name"]
            if name in part_objects:
                path = os.path.join(stl_dir, f"{name}.stl")
                Mesh.export([part_objects[name]], path)
                sz = os.path.getsize(path)
                log(f"  STL: {name}.stl ({sz//1024}KB)")

    if stl_config.get("combined", False):
        all_shapes = [o.Shape for o in part_objects.values() if o]
        if all_shapes:
            from functools import reduce
            combined = reduce(lambda a,b: a.fuse(b), all_shapes[1:], all_shapes[0])
            mesh = Mesh.Mesh(combined.tessellate(0.5))
            path = os.path.join(stl_dir, "Assembly.stl")
            mesh.write(path)
            log(f"  STL: Assembly.stl ({os.path.getsize(path)//1024}KB)")

    # Save FCStd
    fc_path = os.path.join(output_dir, f"{meta.get('name', 'Design')}.FCStd")
    doc.saveAs(fc_path)
    log(f"  Saved: {fc_path}")

    # Print machine-readable summary
    summary = {
        "status": "ok",
        "name": meta.get("name"),
        "output_dir": output_dir,
        "parts": len(part_objects),
        "fcstd": fc_path,
        "stls": stl_config.get("directory", "STLs") if stl_config.get("per_part", True) else None,
        "logs": logs[-20:]  # last 20 lines for diagnostics
    }
    print("\n=== COMPILER OUTPUT ===")
    print(json.dumps(summary))
    return summary

if __name__ == "__main__":
    spec = os.environ.get("CAD_SPEC")
    if not spec:
        print("Setting CAD_SPEC from argv...")
        if len(sys.argv) < 2:
            print("Usage: CAD_SPEC=path/to/spec.yaml cad_compile.py [spec.yaml]")
            print("  or: cad_compile.py <spec.yaml>")
            sys.exit(1)
        spec = sys.argv[1]
        os.environ["CAD_SPEC"] = spec
    try:
        compile_spec(spec)
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e), "traceback": traceback.format_exc()}))
        sys.exit(1)
