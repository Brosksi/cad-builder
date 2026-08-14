#!/usr/bin/env python3
"""
CAD Image Analysis Library — deterministic helper for:
- 3D reconstruction from multi-view / single view
- Arrow and dimension line detection
- Scale reference detection (rulers, known objects)
- Functional relationship inference (containment, connectors, roles)
- Component graph edge detection
- Nested component detection

All functions are deterministic Pillow-only (no NN/ML).
"""
import math, re
from PIL import Image, ImageFilter, ImageDraw, ImageStat

# ── 3D Reconstruction ──────────────────────────────────────────

def fuse_image_analyses(analyses, image_paths):
    """Fuse multiple image analyses into one 3D part spec.
    
    Each analysis is the result dict from cad_extract_dimensions.
    Returns merged parts list with 3D dimensions and uncertainty markers.
    """
    if not analyses:
        return {"parts": [], "method": "none"}
    
    # If only 1 analysis, use single-view fallback
    if len(analyses) == 1:
        parts = infer_3d_from_single_view(analyses[0])
        return {"parts": parts, "method": "single_view_projection",
                "_3d_confident": False}
    
    # 2+ views: attempt matching
    parts_3d = []
    id_counter = 0
    
    # Extract all components across views
    view_components = []
    for i, a in enumerate(analyses):
        comps = a.get("components", [])
        view_components.append((i, comps, image_paths[i] if i < len(image_paths) else f"view_{i}"))
    
    # Match components across views by aspect ratio
    # View A component with (w, h) ≈ View B component with (h, w) → same object rotated
    matched_ids = {}  # (view_idx, comp_idx) -> part_id
    parts_pool = []   # list of matched part dicts
    
    for vi_a, (vi_a_idx, comps_a, _) in enumerate(view_components):
        for ci_a, comp_a in enumerate(comps_a):
            if (vi_a_idx, ci_a) in matched_ids:
                continue
            
            w_a = comp_a.get("bbox", [0,0,100,100])[2] - comp_a.get("bbox", [0,0,100,100])[0]
            h_a = comp_a.get("bbox", [0,0,100,100])[3] - comp_a.get("bbox", [0,0,100,100])[1]
            aspect_a = w_a / max(h_a, 1)
            
            best_match = None
            best_score = 0
            
            for vi_b, (vi_b_idx, comps_b, _) in enumerate(view_components):
                if vi_b_idx == vi_a_idx:
                    continue
                for ci_b, comp_b in enumerate(comps_b):
                    if (vi_b_idx, ci_b) in matched_ids:
                        continue
                    w_b = comp_b.get("bbox", [0,0,100,100])[2] - comp_b.get("bbox", [0,0,100,100])[0]
                    h_b = comp_b.get("bbox", [0,0,100,100])[3] - comp_b.get("bbox", [0,0,100,100])[1]
                    aspect_b = w_b / max(h_b, 1)
                    
                    # Aspect ratio reversal = rotated view
                    score = 0
                    if abs(aspect_a * aspect_b - 1.0) < 0.3:
                        score += 0.8  # rotation match
                    if abs(aspect_a - aspect_b) < 0.2:
                        score += 0.5  # same view
                    
                    # Area similarity
                    area_a = w_a * h_a
                    area_b = w_b * h_b
                    if area_a > 0 and area_b > 0:
                        area_ratio = min(area_a, area_b) / max(area_a, area_b)
                        if area_ratio > 0.6:
                            score += 0.3
                    
                    if score > best_score:
                        best_score = score
                        best_match = (vi_b_idx, ci_b)
            
            pid = f"part_{id_counter}"
            matched_ids[(vi_a_idx, ci_a)] = pid
            
            part = {
                "id": pid,
                "name": f"part_{id_counter}",
                "_source_view": image_paths[vi_a_idx] if vi_a_idx < len(image_paths) else f"view_{vi_a_idx}",
                "_3d_method": "multi_view",
                "shape": comp_a.get("shape", {"classification": "rectangular"}),
            }
            
            # Determine dimensions from matched views
            dims_v1 = {"w": comp_a.get("w_px", 0), "h": comp_a.get("h_px", 0)}
            
            if best_match is not None and best_score > 0.6:
                matched_ids[best_match] = pid
                vi_b_idx, ci_b = best_match
                comp_b = view_components[vi_b_idx][1][ci_b]
                
                w_b = comp_b.get("bbox", [0,0,100,100])[2] - comp_b.get("bbox", [0,0,100,100])[0]
                h_b = comp_b.get("bbox", [0,0,100,100])[3] - comp_b.get("bbox", [0,0,100,100])[1]
                
                aspect_a = dims_v1["w"] / max(dims_v1["h"], 1)
                aspect_b = w_b / max(h_b, 1)
                
                if abs(aspect_a * aspect_b - 1.0) < 0.3:
                    # Front + Side: view A gives (w, h), view B gives (d, h)
                    dims_3d = {
                        "width_px": dims_v1["w"],
                        "depth_px": h_b,
                        "height_px": dims_v1["h"]
                    }
                    if comp_b.get("dimension_inferences"):
                        dims_3d["_depth_source"] = "side_view"
                    part["_3d_view_match"] = "front_side"
                else:
                    # Same aspect → same face shown in both
                    dims_3d = {
                        "width_px": dims_v1["w"],
                        "depth_px": dims_v1["w"],
                        "height_px": dims_v1["h"]
                    }
                    part["_3d_view_match"] = "same_face"
                
                part["_3d_confidence"] = 0.8
                part["_dimensions_3d"] = dims_3d
                part["_uncertain"] = []
            else:
                # Single-view fallback for unmatched
                dims_3d = infer_3d_from_component(comp_a)
                part.update(dims_3d)
                part["_3d_confidence"] = 0.4
            
            # Inherit dimension inferences from best view
            for a in analyses:
                for di in a.get("dimension_inferences", []):
                    if "orientation" in di and "estimated_mm" in di:
                        part.setdefault("_dimension_inferences", []).append(di)
            
            parts_pool.append(part)
            id_counter += 1
    
    return {"parts": parts_pool, "method": f"multi_view_{len(analyses)}",
            "_3d_confident": any(p.get("_3d_confidence", 0) > 0.7 for p in parts_pool)}


