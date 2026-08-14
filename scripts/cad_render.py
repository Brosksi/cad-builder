#!/usr/bin/env python3
"""
CAD Renderer: opens compiled FCStd → captures annotated screenshots.
Usage: freecad cad_render.py <path/to/design.FCStd> [output_dir]
"""

import json, os, sys, time, traceback
from PySide6 import QtWidgets

def render(fcstd_path, output_dir=None):
    import FreeCAD, FreeCADGui

    for _ in range(40):
        QtWidgets.QApplication.processEvents(); time.sleep(0.25)
        if FreeCADGui.getMainWindow(): break

    doc = FreeCAD.open(fcstd_path)
    v = FreeCADGui.ActiveDocument.ActiveView
    FreeCADGui.updateGui(); time.sleep(0.5)

    if not output_dir:
        output_dir = os.path.dirname(fcstd_path)

    # Apply dark appearance for white-background screenshots
    for o in doc.Objects:
        try:
            o.ViewObject.DisplayMode = "FlatLines"
            o.ViewObject.ShapeColor = (0.22, 0.22, 0.25)
            o.ViewObject.LineColor = (0.01, 0.01, 0.01)
        except:
            pass
    doc.recompute()
    FreeCADGui.updateGui(); time.sleep(0.5)

    screenshots_dir = os.path.join(output_dir, "screenshots")
    os.makedirs(screenshots_dir, exist_ok=True)

    captures = []
    log = lambda s: captures.append(s) or print(s)

    def shot(subdir, fname, vt="iso"):
        d = os.path.join(screenshots_dir, subdir)
        os.makedirs(d, exist_ok=True)
        p = os.path.join(d, fname)
        {"iso": v.viewIsometric, "front": v.viewFront, "top": v.viewTop}[vt]()
        QtWidgets.QApplication.processEvents(); time.sleep(0.2)
        v.fitAll()
        for _ in range(3):
            QtWidgets.QApplication.processEvents(); time.sleep(0.15)
        FreeCADGui.updateGui()
        v.saveImage(p, 1920, 1080, "White")
        sz = os.path.getsize(p)//1024 if os.path.exists(p) else 0
        log(f"  {subdir}/{fname} ({sz}KB)")
        return p

    def show(names):
        for o in doc.Objects:
            try: o.ViewObject.Visibility = False
            except: pass
        for n in names:
            o = doc.getObject(n)
            if o: o.ViewObject.Visibility = True
        FreeCADGui.updateGui(); QtWidgets.QApplication.processEvents(); time.sleep(0.3)

    # Per-part screenshots
    for o in doc.Objects:
        show([o.Name])
        shot(o.Name, f"{o.Name}.png", "iso")

    # Assembly screenshot (all objects)
    all_names = [o.Name for o in doc.Objects]
    show(all_names)
    shot("assembly", f"assembly.png", "iso")
    shot("assembly", f"assembly_front.png", "front")
    shot("assembly", f"assembly_top.png", "top")

    log(f"\nScreenshots: {screenshots_dir}")

    result = {
        "status": "ok",
        "screenshots_dir": screenshots_dir,
        "captures": len(captures),
    }
    print("\n=== RENDERER OUTPUT ===")
    print(json.dumps(result))
    return result

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: freecad cad_render.py <design.FCStd> [output_dir]")
        sys.exit(1)
    fcstd = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    try:
        render(fcstd, out)
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e), "traceback": traceback.format_exc()}))
    try: FreeCADGui.getMainWindow().close()
    except: pass
    sys.exit(0)