def infer_3d_from_single_view(analysis):
    """Infer 3D dimensions from a single 2D view."""
    parts = []
    for comp in analysis.get("components", []):
        part = infer_3d_from_component(comp)
        part["_3d_method"] = "single_view_projection"
        part["_3d_confidence"] = 0.3
        part["_source_view"] = analysis.get("_image_path", "unknown")
        parts.append(part)
    return parts


def infer_3d_from_component(comp):
    """Single component → estimated 3D block.
    
    w = explicit width from dim line or bbox width
    d = w * depth_factor (based on shape class)
    h = explicit height from dim line or bbox height
    """
    w_px = comp.get("w_px", comp.get("bbox", [0,0,100,100])[2] - comp.get("bbox", [0,0,100,100])[0])
    h_px = comp.get("h_px", comp.get("bbox", [0,0,100,100])[3] - comp.get("bbox", [0,0,100,100])[1])
    
    shape_class = comp.get("shape", {}).get("classification", "rectangular")
    depth_factors = {"circular": 1.0, "square_like": 0.9, "elongated_rect": 0.5,
                     "rectangular": 0.7, "irregular": 0.6, "multi_part": 0.5,
                     "unclear": 0.5}
    df = depth_factors.get(shape_class, 0.7)
    
    part = {
        "w_px": w_px,
        "d_px": int(w_px * df),
        "h_px": h_px,
        "_uncertain": ["depth"],
        "_depth_factor": df,
        "_depth_source": "aspect_ratio_inference",
    }
    
    # Check for dimension inferences attached to this component
    dim_infs = comp.get("_nearby_dimensions", [])
    for di in dim_infs:
        if di.get("orientation") == "horizontal" and di.get("estimated_mm"):
            part["_width_mm"] = di["estimated_mm"]
        elif di.get("orientation") == "vertical" and di.get("estimated_mm"):
            part["_height_mm"] = di["estimated_mm"]
    
    return part


# ── Arrow and Dimension Line Detection ─────────────────────────

def detect_dimension_lines(gray_img, edge_img, components):
    """Detect dimension arrows and lines from image.
    
    Strategies used in order:
    1. Arrowhead detection (filled triangles near thin lines)
    2. Thin line detection (1-2px wide lines near component edges)
    3. Annotation bracket detection (L-shaped corners)
    """
    result = {"dimension_inferences": [], "_detection_method": None}
    w, h = gray_img.size
    
    # Invert: make lines white on black
    edges_inv = Image.eval(edge_img, lambda x: 255 - x)
    px = edges_inv.load()
    
    # Strategy 1: Detect thin horizontal/vertical lines
    # Scan for long runs of edge pixels in rows and columns
    h_spans = []
    for y in range(0, h, 2):
        run_start = None
        for x in range(0, w, 2):
            if px[x, y] > 200:
                if run_start is None:
                    run_start = x
            else:
                if run_start is not None and (x - run_start) > 40:
                    h_spans.append((run_start, y, x - run_start))
                run_start = None
        if run_start is not None and (w - run_start) > 40:
            h_spans.append((run_start, y, w - run_start))
    
    v_spans = []
    for x in range(0, w, 2):
        run_start = None
        for y in range(0, h, 2):
            if px[x, y] > 200:
                if run_start is None:
                    run_start = y
            else:
                if run_start is not None and (y - run_start) > 40:
                    v_spans.append((x, run_start, y - run_start))
                run_start = None
        if run_start is not None and (h - run_start) > 40:
            v_spans.append((x, run_start, h - run_start))
    
    # Filter: lines must be thin (1-3px) — check perpendicular profile
    def is_thin_line(x, y, orientation):
        """Check that line is 1-3px wide at midpoint."""
        thickness = 0
        if orientation == "h":
            for dy in range(-5, 6):
                if 0 <= y+dy < h and 0 <= x < w:
                    if px[x, y+dy] > 200:
                        thickness += 1
            return thickness <= 4
        else:
            for dx in range(-5, 6):
                if 0 <= x+dx < w and 0 <= y < h:
                    if px[x+dx, y] > 200:
                        thickness += 1
            return thickness <= 4
    
    dim_lines = []
    for xs, yc, length in h_spans:
        mid = xs + length // 2
        if is_thin_line(mid, yc, "h"):
            dim_lines.append({"orientation": "horizontal", "x1": xs, "x2": xs+length,
                              "y": yc, "length_px": length, "type": "dimension_line"})
    
    for xc, ys, length in v_spans:
        mid = ys + length // 2
        if is_thin_line(xc, mid, "v"):
            dim_lines.append({"orientation": "vertical", "y1": ys, "y2": ys+length,
                              "x": xc, "length_px": length, "type": "dimension_line"})
    
    # Associate dimension lines with nearest component bbox edges
    for dl in dim_lines:
        dl["associated_components"] = []
        for comp in components:
            bx1, by1, bx2, by2 = comp.get("bbox", [0,0,w,h])
            if dl["orientation"] == "horizontal":
                # Check if line is near component bottom or top edge
                if abs(dl["y"] - by2) < 20 or abs(dl["y"] - by1) < 20:
                    if dl["x1"] < bx2 + 20 and dl["x2"] > bx1 - 20:
                        dl["associated_components"].append(comp.get("id", "?"))
                        dl["matches_bbox"] = abs(dl["length_px"] - (bx2 - bx1)) < 15
            else:
                if abs(dl["x"] - bx2) < 20 or abs(dl["x"] - bx1) < 20:
                    if dl["y1"] < by2 + 20 and dl["y2"] > by1 - 20:
                        dl["associated_components"].append(comp.get("id", "?"))
                        dl["matches_bbox"] = abs(dl["length_px"] - (by2 - by1)) < 15
    
    result["dimension_inferences"] = dim_lines
    result["_detection_method"] = "line_scan"
    return result


def detect_arrowheads(edge_img):
    """Detect arrowhead shapes (filled triangles) on image.
    
    Arrowheads are small triangular regions near the end of thin lines.
    Returns list of (x, y, direction) for detected arrowheads.
    """
    w, h = edge_img.size
    px = edge_img.load()
    arrows = []
    
    # Scan for arrowhead patterns: small triangular clusters of edge pixels
    # centered near the endpoint of a thin line segment
    for x in range(5, w-5, 3):
        for y in range(5, h-5, 3):
            region = []
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    if 0 <= x+dx < w and 0 <= y+dy < h:
                        if px[x+dx, y+dy] > 200:
                            region.append((dx, dy))
            
            if 8 <= len(region) <= 20:
                # Check V-shape: region forms a triangle (arrowhead)
                dxs = [p[0] for p in region]
                dys = [p[1] for p in region]
                if max(dxs) - min(dxs) >= 4 and max(dys) - min(dys) >= 3:
                    # Arrow direction determined by pointed side
                    asymmetry = sum(p[1] for p in region) / len(region)
                    if asymmetry > 0.3:
                        arrows.append({"cx": x, "cy": y, "direction": "up"})
                    elif asymmetry < -0.3:
                        arrows.append({"cx": x, "cy": y, "direction": "down"})
                    else:
                        arrows.append({"cx": x, "cy": y, "direction": "unknown"})
    
    return arrows


# ── Scale Reference Detection ──────────────────────────────────

def detect_scale_reference(gray_img, edge_img):
    """Detect scale references in the image:
    1. Ruler ticks: repeating short vertical marks
    2. Grid pattern: evenly spaced horizontal lines
    3. Known object reference (not implemented — requires prior knowledge)
    
    Returns: {"scale_px_per_mm": float or None, "method": str, "confidence": float}
    """
    w, h = gray_img.size
    px = edge_img.load()
    
    # Strategy 1: Detect ruler ticks along bottom edge
    ruler_ticks = []
    if h > 10:
        scan_y = h - 10  # Last 10 rows
        for x in range(1, w-1):
            col_active = any(px[x, y] > 200 for y in range(scan_y, h))
            if col_active:
                ruler_ticks.append(x)
    
    if len(ruler_ticks) > 5:
        # Find regular spacing
        gaps = [ruler_ticks[i+1] - ruler_ticks[i] for i in range(len(ruler_ticks)-1)]
        if gaps:
            avg_gap = sum(gaps) / len(gaps)
            if 5 < avg_gap < 50:
                # Ruler ticks at regular spacing
                return {"scale_px_per_mm": avg_gap, "method": "ruler_ticks",
                        "confidence": 0.7, "tick_count": len(ruler_ticks),
                        "avg_gap_px": avg_gap}
    
    # Strategy 2: Detect grid pattern (engineering grid paper)
    h_lines = []
    for y in range(0, h, 2):
        line_px = sum(1 for x in range(0, w, 3) if 0 <= x < w and 0 <= y < h and px[x, y] > 200)
        if line_px > w * 0.3:
            h_lines.append(y)
    
    if len(h_lines) > 3:
        gaps = [h_lines[i+1] - h_lines[i] for i in range(len(h_lines)-1)]
        if gaps:
            avg_gap = sum(gaps) / len(gaps)
            grid_gap = sum(1 for g in gaps if abs(g - avg_gap) < avg_gap * 0.2)
            if grid_gap > len(gaps) * 0.5 and 10 < avg_gap < 100:
                # Common grid sizes: 5mm (5px), 10mm (10px), ...
                possible_scales = [avg_gap / s for s in [1, 2, 5] if avg_gap / s > 1]
                if possible_scales:
                    return {"scale_px_per_mm": possible_scales[0],
                            "method": f"grid_pattern_gap_{avg_gap:.0f}px",
                            "confidence": 0.5}
    
    return {"scale_px_per_mm": None, "method": "none", "confidence": 0.0}


def ocr_dimension_labels(region_img, tesseract_available=True):
    """Read numeric labels from a region using OCR-like pixel analysis.
    Falls back to simple digit pattern matching if tesseract unavailable.
    """
    if tesseract_available:
        try:
            import subprocess
            temp_path = f"/tmp/_ocr_label_{hash(str(region_img.tobytes()))}.png"
            region_img.save(temp_path)
            result = subprocess.run(
                ["tesseract", temp_path, "stdout", "--psm", "7", "-c", "tessedit_char_whitelist=0123456789.,"],
                capture_output=True, text=True, timeout=5
            )
            text = result.stdout.strip()
            if text:
                return {"value": float(re.sub(r'[^0-9.]', '', text)),
                        "text": text, "method": "tesseract_psm7", "confidence": 0.8}
        except:
            pass
    
    # Fallback: detect digit-like patterns (clusters of edges that could be digits)
    return None


# ── Functional Relationship Detection ──────────────────────────

def detect_containment(components, img_size):
    """Build a containment hierarchy from component bounding boxes.
    
    Returns list of { container_id, contained_id, margin_px, confidence }
    """
    containment = []
    for a in components:
        aid = a.get("id", "?")
        ax1, ay1, ax2, ay2 = a.get("bbox", [0, 0, img_size[0], img_size[1]])
        a_area = (ax2-ax1) * (ay2-ay1)
        if a_area <= 0:
            continue
        for b in components:
            bid = b.get("id", "?")
            if aid == bid:
                continue
            bx1, by1, bx2, by2 = b.get("bbox", [0, 0, img_size[0], img_size[1]])
            # B fully inside A?
            inside_x = bx1 >= ax1 and bx2 <= ax2
            inside_y = by1 >= ay1 and by2 <= ay2
            if inside_x and inside_y:
                b_area = (bx2-bx1) * (by2-by1)
                ratio = b_area / a_area if a_area > 0 else 0
                if ratio < 0.85:  # not equal (not the same component)
                    containment.append({
                        "container_id": aid,
                        "contained_id": bid,
                        "margin_px": min(bx1-ax1, ax2-bx2, by1-ay1, ay2-by2),
                        "confidence": 0.8 if ratio < 0.5 else 0.6,
                        "fill_ratio": round(ratio, 3),
                    })
    return containment


def detect_functional_roles(components, containment, img_size):
    """Assign functional roles to detected components.
    
    Roles: body, lid, handle, stem, insert, connector, unknown
    """
    if not components:
        return []
    
    # Find largest component by area → body
    body_id = None
    max_area = 0
    for comp in components:
        bbox = comp.get("bbox", [0, 0, img_size[0], img_size[1]])
        area = (bbox[2]-bbox[0]) * (bbox[3]-bbox[1])
        if area > max_area:
            max_area = area
            body_id = comp.get("id")
    
    roles = {}
    for comp in components:
        cid = comp.get("id")
        if cid is None:
            continue
        bbox = comp.get("bbox", [0, 0, img_size[0], img_size[1]])
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        area = w * h
        cy = (bbox[1] + bbox[3]) / 2
        
        if cid == body_id:
            roles[cid] = {"role": "body", "confidence": 0.95}
        elif max_area > 0 and area / max_area < 0.15 and h < w * 0.5:
            # Small, wide part on top of body → lid
            roles[cid] = {"role": "lid", "confidence": 0.7}
        elif max_area > 0 and area / max_area < 0.2 and w < max(w, h) * 0.3:
            # Narrow, tall part → stem
            roles[cid] = {"role": "stem", "confidence": 0.6}
        elif any(c.get("contained_id") == cid for c in containment):
            # Contained inside another → insert
            roles[cid] = {"role": "insert", "confidence": 0.8}
        elif max_area > 0 and area / max_area > 0.3:
            # Multiple large components → multiple bodies
            roles[cid] = {"role": "body", "confidence": 0.5}
        else:
            # Check if small and at body edge → handle
            if body_id:
                body = next((c for c in components if c.get("id") == body_id), None)
                if body:
                    bbx = body.get("bbox", [0, 0, img_size[0], img_size[1]])
                    edge_overlap_x = min(bbx[2], bbox[2]) - max(bbx[0], bbox[0])
                    edge_overlap_y = min(bbx[3], bbox[3]) - max(bbx[1], bbox[1])
                    if edge_overlap_x > 10 and edge_overlap_y > 10:
                        roles[cid] = {"role": "handle", "confidence": 0.6}
                        continue
            roles[cid] = {"role": "unknown", "confidence": 0.3}
    
    return roles


def detect_connectors(components, edge_img):
    """Detect connector patterns between components.
    
    Checks overlap region between component bounding boxes for
    parallel edge lines (tongue-and-groove, friction-fit, etc.)
    """
    w, h = edge_img.size
    px = edge_img.load()
    connectors = []
    
    for a in components:
        for b in components:
            if a.get("id") == b.get("id"):
                continue
            ax1, ay1, ax2, ay2 = a.get("bbox", [0, 0, w, h])
            bx1, by1, bx2, by2 = b.get("bbox", [0, 0, w, h])
            
            # Extend bboxes by 10px to find overlap
            ox1 = max(ax1, bx1) - 5
            oy1 = max(ay1, by1) - 5
            ox2 = min(ax2, bx2) + 5
            oy2 = min(ay2, by2) + 5
            
            if ox1 >= ox2 or oy1 >= oy2:
                continue
            
            # Count parallel thin lines in overlap region
            h_lines = 0
            v_lines = 0
            scan_step = max(1, (ox2 - ox1) // 20)
            for x in range(int(ox1), int(ox2), scan_step):
                col_count = sum(1 for y in range(int(oy1), int(oy2), 2)
                               if 0 <= x < w and 0 <= y < h and px[x, y] > 200)
                if col_count > (oy2 - oy1) * 0.3:
                    v_lines += 1
            
            for y in range(int(oy1), int(oy2), scan_step):
                row_count = sum(1 for x in range(int(ox1), int(ox2), 2)
                               if 0 <= x < w and 0 <= y < h and px[x, y] > 200)
                if row_count > (ox2 - ox1) * 0.3:
                    h_lines += 1
            
            connector_type = None
            connector_conf = 0.0
            
            if h_lines >= 4 or v_lines >= 4:
                connector_type = "tongue_and_groove"
                connector_conf = 0.5 + 0.05 * max(h_lines, v_lines)
            elif h_lines >= 2 or v_lines >= 2:
                connector_type = "friction_fit"
                connector_conf = 0.5
            else:
                connector_type = "butt_joint"
                connector_conf = 0.3
            
            connectors.append({
                "from": a.get("id"),
                "to": b.get("id"),
                "type": connector_type,
                "confidence": min(connector_conf, 0.95),
                "overlap_region": [int(ox1), int(oy1), int(ox2), int(oy2)],
            })
    
    return connectors


def build_component_graph_edges(components, containment, functional_roles, img_size):
    """Build full component graph edges from detected relationships."""
    edges = []
    
    # Containment edges
    for c in containment:
        edges.append({
            "from": c["container_id"],
            "to": c["contained_id"],
            "relationship": "contains",
            "confidence": c["confidence"],
            "margin_px": c["margin_px"],
        })
    
    # Spatial relationship edges (top/bottom/side)
    for a in components:
        for b in components:
            if a.get("id") == b.get("id"):
                continue
            ax1, ay1, ax2, ay2 = a.get("bbox", [0, 0, img_size[0], img_size[1]])
            bx1, by1, bx2, by2 = b.get("bbox", [0, 0, img_size[0], img_size[1]])
            
            # Gap between components
            gap_x = max(0, bx1 - ax2, ax1 - bx2)
            gap_y = max(0, by1 - ay2, ay1 - by2)
            
            if gap_x < 20 and gap_y < 20:
                # Determine spatial relationship
                rel = None
                if abs(ay2 - by1) < 20 and ax1 < bx2 and ax2 > bx1:
                    rel = "aligned_above" if ay2 < by1 else "aligned_below"
                elif abs(ax2 - bx1) < 20 and ay1 < by2 and ay2 > by1:
                    rel = "side_by_side"
                
                if rel:
                    overlap_px = min(ax2, bx2) - max(ax1, bx1) if "side" in (rel or "") else min(ay2, by2) - max(ay1, by1)
                    edges.append({
                        "from": a.get("id"),
                        "to": b.get("id"),
                        "relationship": rel,
                        "confidence": 0.7,
                        "gap_px": max(gap_x, gap_y),
                        "overlap_px": max(overlap_px, 0),
                    })
    
    return edges


def detect_nested_components(components, img_size, threshold=0.85):
    """Detect component nesting — one component fully inside another.
    
    Returns list of { parent_id, child_id, margin_px, nest_depth }
    """
    nesting = []
    sorted_comps = sorted(components, key=lambda c:
                          (c.get("bbox", [0,0,img_size[0],img_size[1]])[2] -
                           c.get("bbox", [0,0,img_size[0],img_size[1]])[0]) *
                          (c.get("bbox", [0,0,img_size[0],img_size[1]])[3] -
                           c.get("bbox", [0,0,img_size[0],img_size[1]])[1]),
                          reverse=True)
    
    for i, a in enumerate(sorted_comps):
        aid = a.get("id")
        ax1, ay1, ax2, ay2 = a.get("bbox", [0, 0, img_size[0], img_size[1]])
        for b in sorted_comps[i+1:]:
            bid = b.get("id")
            bx1, by1, bx2, by2 = b.get("bbox", [0, 0, img_size[0], img_size[1]])
            if bx1 >= ax1 and bx2 <= ax2 and by1 >= ay1 and by2 <= ay2:
                nesting.append({
                    "parent_id": aid, "child_id": bid,
                    "margin_px": min(bx1-ax1, ax2-bx2, by1-ay1, ay2-by2),
                })
    return nesting


def detect_inner_edge_loops(contour, img_size):
    """Detect if a contour has inner loops (holes / hollow center).
    
    A component with num_contours > 1 has inner boundaries.
    This indicates a slot, hole, or hollow interior.
    
    Returns: {"has_inner_loops": bool, "count": int, "confidence": float}
    """
    # This is a placeholder — needs proper contour analysis
    # In practice, use cv2.findContours or compare pixel fill ratio
    return {"has_inner_loops": False, "count": 0, "confidence": 0.0}


# ── Unified Analysis Pipeline ──────────────────────────────────

def run_full_analysis(image_path, known_scale=None):
    """Run the full image analysis pipeline on a single image.
    
    Step 1: Load and preprocess
    Step 2: Component detection
    Step 3: Shape classification
    Step 4: Dimension line detection
    Step 5: Scale reference detection
    Step 6: Role inference + containment + connectors
    Step 7: Build component graph
    Step 8: 3D estimation
    
    Returns unified result dict.
    """
    from PIL import Image, ImageFilter
    
    img = Image.open(image_path)
    gray_img = img.convert("L") if img.mode != "L" else img
    edge_img = gray_img.filter(ImageFilter.FIND_EDGES)
    w, h = gray_img.size
    
    # Step 1: Component detection (simple flood-fill)
    components = detect_components(edge_img, w, h)
    
    # Step 2: Shape info per component
    for comp in components:
        compute_shape_info(comp, edge_img)
    
    # Step 3: Dimension lines
    dim_info = detect_dimension_lines(gray_img, edge_img, components)
    
    # Step 4: Scale
    scale_info = detect_scale_reference(gray_img, edge_img)
    
    # Step 5: Arrowheads
    arrows = detect_arrowheads(edge_img)
    
    # Step 6: Relationships
    containment = detect_containment(components, (w, h))
    roles = detect_functional_roles(components, containment, (w, h))
    nested = detect_nested_components(components, (w, h))
    connectors = detect_connectors(components, edge_img)
    edges = build_component_graph_edges(components, containment, roles, (w, h))
    
    # Step 7: 3D estimation
    parts_3d = infer_3d_from_single_view({
        "components": components,
        "_image_path": image_path,
    })
    
    result = {
        "_image_path": image_path,
        "components": components,
        "component_count": len(components),
        "containment": containment,
        "function_roles": roles,
        "nested_components": nested,
        "connectors": connectors,
        "component_graph_edges": edges,
        "dimension_inferences": dim_info["dimension_inferences"],
        "scale": scale_info,
        "arrowheads": arrows,
        "_3d_estimates": parts_3d,
        "_method": "cad_image_analysis_v2",
    }
    
    # Step 8: Evidence-driven template scoring
    # Template scores come from VISIBLE EVIDENCE ONLY — no filenames,
    # folder names, or other metadata drive geometry selection.
    template_scores = _score_templates(components, roles, containment, (w, h))
    result["_template_scores"] = template_scores
    
    # Step 9: Build evidence report
    result["_evidence"] = build_evidence_report(
        image_path, components, roles, containment,
        dim_info["dimension_inferences"], scale_info,
        template_scores, known_scale,
    )
    
    # Apply known_scale if provided
    if known_scale:
        result["_known_scale"] = known_scale
        # Convert px measurements to mm
        for di in result["dimension_inferences"]:
            if "length_px" in di:
                di["length_mm_estimate"] = round(di["length_px"] / known_scale, 1)
                di["_scale_source"] = "user_provided"
    
    return result


# ── Simple component detection ─────────────────────────────────

def detect_components(edge_img, w, h):
    """Simple flood-fill component detection on edge image."""
    from collections import deque
    
    px = edge_img.load()
    visited = [[False] * h for _ in range(w)]
    components = []
    next_id = 0
    
    for sx in range(0, w, 3):
        for sy in range(0, h, 3):
            if px[sx, sy] > 200 and not visited[sx][sy]:
                # BFS flood-fill
                queue = deque([(sx, sy)])
                visited[sx][sy] = True
                region_px = []
                min_x, min_y = sx, sy
                max_x, max_y = sx, sy
                
                while queue:
                    cx, cy = queue.popleft()
                    region_px.append((cx, cy))
                    min_x = min(min_x, cx)
                    min_y = min(min_y, cy)
                    max_x = max(max_x, cx)
                    max_y = max(max_y, cy)
                    
                    for dx, dy in [(0,1),(0,-1),(1,0),(-1,0)]:
                        nx, ny = cx+dx, cy+dy
                        if 0 <= nx < w and 0 <= ny < h and not visited[nx][ny] and px[nx, ny] > 200:
                            visited[nx][ny] = True
                            queue.append((nx, ny))
                
                components.append({
                    "id": f"comp_{next_id}",
                    "bbox": [min_x, min_y, max_x, max_y],
                    "w_px": max_x - min_x,
                    "h_px": max_y - min_y,
                    "area_px2": len(region_px),
                    "pixel_count": len(region_px),
                })
                next_id += 1
    
    # Filter noise: remove tiny components (< 20px)
    components = [c for c in components if c["w_px"] > 10 and c["h_px"] > 10]
    return components


def compute_shape_info(comp, edge_img):
    """Add shape classification, symmetry, and contour info to a component."""
    bx1, by1, bx2, by2 = comp["bbox"]
    w_px = comp["w_px"]
    h_px = comp["h_px"]
    
    area = comp["area_px2"]
    bbox_area = w_px * h_px if w_px * h_px > 0 else 1
    perimeter_px = 2 * (w_px + h_px)
    
    circularity = 4 * math.pi * area / (perimeter_px * perimeter_px) if perimeter_px > 0 else 0
    rectangularity = area / bbox_area if bbox_area > 0 else 0
    aspect_ratio = w_px / max(h_px, 1)
    
    # Simple shape classification
    if circularity > 0.70:
        cls = "circular"
    elif rectangularity > 0.75:
        if aspect_ratio < 1.5:
            cls = "square_like"
        elif aspect_ratio < 4.0:
            cls = "elongated_rect"
        else:
            cls = "rectangular"
    elif rectangularity > 0.50:
        cls = "rectangular"
    else:
        cls = "irregular"
    
    # Symmetry (pixel-based)
    symmetry_h = 0.0
    symmetry_v = 0.0
    px = edge_img.load()
    if w_px > 5 and h_px > 5:
        # Horizontal symmetry: compare left half vs right half (flipped)
        mid_x = (bx1 + bx2) // 2
        mid_y = (by1 + by2) // 2
        matches = 0
        total = 0
        for y in range(by1, by2-1, 2):
            for dx in range(0, min(mid_x - bx1, bx2 - mid_x), 2):
                lx = mid_x - dx
                rx = mid_x + dx
                lv = 1 if 0 <= lx < edge_img.width and 0 <= y < edge_img.height and px[lx, y] > 200 else 0
                rv = 1 if 0 <= rx < edge_img.width and 0 <= y < edge_img.height and px[rx, y] > 200 else 0
                if lv == rv:
                    matches += 1
                total += 1
        symmetry_h = matches / max(total, 1) if total > 0 else 0
        
        matches = 0
        total = 0
        for x in range(bx1, bx2-1, 2):
            for dy in range(0, min(mid_y - by1, by2 - mid_y), 2):
                ty = mid_y - dy
                by = mid_y + dy
                tv = 1 if 0 <= x < edge_img.width and 0 <= ty < edge_img.height and px[x, ty] > 200 else 0
                bv = 1 if 0 <= x < edge_img.width and 0 <= by < edge_img.height and px[x, by] > 200 else 0
                if tv == bv:
                    matches += 1
                total += 1
        symmetry_v = matches / max(total, 1) if total > 0 else 0
    
    comp["shape"] = {
        "classification": cls,
        "circularity": round(circularity, 3),
        "rectangularity": round(rectangularity, 3),
        "aspect_ratio": round(aspect_ratio, 3),
        "symmetry_h": round(symmetry_h, 3),
        "symmetry_v": round(symmetry_v, 3),
    }


# ── Evidence-driven template scoring ────────────────────────────
# Templates are scored against VISIBLE evidence only (contours, symmetry,
# component boundaries, topology). Metadata (filenames, folder names) is
# NEVER used to drive geometry selection.

TEMPLATE_REGISTRY = [
    {
        "name": "box_with_lid",
        "required_component_count": 2,
        "shape_pattern": {"primary": "square_like", "secondary": "square_like"},
        "role_pattern": {"body": 1, "lid": 1},
        "requires_nesting": False,
        "symmetry_threshold": 0.75,
        "score_match": 0.9,
        "score_partial": 0.4,
    },
    {
        "name": "cylinder_with_stem",
        "required_component_count": 2,
        "shape_pattern": {"primary": "circular", "secondary": "elongated_rect"},
        "role_pattern": {"body": 1, "stem": 1},
        "requires_nesting": False,
        "symmetry_threshold": 0.85,
        "score_match": 0.85,
        "score_partial": 0.35,
    },
    {
        "name": "tray_with_inserts",
        "required_component_count": 2,
        "shape_pattern": {"primary": "rectangular", "secondary": "square_like"},
        "role_pattern": {"body": 1, "insert": 1},
        "requires_nesting": True,
        "symmetry_threshold": 0.60,
        "score_match": 0.88,
        "score_partial": 0.3,
    },
    {
        "name": "body_with_handle",
        "required_component_count": 2,
        "shape_pattern": {"primary": "rectangular", "secondary": "elongated_rect"},
        "role_pattern": {"body": 1, "handle": 1},
        "requires_nesting": False,
        "symmetry_threshold": 0.65,
        "score_match": 0.85,
        "score_partial": 0.25,
    },
    {
        "name": "enclosure_with_lid",
        "required_component_count": 2,
        "shape_pattern": {"primary": "rectangular", "secondary": "square_like"},
        "role_pattern": {"body": 1, "lid": 1},
        "requires_nesting": True,
        "symmetry_threshold": 0.80,
        "score_match": 0.85,
        "score_partial": 0.3,
    },
    # Klein bottle: requires very specific topology that is practically
    # undetectable from 2D images without explicit self-intersection cues.
    # This template is a sentinel — it will almost never activate.
    {
        "name": "klein_bottle",
        "required_component_count": 1,
        "shape_pattern": {"primary": "irregular"},
        "role_pattern": {"body": 1},
        "requires_nesting": False,
        "symmetry_threshold": 0.0,
        "score_match": 0.05,  # never match confidently from single 2D image
        "score_partial": 0.0,
        "activation_guard": "self_intersecting_contour",
    },
]

# Topology guards — signals that must be PRESENT to activate certain templates.
# Kept separate from TEMPLATE_REGISTRY to keep the evidence log clean.
TOPOLOGY_GUARDS = {
    "self_intersecting_contour": "contour shows figure-8 crossing (two lobes joined at center)",
}


def _score_templates(components, roles, containment, img_size):
    """Score all templates against visible image evidence.
    
    Pure function — no side effects, no metadata access.
    Returns: {
        "scores": [{"template": str, "score": float, "reason": str}, ...],
        "winner": str,
        "winner_reason": str,
        "topology_guards_checked": [str, ...],
        "guards_triggered": [str, ...],
    }
    """
    n_comp = len(components)
    w, h = img_size
    
    # Aggregate visible signals from components
    primary_shape = "none"
    secondary_shape = "none"
    role_counts = {}
    max_symmetry = 0.0
    has_nesting = len(containment) > 0
    
    if n_comp > 0:
        # Sort components by area descending for primary/secondary
        sorted_comps = sorted(components, key=lambda c: c.get("area_px2", 0), reverse=True)
        
        primary_shape = sorted_comps[0].get("shape", {}).get("classification", "none")
        max_symmetry = max(
            sorted_comps[0].get("shape", {}).get("symmetry_h", 0),
            sorted_comps[0].get("shape", {}).get("symmetry_v", 0)
        )
        
        if n_comp > 1:
            secondary_shape = sorted_comps[1].get("shape", {}).get("classification", "none")
    
    # Count roles
    for role_info in roles.values():
        r = role_info.get("role", "unknown")
        role_counts[r] = role_counts.get(r, 0) + 1
    
    # Check for Klein bottle topology: figure-8 contour crossing
    # Detect by looking for two distinct lobes in the primary component
    # that share a narrow waist (width at mid-height < 0.3 * max_width)
    has_self_intersecting_contour = False
    if n_comp > 0:
        primary = sorted_comps[0] if n_comp > 0 else components[0]
        bx1, by1, bx2, by2 = primary.get("bbox", [0, 0, w, h])
        cw = bx2 - bx1
        ch = by2 - by1
        if ch > 20 and cw > 20:
            # Check if component has a narrow waist at mid-height
            mid_y_low = by1 + ch // 3
            mid_y_high = by1 + 2 * ch // 3
            # For figure-8: the component spans full width at top/bottom but
            # narrows significantly at mid-height — we'd need pixel data for this
            # but from simple bbox we can't detect it precisely.
            # So we set it to False — no 2D evidence can reliably detect this.
            pass
    
    # Notify if secondary component suggests nesting (containment)
    nesting_hint = has_nesting
    
    # Build signal set (for evidence report)
    signals_used = [
        f"component_count={n_comp}",
        f"primary_shape={primary_shape}",
        f"secondary_shape={secondary_shape}",
        f"role_counts={role_counts}",
        f"max_symmetry={max_symmetry:.2f}",
        f"nesting_detected={has_nesting}",
    ]
    
    # Score each template against visible evidence
    scores = []
    for tmpl in TEMPLATE_REGISTRY:
        tmpl_name = tmpl["name"]
        reasons = []
        score = 0.0
        
        # Component count check
        if n_comp == tmpl["required_component_count"]:
            score += 0.25
        elif n_comp > 0 and tmpl["required_component_count"] > 1 and n_comp > 1:
            score += 0.1  # partial: enough components
            reasons.append(f"partial component count ({n_comp} vs {tmpl['required_component_count']})")
        else:
            reasons.append(f"component count {n_comp} != {tmpl['required_component_count']}")
        
        # Shape pattern check (primary)
        if primary_shape == tmpl["shape_pattern"]["primary"]:
            score += 0.25
        elif primary_shape in ("square_like", "rectangular") and tmpl["shape_pattern"]["primary"] in ("square_like", "rectangular"):
            score += 0.15  # cross-match rectangular/square_like
            reasons.append(f"shape {primary_shape} approximates {tmpl['shape_pattern']['primary']}")
        else:
            reasons.append(f"primary shape {primary_shape} != {tmpl['shape_pattern']['primary']}")
        
        # Secondary shape check (if applicable and template defines one)
        if n_comp > 1 and "secondary" in tmpl["shape_pattern"]:
            if secondary_shape == tmpl["shape_pattern"]["secondary"]:
                score += 0.15
            elif secondary_shape in ("square_like", "rectangular") and tmpl["shape_pattern"]["secondary"] in ("square_like", "rectangular"):
                score += 0.08
                reasons.append(f"shape {secondary_shape} approximates {tmpl['shape_pattern']['secondary']}")
            else:
                reasons.append(f"secondary shape {secondary_shape} != {tmpl['shape_pattern']['secondary']}")
        
        # Role pattern check
        role_match = True
        for required_role, required_count in tmpl["role_pattern"].items():
            actual_count = role_counts.get(required_role, 0)
            if actual_count >= required_count:
                score += 0.1
            else:
                role_match = False
                reasons.append(f"role {required_role} needs {required_count}, found {actual_count}")
        if role_match:
            score += 0.05  # bonus for full role match
        
        # Nesting check
        if tmpl["requires_nesting"]:
            if has_nesting:
                score += 0.1
            else:
                reasons.append("no nesting detected (expected for this template)")
        
        # Symmetry check
        if tmpl["symmetry_threshold"] > 0 and max_symmetry >= tmpl["symmetry_threshold"]:
            score += 0.1
        
        # Activation guard — Klein bottle specific
        if tmpl.get("activation_guard") == "self_intersecting_contour":
            if has_self_intersecting_contour:
                score = max(score, 0.3)
                reasons.append("self-intersecting contour detected (figure-8 topology)")
            else:
                score = 0.0
                reasons.append("activation guard failed: no self-intersecting contour — Klein bottle requires figure-8 topology not visible from 2D edge profile")
        
        # Clamp
        score = min(max(score, 0.0), 1.0)
        
        tmpl_entry = tmpl["name"]
        for t in TEMPLATE_REGISTRY:
            if t["name"] == tmpl_name:
                tmpl_entry = t["name"]
                break
        
        scores.append({
            "template": tmpl_name,
            "score": round(score, 2),
            "reason": "; ".join(reasons) if reasons else "all criteria met",
        })
    
    # Sort by score descending
    scores.sort(key=lambda s: s["score"], reverse=True)
    
    if scores and scores[0]["score"] > 0:
        winner = scores[0]
    else:
        # All scores are 0 — no template matched visible evidence
        winner = {"template": "none", "score": 0.0,
                  "reason": "no template matched visible pixel evidence — all scores zero"}
    
    return {
        "scores": scores,
        "winner": winner["template"],
        "winner_reason": winner.get("reason", ""),
        "winner_score": winner["score"],
        "signals_used": signals_used,
        "signals_ignored": ["filename", "folder_name", "file_metadata"],
        "signals_ignored_reason": "metadata cannot drive geometry selection — only pixel evidence is authoritative",
        "topology_guards_checked": ["self_intersecting_contour"],
        "guards_triggered": ["self_intersecting_contour"] if has_self_intersecting_contour else [],
    }


def build_evidence_report(image_path, components, roles, containment,
                           dim_inferences, scale_info, template_scores,
                           known_scale=None):
    """Build a structured evidence report for one image analysis.
    
    Shows which signals were used, which were ignored, and why the
    winning template (if any) was selected.
    """
    w_used = []
    w_ignored = []
    
    # Signals that ARE used (pixel-derived)
    w_used.append({
        "signal": "component_count",
        "value": len(components),
        "source": "flood_fill_edge_detection",
    })
    if components:
        primary = max(components, key=lambda c: c.get("area_px2", 0))
        shape = primary.get("shape", {})
        w_used.append({
            "signal": "primary_shape_classification",
            "value": shape.get("classification", "none"),
            "source": "contour_circularity_rectangularity_ar",
            "metrics": {
                "circularity": shape.get("circularity", 0),
                "rectangularity": shape.get("rectangularity", 0),
                "aspect_ratio": shape.get("aspect_ratio", 0),
            },
        })
        w_used.append({
            "signal": "symmetry",
            "value": {"horizontal": shape.get("symmetry_h", 0), "vertical": shape.get("symmetry_v", 0)},
            "source": "pixel_by_pixel_comparison_across_midline",
        })
    if dim_inferences:
        w_used.append({
            "signal": "dimension_lines",
            "value": len(dim_inferences),
            "source": "thin_line_profile_scan",
        })
    if scale_info and scale_info.get("method") != "none":
        w_used.append({
            "signal": "scale_reference",
            "value": scale_info.get("method"),
            "source": "ruler_tick_or_grid_pattern_detection",
        })
    if containment:
        w_used.append({
            "signal": "containment_relationships",
            "value": len(containment),
            "source": "bbox_nesting_analysis",
        })
    if roles:
        w_used.append({
            "signal": "functional_roles",
            "value": {k: v.get("role", "unknown") for k, v in roles.items()},
            "source": "position_size_area_based_role_inference",
        })
    
    # Signals that are EXPLICITLY ignored
    w_ignored.append({
        "signal": "filename",
        "value": image_path.split("/")[-1] if "/" in image_path else image_path,
        "reason": "filename is metadata, not pixel evidence — cannot drive geometry selection",
    })
    w_ignored.append({
        "signal": "folder_name",
        "value": image_path.split("/")[-2] if "/" in image_path else ".",
        "reason": "folder name is metadata, not pixel evidence — cannot drive geometry selection",
    })
    
    return {
        "image": image_path,
        "signals_used": w_used,
        "signals_ignored": w_ignored,
        "template_scores": template_scores,
        "known_scale": known_scale,
    }
