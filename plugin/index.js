import { tool } from "@opencode-ai/plugin";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname, resolve, basename } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, "../../skills/cad-builder");
const COMPILE_SCRIPT = join(SKILL_DIR, "scripts/cad_compile.py");
const RENDER_SCRIPT = join(SKILL_DIR, "scripts/cad_render.py");
const FREECADCMD = "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd";
const FREECAD = "/Applications/FreeCAD.app/Contents/MacOS/FreeCAD";

const VALID_GEOM_TYPES = ["solid_block", "hollow_container", "cylinder", "extrusion", "sphere", "cone", "torus", "lshape", "wedge", "ellipsoid", "pyramid", "multi_layer", "button_round", "t_shape", "groove", "arch"];
const VALID_FEATURE_TYPES = ["friction_tab", "slot", "slot_array", "fillet", "hole", "cutout", "boss"];

// ── State helpers ──────────────────────────────────────────
const STATE_DIR = join(process.env.HOME || "/tmp", ".cache/cad-plugin");
mkdirSync(STATE_DIR, { recursive: true });

function meta(root) { return join(root, ".cad_state.json"); }

function loadState(root) {
  try {
    const d = JSON.parse(readFileSync(meta(root), "utf-8"));
    d.root = root;
    return d;
  } catch { return null; }
}

function saveState(state) {
  if (!state.root) return;
  mkdirSync(state.root, { recursive: true });
  mkdirSync(join(state.root, "STLs"), { recursive: true });
  mkdirSync(join(state.root, "screenshots"), { recursive: true });
  writeFileSync(meta(state.root), JSON.stringify(state, null, 2));
}

function listProjects() {
  const projects = [];
  if (!existsSync(STATE_DIR)) return projects;
  for (const f of readdirSync(STATE_DIR)) {
    if (f.endsWith(".json")) {
      try {
        projects.push(JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8")));
      } catch {}
    }
  }
  return projects;
}

function registerProject(state) {
  try {
    writeFileSync(join(STATE_DIR, `${state.name}.json`), JSON.stringify({
      name: state.name, root: state.root, created: state.created
    }));
  } catch {}
}

function findProject(start) {
  for (const d of [start, dirname(start), process.cwd()]) {
    const s = loadState(d);
    if (s) return s;
  }
  // Also scan cad-output/ subdirectories (default cad_init location)
  const cadDir = join(start, "cad-output");
  if (existsSync(cadDir)) {
    try {
      for (const entry of readdirSync(cadDir)) {
        const candidate = join(cadDir, entry);
        if (statSync(candidate).isDirectory()) {
          const s = loadState(candidate);
          if (s) return s;
        }
      }
    } catch {}
  }
  return null;
}

// ── Shell ───────────────────────────────────────────────────
function run(cmd) {
  try {
    const out = execSync(cmd, { timeout: 120000, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 });
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, error: e.message, stderr: e.stderr, stdout: e.stdout };
  }
}

// freecadcmd treats .yaml/.py arguments as documents — use a bridge script instead
function compileCmd(specPath) {
  const tmpWrapper = join("/tmp", `cad_c_${Date.now()}.py`);
  const scriptDir = COMPILE_SCRIPT.replace("/cad_compile.py", "");
  writeFileSync(tmpWrapper, `import sys, os\nsys.path.insert(0, "${scriptDir.replace(/"/g, '\\"')}")\nimport cad_compile\ncad_compile.compile_spec(os.environ["CAD_SPEC"])\n`);
  return { cmd: `CAD_SPEC="${specPath}" "${FREECADCMD}" "${tmpWrapper}"`, cleanup: tmpWrapper };
}

// ── Error recovery ──────────────────────────────────────────
const ERROR_PATTERNS = [
  { match: /No module named '(\w+)'/, fix: (m) => `Missing Python module \`${m[1]}\`. Install: \`pip install ${m[1]}\`` },
  { match: /AttributeError.*no attribute '(\w+)'/, fix: () => "Invalid geometry type or parameter name. Check the primitive type and field names." },
  { match: /'(\w+)'.*is not defined/, fix: () => "Undefined variable or reference. Check that all part names match exactly." },
  { match: /KeyError.*'(\w+)'/, fix: (m) => `Missing required parameter \`${m[1]}\` in part geometry definition.` },
  { match: /makeFillet.*failed/i, fix: () => "Fillet radius too large for the part. Reduce `top_fillet` or `radius`." },
  { match: /BRep_API: command not done/i, fix: () => "Boolean operation failed — overlapping or intersecting geometry. Check slot positions." },
  { match: /Standard_OutOfRange/i, fix: () => "Geometry exceeded valid bounds. Check dimensions and positions." },
  { match: /cannot be computed/i, fix: () => "Shape cannot be computed. Check for zero-thickness walls or impossible fillets." },
  { match: /'str' object has no attribute 'get'/i, fix: () => "YAML structure is incorrect. Check indentation: each part needs a `geometry:` block." },
  { match: /invalid literal for int/i, fix: () => "Invalid numeric value. Check that all dimensions are numbers, not text." },
];

function parseCompileError(raw) {
  const lines = (raw || "").split("\n");
  const suggestions = [];
  for (const line of lines) {
    for (const p of ERROR_PATTERNS) {
      const m = line.match(p.match);
      if (m) { suggestions.push(p.fix(m)); break; }
    }
  }
  if (suggestions.length === 0 && lines.length > 0) {
    const fatal = lines.find(l => l.includes("Error:") || l.includes("Traceback") || l.includes("Exception"));
    if (fatal) suggestions.push(`FreeCAD error: \`${fatal.trim()}\`. Usually a geometry issue — check dimensions, positions, and part names.`);
  }
  return suggestions;
}

// ── STL bounding-box helper ─────────────────────────────────
function stlDims(stlPath) {
  try {
    const out = execSync(`"${FREECADCMD}" -c 2>/dev/null << 'PYEOF'
import Mesh
m = Mesh.Mesh("${stlPath}")
xs=[p.x for p in m.Points]; ys=[p.y for p in m.Points]; zs=[p.z for p in m.Points]
dx=max(xs)-min(xs); dy=max(ys)-min(ys); dz=max(zs)-min(zs)
print(f"{dx:.1f}x{dy:.1f}x{dz:.1f}")
PYEOF`, { timeout: 15000, encoding: "utf-8" });
    const m = out.match(/([\d.]+)x([\d.]+)x([\d.]+)/);
    if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]) };
  } catch {}
  return null;
}

// ── Spec diff / change detection ──────────────────────────────
function parsePartBlocks(yamlText) {
  const parts = [];
  const lines = yamlText.split("\n");
  let current = null;
  let inPart = false, inGeom = false, inFeat = false, inFeatBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const mName = l.match(/^\s*- name:\s*(\S+)/);
    if (mName) {
      if (current) parts.push(current);
      current = { name: mName[1], lines: [], hashItems: [] };
      inPart = true; inGeom = false; inFeat = false; inFeatBlock = false;
      current.lines.push(l);
      continue;
    }
    if (!current) continue;
    current.lines.push(l);
    // Track structural boundaries for hashing
    if (l.trim() === "geometry:") { inGeom = true; inFeat = false; continue; }
    if (l.trim().startsWith("features:")) { inFeat = true; inGeom = false; continue; }
    if (inGeom && l.trim() && !l.startsWith(" ") && !l.startsWith("-")) { inGeom = false; }
    if (inFeat && l.trim() && !l.startsWith(" ") && !l.startsWith("-") && l.trim() !== "features:") { inFeat = false; }
    // Collect significant lines for hashing (skip comments)
    if (l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("//")) {
      current.hashItems.push(l.trim());
    }
  }
  if (current) parts.push(current);
  return parts;
}

function partHash(part) {
  // Stable string hash based on property lines (ignoring whitespace differences)
  const sig = (part.hashItems || part.lines || [])
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("- name:"))
    .join("|");
  let h = 0;
  for (let i = 0; i < sig.length; i++) {
    h = ((h << 5) - h) + sig.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

function detectChanges(oldYaml, newYaml) {
  const oldParts = parsePartBlocks(oldYaml || "");
  const newParts = parsePartBlocks(newYaml || "");
  const oldMap = {}; for (const p of oldParts) oldMap[p.name] = p;
  const newMap = {}; for (const p of newParts) newMap[p.name] = p;

  const changes = { changed: [], added: [], removed: [], same: [] };
  const allNames = [...new Set([...Object.keys(oldMap), ...Object.keys(newMap)])];

  for (const name of allNames) {
    const oldP = oldMap[name];
    const newP = newMap[name];
    if (!oldP && newP) { changes.added.push(name); continue; }
    if (oldP && !newP) { changes.removed.push(name); continue; }
    const h1 = partHash(oldP);
    const h2 = partHash(newP);
    if (h1 === h2) { changes.same.push(name); }
    else { changes.changed.push(name); }
  }
  return changes;
}

// ── Screenshot version management ─────────────────────────────
function rotateScreenshots(root, maxVersions) {
  maxVersions = maxVersions || 3;
  const shotDir = join(root, "screenshots");
  if (!existsSync(shotDir)) { mkdirSync(shotDir, { recursive: true }); return; }

  // Find current screenshots
  const shots = readdirSync(shotDir).filter(f => f.endsWith(".png"));
  if (shots.length === 0) return;

  // Move current shots to v1
  const vDir = join(shotDir, "v1");
  mkdirSync(vDir, { recursive: true });
  for (const f of shots) {
    const src = join(shotDir, f);
    const dst = join(vDir, f);
    writeFileSync(dst, readFileSync(src));
  }
  for (const f of shots) {
    try { execSync(`rm "${join(shotDir, f)}"`, { timeout: 5000 }); } catch {}
  }

  // Rotate existing versions: v2→v3, v1→v2
  for (let v = maxVersions; v >= 2; v--) {
    const srcDir = join(shotDir, `v${v-1}`);
    const dstDir = join(shotDir, `v${v}`);
    if (existsSync(srcDir)) {
      if (existsSync(dstDir)) execSync(`rm -rf "${dstDir}"`, { timeout: 5000 });
      execSync(`mv "${srcDir}" "${dstDir}"`, { timeout: 5000 });
    }
  }
}

function renderCompareHtml(root) {
  const shotDir = join(root, "screenshots");
  const v1Dir = join(shotDir, "v1");
  const v2Dir = join(shotDir, "v2");
  if (!existsSync(v1Dir) && !existsSync(v2Dir)) return;

  const v1Shots = existsSync(v1Dir) ? readdirSync(v1Dir).filter(f => f.endsWith(".png")).sort() : [];
  const v2Shots = existsSync(v2Dir) ? readdirSync(v2Dir).filter(f => f.endsWith(".png")).sort() : [];

  let html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Revision Diff</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#1a1a2e;color:#eee;padding:20px}
h1{color:#a0a0c0;font-size:20px;margin-bottom:16px}
h2{color:#888;font-size:14px;margin:24px 0 8px;border-bottom:1px solid #333;padding-bottom:4px}
.pair{display:flex;gap:8px;margin-bottom:16px;align-items:flex-start;flex-wrap:wrap}
.pair>div{flex:1;min-width:300px}
.pair img{width:100%;border:1px solid #333;border-radius:4px}
.label{font-size:12px;color:#666;margin-bottom:4px}
.badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;margin-left:6px}
.badge-old{background:#5a1a1a;color:#f88}
.badge-new{background:#1a3a1a;color:#8f8}
</style></head><body>
<h1>Screenshot Comparison</h1>`;

  const allShots = [...new Set([...v1Shots, ...v2Shots])];
  for (const shot of allShots) {
    html += `<h2>${shot}</h2><div class="pair">`;
    if (v2Shots.includes(shot)) {
      html += `<div><div class="label">Previous <span class="badge badge-old">v2</span></div><img src="v2/${shot}" loading="lazy"></div>`;
    }
    if (v1Shots.includes(shot)) {
      html += `<div><div class="label">Current <span class="badge badge-new">v1</span></div><img src="v1/${shot}" loading="lazy"></div>`;
    }
    html += `</div>`;
  }
  html += `</body></html>`;

  writeFileSync(join(shotDir, "compare.html"), html);
  return join(shotDir, "compare.html");
}

// ── Auto-fix helpers ──────────────────────────────────────────
const AUTO_FIX_RULES = [
  {
    name: "missing-wall",
    test: (block) => block.includes("type: hollow_container") && !block.includes("wall:"),
    apply: (block) => {
      const m = block.match(/\n(\s*)(top_fillet:|outer:)/);
      if (m) return block.replace(m[0], `\n${m[1]}wall: 3${m[0]}`);
      return block;
    },
    message: "Added wall: 3 (default thickness) to hollow_container",
  },
  {
    name: "missing-top-fillet",
    test: (block) => (block.includes("type: hollow_container") || block.includes("type: solid_block")) && !block.includes("top_fillet:"),
    apply: (block) => {
      const m = block.match(/\n(\s*)(size:|outer:)/);
      if (m) return block.replace(m[0], `\n${m[1]}top_fillet: 5${m[0]}`);
      return block;
    },
    message: "Added top_fillet: 5 (safe radius) to part",
  },
  {
    name: "missing-friction-clearance",
    test: (block) => block.includes("type: friction_tab") && !block.includes("clearance:"),
    apply: (block) => block.replace(/(size: \[[\d., ]+\])/, "$1\n        clearance: 0.5"),
    message: "Added clearance: 0.5mm to friction tab",
  },
  {
    name: "short-position",
    test: () => true,
    apply: (block) => block.replace(/^(\s+)(\S+):\s*\[([\d., -]+)\]\s*$/gm, (match, indent, name, coords) => {
      const parts = coords.split(",").map(s => s.trim());
      if (parts.length === 2) return `${indent}${name}: [${parts[0]}, ${parts[1]}, 0]`;
      return match;
    }),
    message: "Added z=0 to assembly positions with only [x, y]",
  },
];

// ── Incremental compile helpers ──────────────────────────────
function preserveUnchangedStls(stlDir, changes) {
  if (changes.same.length === 0) return null;
  const preserveDir = join(stlDir, `.preserve_${Date.now()}`);
  mkdirSync(preserveDir, { recursive: true });
  let count = 0;
  for (const name of changes.same) {
    const src = join(stlDir, `${name}.stl`);
    if (existsSync(src)) { writeFileSync(join(preserveDir, `${name}.stl`), readFileSync(src)); count++; }
  }
  if (count === 0) { try { execSync(`rm -rf "${preserveDir}"`, { timeout: 5000 }); } catch {} return null; }
  return preserveDir;
}

function restoreStls(stlDir, preserveDir) {
  if (!preserveDir || !existsSync(preserveDir)) return [];
  const restored = [];
  for (const f of readdirSync(preserveDir)) {
    if (f.endsWith(".stl")) { writeFileSync(join(stlDir, f), readFileSync(join(preserveDir, f))); restored.push(f.replace(".stl", "")); }
  }
  try { execSync(`rm -rf "${preserveDir}"`, { timeout: 5000 }); } catch {}
  return restored;
}

function perPartDeltas(newStls, oldStls) {
  if (!oldStls) return null;
  const deltas = {};
  for (const [name, nd] of Object.entries(newStls)) {
    const od = oldStls[name];
    if (!od) { deltas[name] = "NEW"; continue; }
    const parts = [];
    for (const axis of ["x", "y", "z"]) {
      const d = nd[axis] - od[axis];
      if (Math.abs(d) > 0.05) parts.push(`${axis}: ${d >= 0 ? "+" : ""}${d.toFixed(1)}`);
    }
    deltas[name] = parts.length > 0 ? parts.join(", ") : "unchanged";
  }
  return deltas;
}

// ── Diff image generation (Pillow) ───────────────────────────
function renderDiffPng(root, name, revFrom, revTo, changes, oldStls, newStls) {
  const outPath = join(root, "screenshots", "diff.png");
  const scriptPath = join("/tmp", `cad_diff_${Date.now()}.py`);
  const dataPath = join("/tmp", `cad_diff_data_${Date.now()}.json`);

  const data = { name, revFrom, revTo, changes, oldStls, newStls };
  writeFileSync(dataPath, JSON.stringify(data));

  const script = `
import json, sys
from PIL import Image, ImageDraw
d = json.load(open(sys.argv[1]))
w = 900
h = 140 + 38 * len(d["newStls"])
img = Image.new("RGB", (w, h), (30, 30, 50))
draw = ImageDraw.Draw(img)
draw.text((20, 12), "CAD Diff: " + d["name"], fill=(200, 200, 220))
draw.text((20, 36), "Rev " + str(d["revFrom"]) + " -> " + str(d["revTo"]), fill=(150, 150, 180))
y = 70
for pn in sorted(d["newStls"].keys()):
    nd = d["newStls"][pn]
    od = d["oldStls"].get(pn)
    if pn in d["changes"]["added"]:
        c = (100, 200, 220)
        t = f'{pn}: {nd["x"]}x{nd["y"]}x{nd["z"]}mm [NEW]'
    elif pn in d["changes"]["changed"]:
        c = (220, 220, 80)
        ds = []
        for a in ("x", "y", "z"):
            dd = nd[a] - od[a]
            if abs(dd) > 0.1: ds.append(f'{a}: {dd:+.0f}')
        t = f'{pn}: {od["x"]}x{od["y"]}x{od["z"]} -> {nd["x"]}x{nd["y"]}x{nd["z"]}mm  ({", ".join(ds)})'
    else:
        c = (100, 200, 100)
        t = f'{pn}: {nd["x"]}x{nd["y"]}x{nd["z"]}mm'
    draw.text((20, y), t, fill=c)
    y += 34
img.save(sys.argv[2])
`;
  writeFileSync(scriptPath, script);
  const result = run(`python3 "${scriptPath}" "${dataPath}" "${outPath}"`);
  try { execSync(`rm -f "${scriptPath}" "${dataPath}"`, { timeout: 5000 }); } catch {}
  return result.ok ? outPath : null;
}

function autoFixYaml(yamlText) {
  const fixes = [];
  let text = yamlText;

  // Apply part-level fixes by scanning each `- name:` block
  const blocks = text.split(/(?=\n  - name:)/g);
  const fixedBlocks = blocks.map((block) => {
    if (!block.trim()) return block;
    for (const rule of AUTO_FIX_RULES) {
      if (rule.name === "short-position") continue; // handled globally
      if (rule.test(block)) {
        const newBlock = rule.apply(block);
        if (newBlock !== block) {
          fixes.push({ rule: rule.name, msg: rule.message, part: (block.match(/- name:\s*(\S+)/) || [,"?"])[1] });
          return newBlock;
        }
      }
    }
    return block;
  });
  text = fixedBlocks.join("");

  // Apply global fixes (assembly positions)
  for (const rule of AUTO_FIX_RULES) {
    if (rule.name === "short-position") {
      const newText = rule.apply(text);
      if (newText !== text) {
        fixes.push({ rule: rule.name, msg: rule.message, part: "assembly" });
        text = newText;
      }
    }
  }

  return { text, fixes };
}

// ── Change summary formatting ────────────────────────────
function formatChangeSummary(changes, oldStls, newStls) {
  if (!changes) return "";
  const parts = [];
  if (changes.changed.length > 0) parts.push(`📝 **Changed:** ${changes.changed.join(", ")}`);
  if (changes.added.length > 0) parts.push(`➕ **Added:** ${changes.added.join(", ")}`);
  if (changes.removed.length > 0) parts.push(`➖ **Removed:** ${changes.removed.join(", ")}`);
  if (changes.same.length > 0) parts.push(`⏺ **Unchanged:** ${changes.same.join(", ")}`);

  // Dimension comparison
  const dimLines = [];
  const targetParts = [...changes.changed, ...changes.added];
  for (const name of targetParts) {
    const newDim = newStls[name];
    const oldDim = oldStls[name];
    if (newDim) {
      const oldStr = oldDim ? ` (was ${oldDim.x}×${oldDim.y}×${oldDim.z})` : "";
      dimLines.push(`- \`${name}\`: ${newDim.x}×${newDim.y}×${newDim.z}mm${oldStr}`);
    }
  }
  if (dimLines.length > 0) parts.push("\n**Dimension changes:**\n" + dimLines.join("\n"));

  return parts.join("\n");
}

// ── Spec validation ─────────────────────────────────────────
function validateSpec(spec) {
  const issues = [];
  const parts = spec.parts || [];
  const assembly = spec.assembly || {};

  // Check parts have geometry
  for (const p of parts) {
    if (!p.name) { issues.push({ severity: "error", field: "parts[?].name", msg: "Every part must have a `name`." }); continue; }
    if (!p.geometry) { issues.push({ severity: "error", field: `${p.name}.geometry`, msg: "Missing `geometry` block." }); continue; }
    const g = p.geometry;
    if (g.type && !VALID_GEOM_TYPES.includes(g.type)) {
      issues.push({ severity: "warning", field: `${p.name}.geometry.type`, msg: `Unknown geometry type "${g.type}". Valid: ${VALID_GEOM_TYPES.join(", ")}` });
    }
    // Shape-class conflict detection
    if (p._shape_class) {
      if (p._shape_class === "circular" && g.type !== "cylinder" && g.type !== "extrusion") {
        issues.push({ severity: "error", field: `${p.name}.geometry.type`, msg: `Shape classification "${p._shape_class}" suggests cylindrical geometry, but type is "${g.type}". Use "cylinder" or "extrusion".` });
      }
      if (p._shape_class === "square_like" && g.type === "cylinder") {
        issues.push({ severity: "error", field: `${p.name}.geometry.type`, msg: `Shape classification "${p._shape_class}" suggests prismatic/box geometry, but type is "${g.type}". Use "solid_block" or "hollow_container".` });
      }
      if (p._shape_class === "elongated_rect" && g.type === "cylinder") {
        issues.push({ severity: "error", field: `${p.name}.geometry.type`, msg: `Shape classification "${p._shape_class}" suggests elongated tray/bin, but type is "${g.type}". Use "hollow_container" or "solid_block".` });
      }
      if (p._shape_class === "multi_part") {
        issues.push({ severity: "warning", field: `${p.name}._shape_class`, msg: `Image analysis suggests "${p.name}" may contain multiple separate components. Consider splitting into multiple part definitions.` });
      }
    }
    if (g.type === "solid_block" && !g.size) {
      issues.push({ severity: "error", field: `${p.name}.geometry.size`, msg: "Solid block requires `size: [w, d, h]`." });
    }
    if (g.type === "hollow_container" && !g.outer) {
      issues.push({ severity: "error", field: `${p.name}.geometry.outer`, msg: "Hollow container requires `outer: [w, d, h]`." });
    }
    if (g.type === "hollow_container" && !g.wall) {
      issues.push({ severity: "warning", field: `${p.name}.geometry.wall`, msg: "No `wall` thickness set for hollow container. Defaults to 3mm." });
    }
    // New primitive validations
    if (g.type === "sphere") {
      if (!g.radius) issues.push({ severity: "error", field: `${p.name}.geometry.radius`, msg: "Sphere requires `radius` or `size` ([rx, ry, rz] for ellipsoid)." });
    }
    if (g.type === "cone") {
      if (!g.radius_bottom && !g.radius_top && !g.size) issues.push({ severity: "error", field: `${p.name}.geometry`, msg: "Cone requires `radius_bottom` and `radius_top` (or `size` for pyramid)." });
      if (!g.height) issues.push({ severity: "error", field: `${p.name}.geometry.height`, msg: "Cone requires `height`." });
    }
    if (g.type === "torus") {
      if (!g.major_radius) issues.push({ severity: "error", field: `${p.name}.geometry.major_radius`, msg: "Torus requires `major_radius`." });
      if (!g.minor_radius) issues.push({ severity: "error", field: `${p.name}.geometry.minor_radius`, msg: "Torus requires `minor_radius`." });
    }
    if (g.type === "lshape") {
      if (!g.leg1 || !g.leg2) issues.push({ severity: "error", field: `${p.name}.geometry`, msg: "L-shape requires `leg1: [w, d, h]` and `leg2: [w, d, h]`." });
      if (!g.thickness) issues.push({ severity: "warning", field: `${p.name}.geometry.thickness`, msg: "No `thickness` set for L-shape. Defaults to 3mm." });
    }
    if (g.type === "extrusion" && !g.profile) {
      issues.push({ severity: "error", field: `${p.name}.geometry.profile`, msg: "Extrusion requires `profile: [[x,y], ...]` polygon points." });
    }
    if (g.type === "wedge") {
      if (!g.size) issues.push({ severity: "error", field: `${p.name}.geometry.size`, msg: "Wedge requires `size: [w, d, h]`." });
    }
    if (g.type === "ellipsoid") {
      if (!g.size) issues.push({ severity: "error", field: `${p.name}.geometry.size`, msg: "Ellipsoid requires `size: [w, d, h]`." });
    }
    if (g.type === "pyramid") {
      if (!g.size) issues.push({ severity: "error", field: `${p.name}.geometry.size`, msg: "Pyramid requires `size: [w, d, h]`." });
    }
    if (g.type === "multi_layer") {
      if (!g.layers || !Array.isArray(g.layers) || g.layers.length === 0) issues.push({ severity: "error", field: `${p.name}.geometry.layers`, msg: "Multi-layer requires `layers: [{size: [w,d,h], at: [x,y,z]}, ...]`." });
    }
    if (g.type === "button_round") {
      if (!g.radius) issues.push({ severity: "error", field: `${p.name}.geometry.radius`, msg: "Button round requires `radius`." });
      if (!g.height) issues.push({ severity: "error", field: `${p.name}.geometry.height`, msg: "Button round requires `height`." });
    }
    if (g.type === "t_shape") {
      if (!g.stem || !g.bar) issues.push({ severity: "error", field: `${p.name}.geometry`, msg: "T-shape requires `stem: [w, d, h]` and `bar: [w, d, h]`." });
    }
    if (g.type === "groove") {
      if (!g.size) issues.push({ severity: "error", field: `${p.name}.geometry.size`, msg: "Groove requires `size: [w, d, h]`." });
    }
    if (g.type === "arch") {
      if (!g.span) issues.push({ severity: "error", field: `${p.name}.geometry.span`, msg: "Arch requires `span` (opening width)." });
      if (!g.thickness) issues.push({ severity: "warning", field: `${p.name}.geometry.thickness`, msg: "No `thickness` set for arch. Defaults to 3mm." });
    }
    if (g.top_fillet && g.outer) {
      const minDim = Math.min(...g.outer);
      if (g.top_fillet > minDim / 2) {
        issues.push({ severity: "warning", field: `${p.name}.geometry.top_fillet`, msg: `Fillet ${g.top_fillet}mm > half the smallest dimension (${minDim/2}mm). May fail.` });
      }
    }

    // Check features
    for (const feat of (p.features || [])) {
      if (!feat.type) { issues.push({ severity: "error", field: `${p.name}.features[?].type`, msg: "Feature missing `type`." }); }
      if (feat.type && !VALID_FEATURE_TYPES.includes(feat.type)) {
        issues.push({ severity: "warning", field: `${p.name}.features.type`, msg: `Unknown feature type "${feat.type}". Valid: ${VALID_FEATURE_TYPES.join(", ")}` });
      }
      if (feat.type === "friction_tab" && !feat.size) {
        issues.push({ severity: "error", field: `${p.name}.features.friction_tab.size`, msg: "Friction tab requires `size: [w, d, h]`." });
      }
      if (feat.type === "slot" && (!feat.size || !feat.at)) {
        issues.push({ severity: "error", field: `${p.name}.features.slot`, msg: "Slot requires both `size` and `at`." });
      }
    }
  }

  // Check assembly references resolve
  const partNames = new Set(parts.map(p => p.name));
  for (const [inst, pos] of Object.entries(assembly)) {
    const baseName = inst.split("#")[0];
    if (!partNames.has(baseName)) {
      issues.push({ severity: "error", field: `assembly.${inst}`, msg: `Part "${baseName}" not defined in \`parts\` list.` });
    }
    if (!Array.isArray(pos) || pos.length < 2) {
      issues.push({ severity: "error", field: `assembly.${inst}`, msg: `Position must be [x, y] or [x, y, z].` });
    } else if (pos.some(v => typeof v !== 'number')) {
      issues.push({ severity: "error", field: `assembly.${inst}`, msg: `All position values must be numbers.` });
    }
  }

  // Basic overlap check (2D, in-plane) — skip containment cases (e.g. bins inside base)
  const placed = [];
  for (const [inst, pos] of Object.entries(assembly)) {
    const baseName = inst.split("#")[0];
    const pdef = parts.find(p => p.name === baseName);
    if (!pdef || !pdef.geometry) continue;
    const w = (pdef.geometry.outer || pdef.geometry.size || [0, 0])[0];
    const d = (pdef.geometry.outer || pdef.geometry.size || [0, 0])[1];
    const x = pos[0] || 0, y = pos[1] || 0;
    placed.push({ inst, x, y, w, d });
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      if (a.w === 0 || a.d === 0 || b.w === 0 || b.d === 0) continue;
      // Check if one fully contains the other (bins on base — by design)
      const aContainsB = a.x <= b.x && a.y <= b.y && (a.x + a.w) >= (b.x + b.w) && (a.y + a.d) >= (b.y + b.d);
      const bContainsA = b.x <= a.x && b.y <= a.y && (b.x + b.w) >= (a.x + a.w) && (b.y + b.d) >= (a.y + a.d);
      if (aContainsB || bContainsA) continue;
      const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y));
      if (ox > 0 && oy > 0) {
        issues.push({ severity: "warning", field: `assembly`, msg: `${a.inst} overlaps ${b.inst} by ${ox.toFixed(1)}×${oy.toFixed(1)}mm in XY plane.` });
      }
    }
  }

  return issues;
}

function formatValidation(issues) {
  if (issues.length === 0) return "✅ Spec validation passed — no issues found.";
  const errors = issues.filter(i => i.severity === "error");
  const warnings = issues.filter(i => i.severity === "warning");
  let out = "";
  if (errors.length > 0) {
    out += `### ❌ ${errors.length} Error(s) — must fix\n\n`;
    for (const e of errors) out += `- \`${e.field}\`: ${e.msg}\n`;
    out += "\n";
  }
  if (warnings.length > 0) {
    out += `### ⚠️ ${warnings.length} Warning(s) — review\n\n`;
    for (const w of warnings) out += `- \`${w.field}\`: ${w.msg}\n`;
    out += "\n";
  }
  return out;
}

// ── Conflict resolution helpers ──────────────────────────────
const SOURCE_CONFIDENCE_RULES = [
  { score: 3, patterns: [/\.(pdf|docx?|txt|md|rtf|csv)$/i, /explicit|doc|document|spec|criteria/i] },
  { score: 0, patterns: [/infer|estimate|approx|guess/i] },
];

function sourceConfidence(name) {
  const lower = name.toLowerCase();
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(lower)) return 1;
  if (/infer|estimate|approx|guess/.test(lower)) return 0;
  for (const rule of SOURCE_CONFIDENCE_RULES) {
    for (const re of rule.patterns) if (re.test(lower)) return rule.score;
  }
  return 2;
}

function resolveConflicts(conflicts, sourceUncertainty = {}) {
  const resolved = [];
  const unresolved = [];
  for (const c of conflicts) {
    const baseScores = c.sources.map(s => sourceConfidence(s));
    const uncertainFields = c.sources.map(s => (sourceUncertainty[s] || []));
    const fieldPenalties = uncertainFields.map(u => u.includes(c.field) ? -1 : 0);
    const finalScores = baseScores.map((s, i) => s + fieldPenalties[i]);
    const maxScore = Math.max(...finalScores);
    const maxCount = finalScores.filter(s => s === maxScore).length;
    if (maxCount === 1) {
      const maxIdx = finalScores.indexOf(maxScore);
      resolved.push({
        part: c.part, field: c.field, chosen: c.values[maxIdx],
        from: c.sources[maxIdx],
        reason: `auto: ${c.sources[maxIdx]} has higher confidence (score ${maxScore})`,
        overwritten: JSON.stringify(c.chosen) !== JSON.stringify(c.values[maxIdx]),
      });
    } else {
      // Secondary tie-breaking heuristics
      const tiedIndices = finalScores.map((s, i) => s === maxScore ? i : -1).filter(i => i >= 0);
      const tiedSources = tiedIndices.map(i => ({ idx: i, src: c.sources[i], val: c.values[i], uncertain: uncertainFields[i] }));
      let tieBroken = false;

      // 1. Prefer explicit document text over OCR/inferred sources
      const nonOcr = tiedSources.filter(t => !/ocr|infer|estimate|approx|guess/i.test(t.src));
      if (nonOcr.length === 1) {
        const t = nonOcr[0];
        resolved.push({
          part: c.part, field: c.field, chosen: t.val,
          from: t.src,
          reason: `tie-break: ${t.src} is explicit text, prefer over OCR/inferred sources`,
          overwritten: false,
        });
        tieBroken = true;
      }

      // 2. Prefer structured table values over free text pattern matches
      if (!tieBroken) {
        const tableSrcs = tiedSources.filter(t => /table|docx_table/i.test(t.src) || t.uncertain.length === 0);
        const freeTextSrcs = tiedSources.filter(t => /text|pattern|match|infer/i.test(t.src));
        if (tableSrcs.length === 1 && freeTextSrcs.length > 0) {
          const t = tableSrcs[0];
          resolved.push({
            part: c.part, field: c.field, chosen: t.val,
            from: t.src,
            reason: `tie-break: ${t.src} is a structured table value, prefer over free text`,
            overwritten: false,
          });
          tieBroken = true;
        }
      }

      // 3. Prefer container-friendly dimensions when part type is clearly a bin/tray/box
      //    "Container-friendly" = values that are round multiples of 5 or 10
      if (!tieBroken) {
        const partNameLower = (c.part || "").toLowerCase();
        if (/bin|tray|box|tank|container|holder|drawer/.test(partNameLower)) {
          const rounded = tiedSources.filter(t => {
            const vals = Array.isArray(t.val) ? t.val : [];
            return vals.every(v => v % 5 === 0);
          });
          if (rounded.length === 1) {
            const t = rounded[0];
            resolved.push({
              part: c.part, field: c.field, chosen: t.val,
              from: t.src,
              reason: `tie-break: ${t.src} has rounded dimensions (multiples of 5), suitable for bin/tray`,
              overwritten: false,
            });
            tieBroken = true;
          }
        }
      }

      // 4. Prefer values supported by more source references
      if (!tieBroken) {
        const srcCounts = tiedSources.map(t => t.uncertain.length === 0 ? 2 : 1);
        const maxCount = Math.max(...srcCounts);
        const bestCount = srcCounts.filter(c => c === maxCount).length;
        if (bestCount === 1) {
          const bestIdx = srcCounts.indexOf(maxCount);
          const t = tiedSources[bestIdx];
          resolved.push({
            part: c.part, field: c.field, chosen: t.val,
            from: t.src,
            reason: `tie-break: ${t.src} has fewer uncertainty markers (more trustworthy)`,
            overwritten: false,
          });
          tieBroken = true;
        }
      }

      if (!tieBroken) {
        unresolved.push(c);
      }
    }
  }
  return { resolved, unresolved };
}

// ── Assembly templates ─────────────────────────────────────
const ASSEMBLY_TEMPLATES = {
  /** Box + lid: lid sits on top of base at (0,0,base_height) */
  box_with_lid(baseName, lidName, baseHeight) {
    return {
      [`${baseName}#1`]: [0, 0, 0],
      [`${lidName}#1`]: [0, 0, baseHeight],
    };
  },
  /** Cylinder + stem: stem extends from cylinder center top */
  cylinder_with_stem(cylName, stemName, cylHeight) {
    return {
      [`${cylName}#1`]: [0, 0, 0],
      [`${stemName}#1`]: [0, 0, cylHeight],
    };
  },
  /** Tray + inserts: items arranged in a grid on the tray */
  tray_with_inserts(trayName, insertNames, traySize, trayHeight, cols = 3) {
    const asm = {};
    asm[`${trayName}#1`] = [0, 0, 0];
    const margin = 5;
    const tw = traySize[0] - 2 * margin;
    const th = traySize[1] - 2 * margin;
    const spacingX = cols > 0 ? tw / cols : tw;
    for (let i = 0; i < insertNames.length; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      asm[`${insertNames[i]}#1`] = [
        margin + col * spacingX,
        margin + row * spacingX,
        trayHeight,
      ];
    }
    return asm;
  },
  /** Multi-part from component graph: place parts at (0,0) with vertical stacking */
  fromComponentGraph(nodes, scale_px_per_mm = 1) {
    const asm = {};
    // Sort by y-position in image (top to bottom → bottom to top in assembly)
    const sorted = [...nodes].sort((a, b) => (a.centroid[1] || 0) - (b.centroid[1] || 0));
    let z = 0;
    for (const n of sorted) {
      const id = n.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      asm[`${id}#1`] = [0, 0, z];
      z += (n.size_px[1] || 10) / scale_px_per_mm;
    }
    return asm;
  },
};

/** Suggest an assembly template match from component graph nodes */
function suggestAssemblyTemplate(nodes) {
  const roles = nodes.filter(n => n.role !== "unknown").map(n => n.role);
  if (roles.includes("lid") && roles.includes("body")) {
    return { template: "box_with_lid", confidence: "medium", label: "Box with lid" };
  }
  if (roles.includes("stem") && roles.includes("body")) {
    return { template: "cylinder_with_stem", confidence: "low", label: "Cylinder with stem" };
  }
  if (roles.length >= 2 && roles.includes("handle")) {
    return { template: null, confidence: "low", label: "Body with handle — manual placement needed" };
  }
  if (nodes.length > 1 && roles.length > 0) {
    return { template: "fromComponentGraph", confidence: "low", label: "Stacked from image layout" };
  }
  return null;
}

// ── YAML builder from structured extraction ─────────────────
function buildYaml(extraction) {
  const { project_name, parts, assembly, constraints, output, conflicts } = extraction;

  let y = `meta:\n  name: "${project_name || "Untitled"}"\n  output_dir: "./"\n`;

  const mat = (constraints && constraints.material) ? constraints.material : "PLA";
  y += `  material: "${mat}"\n`;

  if (constraints && constraints.layer_height) y += `  layer_height: ${constraints.layer_height}\n`;
  if (constraints && constraints.tolerance) y += `  tolerance: ${constraints.tolerance}\n`;

  y += "\nparts:\n";

  for (const p of (parts || [])) {
    const partConflicts = conflicts ? conflicts.filter(c => c.part === p.name) : [];

    y += `  - name: ${p.name}\n`;

    for (const pc of partConflicts) {
      y += `    # conflict: ${pc.field} differs between ${pc.sources.join(" and ")} (${pc.values.map((v, i) => pc.sources[i] + ": " + JSON.stringify(v)).join("; ")})\n`;
      y += `    # current: ${JSON.stringify(pc.chosen)} — use cad_revise to resolve\n`;
    }

    y += `    geometry:\n`;
    y += `      type: ${p.type || "hollow_container"}\n`;

    if (p.type === "solid_block") {
      y += `      size: [${p.size.join(", ")}]\n`;
    } else if (p.type === "cylinder") {
      y += `      radius: ${p.radius}\n      height: ${p.height}\n`;
    } else if (p.type === "sphere") {
      if (p.radius) y += `      radius: ${p.radius}\n`;
      if (p.size) y += `      size: [${p.size.join(", ")}]\n`;
    } else if (p.type === "cone") {
      if (p.radius_bottom !== undefined) y += `      radius_bottom: ${p.radius_bottom}\n`;
      if (p.radius_top !== undefined) y += `      radius_top: ${p.radius_top}\n`;
      if (p.height !== undefined) y += `      height: ${p.height}\n`;
      if (p.size) y += `      size: [${p.size.join(", ")}]\n`;
    } else if (p.type === "torus") {
      y += `      major_radius: ${p.major_radius}\n      minor_radius: ${p.minor_radius}\n`;
    } else if (p.type === "lshape") {
      y += `      leg1: [${p.leg1.join(", ")}]\n      leg2: [${p.leg2.join(", ")}]\n`;
      if (p.thickness !== undefined) y += `      thickness: ${p.thickness}\n`;
    } else if (p.type === "wedge" || p.type === "ellipsoid" || p.type === "pyramid") {
      y += `      size: [${p.size.join(", ")}]\n`;
    } else if (p.type === "multi_layer") {
      if (p.layers) { y += `      layers:\n`; for (const ly of p.layers) { y += `        - {size: [${ly.size.join(", ")}], at: [${ly.at.join(", ")}]}\n`; } }
    } else if (p.type === "button_round") {
      y += `      radius: ${p.radius}\n      height: ${p.height}\n`;
    } else if (p.type === "t_shape") {
      y += `      stem: [${p.stem.join(", ")}]\n      bar: [${p.bar.join(", ")}]\n`;
    } else if (p.type === "groove") {
      y += `      size: [${p.size.join(", ")}]\n`;
    } else if (p.type === "arch") {
      y += `      span: ${p.span}\n      thickness: ${p.thickness || 3}\n`;
    } else {
      y += `      outer: [${(p.outer || p.size || []).join(", ")}]\n`;
    }

    if (p.wall !== undefined) y += `      wall: ${p.wall}\n`;
    if (p.top_fillet !== undefined) y += `      top_fillet: ${p.top_fillet}\n`;

    if (p.features && p.features.length > 0) {
      y += `    features:\n`;
      for (const f of p.features) {
        y += `      - type: ${f.type}\n`;
        if (f.at) y += `        at: ${f.at}\n`;
        if (f.size) y += `        size: [${f.size.join(", ")}]\n`;
        if (f.clearance !== undefined) y += `        clearance: ${f.clearance}\n`;
        if (f.radius !== undefined) y += `        radius: ${f.radius}\n`;
        if (f.depth !== undefined) y += `        depth: ${f.depth}\n`;
        if (f.direction) y += `        direction: ${f.direction}\n`;
        if (f.edges) y += `        edges: ${f.edges}\n`;
        if (f.shape) y += `        shape: ${f.shape}\n`;
        if (f.slots) {
          y += `        slots:\n`;
          for (const s of f.slots) {
            y += `          - instance: ${s.instance}\n`;
            y += `            size: [${s.size.join(", ")}]\n`;
            y += `            at: [${s.at.join(", ")}]\n`;
          }
        }
      }
    }
    y += "\n";
  }

  // Assembly layout
  if (assembly && Object.keys(assembly).length > 0) {
    y += "assembly:\n";
    for (const [inst, pos] of Object.entries(assembly)) {
      if (pos === null) {
        y += `  ${inst}: null\n`;
        continue;
      }
      const posStr = pos.length === 2 ? `[${pos[0]}, ${pos[1]}, 0]` : `[${pos.join(", ")}]`;
      y += `  ${inst}: ${posStr}\n`;
    }
    y += "\n";
  }

  // Output config
  const oc = output || {};
  y += "output:\n";
  y += `  stl:\n    per_part: ${oc.per_part !== false}\n    combined: ${oc.combined || false}\n    directory: "STLs"\n`;
  y += `  screenshots:\n    per_part: ${oc.screenshots_per_part !== false}\n    assembly: true\n    annotate: dimensions\n    background: white\n`;

  return y;
}

// ── Assembly template inference ───────────────────────────────
// Takes a list of parts (with extracted component graph) and auto-positions them
// using template patterns: box+lid, cylinder+stem, tray+inserts, freeform.
// Returns an assembly dict `{ "partname#1": [x, y, z] | null }`.
const LIBRARY_DIR = join(STATE_DIR, "library");
const SEED_TEMPLATES = [ // built-in seed templates
  { name: "box_with_lid", version: 1, match_signature: { partCount: { min: 2, max: 2 }, typePattern: { 0: "hollow_container|solid_block", 1: "solid_block" }, sizePattern: ["oneLargeFlat"], containmentPattern: "none" }, assemblyStub: { templateType: "box_with_lid" } },
  { name: "cylinder_with_stem", version: 1, match_signature: { partCount: { min: 2, max: 2 }, typePattern: { 0: "cylinder", 1: "cylinder|solid_block" } }, assemblyStub: { templateType: "cylinder_with_stem" } },
  { name: "tray_with_inserts", version: 1, match_signature: { partCount: { min: 3, max: 12 }, typePattern: { "dominant": "solid_block", "rest?": "hollow_container|solid_block", "dominantFlat": true } }, assemblyStub: { templateType: "tray_with_inserts" } },
  { name: "base_with_bins", version: 1, match_signature: { partCount: { min: 3, max: 20 }, typePattern: { "largest": "solid_block", "rest": "hollow_container|solid_block", "largestFlat": true } }, assemblyStub: { templateType: "base_with_bins" } },
  { name: "body_with_handle", version: 1, match_signature: { partCount: { min: 2, max: 2 }, sizePattern: ["oneLargeOneSmall"] }, assemblyStub: { templateType: "body_with_handle" } },
  { name: "enclosure_with_lid", version: 1, match_signature: { partCount: { min: 2, max: 2 }, typePattern: { 0: "hollow_container|solid_block", 1: "solid_block" }, sizePattern: ["twoLargeFlat"] }, assemblyStub: { templateType: "enclosure_with_lid" } },
  { name: "nested_containers", version: 1, match_signature: { partCount: { min: 2, max: 10 }, containmentPattern: "nested" }, assemblyStub: { templateType: "nested_containers" } },
];

// ── Library / Prior-Component Matching System ─────────────────

function ensureLibraryDir() {
  mkdirSync(LIBRARY_DIR, { recursive: true });
}

function saveToLibrary(spec) {
  ensureLibraryDir();
  if (!spec || !spec.parts) return;
  const sig = buildLibrarySignature(spec.parts, spec.assembly);
  const existing = readdirSync(LIBRARY_DIR).filter(f => f.endsWith(".json"));
  for (const f of existing) {
    try {
      const t = JSON.parse(readFileSync(join(LIBRARY_DIR, f), "utf-8"));
      if (scoreSignature(t.match_signature, sig) > 0.85) return; // too similar, skip
    } catch {}
  }
  const name = (spec.meta?.name || "unknown").replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  const path = join(LIBRARY_DIR, `${name}_v${existing.length + 1}.json`);
  writeFileSync(path, JSON.stringify({
    name, version: existing.length + 1, created: new Date().toISOString(),
    match_signature: sig,
    componentGraph: null,
    assemblyTemplate: spec.assembly || {},
  }, null, 2));
}

function buildLibrarySignature(parts, assembly) {
  const types = parts.map(p => p.geometry?.type || p.type || "solid_block");
  const sizes = parts.map(p => {
    const sz = p.geometry?.size || p.outer || p.geometry?.outer || p.size || [60, 60, 100];
    return { w: sz[0] || 60, d: sz[1] || 60, h: sz[2] || 100 };
  });
  const flatCount = sizes.filter(s => (s.h || 100) < 30).length;
  const tallCount = sizes.filter(s => (s.h || 100) >= 30).length;
  const largestAreaIdx = sizes.reduce((bi, s, i, a) => (s.w * s.d > (a[bi]?.w * a[bi]?.d || 0) ? i : bi), 0);
  const maxH = Math.max(...sizes.map(s => s.h));
  const minH = Math.min(...sizes.map(s => s.h));
  return {
    partCount: { min: parts.length, max: parts.length },
    typeCounts: types.reduce((a, t) => { a[t] = (a[t] || 0) + 1; return a; }, {}),
    largestType: types[largestAreaIdx],
    flatCount, tallCount, total: parts.length,
    largestAreaIdx,
    heightRange: [minH, maxH],
    sizeRatios: sizes.map(s => ({ wr: s.w / sizes[largestAreaIdx].w, dr: s.d / sizes[largestAreaIdx].d, hr: s.h / sizes[largestAreaIdx].h })),
  };
}

function scoreSignature(tplSig, detectedSig) {
  let score = 0;
  const ranges = tplSig.partCount;
  if (detectedSig.total >= ranges.min && detectedSig.total <= ranges.max) score += 0.25;

  if (tplSig.typePattern) {
    const pattern = tplSig.typePattern;
    let m = 0, n = 0;
    for (const [k, v] of Object.entries(pattern)) {
      n++;
      if (k === "dominant" && detectedSig.largestType && v.split("|").includes(detectedSig.largestType)) m++;
      else if (k === "rest?" && detectedSig.typeCounts) {
        const restCount = Object.entries(detectedSig.typeCounts).filter(([t]) => v.split("|").includes(t)).length;
        if (restCount > 0) m++;
      } else if (k === "largestFlat" && v === true && detectedSig.flatCount > 0) m++;
      else if (+k === +k && detectedSig.types && detectedSig.types[k] && v.split("|").includes(detectedSig.types[k])) m++;
    }
    score += 0.35 * (m / Math.max(n, 1));
  }

  if (tplSig.sizePattern) {
    let m = 0, n = 0;
    for (const sp of tplSig.sizePattern) {
      n++;
      if (sp === "oneLargeFlat" && detectedSig.flatCount === 1 && detectedSig.total === 2) m++;
      else if (sp === "oneLargeOneSmall" && detectedSig.total === 2) m++;
      else if (sp === "twoLargeFlat" && detectedSig.flatCount === 2) m++;
    }
    score += 0.2 * (m / Math.max(n, 1));
  }

  if (tplSig.heightRange) {
    if (detectedSig.heightRange[0] >= tplSig.heightRange[0] * 0.5 && detectedSig.heightRange[1] <= tplSig.heightRange[1] * 2) score += 0.1;
  }

  return Math.min(score, 1.0);
}

function matchPriorLibrary(parts) {
  ensureLibraryDir();
  const detectedSig = buildLibrarySignature(parts);
  const matches = [];

  // Check seed templates
  for (const tpl of SEED_TEMPLATES) {
    matches.push({ name: tpl.name, score: scoreSignature(tpl.match_signature, detectedSig), template: tpl, source: "seed" });
  }

  // Check persisted library
  if (existsSync(LIBRARY_DIR)) {
    for (const f of readdirSync(LIBRARY_DIR).filter(f => f.endsWith(".json"))) {
      try {
        const tpl = JSON.parse(readFileSync(join(LIBRARY_DIR, f), "utf-8"));
        matches.push({ name: tpl.name, score: scoreSignature(tpl.match_signature, detectedSig), template: tpl, source: "library" });
      } catch {}
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 5);
}

// ── Collision Checking ────────────────────────────────────────

function checkCollisions(assembly, parts) {
  const warnings = [];
  const collisions = [];

  const placed = Object.entries(assembly).filter(([, pos]) => pos !== null && Array.isArray(pos));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const [nameA, posA] = placed[i];
      const [nameB, posB] = placed[j];
      const partA = parts.find(p => p.name === nameA.split("#")[0]);
      const partB = parts.find(p => p.name === nameB.split("#")[0]);
      if (!partA || !partB) continue;

      const szA = partA.geometry?.size || partA.outer || [30, 30, 30];
      const szB = partB.geometry?.size || partB.outer || [30, 30, 30];
      const [ax, ay, az] = posA;
      const [bx, by, bz] = posB;
      const [aw, ad, ah] = [szA[0] || 30, szA[1] || 30, szA[2] || 30];
      const [bw, bd, bh] = [szB[0] || 30, szB[1] || 30, szB[2] || 30];

      const overlapX = ax < bx + bw && ax + aw > bx;
      const overlapY = ay < by + bd && ay + ad > by;
      const overlapZ = az < bz + bh && az + ah > bz;

      if (overlapX && overlapY && overlapZ) {
        const typeA = partA.geometry?.type || partA.type || "?";
        const typeB = partB.geometry?.type || partB.type || "?";
        // Nested containers are OK (insert in tray, bin on base)
        if (typeA === "solid_block" && az === 0) { collisions.push({ msg: `${nameA} overlaps with ${nameB} but base is OK`, severity: "info" }); }
        else { collisions.push({ msg: `${nameA} collides with ${nameB}`, severity: "warning", posA, posB, sz: [aw, ad, ah] }); }
      }
    }
  }
  return { collisions, warnings, passes: collisions.length === 0 };
}

// ── Auto-Alignment ────────────────────────────────────────────

function autoAlign(parts, assembly) {
  const placed = { ...assembly };
  const positions = Object.entries(placed).filter(([, pos]) => pos !== null && Array.isArray(pos));
  if (positions.length === 0) return placed;

  // Snap all non-origin positions to 5mm grid
  for (const [name, pos] of positions) {
    if (pos[0] === 0 && pos[1] === 0 && pos[2] === 0) continue; // keep origin on base
    placed[name] = [
      Math.round(pos[0] / 5) * 5,
      Math.round(pos[1] / 5) * 5,
      Math.round(pos[2] / 5) * 5,
    ];
  }

  // Centering: for all parts, calculate aggregate center, shift so origin parts stay
  let cx = 0, cy = 0, count = 0;
  for (const [, pos] of Object.entries(placed).filter(([, p]) => p !== null)) {
    cx += pos[0]; cy += pos[1]; count++;
  }
  if (count > 1) {
    const avgX = cx / count, avgY = cy / count;
    // If aggregate center is far from origin, shift everything
    if (Math.abs(avgX) > 20 || Math.abs(avgY) > 20) {
      for (const [name, pos] of Object.entries(placed).filter(([, p]) => p !== null)) {
        placed[name] = [Math.round((pos[0] - avgX) / 5) * 5, Math.round((pos[1] - avgY) / 5) * 5, pos[2]];
      }
    }
  }

  return placed;
}

// ── Extended Assembly Template Engine ─────────────────────────

function applyExtendedTemplate(templateType, parts, sizes, types) {
  const assembly = {};
  for (const p of parts) assembly[`${p.name}#1`] = null;
  const getSize = (i) => sizes[i] || { w: 60, d: 60, h: 100 };

  switch (templateType) {
    case "box_with_lid": {
      const [boxIdx, lidIdx] = types.findIndex(t => t === "hollow_container" || t === "solid_block") >= 0
        ? [types.findIndex(t => t === "hollow_container" || t === "solid_block"),
           types.findLastIndex(t => t === "solid_block" || t === "hollow_container")]
        : [0, 1];
      const b = getSize(boxIdx), l = getSize(lidIdx);
      assembly[`${parts[boxIdx].name}#1`] = [0, 0, 0];
      assembly[`${parts[lidIdx].name}#1`] = [((b.w || 60) - (l.w || 60)) / 2, ((b.d || 60) - (l.d || 60)) / 2, (b.h || 100)];
      break;
    }
    case "cylinder_with_stem": {
      const cylIdx = types.findIndex(t => t === "cylinder");
      const stemIdx = cylIdx === 0 ? 1 : 0;
      const c = getSize(cylIdx >= 0 ? cylIdx : 0), s = getSize(stemIdx);
      assembly[`${parts[cylIdx >= 0 ? cylIdx : 0].name}#1`] = [0, 0, 0];
      assembly[`${parts[stemIdx].name}#1`] = [-(s.w || 10) / 2, 0, -(s.h || 50)];
      break;
    }
    case "tray_with_inserts": {
      const flatSizes = sizes.map((s, i) => ({ i, s, h: s.h || 100 }));
      flatSizes.sort((a, b) => a.h - b.h);
      const trayIdx = flatSizes[0] && flatSizes[0].h < 30 ? flatSizes[0].i : 0;
      const insertIdxs = parts.map((_, i) => i).filter(i => i !== trayIdx);
      const tw = sizes[trayIdx].w || 100, td = sizes[trayIdx].d || 80, th = sizes[trayIdx].h || 20;
      assembly[`${parts[trayIdx].name}#1`] = [0, 0, 0];
      const cols = Math.ceil(Math.sqrt(insertIdxs.length)) || 1;
      const rows = Math.ceil(insertIdxs.length / cols) || 1;
      const spW = tw / (cols + 1), spD = td / (rows + 1);
      let idx = 0;
      for (let r = 0; r < rows && idx < insertIdxs.length; r++) {
        for (let c = 0; c < cols && idx < insertIdxs.length; c++) {
          const ip = sizes[insertIdxs[idx]];
          assembly[`${parts[insertIdxs[idx]].name}#1`] = [(c + 1) * spW - (ip.w || 20) / 2, (r + 1) * spD - (ip.d || 20) / 2, th];
          idx++;
        }
      }
      break;
    }
    case "body_with_handle": {
      const largeIdx = sizes.reduce((bi, s, i, a) => (s.w * s.h > (a[bi]?.w * a[bi]?.h || 0) ? i : bi), 0);
      const smallIdx = largeIdx === 0 ? 1 : 0;
      const b = getSize(largeIdx), s = getSize(smallIdx);
      assembly[`${parts[largeIdx].name}#1`] = [0, 0, 0];
      assembly[`${parts[smallIdx].name}#1`] = [(b.w || 60) / 2 + (s.w || 10) / 2, (b.d || 60) / 2 - (s.d || 10) / 2, (b.h || 60) / 2 - (s.h || 10) / 2];
      break;
    }
    case "enclosure_with_lid": {
      const encIdx = sizes.reduce((bi, s, i, a) => (s.w * s.d > (a[bi]?.w * a[bi]?.d || 0) ? i : bi), 0);
      const lidIdx = encIdx === 0 ? 1 : 0;
      const e = getSize(encIdx), l = getSize(lidIdx);
      assembly[`${parts[encIdx].name}#1`] = [0, 0, 0];
      assembly[`${parts[lidIdx].name}#1`] = [((e.w || 100) - (l.w || 100)) / 2, ((e.d || 80) - (l.d || 80)) / 2, (e.h || 60)];
      break;
    }
    case "nested_containers": {
      const byArea = sizes.map((s, i) => ({ i, area: (s.w || 60) * (s.d || 60) }));
      byArea.sort((a, b) => b.area - a.area);
      assembly[`${parts[byArea[0].i].name}#1`] = [0, 0, 0];
      let zOff = 0;
      for (let k = 1; k < byArea.length; k++) {
        const outer = sizes[byArea[k].i];
        const parent = sizes[byArea[k - 1].i];
        zOff += (parent.h || 30);
        assembly[`${parts[byArea[k].i].name}#1`] = [((parent.w || 60) - (outer.w || 30)) / 2, ((parent.d || 60) - (outer.d || 30)) / 2, zOff];
      }
      break;
    }
    default:
      break;
  }
  return assembly;
}

function applyAssemblyTemplate(parts, componentGraph) {
  const assembly = {};
  if (!parts || parts.length === 0) return assembly;

  // Default: all parts unplaced
  for (const p of parts) {
    assembly[`${p.name}#1`] = null;
  }

  // Try library matching first
  const matches = matchPriorLibrary(parts);
  if (matches.length > 0 && matches[0].score > 0.5) {
    const template = matches[0].template;
    const types = parts.map(p => p.geometry?.type || p.type);
    const sizes = parts.map(p => {
      const sz = p.geometry?.size || p.outer || p.geometry?.outer || p.size || [60, 60, 100];
      return { w: sz[0] || 60, d: sz[1] || 60, h: sz[2] || 100 };
    });
    if (template.assemblyStub?.templateType) {
      const tplAssembly = applyExtendedTemplate(template.assemblyStub.templateType, parts, sizes, types);
      for (const [key, pos] of Object.entries(tplAssembly)) {
        if (pos !== null) assembly[key] = pos;
      }
    }
  }

  // If a component graph with suggested assembly is available, use it
  if (componentGraph && componentGraph.suggested_assembly) {
    const sa = componentGraph.suggested_assembly;
    const base = sa.base_part_id;
    const basePart = parts[0];
    if (!basePart) return assembly;

    const baseIdx = parts.findIndex(p => p.name === base.replace("part_", ""));
    const actualBase = baseIdx >= 0 ? parts[baseIdx] : parts[0];
    const baseOuter = actualBase.outer || actualBase.size || [60, 60, 100];
    const bW = baseOuter[0] || 60;
    const bD = baseOuter[1] || 60;
    const bH = baseOuter[2] || 100;

    // Base part at origin
    assembly[`${actualBase.name}#1`] = [0, 0, 0];

    // Position relatives
    let relIdx = 0;
    for (const rp of sa.relative_parts || []) {
      const relPartIdx = parts.findIndex(p => p.name === rp.part_id.replace("part_", ""));
      if (relPartIdx < 0) { relIdx++; continue; }
      const relPart = parts[relPartIdx];
      const relOuter = relPart.outer || relPart.size || [30, 30, 30];
      const rW = relOuter[0] || 30;
      const rD = relOuter[1] || 30;
      const rH = relOuter[2] || 30;

      const pos = { x: 0, y: 0, z: 0 };
      switch (rp.position) {
        case "above":
          if (rp.role === "lid") {
            // Lid sits directly on top
            pos.z = bH;
            pos.x = (bW - rW) / 2;
            pos.y = (bD - rD) / 2;
          } else {
            // Stacked above
            pos.z = bH + relIdx * 5;
          }
          break;
        case "below":
          if (rp.role === "stem") {
            // Stem centered below
            pos.x = (bW - rW) / 2;
            pos.y = (bD - rD) / 2;
            pos.z = -rH;
          } else {
            pos.z = -(rH + relIdx * 5);
          }
          break;
        case "side":
          // Handle or attachment to the side
          pos.x = bW / 2 + rW / 2 + 2;
          pos.z = bH / 2 - rH / 2;
          break;
      }
      assembly[`${relPart.name}#1`] = [pos.x, pos.y, pos.z];
      relIdx++;
    }
    return assembly;
  }

  // ── Template-based inference (no component graph) ──
  // Detect pattern from part types and sizes
  const types = parts.map(p => p.type);
  const sizes = parts.map(p => p.outer || p.size || [60, 60, 100]);

  // Pattern 1: Box + Lid (box + flat component)
  const hasBox = types.some(t => t === "hollow_container" || t === "solid_block");
  const hasLid = sizes.some(s => (s[2] || 100) < 20 && (s[0] || 60) >= 40);
  if (hasBox && hasLid && parts.length === 2) {
    const boxIdx = types.findIndex(t => t === "hollow_container" || t === "solid_block");
    const lidIdx = boxIdx === 0 ? 1 : 0;
    const boxOuter = sizes[boxIdx];
    const lidOuter = sizes[lidIdx];
    assembly[`${parts[boxIdx].name}#1`] = [0, 0, 0];
    assembly[`${parts[lidIdx].name}#1`] = [
      ((boxOuter[0] || 60) - (lidOuter[0] || 60)) / 2,
      ((boxOuter[1] || 60) - (lidOuter[1] || 60)) / 2,
      (boxOuter[2] || 100),
    ];
    return assembly;
  }

  // Pattern 2: Cylinder + Stem (cylinder + narrow tall component)
  if (parts.length === 2) {
    const cylIdx = types.findIndex(t => t === "cylinder");
    const stemIdx = cylIdx === 0 ? 1 : 0;
    if (cylIdx >= 0 && stemIdx >= 0) {
      const cylOuter = sizes[cylIdx];
      const stemOuter = sizes[stemIdx];
      const cylR = cylOuter[0] || 30;
      const stemW = stemOuter[0] || 10;
      const stemH = stemOuter[2] || 50;
      assembly[`${parts[cylIdx].name}#1`] = [0, 0, 0];
      assembly[`${parts[stemIdx].name}#1`] = [
        -(stemW / 2), 0, -stemH
      ];
      return assembly;
    }
  }

  // Pattern 3: Tray + Inserts (wide flat tray + small containers)
  const trayIdx = sizes.findIndex(s => (s[0] || 0) > 80 && (s[1] || 0) > 60 && (s[2] || 100) < 30);
  if (trayIdx >= 0) {
    const insertIndices = parts.map((p, i) => i).filter(i => i !== trayIdx);
    const trayOuter = sizes[trayIdx];
    const tw = trayOuter[0] || 100;
    const td = trayOuter[1] || 80;
    const th = trayOuter[2] || 20;

    assembly[`${parts[trayIdx].name}#1`] = [0, 0, 0];

    // Arrange inserts in a grid on top of the tray
    const inserts = insertIndices.map(i => parts[i]);
    const numInserts = inserts.length;
    const cols = Math.ceil(Math.sqrt(numInserts)) || 1;
    const rows = Math.ceil(numInserts / cols) || 1;
    const spacingW = tw / (cols + 1);
    const spacingD = td / (rows + 1);

    let idx = 0;
    for (let r = 0; r < rows && idx < numInserts; r++) {
      for (let c = 0; c < cols && idx < numInserts; c++) {
        const ip = inserts[idx];
        const ipOuter = ip.outer || ip.size || [20, 20, 30];
        const ix = (c + 1) * spacingW - ipOuter[0] / 2;
        const iy = (r + 1) * spacingD - ipOuter[1] / 2;
        assembly[`${ip.name}#1`] = [ix, iy, th];
        idx++;
      }
    }
    return assembly;
  }

  // Auto-alignment + collision check before return
  assembly = autoAlign(parts, assembly);
  const cc = checkCollisions(assembly, parts);
  if (!cc.passes) {
    assembly._collision_check = "warning";
    assembly._collision_notes = cc.collisions.map(c => c.msg).join("; ");
  } else {
    assembly._collision_check = "pass";
  }

  return assembly;
}

// ── Auto-fix retry helper (single-shot, infinite-loop guarded) ―――――
// Called when compile fails. Attempts autoFixYaml and recompiles ONCE.
// Returns { recovered: true, fixes, summary } on success
// Returns { recovered: false, original_errors, retry_errors, fixes } on double-failure
// Returns null if autoFixYaml found nothing to fix.
function autoFixAndRetry(specPath, originalErrors) {
  const specText = readFileSync(specPath, "utf-8");
  const { text: fixed, fixes } = autoFixYaml(specText);
  if (fixes.length === 0) return null;

  writeFileSync(specPath, fixed);
  const { cmd, cleanup } = compileCmd(specPath);
  const retryResult = run(cmd);
  try { execSync(`rm -f "${cleanup}"`, { timeout: 5000 }); } catch {}

  let summary = null;
  if (retryResult.output) {
    const m = retryResult.output.match(/=== COMPILER OUTPUT ===\n(.+?)(?:\n|$)/s);
    if (m) { try { summary = JSON.parse(m[1]); } catch {} }
  }

  if (!summary || summary.status !== "ok") {
    return {
      recovered: false,
      original_errors: originalErrors,
      fixes,
      retry_errors: parseCompileError(retryResult.stderr || retryResult.output || retryResult.error || ""),
    };
  }

  return { recovered: true, fixes, summary };
}

// ── Auto-build threshold check ────────────────────────────────
// Returns { ready, reason, status, auto_parts }
// ready=true only when parts are clearly spec-ready with minimal uncertainty.
// Keeps uncertain results in draft mode.
function checkAutoBuildThreshold(parts, source) {
  if (!parts || parts.length === 0) {
    return { ready: false, reason: "No parts extracted", status: "draft", auto_parts: [] };
  }

  const auto_parts = [];
  const uncertain = [];
  const drafts = [];

  for (const p of parts) {
    const hasOuter = p.outer || p.dimensions || p.size;
    const hasType = p.type || p.suggested_type;
    const unc = (p._uncertain || []);

    if (hasOuter && hasType && unc.length === 0) {
      // Fully spec-ready
      auto_parts.push({
        name: p.name || p.name_slug || "part_" + Math.random().toString(36).slice(2, 6),
        type: p.type || p.suggested_type || "hollow_container",
        outer: p.outer || p.dimensions || p.size,
        wall: p.wall || 3,
        _uncertain: [],
      });
    } else if (hasOuter && hasType && unc.length > 0) {
      // Has shape but uncertain markers — keep as draft
      drafts.push(p);
    } else {
      uncertain.push(p);
    }
  }

  if (auto_parts.length > 0 && uncertain.length === 0 && drafts.length === 0) {
    return {
      ready: true,
      reason: `All ${auto_parts.length} part(s) fully spec-ready, no uncertainty`,
      status: "ready",
      auto_parts,
    };
  }

  if (auto_parts.length > 0 && drafts.length > 0) {
    return {
      ready: false,
      reason: `${auto_parts.length} part(s) ready, ${drafts.length} part(s) have uncertainty — manual review needed`,
      status: "partial",
      auto_parts,
    };
  }

  return {
    ready: false,
    reason: `${auto_parts.length} ready, ${drafts.length} draft, ${uncertain.length} uncertain — insufficient for auto-build`,
    status: "draft",
    auto_parts: auto_parts.length > 0 ? auto_parts : [],
  };
}

// ── Shared ingest core (plain function, not a tool) ───────────
// Called by cad_ingest.execute and all auto-ingest paths.
// All args are parsed values (not JSON strings).
// Returns the output text for the caller to append.
async function runIngestCore(args, ctx) {
  const { project_name, parts, assembly, constraints, output, source_notes, source_dirs, auto_compile } = args;

  let state = findProject(ctx.directory);
  if (!state) return "No CAD project found. Run `cad_init` first.";

  if (!Array.isArray(parts)) return "`parts` must be an array.";
  if (parts.length === 0) return "At least one part required.";
  if (typeof assembly !== "object") return "`assembly` must be an object.";

  // Auto-apply assembly template if positions are missing
  const allNull = Object.values(assembly).every(v => v === null || (Array.isArray(v) && v.every(c => c === null)));
  const hasComponentGraph = parts.some(p => p._component_graph);
  if (allNull || hasComponentGraph) {
    // Save original for template detection in output
    args._original_assembly = JSON.parse(JSON.stringify(assembly));
    // Extract component_graph from parts metadata
    const cg = parts.find(p => p._component_graph)?._component_graph || null;
    const templated = applyAssemblyTemplate(parts, cg);
    // Merge: keep explicit non-null positions, fill nulls from template
    for (const [key, pos] of Object.entries(templated)) {
      if (assembly[key] === null || (Array.isArray(assembly[key]) && assembly[key].every(c => c === null))) {
        assembly[key] = pos;
      }
    }
  }

  const uncertain = [];
  for (const p of parts) {
    if (p._uncertain) {
      for (const f of (Array.isArray(p._uncertain) ? p._uncertain : [p._uncertain])) {
        uncertain.push({ part: p.name, field: f });
      }
    }
  }

  const pendingConflicts = (state.conflicts || []).filter(c => !c.resolved);

  const extraction = {
    project_name,
    parts, assembly, constraints, output,
    conflicts: pendingConflicts,
  };
  if (pendingConflicts.length > 0) {
    extraction.conflicts = pendingConflicts;
  }

  const yaml = buildYaml(extraction);
  const issues = validateSpec({ parts, assembly });

  const specPath = join(state.root, "design.yaml");
  writeFileSync(specPath, yaml);
  state.spec = specPath;
  state.compiled = false;
  state.rendered = false;
  state.extraction_sources = state.extraction_sources || [];
  if (source_notes) state.extraction_sources.push({ source: source_notes, at: new Date().toISOString() });

  const scannedFiles = [];
  if (source_dirs) {
    const dirs = source_dirs.split(",").map(s => s.trim());
    for (const d of dirs) {
      if (!existsSync(d)) { scannedFiles.push(`[not found: ${d}]`); continue; }
      const stat = statSync(d);
      if (!stat.isDirectory()) { scannedFiles.push(`[not a dir: ${d}]`); continue; }
      try {
        const entries = readdirSync(d, { withFileTypes: true });
        const found = [];
        for (const e of entries) {
          if (e.isFile() && /\.(png|jpg|jpeg|gif|webp|bmp|svg|pdf|doc|docx|txt|md|rtf|csv|json|yaml|yml)$/i.test(e.name)) {
            found.push(join(d, e.name));
          }
        }
        if (found.length > 0) {
          scannedFiles.push(...found);
          state.extraction_sources.push({ source: `scanned: ${d} (${found.length} files)`, at: new Date().toISOString() });
        }
      } catch {}
    }
  }
  saveState(state);

  ctx.metadata({ title: `Ingested: ${project_name}`, metadata: { parts: parts.length, spec: specPath } });

  let out = `## Spec Generated: ${project_name}\n\n`;
  out += `**${parts.length} parts defined, ${Object.keys(assembly).length} placed in assembly**\n\n`;

  // Detect if assembly template was applied
  const wasAllNull = args._original_assembly ? Object.values(args._original_assembly).every(v => v === null) : false;
  if (wasAllNull && Object.values(assembly).some(v => v !== null && !(Array.isArray(v) && v.every(c => c === null)))) {
    out += "> Assembly template applied: auto-positioned parts based on type/size analysis.\n";
    out += "> Review positions below and adjust with `cad_revise` if needed.\n\n";
  }

  if (uncertain.length > 0) {
    out += `### ⚠️ Uncertain Values (${uncertain.length})\n`;
    for (const u of uncertain) out += `- \`${u.part}.${u.field}\`\n`;
    out += "\n";
  }

  if (scannedFiles.length > 0) {
    out += `### Source Files (${scannedFiles.length})\n`;
    for (const f of scannedFiles) out += `- \`${f}\`\n`;
    out += "\n";
  }

  const nullPositions = Object.entries(assembly)
    .filter(([, pos]) => pos === null || (Array.isArray(pos) && pos.some(v => v === null)))
    .map(([name]) => name);
  if (nullPositions.length > 0) {
    out += `### ⚠️ Missing Positions (${nullPositions.length})\n`;
    for (const np of nullPositions) out += `- \`${np}\` position not specified\n`;
    out += "Set positions with `cad_revise` or edit the YAML.\n\n";
  }

  if (pendingConflicts.length > 0) {
    out += `### ⚠️ Unresolved Conflicts (${pendingConflicts.length})\n`;
    for (const c of pendingConflicts) {
      out += `- \`${c.part}.${c.field}\`: ${c.sources.map((s, i) => `${s}=${JSON.stringify(c.values[i])}`).join(" vs ")}\n`;
    }
    out += "\nResolve each by setting a value with `cad_revise`.\n\n";
  }

  const valResult = formatValidation(issues);
  if (issues.length > 0) out += `### Validation\n${valResult}\n`;

  out += `\`\`\`yaml\n${yaml}\n\`\`\`\n\n`;

  if (auto_compile) {
    out += `---\n### Auto-Compile Pipeline\n\n`;

    out += `#### Step 1: Compile\n`;
    const specText = readFileSync(specPath, "utf-8");
    const patched = specText.replace(/output_dir:\s*.+/, `output_dir: "${state.root}"`);
    writeFileSync(specPath, patched);

    const { cmd, cleanup } = compileCmd(specPath);
    const compileResult = run(cmd);
    try { execSync(`rm -f "${cleanup}"`, { timeout: 5000 }); } catch {}

    let compileSummary = null;
    if (compileResult.output) {
      const cm = compileResult.output.match(/=== COMPILER OUTPUT ===\n(.+?)(?:\n|$)/s);
      if (cm) { try { compileSummary = JSON.parse(cm[1]); } catch {} }
    }

    if (!compileSummary || compileSummary.status !== "ok") {
      const compileErrors = parseCompileError(compileResult.stderr || compileResult.output || compileResult.error || "");
      const retry = autoFixAndRetry(specPath, compileErrors);
      if (retry && retry.recovered) {
        compileSummary = retry.summary;
        out += `🔧 Auto-fix applied: ${retry.fixes.map(f => f.msg).join("; ")}\n\n`;
      } else if (retry && !retry.recovered) {
        out += `❌ Compile failed. Auto-fix attempted but also failed.\n`;
        out += `Original: ${compileErrors[0]}\nRetry: ${retry.retry_errors[0]}\n\n`;
        out += "Edit the spec with `cad_revise` and try again.";
        return out;
      } else {
        out += `❌ Compile failed: ${compileErrors.length > 0 ? compileErrors[0] : "Unknown error"}\n\n`;
        out += "Edit the spec with `cad_revise` and try again.";
        return out;
      }
    }

    state.compiled = true;
    state.last_compile_error = null;

    const stlDir = join(state.root, "STLs");
    if (existsSync(stlDir)) state.parts = readdirSync(stlDir).filter(f => f.endsWith(".stl"));
    saveState(state);

    out += `**${state.parts.length} parts compiled**\n`;
    const stlDimsMap = {};
    for (const p of state.parts) {
      const fp = join(stlDir, p);
      const dims = existsSync(fp) ? stlDims(fp) : null;
      stlDimsMap[p.replace(".stl", "")] = dims;
      if (dims) out += `- \`${p}\` — ${dims.x}×${dims.y}×${dims.z} mm\n`;
    }
    out += "\n";

    // Save to prior library for future matching
    try {
      const specPath = join(state.root, `${state.name}.yaml`);
      if (existsSync(specPath)) {
        const spec = JSON.parse(JSON.stringify({ meta: { name: state.name }, parts: JSON.parse(readFileSync(specPath, "utf-8")).parts }));
        saveToLibrary(spec);
        out += "> Added to component library for future matching.\n\n";
      }
    } catch {} // non-blocking

    out += `#### Step 2: Render Screenshots\n`;
    const fcstd = join(state.root, `${state.name}.FCStd`);
    if (existsSync(fcstd)) {
      const renderResult = run(`"${FREECAD}" "${RENDER_SCRIPT}" "${fcstd}" "${state.root}"`);
      const rm = renderResult.output.match(/=== RENDERER OUTPUT ===\n(.+?)(?:\n|$)/s);
      if (rm) {
        try { const rs = JSON.parse(rm[1]); if (rs.status === "ok") {
          state.rendered = true;
          const shotDir = join(state.root, "screenshots");
          const shots = existsSync(shotDir) ? readdirSync(shotDir).filter(f => f.endsWith(".png")) : [];
          out += `${shots.length} screenshots captured.\n\n`;
        } } catch {}
      }
    }
    saveState(state);

    out += `#### Step 3: STL Summary\n`;
    out += `STL files: \`${stlDir}\`\n`;
    if (output && output.combined) {
      const combinedPath = join(stlDir, `${project_name}_assembly.stl`);
      if (existsSync(combinedPath)) out += `Assembly STL: \`${combinedPath}\`\n`;
    }
    out += "\n";
  }

  return out;
}

// ── Plugin ──────────────────────────────────────────────────
const _crossTools = {};
export const CadPlugin = async (_ctx) => {
  const plugin = {
    tool: {

      cad_init: tool({
        description: "Initialize a new CAD project. Creates the project directory and state tracking.",
        args: {
          name: tool.schema.string().describe("Project name (e.g. 'Organizer')"),
          output_dir: tool.schema.string().optional().describe("Output directory (default: ./cad-output/<name>)"),
        },
        async execute(args, ctx) {
          const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "_");
          const baseDir = args.output_dir || join(ctx.directory, "cad-output", name);
          const state = {
            name, root: baseDir,
            created: new Date().toISOString(),
            spec: null, compiled: false, rendered: false,
            parts: [], last_compile_error: null,
            revision_history: [],
            extraction_sources: [],
          };
          saveState(state);
          registerProject(state);
          ctx.metadata({ title: `CAD: ${name}`, metadata: { dir: baseDir } });
          return `## CAD Project: ${name}\n\nProject created at \`${baseDir}\`\n\nSteps:\n1. Load source docs: \`cad_ingest\` or \`cad_draft\`\n2. \`cad_compile\` → STLs\n3. \`cad_render\` → screenshots\n4. \`cad_preview\` → 3D viewer\n5. \`cad_revise\` → iterate`;
        },
      }),

      cad_list: tool({
        description: "List all CAD projects.",
        args: {
          switch_to: tool.schema.string().optional().describe("Project name to switch to"),
        },
        async execute(args, ctx) {
          const projects = listProjects();
          if (args.switch_to) {
            const found = projects.find(p => p.name === args.switch_to);
            if (found) return `## Switched to: ${found.name}\n\nRoot: \`${found.root}\`\nRun \`cad_status\` to see state.`;
            return `Project "${args.switch_to}" not found. Available: ${projects.map(p => `\`${p.name}\``).join(", ")}`;
          }
          if (projects.length === 0) return "No CAD projects found.";
          let out = `## CAD Projects (${projects.length})\n\n`;
          for (const p of projects) {
            const st = loadState(p.root);
            out += `- **${p.name}** — ${st ? (st.compiled ? "✅ compiled" : "⏳ pending") : "⚠ missing"}\n  \`${p.root}\`\n`;
          }
          return out;
        },
      }),

      // ── INGEST: Source material → structured extraction → YAML ―――――――
      cad_ingest: tool({
        description: "Convert structured extraction notes (from reading docs/images) into a validated YAML CAD spec. Optionally auto-compile, render, and diff.",
        args: {
          project_name: tool.schema.string().describe("Project/assembly name"),
          parts: tool.schema.string().describe("JSON array of part objects. Each: {name, type, outer/size, wall, top_fillet, features, _uncertain}: list fields where value is estimated"),
          assembly: tool.schema.string().describe("JSON object mapping instance names to positions: {PartName#ID: [x, y], ...}. Use null for unknown positions."),
          constraints: tool.schema.string().optional().describe("JSON object: {material, layer_height, tolerance, notes}"),
          output: tool.schema.string().optional().describe("JSON object: {per_part, combined, screenshots_per_part}"),
          source_notes: tool.schema.string().optional().describe("Text notes about what source material was used (document path, image description, etc.)"),
          source_dirs: tool.schema.string().optional().describe("Comma-separated directory paths to scan for source files (images, documents)."),
          auto_compile: tool.schema.boolean().optional().describe("Auto-compile, render, and diff after ingest (default: false)"),
        },
        async execute(args, ctx) {
          let parts, assembly, constraints, output;
          try { parts = JSON.parse(args.parts); } catch { return "Invalid `parts` JSON. Must be an array of part objects."; }
          try { assembly = JSON.parse(args.assembly); } catch { return "Invalid `assembly` JSON. Must be an object mapping instance names to positions."; }
          if (args.constraints) { try { constraints = JSON.parse(args.constraints); } catch { return "Invalid `constraints` JSON."; } }
          if (args.output) { try { output = JSON.parse(args.output); } catch { return "Invalid `output` JSON."; } }

          if (!Array.isArray(parts)) return "`parts` must be a JSON array.";
          if (parts.length === 0) return "At least one part required.";
          if (typeof assembly !== "object") return "`assembly` must be a JSON object.";

          return runIngestCore({
            project_name: args.project_name,
            parts, assembly, constraints, output,
            source_notes: args.source_notes,
            source_dirs: args.source_dirs,
            auto_compile: args.auto_compile,
          }, ctx);
        },
      }),

      // ── MERGE: Multi-source extraction merge with conflict detection ―――
      cad_merge: tool({
        description: "Merge parts extracted from multiple sources into one spec. Detects conflicting dimensions and stores both values for model resolution.",
        args: {
          project: tool.schema.string().describe("Project name (creates or uses existing project)"),
          source: tool.schema.string().describe("Name of this source (e.g. 'sketch.png', 'Criteria_C.docx')"),
          parts: tool.schema.string().describe("JSON array of part objects extracted from this source. Each: {name, type, outer/size, wall, top_fillet, features}"),
          existing_parts: tool.schema.string().optional().describe("JSON array of previously extracted parts to merge with. Omit to use project state parts."),
          assembly: tool.schema.string().optional().describe("JSON assembly positions for this source."),
          source_notes: tool.schema.string().optional().describe("Notes about this source."),
        },
        async execute(args, ctx) {
          let projectState = findProject(ctx.directory);
          if (!projectState) return "No project. Run `cad_init` first.";

          let sourceParts;
          try { sourceParts = JSON.parse(args.parts); } catch { return "Invalid `parts` JSON."; }
          if (!Array.isArray(sourceParts)) return "`parts` must be a JSON array.";

          let existingParts = [];
          if (args.existing_parts) {
            try { existingParts = JSON.parse(args.existing_parts); } catch { return "Invalid `existing_parts` JSON."; }
            if (!Array.isArray(existingParts)) return "`existing_parts` must be a JSON array.";
          } else if (projectState.merged_parts && projectState.merged_parts.length > 0) {
            existingParts = projectState.merged_parts;
          } else if (projectState.build_history && projectState.build_history.length > 0) {
            return "Cannot merge: existing project has compile history. Use `existing_parts` explicitly or start fresh.";
          }

          const partsByName = {};
          for (const p of existingParts) partsByName[p.name] = p;

          const conflicts = [];
          const merged = [...existingParts];

          for (const sp of sourceParts) {
            const existing = partsByName[sp.name];
            if (!existing) {
              const enriched = { ...sp, _source: args.source };
              merged.push(enriched);
              partsByName[sp.name] = enriched;
              continue;
            }

            const fieldsToCheck = ["outer", "size", "wall", "top_fillet", "height", "radius"];
            for (const field of fieldsToCheck) {
              const val1 = existing[field];
              const val2 = sp[field];
              if (val1 !== undefined && val2 !== undefined) {
                const s1 = JSON.stringify(val1);
                const s2 = JSON.stringify(val2);
                if (s1 !== s2) {
                  conflicts.push({
                    part: sp.name,
                    field,
                    values: [val1, val2],
                    sources: [existing._source || "previous", args.source],
                    chosen: val1,
                  });
                }
              }
            }

            if (sp.features && sp.features.length > 0) {
              existing.features = existing.features || [];
              const featKeys = new Set(existing.features.map(f => `${f.type}:${f.at || ""}`));
              for (const f of sp.features) {
                const k = `${f.type}:${f.at || ""}`;
                if (!featKeys.has(k)) {
                  existing.features.push(f);
                  featKeys.add(k);
                }
              }
            }
          }

          // Auto-resolve conflicts by confidence
          const sourceUncertainty = {};
          for (const p of [...sourceParts, ...existingParts]) {
            if (p._uncertain && p._source) {
              sourceUncertainty[p._source] = sourceUncertainty[p._source] || [];
              sourceUncertainty[p._source].push(...(Array.isArray(p._uncertain) ? p._uncertain : [p._uncertain]));
            }
          }

          const { resolved: autoResolved, unresolved } = resolveConflicts(conflicts, sourceUncertainty);

          for (const ar of autoResolved) {
            const target = merged.find(p => p.name === ar.part);
            if (target) {
              target[ar.field] = ar.chosen;
            }
          }

          projectState.conflicts = projectState.conflicts || [];
          const stillUnresolvedKeys = new Set(unresolved.map(c => `${c.part}:${c.field}`));
          projectState.conflicts = projectState.conflicts.filter(c => stillUnresolvedKeys.has(`${c.part}:${c.field}`) || c.resolved);
          for (const c of unresolved) {
            const dup = projectState.conflicts.find(
              x => x.part === c.part && x.field === c.field && !x.resolved
            );
            if (!dup) projectState.conflicts.push({ ...c, resolved: false });
          }

          projectState.extraction_sources = projectState.extraction_sources || [];
          projectState.extraction_sources.push({ source: args.source, parts: sourceParts.length, at: new Date().toISOString(), notes: args.source_notes || "" });

          projectState.merged_parts = merged;

          const mergedAssembly = args.assembly ? (() => { try { return JSON.parse(args.assembly); } catch { return null; } })() : null;
          if (mergedAssembly) {
            projectState.merge_assembly = projectState.merge_assembly || {};
            Object.assign(projectState.merge_assembly, mergedAssembly);
          }

          saveState(projectState);

          let out = `## Merge: ${args.project} — ${args.source}\n\n`;
          out += `**Source parts:** ${sourceParts.length}\n`;
          out += `**Existing parts:** ${existingParts.length}\n`;
          out += `**Merged parts:** ${merged.length}\n`;

          if (autoResolved.length > 0) {
            out += `\n### ✅ Auto-Resolved (${autoResolved.length})\n`;
            for (const ar of autoResolved) {
              const verb = ar.overwritten ? `overwritten: ${JSON.stringify(ar.chosen)}` : "kept";
              out += `- \`${ar.part}.${ar.field}\` ${verb} (${ar.reason})\n`;
            }
          }

          if (unresolved.length > 0) {
            out += `\n### ⚠️ Unresolved (${unresolved.length})\n`;
            for (const c of unresolved) {
              out += `- \`${c.part}.${c.field}\`: ${c.sources[0]} = ${JSON.stringify(c.values[0])} vs ${c.sources[1]} = ${JSON.stringify(c.values[1])}\n`;
            }
            out += "\nResolve with `cad_revise`.\n";
          }

          if (conflicts.length === 0) out += "\nNo conflicts detected.\n";

          out += `\n### Merged Parts\n`;
          for (const p of merged) {
            const dim = p.outer ? `${p.outer.join("×")}` : p.size ? `${p.size.join("×")}` : "";
            out += `- \`${p.name}\` ${dim} (${p.type}) — from ${p._source || "unknown"}\n`;
          }

          if (mergedAssembly) {
            out += `\n**Assembly:** ${Object.keys(mergedAssembly).length} instances\n`;
          }

          out += `\nNext: call \`cad_ingest\` to build the YAML spec from the merged parts, or merge another source.`;

          return out;
        },
      }),

      // ── MERGE ALL: Batch directory ingestion ―――――――――――――――
      cad_merge_all: tool({
        description: "Scan a directory for source files and batch-merge all valid inputs into one project with auto-conflict resolution. Supports JSON extraction files, text files, and images.",
        args: {
          directory: tool.schema.string().describe("Directory to scan for source files."),
          project: tool.schema.string().optional().describe("Project name (uses directory name if not specified)"),
          patterns: tool.schema.string().optional().describe("File extension filter (default: *.json,*.txt,*.png,*.jpg). Separate with commas."),
        },
        async execute(args, ctx) {
          const scanDir = args.directory;
          if (!existsSync(scanDir)) return `Directory not found: ${scanDir}`;
          const stat = statSync(scanDir);
          if (!stat.isDirectory()) return `Not a directory: ${scanDir}`;

          let projectName = args.project || basename(scanDir).replace(/[^a-zA-Z0-9_-]/g, "_");

          let projectState = null;
          const existingProjects = listProjects();
          const found = existingProjects.find(p => p.name === projectName);
          if (found) projectState = loadState(found.root);
          if (!projectState) {
            const baseDir = join(scanDir, "cad-output", projectName);
            projectState = {
              name: projectName, root: baseDir,
              created: new Date().toISOString(),
              spec: null, compiled: false, rendered: false,
              parts: [], last_compile_error: null,
              revision_history: [],
              extraction_sources: [],
            };
            saveState(projectState);
            registerProject(projectState);
          }

          const extFilter = args.patterns ? args.patterns.split(",").map(s => s.trim().replace(/^\*\.?/, ".").toLowerCase()) : null;
          function matchExt(name) {
            const ext = "." + name.split(".").pop().toLowerCase();
            if (!extFilter) return true;
            return extFilter.some(f => name.toLowerCase().endsWith(f) || ext === f);
          }

          const allFiles = readdirSync(scanDir, { withFileTypes: true })
            .filter(e => e.isFile() && matchExt(e.name))
            .map(e => join(scanDir, e.name))
            .sort();

          if (allFiles.length === 0) {
            return `No supported source files found in \`${scanDir}\`. Supported: JSON (parts definitions), TXT/MD (text specs), PNG/JPG (images).\nUse \`cad_draft\` to create extraction templates.`;
          }

          // Classify files
          const imageExts = /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i;
          const textExts = /\.(txt|md|csv)$/i;
          const jsonExts = /\.json$/i;

          const jsonFiles = allFiles.filter(f => jsonExts.test(f));
          const imageFiles = allFiles.filter(f => imageExts.test(f));
          const textFiles = allFiles.filter(f => textExts.test(f));
          const otherFiles = allFiles.filter(f => !jsonExts.test(f) && !imageExts.test(f) && !textExts.test(f));

          const results = [];
          let totalParts = 0;
          let totalAutoResolved = 0;
          let totalUnresolved = 0;

          // 1. Process JSON files (direct merge)
          for (const fp of jsonFiles) {
            try {
              const content = readFileSync(fp, "utf-8");
              let data;
              try { data = JSON.parse(content); } catch { results.push({ file: fp, type: "json", status: "invalid JSON" }); continue; }
              const sourceName = data.source || basename(fp);
              if (!data.parts || !Array.isArray(data.parts)) { results.push({ file: fp, type: "json", status: "no parts array" }); continue; }
              const sourceParts = data.parts.map(p => ({ ...p, _source: sourceName }));
              const existingParts = projectState.merged_parts || [];
              const partsByName = {};
              for (const p of existingParts) partsByName[p.name] = p;
              const conflicts = [];
              const merged = [...existingParts];

              for (const sp of sourceParts) {
                const existing = partsByName[sp.name];
                if (!existing) { merged.push(sp); partsByName[sp.name] = sp; continue; }
                for (const field of ["outer", "size", "wall", "top_fillet", "height", "radius"]) {
                  const v1 = existing[field], v2 = sp[field];
                  if (v1 !== undefined && v2 !== undefined && JSON.stringify(v1) !== JSON.stringify(v2)) {
                    conflicts.push({ part: sp.name, field, values: [v1, v2], sources: [existing._source || "previous", sourceName], chosen: v1 });
                  }
                }
                if (sp.features) {
                  existing.features = existing.features || [];
                  const featKeys = new Set(existing.features.map(f => `${f.type}:${f.at || ""}`));
                  for (const f of sp.features) {
                    if (!featKeys.has(`${f.type}:${f.at || ""}`)) { existing.features.push(f); featKeys.add(`${f.type}:${f.at || ""}`); }
                  }
                }
              }
              const sourceUncertainty = {};
              for (const p of sourceParts) {
                if (p._uncertain && p._source) {
                  sourceUncertainty[p._source] = sourceUncertainty[p._source] || [];
                  sourceUncertainty[p._source].push(...(Array.isArray(p._uncertain) ? p._uncertain : [p._uncertain]));
                }
              }
              const { resolved: autoResolved, unresolved } = resolveConflicts(conflicts, sourceUncertainty);
              for (const ar of autoResolved) {
                const target = merged.find(p => p.name === ar.part);
                if (target) target[ar.field] = ar.chosen;
              }

              projectState.conflicts = projectState.conflicts || [];
              for (const c of unresolved) {
                const dup = projectState.conflicts.find(x => x.part === c.part && x.field === c.field && !x.resolved);
                if (!dup) projectState.conflicts.push({ ...c, resolved: false });
              }
              projectState.extraction_sources = projectState.extraction_sources || [];
              projectState.extraction_sources.push({ source: sourceName, parts: sourceParts.length, type: "json", at: new Date().toISOString(), notes: data.notes || "" });
              if (data.assembly) {
                projectState.merge_assembly = projectState.merge_assembly || {};
                Object.assign(projectState.merge_assembly, data.assembly);
              }
              projectState.merged_parts = merged;
              saveState(projectState);

              totalParts += sourceParts.length;
              totalAutoResolved += autoResolved.length;
              totalUnresolved += unresolved.length;
              results.push({ file: fp, type: "json", parts: sourceParts.length, auto: autoResolved.length, unresolved: unresolved.length, status: "merged" });
            } catch (e) {
              results.push({ file: fp, type: "json", status: `error: ${e.message.slice(0, 80)}` });
            }
          }

          // 2. Process image files — emit as source material for cad_extract_dimensions
          for (const fp of imageFiles) {
            const sourceName = basename(fp);
            projectState.extraction_sources = projectState.extraction_sources || [];
            projectState.extraction_sources.push({ source: sourceName, type: "image", at: new Date().toISOString(), notes: "use cad_extract_dimensions to analyze" });
            saveState(projectState);
            results.push({ file: fp, type: "image", status: "found — run cad_extract_dimensions for measurement analysis" });
          }

          // 3. Process text files — scan for dimension patterns
          for (const fp of textFiles) {
            try {
              const content = readFileSync(fp, "utf-8");
              const sourceName = basename(fp);
              // Simple heuristic: find "[N]×[N]×[N]" or "[N]x[N]x[N]" patterns
              const dimPattern = /(\d+)\s*[×xX]\s*(\d+)\s*[×xX]\s*(\d+)/g;
              const match = dimPattern.exec(content);
              const dimHints = [];
              while (match) {
                dimHints.push({ w: parseInt(match[1]), d: parseInt(match[2]), h: parseInt(match[3]) });
                dimPattern.lastIndex = match.index + 1;
                const m = dimPattern.exec(content);
                if (!m) break;
                match[0] = m[0]; match[1] = m[1]; match[2] = m[2]; match[3] = m[3];
                match.index = m.index;
              }
              projectState.extraction_sources = projectState.extraction_sources || [];
              projectState.extraction_sources.push({ source: sourceName, type: "text", dimHints: dimHints.length, at: new Date().toISOString() });
              saveState(projectState);
              const hintStr = dimHints.length > 0 ? ` (${dimHints.length} dimension hints found)` : "";
              results.push({ file: fp, type: "text", status: `found${hintStr}` });
            } catch (e) {
              results.push({ file: fp, type: "text", status: `error: ${e.message.slice(0, 80)}` });
            }
          }

          // 4. Other files
          for (const fp of otherFiles) {
            results.push({ file: fp, type: "other", status: "unsupported type — skip" });
          }

          let out = `## Batch Merge: ${scanDir}\n\n`;
          out += `**Project:** ${projectName}\n`;
          out += `**Files scanned:** ${allFiles.length} (${jsonFiles.length} JSON, ${imageFiles.length} images, ${textFiles.length} text, ${otherFiles.length} other)\n`;
          const mergedCount = results.filter(r => r.status === "merged").length;
          out += `**Merged:** ${mergedCount} JSON files → ${totalParts} parts`;
          if (totalAutoResolved > 0) out += `, ${totalAutoResolved} auto-resolved`;
          if (totalUnresolved > 0) out += `, ${totalUnresolved} unresolved`;
          out += "\n";

          if (imageFiles.length > 0) {
            out += `\n**Images found:** ${imageFiles.length} — run \`cad_extract_dimensions\` on each to extract structure.\n`;
          }
          if (textFiles.length > 0) {
            out += `\n**Text files found:** ${textFiles.length} — review and create JSON extraction files for merge.\n`;
          }

          // Results table
          out += `\n### Files\n\n`;
          out += `| File | Type | Status |\n`;
          out += `|------|------|--------|\n`;
          for (const r of results) {
            const name = basename(r.file);
            if (r.status === "merged") {
              const detail = `${r.parts}p${r.auto > 0 ? `, ${r.auto}auto` : ""}${r.unresolved > 0 ? `, ${r.unresolved}?!` : ""}`;
              out += `| ${name} | ${r.type} | ✅ merged (${detail}) |\n`;
            } else if (r.type === "image") {
              out += `| ${name} | image | 📷 ${r.status} |\n`;
            } else if (r.type === "text") {
              out += `| ${name} | text | 📄 ${r.status} |\n`;
            } else {
              out += `| ${name} | ${r.type} | ${r.status} |\n`;
            }
          }

          out += `\n### Merged Parts\n`;
          if (projectState.merged_parts) {
            for (const p of projectState.merged_parts) {
              const dim = p.outer ? `${p.outer.join("×")}` : p.size ? `${p.size.join("×")}` : "";
              out += `- \`${p.name}\` ${dim} (${p.type}) — from ${p._source || "unknown"}\n`;
            }
          }

          const pendingConflicts = (projectState.conflicts || []).filter(c => !c.resolved);
          if (pendingConflicts.length > 0) {
            out += `\n### ⚠️ Unresolved Conflicts (${pendingConflicts.length})\n`;
            for (const c of pendingConflicts) out += `- \`${c.part}.${c.field}\`: ${c.sources.map((s, i) => `${s}=${JSON.stringify(c.values[i])}`).join(" vs ")}\n`;
          }

          out += `\nNext steps:\n`;
          if (imageFiles.length > 0) out += `1. \`cad_extract_dimensions\` on image files for measurement data\n`;
          out += `${mergedCount > 0 ? `${imageFiles.length > 0 ? "2" : "1"}. ` : ""}\`cad_ingest\` to build YAML spec\n`;

          return out;
        },
      }),

      // ── EXTRACT DIMENSIONS: Image measurement detection ―――――――――
      cad_extract_dimensions: tool({
        description: "Analyze an image (screenshot, sketch, diagram) for visible measurement annotations, dimension lines, or layout markers. Returns estimated bounding-box dimensions with uncertainty markers. Results are approximate and primarily guide the model's extraction.",
        args: {
          image_path: tool.schema.string().describe("Path to the image file (PNG, JPG, etc.) to analyze."),
          known_scale: tool.schema.number().optional().describe("If the image has a known reference dimension in mm, provide it here. E.g. if a 100px line equals 10mm, use the pixel-to-mm ratio."),
        },
        async execute(args, ctx) {
          if (!existsSync(args.image_path)) return `Image not found: ${args.image_path}`;

          const knownScale = args.known_scale || null;
          const pyScript = `/tmp/cad_extract_${Date.now()}.py`;
          const pyCode = `
import sys, json, os, math, subprocess, re, tempfile
from PIL import Image, ImageFilter, ImageDraw, ImageStat
from collections import defaultdict
# CAD image analysis library
_cia_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "scripts")
if _cia_dir not in sys.path:
    sys.path.insert(0, _cia_dir)
try:
    import cad_image_analysis as cia
    _cia_available = True
except ImportError:
    _cia_available = False

image_path = sys.argv[1] if len(sys.argv) > 1 else None
known_scale = float(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None
max_pages = 10
ext = (image_path or "").rsplit(".", 1)[-1].lower() if image_path else ""
is_document_mode = ext in ("pdf", "docx", "doc")
pages_text = []
tables_data = []
draft_parts = []
spec_ready_parts = []
dimension_hints = []
measurement_phrases = []

try:
    img = Image.open(image_path)
except Exception as e:
    print(json.dumps({"error": str(e), "image_size": None}))
    sys.exit(0)

w, h = img.size
result = {"image_size_px": [w, h], "aspect_ratio": round(w / h, 3) if h > 0 else 0,
          "dimension_hints": [], "measurement_phrases": [], "pages": [],
          "page_count": 0, "total_text": "", "word_count": 0}

gray = img.convert("L")
inverted = Image.eval(gray, lambda x: 255 - x)

# Edge detection
edges = gray.filter(ImageFilter.FIND_EDGES)
estat = ImageStat.Stat(edges)
edge_ratio = estat.mean[0] / 255.0 if estat.mean else 0
result["edge_density"] = round(edge_ratio, 4)

edge_pixels = edges.load()
edge_thresh = 64

# Horizontal and vertical line clusters
horiz_clusters = 0
vert_clusters = 0
step = max(1, min(w, h) // 50)
for y in range(0, h, step):
    count = sum(1 for x in range(0, w, 2) if edge_pixels[x, y] > 128)
    if count > w * 0.3: horiz_clusters += 1
for x in range(0, w, step):
    count = sum(1 for y in range(0, h, 2) if edge_pixels[x, y] > 128)
    if count > h * 0.3: vert_clusters += 1
result["horizontal_edge_lines"] = horiz_clusters
result["vertical_edge_lines"] = vert_clusters

# ── Component detection (flood fill) ──
visited = [[False] * w for _ in range(h)]
components = []
for y in range(2, h-2, 2):
    for x in range(2, w-2, 2):
        if not visited[y][x] and edge_pixels[x, y] > edge_thresh:
            stack = [(x, y)]
            pixels = []
            while stack and len(pixels) < 10000:
                cx, cy = stack.pop()
                if (cx < 2 or cx >= w-2 or cy < 2 or cy >= h-2 or
                    visited[cy][cx] or edge_pixels[cx, cy] <= edge_thresh):
                    continue
                visited[cy][cx] = True
                pixels.append((cx, cy))
                for dx, dy in [(1,0),(-1,0),(0,1),(0,-1)]:
                    stack.append((cx+dx, cy+dy))
            if len(pixels) > 50:
                xs = [p[0] for p in pixels]
                ys = [p[1] for p in pixels]
                components.append({
                    "bbox": [min(xs), min(ys), max(xs), max(ys)],
                    "w": max(xs)-min(xs)+1, "h": max(ys)-min(ys)+1,
                    "area": len(pixels),
                    "cx": (min(xs)+max(xs))//2, "cy": (min(ys)+max(ys))//2,
                })

# Filter to significant components
comps = [c for c in components if c["area"] > 200 and c["w"] > 20 and c["h"] > 20]
result["components"] = len(comps)
rects = sum(1 for c in comps if 0.5 < c["w"]/max(c["h"],1) < 3.0 and c["w"]*c["h"]>2000)
result["rectangular_components"] = rects

# ── Contour extraction + shape classification ──
def moore_trace(start_x, start_y):
    """Trace outer boundary of a component using Moore-Neighbor with Jacob's stopping criterion."""
    contour = []
    cx, cy = start_x, start_y
    dirs = [(-1,0),(-1,-1),(0,-1),(1,-1),(1,0),(1,1),(0,1),(-1,1)]
    start_dir = 0
    first = True
    while True:
        if not first and cx == start_x and cy == start_y:
            break
        first = False
        contour.append((cx, cy))
        found = False
        for i in range(8):
            d = (start_dir + i) % 8
            nx, ny = cx + dirs[d][0], cy + dirs[d][1]
            if 0 <= nx < w and 0 <= ny < h and edge_pixels[nx, ny] > edge_thresh:
                cx, cy = nx, ny
                start_dir = (d + 5) % 8
                found = True
                break
        if not found or len(contour) > 10000:
            break
    return contour

def simplify_contour(pts, eps):
    if len(pts) <= 2:
        return pts
    x1, y1 = pts[0]
    x2, y2 = pts[-1]
    dm, idx = 0, 0
    for i in range(1, len(pts)-1):
        xi, yi = pts[i]
        den = ((x2-x1)**2 + (y2-y1)**2)**0.5
        if den == 0:
            d = ((xi-x1)**2 + (yi-y1)**2)**0.5
        else:
            d = abs((x2-x1)*(y1-yi) - (x1-xi)*(y2-y1)) / den
        if d > dm:
            dm = d
            idx = i
    if dm > eps:
        L = simplify_contour(pts[:idx+1], eps)
        R = simplify_contour(pts[idx:], eps)
        return L[:-1] + R
    return [pts[0], pts[-1]]

shapes = []
for comp in comps:
    bx = comp["bbox"]
    sx, sy = bx[0], bx[1]
    found_start = False
    for yy in range(sy, bx[3]+1):
        for xx in range(sx, bx[2]+1):
            if edge_pixels[xx, yy] > edge_thresh:
                sx, sy = xx, yy
                found_start = True
                break
        if found_start:
            break
    if not found_start:
        continue
    raw_contour = moore_trace(sx, sy)
    if len(raw_contour) < 10:
        continue
    simplified = simplify_contour(raw_contour, 2.0)
    xs_c = [p[0] for p in simplified]
    ys_c = [p[1] for p in simplified]
    sw = max(xs_c) - min(xs_c)
    sh = max(ys_c) - min(ys_c)
    area = 0
    for i in range(len(simplified)):
        j = (i + 1) % len(simplified)
        area += simplified[i][0] * simplified[j][1] - simplified[j][0] * simplified[i][1]
    area = abs(area) / 2.0
    perimeter = sum(
        ((simplified[i][0]-simplified[(i+1)%len(simplified)][0])**2 +
         (simplified[i][1]-simplified[(i+1)%len(simplified)][1])**2)**0.5
        for i in range(len(simplified))
    )
    circularity = (4 * 3.14159 * area) / (perimeter * perimeter) if perimeter > 0 else 0
    rectangularity = area / (sw * sh) if sw * sh > 0 else 0
    aspect_ratio = sw / max(sh, 1)
    cls = "unclear"
    if circularity > 0.70:
        cls = "circular"
    elif rectangularity > 0.70 and aspect_ratio < 1.7:
        cls = "square_like"
    elif rectangularity > 0.60 and aspect_ratio >= 1.7:
        cls = "elongated_rect"
    elif rectangularity > 0.50:
        cls = "rectangular"
    elif area > 0:
        cls = "irregular"
    shapes.append({
        "class": cls,
        "circularity": round(circularity, 3),
        "rectangularity": round(rectangularity, 3),
        "aspect_ratio": round(aspect_ratio, 3),
        "bbox": [min(xs_c), min(ys_c), max(xs_c), max(ys_c)],
        "bbox_w": sw, "bbox_h": sh,
        "contour_pts": len(simplified),
        "area_px2": round(area, 1),
        "center_x": comp["cx"],
        "center_y": comp["cy"],
    })

# Primary shape (largest area)
if shapes:
    shapes.sort(key=lambda s: s["area_px2"], reverse=True)
    best = shapes[0]
    result["shape"] = {
        "classification": best["class"],
        "circularity": best["circularity"],
        "rectangularity": best["rectangularity"],
        "aspect_ratio": best["aspect_ratio"],
        "contour_pts": best["contour_pts"],
        "bounding_box_px": [best["bbox_w"], best["bbox_h"]],
        "area_px2": best["area_px2"],
    }
    # Symmetry scan
    bx = best["bbox"]
    mid_x = (bx[0] + bx[2]) // 2
    mid_y = (bx[1] + bx[3]) // 2
    sym_h, sym_v, sym_count = 0, 0, 0
    for yy in range(bx[1]+1, bx[3], 5):
        for xx in range(bx[0]+1, bx[2], 5):
            if 0 <= xx < w and 0 <= yy < h and edge_pixels[xx, yy] > edge_thresh:
                sym_count += 1
                rx = 2 * mid_x - xx
                if 0 <= rx < w and edge_pixels[rx, yy] > edge_thresh:
                    sym_h += 1
                ty = 2 * mid_y - yy
                if 0 <= ty < h and edge_pixels[xx, ty] > edge_thresh:
                    sym_v += 1
    if sym_count > 20:
        result["shape"]["symmetry_h"] = round(sym_h / sym_count, 3)
        result["shape"]["symmetry_v"] = round(sym_v / sym_count, 3)

    # Multi-part detection + component graph
    if len(shapes) > 1:
        result["shape"]["multi_part"] = True
        result["shape"]["components_separated"] = len(shapes)
        result["shape"]["parts"] = [
            {"class": s["class"], "bbox_px": s["bbox"],
             "w_px": s["bbox_w"], "h_px": s["bbox_h"],
             "cx": s["center_x"], "cy": s["center_y"],
             "area_px2": s["area_px2"]}
            for s in shapes
        ]
        # Cluster by proximity
        clusters = []
        assigned = set()
        for i, si in enumerate(shapes):
            if i in assigned:
                continue
            cluster = [si]
            assigned.add(i)
            for j, sj in enumerate(shapes):
                if j in assigned:
                    continue
                dx = si["center_x"] - sj["center_x"]
                dy = si["center_y"] - sj["center_y"]
                dist = (dx*dx + dy*dy)**0.5
                if dist < w * 0.15:
                    cluster.append(sj)
                    assigned.add(j)
            clusters.append(cluster)
        cg_nodes = []
        for _, cls_parts in enumerate(clusters):
            cls_parts.sort(key=lambda s: s["area_px2"], reverse=True)
            largest = cls_parts[0]
            for part in cls_parts[1:]:
                role = "body"
                if part["bbox_h"] < largest["bbox_h"] * 0.4 and part["center_y"] < largest["center_y"]:
                    role = "lid"
                elif part["bbox_w"] < largest["bbox_w"] * 0.3 and part["center_y"] > largest["center_y"]:
                    role = "stem"
                elif part["area_px2"] < largest["area_px2"] * 0.3:
                    role = "handle"
                cg_nodes.append({
                    "id": f"part_{len(cg_nodes)}",
                    "shape_class": part["class"],
                    "bbox_px": part["bbox"],
                    "cx": part["center_x"],
                    "cy": part["center_y"],
                    "w_px": part["bbox_w"],
                    "h_px": part["bbox_h"],
                    "role": role,
                })
        if cg_nodes:
            result["component_graph"] = {"nodes": cg_nodes, "edges": []}
            # Suggest assembly
            body = next((n for n in cg_nodes if n["role"] == "body"), cg_nodes[0])
            others = [n for n in cg_nodes if n["id"] != body["id"]]
            if others:
                result["component_graph"]["suggested_assembly"] = {
                    "base_part_id": body["id"],
                    "relative_parts": [
                        {
                            "part_id": o["id"],
                            "position": "above" if o["cy"] < body["cy"] else "below" if o["cy"] > body["cy"] else "side",
                            "role": o["role"],
                        } for o in others
                    ],
                }

# ── Dimension inference from arrows/labels ──
# Detect dimension lines: pairs of opposing ticks spanning component edges
# Uses: edge_pixels, inverted, w, h, components, known_scale
dim_inferences = []

# Detect thin straight lines (potential dimension/tick lines)
# Use max component bbox dimension as reference, fallback to image dims
ref_w = shapes[0]["bbox_w"] if shapes else w * 0.8
ref_h = shapes[0]["bbox_h"] if shapes else h * 0.8
max_h_dim = max(ref_w * 1.5, w * 0.6)
max_v_dim = max(ref_h * 1.5, h * 0.6)

# Scan horizontal: lines of dark inverted pixels running left-right
# These thin lines are dimension lines or witness lines
h_dim_lines = []
for y in range(10, h-10, 2):
    x = 10
    while x < w-10:
        if inverted.getpixel((x, y)) > 128:
            start = x
            while x < w-10 and inverted.getpixel((x, y)) > 128:
                x += 1
            length = x - start
            if 10 < length < max_h_dim:
                mid = start + length // 2
                # Check thinness: pixels above/below should be background
                above_below_clear = True
                for dy in [-1, 1]:
                    cy = y + dy
                    if 0 <= cy < h:
                        for dx in [-2, -1, 1, 2]:
                            cx = mid + dx
                            if 0 <= cx < w and inverted.getpixel((cx, cy)) > 128:
                                above_below_clear = False
                                break
                if above_below_clear:
                    h_dim_lines.append((start, y, x, length))
        x += 1

# Scan vertical: lines of dark inverted pixels running top-bottom
v_dim_lines = []
for x in range(10, w-10, 2):
    y = 10
    while y < h-10:
        if inverted.getpixel((x, y)) > 128:
            start = y
            while y < h-10 and inverted.getpixel((x, y)) > 128:
                y += 1
            length = y - start
            if 10 < length < max_v_dim:
                mid = start + length // 2
                left_right_clear = True
                for dx in [-1, 1]:
                    cx = x + dx
                    if 0 <= cx < w:
                        for dy in [-2, -1, 1, 2]:
                            cy = mid + dy
                            if 0 <= cy < h and inverted.getpixel((cx, cy)) > 128:
                                left_right_clear = False
                                break
                if left_right_clear:
                    v_dim_lines.append((x, start, y, length))
        y += 1

# For each significant component, use its bounding box and nearby dim lines
dim_inferences = []
if shapes:
    sorted_shapes = sorted(shapes, key=lambda s: s["area_px2"], reverse=True)
    main = sorted_shapes[0]
    main_cx = (main["bbox"][0] + main["bbox"][2]) // 2
    main_cy = (main["bbox"][1] + main["bbox"][3]) // 2
    main_w = main["bbox_w"]
    main_h = main["bbox_h"]

    # Match horizontal dim lines
    for l in h_dim_lines:
        lx1, ly, lx2, llen = l
        span = lx2 - lx1
        if span < main_w * 0.3: continue
        # Try OCR for label near midpoint
        label_val = None
        tess_path = "/opt/homebrew/bin/tesseract"
        if os.path.exists(tess_path):
            try:
                mid_x = (lx1 + lx2) // 2
                lx = max(0, mid_x - 20)
                ly_crop = max(0, ly - 12)
                lw = min(40, w - lx)
                lh = min(24, h - ly_crop)
                if lw > 20 and lh > 10:
                    crop = gray.crop((lx, ly_crop, lx+lw, ly_crop+lh))
                    crop_path = "/tmp/_cad_dim_label.png"
                    crop.save(crop_path)
                    ocr_proc = subprocess.run(
                        [tess_path, crop_path, "stdout", "--psm", "7", "-c", "tessedit_char_whitelist=0123456789.,"],
                        capture_output=True, text=True, timeout=10
                    )
                    ocr_text = ocr_proc.stdout.strip()
                    if ocr_text:
                        nums = re.findall(r"[\d.]+", ocr_text)
                        if nums:
                            label_val = float(nums[0].replace(",", "."))
                    try: os.remove(crop_path)
                    except: pass
            except: pass
        dim_inferences.append({
            "type": "horizontal",
            "span_px": span,
            "bbox_w_ref_px": main_w,
            "line_y": ly,
            "component_bottom": main["bbox"][3],
            "left_x": lx1, "right_x": lx2,
            "label_value": label_val,
            "estimated_mm": round(span / known_scale, 1) if known_scale and known_scale > 0 else None,
            "matches_width": abs(span - main_w) < main_w * 0.15,
        })

    # Match vertical dim lines
    for l in v_dim_lines:
        lx, ly1, ly2, llen = l
        span = ly2 - ly1
        if span < main_h * 0.3: continue
        label_val = None
        tess_path = "/opt/homebrew/bin/tesseract"
        if os.path.exists(tess_path):
            try:
                mid_y = (ly1 + ly2) // 2
                lx_crop = max(0, lx - 12)
                ly = max(0, mid_y - 20)
                lw = min(24, w - lx_crop)
                lh = min(40, h - ly)
                if lw > 10 and lh > 20:
                    crop = gray.crop((lx_crop, ly, lx_crop+lw, ly+lh))
                    crop_path = "/tmp/_cad_dim_label.png"
                    crop.save(crop_path)
                    ocr_proc = subprocess.run(
                        [tess_path, crop_path, "stdout", "--psm", "7", "-c", "tessedit_char_whitelist=0123456789.,"],
                        capture_output=True, text=True, timeout=10
                    )
                    ocr_text = ocr_proc.stdout.strip()
                    if ocr_text:
                        nums = re.findall(r"[\d.]+", ocr_text)
                        if nums:
                            label_val = float(nums[0].replace(",", "."))
                    try: os.remove(crop_path)
                    except: pass
            except: pass
        dim_inferences.append({
            "type": "vertical",
            "span_px": span,
            "bbox_h_ref_px": main_h,
            "line_x": lx,
            "component_right": main["bbox"][2],
            "top_y": ly1, "bottom_y": ly2,
            "label_value": label_val,
            "estimated_mm": round(span / known_scale, 1) if known_scale and known_scale > 0 else None,
            "matches_height": abs(span - main_h) < main_h * 0.15,
        })

result["dimension_inferences"] = dim_inferences[:20]
if ext == ".pdf" and (not pages_text or sum(p.get("char_count", 0) for p in pages_text) < 30):
    try:
        from PIL import Image as PIL_IMG
        import os, subprocess, tempfile, shutil

        def render_pdf_page(file_path, page_num, output_path):
            """Render a PDF page to PNG at 200 DPI. Tries pdftoppm, fitz, then Pillow.
            Returns (path, renderer_name) or (None, reason)."""
            # 1: pdftoppm (poppler, best quality for vector text/graphics)
            if shutil.which("pdftoppm"):
                try:
                    subprocess.run(
                        ["pdftoppm", "-png", "-r", "200", "-f", str(page_num), "-l", str(page_num),
                         file_path, output_path.replace(".png", "")],
                        capture_output=True, timeout=30, check=True
                    )
                    expected = output_path.replace(".png", "") + "-1.png"
                    if os.path.exists(expected):
                        os.rename(expected, output_path)
                        return (output_path, "pdftoppm")
                except: pass
            # 2: PyMuPDF (fitz) — good for mixed content
            try:
                import fitz
                doc = fitz.open(file_path)
                if page_num <= len(doc):
                    page = doc.load_page(page_num - 1)
                    pix = page.get_pixmap(matrix=fitz.Matrix(200/72, 200/72))
                    pix.save(output_path)
                doc.close()
                if os.path.exists(output_path):
                    return (output_path, "fitz")
            except: pass
            # 3: Pillow — only works for image-based PDFs
            try:
                pimg = PIL_IMG.open(file_path)
                if hasattr(pimg, 'n_frames') and page_num <= pimg.n_frames:
                    pimg.seek(page_num - 1)
                    pimg.save(output_path)
                    if os.path.exists(output_path):
                        return (output_path, "pillow")
            except: pass
            return (None, "no_renderer")

        # Determine page count without Pillow if possible
        try:
            import fitz
            doc_try = fitz.open(file_path)
            total_frames = len(doc_try)
            doc_try.close()
        except:
            try:
                pimg = PIL_IMG.open(file_path)
                total_frames = pimg.n_frames if hasattr(pimg, 'n_frames') else 1
            except:
                total_frames = max_pages

        total_frames = min(total_frames, max_pages)
        scanned_pages = []

        for pi in range(total_frames):
            page_info = {"page": pi+1, "scanned": True}

            # Render page as PNG for image analysis pipeline
            render_dir = tempfile.mkdtemp(prefix="cad_pdf_render_")
            render_path = os.path.join(render_dir, f"page_{pi+1}.png")
            try:
                render_result, renderer = render_pdf_page(file_path, pi+1, render_path)
                if render_result:
                    pi_img = PIL_IMG.open(render_result)
                page_info["renderer"] = renderer
                pw, ph = pi_img.size
                from PIL import ImageFilter, ImageStat
                pi_gray = pi_img.convert("L")
                pi_edges = pi_gray.filter(ImageFilter.FIND_EDGES)
                es = ImageStat.Stat(pi_edges)
                edge_density = round(es.mean[0]/255.0, 4) if es.mean else 0

                # Component detection
                ep = pi_edges.load()
                w, h = pw, ph
                v = [[False]*w for _ in range(h)]
                comps = []
                for y in range(0, h, 2):
                    for x in range(0, w, 2):
                        if not v[y][x] and ep[x,y] > 64:
                            st, px = [(x,y)], []
                            while st and len(px) < 3000:
                                cx, cy = st.pop()
                                if cx<0 or cx>=w or cy<0 or cy>=h or v[cy][cx] or ep[cx,cy]<=64: continue
                                v[cy][cx] = True; px.append((cx,cy))
                                for dx,dy in [(1,0),(-1,0),(0,1),(0,-1)]: st.append((cx+dx, cy+dy))
                            if len(px)>15:
                                xs=[p[0] for p in px]; ys=[p[1] for p in px]
                                cw=1+max(xs)-min(xs); ch=1+max(ys)-min(ys)
                                comps.append({"box":[min(xs),min(ys),max(xs),max(ys)],"w":cw,"h":ch,"ar":round(cw/max(ch,1),2)})
                rects = sum(1 for c in comps if 0.5 < c["ar"] < 3.0 and c["w"]*c["h"]>500)
                hlines = sum(1 for y in range(0, h, max(1, h//50)) if sum(1 for x in range(0, w, 5) if ep[x,y]>128)>w*0.3)
                vlines = sum(1 for x in range(0, w, max(1, w//50)) if sum(1 for y in range(0, h, 5) if ep[x,y]>128)>h*0.3)

                page_info["image_analysis"] = {
                    "width_px": pw, "height_px": ph,
                    "edge_density": edge_density, "components": len(comps),
                    "rects": rects, "horiz_lines": hlines, "vert_lines": vlines,
                    "structured": hlines > 2 and vlines > 2,
                    "renderer": renderer,
                    "render_path": render_path,
                }

                # OCR on rendered page
                tess_path = "/opt/homebrew/bin/tesseract"
                if os.path.exists(tess_path):
                    try:
                        proc = subprocess.run(
                            [tess_path, render_path, "stdout", "--psm", "6", "-c", "tessedit_char_whitelist=0123456789.,xX-mmc"],
                            capture_output=True, text=True, timeout=10
                        )
                        ocr_text = proc.stdout.strip()
                        if ocr_text:
                            ocr_nums = re.findall(r'(\\d+\\.?\\d*)', ocr_text)
                            page_info["ocr_text"] = ocr_text[:200]
                            page_info["ocr_numbers"] = ocr_nums[:10]
                    except: pass
            except Exception as render_err:
                page_info["render_error"] = str(render_err)[:100]
            finally:
                try: shutil.rmtree(render_dir)
                except: pass

            scanned_pages.append(page_info)

        # Merge with existing pages, enrich with image analysis
        seen_pages = set()
        for p in scanned_pages:
            if p["page"] not in seen_pages:
                found = False
                for ep in pages_text:
                    if ep["page"] == p["page"]:
                        ep["scanned"] = True
                        if "image_analysis" in p: ep["image_analysis"] = p["image_analysis"]
                        if "ocr_text" in p: ep["ocr_text"] = p["ocr_text"]
                        found = True
                        break
                if not found:
                    pa = {k: p[k] for k in ["image_analysis","ocr_text","ocr_numbers"] if k in p}
                    pages_text.append({"page": p["page"], "text": "", "char_count": 0, "scanned": True, "scanned_only": True, **pa})
                seen_pages.add(p["page"])

        result["scanned_pages"] = len(scanned_pages)
        result["scanned_pages_with_img"] = sum(1 for sp in scanned_pages if "image_analysis" in sp)

        # Extract dimension hints from OCR numbers across scanned pages
        dim_hints_from_images = []
        for sp in scanned_pages:
            nums = sp.get("ocr_numbers", [])
            if len(nums) >= 3:
                dim_hints_from_images.append({"page": sp["page"], "text": "x".join(nums[:3]), "values": [round(float(n)) for n in nums[:3]], "source": "ocr"})
            elif len(nums) >= 2:
                dim_hints_from_images.append({"page": sp["page"], "text": "x".join(nums[:2]), "values": [round(float(n)) for n in nums[:2]], "source": "ocr"})
        if dim_hints_from_images:
            result["image_dimension_hints"] = dim_hints_from_images

    except Exception as inner_e:
        result["scanned_pdf_error"] = str(inner_e)[:200]

# ── DOCX: paragraph + table extraction ─────────────────────
elif ext == ".docx":
    try:
        import docx
        doc = docx.Document(file_path)

        page_num = 1
        paragraphs = []

        for para in doc.paragraphs:
            text = para.text.strip()
            if text:
                style = para.style.name if para.style else "Normal"
                is_heading = style and "heading" in style.lower() or "Heading" in style
                paragraphs.append({
                    "page": page_num, "text": text, "style": style,
                    "type": "heading" if is_heading else "paragraph",
                })
                if "PAGE BREAK" in text.upper() or "----" in text:
                    page_num += 1
                if page_num > max_pages:
                    break

        from collections import defaultdict
        page_groups = defaultdict(list)
        style_groups = defaultdict(list)

        for p in paragraphs:
            page_groups[p["page"]].append(p["text"])
            style_groups[p["style"]].append(p["text"])

        for pg in sorted(page_groups.keys()):
            if pg > max_pages:
                break
            joined = " ".join(page_groups[pg])
            pages_text.append({"page": pg, "text": joined, "char_count": len(joined)})

        # DOCX native table extraction
        for i, table in enumerate(doc.tables):
            rows = []
            for row in table.rows:
                cells = [cell.text.strip() for cell in row.cells]
                rows.append(cells)
            if rows:
                tables_data.append({
                    "source_page": "document",
                    "rows": len(rows),
                    "cols": len(rows[0]) if rows else 0,
                    "headers": rows[0] if len(rows) > 1 else [],
                    "data": rows[1:] if len(rows) > 1 else rows,
                    "type": "docx_table",
                })

    except Exception as e:
        result["error"] = f"DOCX reading failed: {str(e)[:200]}"

# ── TABLE DETECTION from text ──────────────────────────────
all_text = "\\n".join([p["text"] for p in pages_text])

# Detect pipe-delimited tables
pipe_tables = []
lines = all_text.split("\\n")
current_table = []
for line in lines:
    if "|" in line:
        cells = [c.strip() for c in line.split("|") if c.strip()]
        if len(cells) >= 2:
            current_table.append(cells)
        else:
            if len(current_table) >= 2:
                pipe_tables.append(current_table)
            current_table = []
    else:
        if len(current_table) >= 2:
            pipe_tables.append(current_table)
        current_table = []
if len(current_table) >= 2:
    pipe_tables.append(current_table)

for tbl in pipe_tables:
    tables_data.append({
        "source_page": "text",
        "rows": len(tbl),
        "cols": len(tbl[0]) if tbl else 0,
        "headers": tbl[0] if len(tbl) > 1 else [],
        "data": tbl[1:] if len(tbl) > 1 else tbl,
        "type": "pipe_delimited",
    })

# ── PART INFERENCE from structured text ────────────────────
all_doc_text = all_text

# Pattern 1: "Name: NxNxN unit" or "Name measures NxNxN"
part_patterns = [
    (r'([A-Za-z][A-Za-z\\s-]+?)[:\\s]+?(\\d+)\\s*[×xX]\\s*(\\d+)\\s*[×xX]\\s*(\\d+)\\s*mm', 3),
    (r'([A-Za-z][A-Za-z\\s-]+?)\\s+(?:measures|is|dimensions?|size)\\s+(\\d+)[×xX](\\d+)[×xX](\\d+)\\s*mm', 3),
    (r'([A-Za-z][A-Za-z\\s-]+?)[:\\s]+?(\\d+)\\s*[×xX]\\s*(\\d+)\\s*mm', 2),
    (r'(\\d+)\\s*[×xX]\\s*(\\d+)\\s*[×xX]\\s*(\\d+)\\s*mm\\s*(?:for|of|--|-)\\s*([A-Za-z][A-Za-z\\s-]+)', 3),
]

pnum = 0
for pattern, dim_count in part_patterns:
    for m in re.finditer(pattern, all_doc_text, re.IGNORECASE):
        groups = m.groups()
        # Determine name and dimensions
        if dim_count == 3:
            if len(groups) >= 4:
                name = groups[0].strip()
                values = [int(groups[1]), int(groups[2]), int(groups[3])]
            elif len(groups) == 4:
                name = groups[3].strip()
                values = [int(groups[0]), int(groups[1]), int(groups[2])]
            else:
                continue
        else:
            name = groups[0].strip()
            values = [int(groups[1]), int(groups[2])]

        # Clean up name
        name = re.sub(r'\\s+', ' ', name).strip()
        # Skip noise
        if len(name) < 2 or name.lower() in ["the", "this", "each"]:
            continue

        pnum += 1
        part_entry = {
            "name": normalize_part_name(name),
            "suggested_type": "hollow_container",
            "dimensions": values,
            "dim_count": dim_count,
            "confidence": "medium" if dim_count == 3 else "low",
            "_uncertain": ["height"] if dim_count == 2 else [],
            "matched_pattern": pattern,
            "matched_text": m.group(0),
        }

        # Check if we can map to a known type
        name_lower = name.lower()
        if "tray" in name_lower or "base" in name_lower:
            part_entry["suggested_type"] = "solid_block" if dim_count == 2 else "hollow_container"
        if "wall" in name_lower or "thickness" in name_lower:
            part_entry["suggested_type"] = "wall_thickness"
        if "fillet" in name_lower or "radius" in name_lower:
            part_entry["suggested_type"] = "fillet"
        if "base" in name_lower or "plate" in name_lower:
            part_entry["suggested_type"] = "solid_block"

        draft_parts.append(part_entry)

# Pattern 2: Tables with dimension columns (header contains dim keywords)
for tbl in tables_data:
    if tbl["type"] == "docx_table" and len(tbl["headers"]) >= 2:
        header_joined = " ".join(tbl["headers"]).lower()
        has_dim_cols = any(k in header_joined for k in ["mm", "size", "dim", "width", "height", "depth", "length"])
        # Also check for standalone W/H with context
        header_tokens = {h.lower().strip() for h in tbl["headers"]}
        has_w = "w" in header_tokens
        has_h = "h" in header_tokens
        if not has_dim_cols and has_w and has_h:
            has_dim_cols = True  # W and H together definitely mean dimensions
        if has_dim_cols:
            for row_data in tbl["data"]:
                # Look for a name column and a dimension column
                name_col = None
                dim_values = []
                qty_val = None
                mat_val = None
                notes_val = None
                for ci, h in enumerate(tbl["headers"]):
                    h_lower = h.lower().strip()
                    # Name column detection
                    if any(k in h_lower for k in ["name", "part", "item", "component", "bin", "tray"]):
                        name_col = ci
                    # Dimension column detection with W/H/L/D disambiguation
                    is_dim_col = False
                    # Full-word dimension keywords always match
                    if any(k in h_lower for k in ["dim", "size", "mm", "dimensions", "width", "height", "depth", "length"]):
                        is_dim_col = True
                    else:
                        # Single-letter dimension headers need context
                        h_exact = h_lower.strip()
                        all_headers_lower = [x.lower().strip() for x in tbl["headers"]]
                        has_width_ref = "width" in all_headers_lower or "w" in all_headers_lower
                        has_height_ref = "height" in all_headers_lower or "h" in all_headers_lower
                        has_other_dim = any(k in " ".join(all_headers_lower) for k in ["dim", "size", "mm", "dimensions", "depth", "length"])
                        if h_exact == "w" and has_height_ref:
                            is_dim_col = True  # W means width when H also present
                        elif h_exact == "h" and has_width_ref:
                            is_dim_col = True  # H means height when W also present
                        elif h_exact in ("l", "len") and has_other_dim:
                            is_dim_col = True  # L/LEN means length with other dims present
                        elif h_exact == "d" and has_other_dim:
                            is_dim_col = True  # D means depth with other dims present
                    if is_dim_col:
                        if ci < len(row_data):
                            dv = re.findall(r'(\\d+)', row_data[ci])
                            if dv:
                                dim_values = [int(x) for x in dv]
                    if any(k in h_lower for k in ["qty", "quantity", "count", "#", "num"]):
                        if ci < len(row_data):
                            try: qty_val = int(re.search(r'(\\d+)', row_data[ci]).group(1))
                            except: pass
                    if any(k in h_lower for k in ["material", "mat", "plastic", "filament"]):
                        if ci < len(row_data): mat_val = row_data[ci].strip()
                    if any(k in h_lower for k in ["note", "comment", "remark", "desc"]):
                        if ci < len(row_data): notes_val = row_data[ci].strip()
                if name_col is not None and len(dim_values) >= 1 and name_col < len(row_data):
                    pnum += 1
                    entry = {
                        "name": normalize_part_name(row_data[name_col].strip()),
                        "suggested_type": "hollow_container",
                        "dimensions": dim_values,
                        "dim_count": len(dim_values),
                        "confidence": "medium" if len(dim_values) >= 2 else "low",
                        "_uncertain": [],
                        "source": "table",
                        "matched_text": str(row_data),
                    }
                    # Single-column dimension recovery: mark missing dims as uncertain
                    if len(dim_values) == 1:
                        entry["_uncertain"].append("height")
                        entry["_uncertain"].append("length")
                        entry["_uncertain"].append("outer")
                    elif len(dim_values) == 2:
                        entry["_uncertain"].append("height")
                    if qty_val: entry["quantity"] = qty_val
                    if mat_val: entry["material"] = mat_val
                    if notes_val: entry["notes"] = notes_val
                    draft_parts.append(entry)

result["draft_parts"] = draft_parts[:12]  # cap at 12 parts
result["tables"] = tables_data

# ── Auto-convert draft parts to cad_ingest-ready spec entries ──
spec_ready_parts = []
seen_names = set()
for dp in draft_parts:
    clean_name = dp["name"].replace(" ", "").replace("-","_").replace("/","_")
    if not clean_name: continue
    if clean_name.lower() in seen_names: continue
    seen_names.add(clean_name.lower())
    dims = dp.get("dimensions", [])
    srp = {
        "name": clean_name,
        "type": dp.get("suggested_type", "hollow_container"),
        "outer": dims[:3] if len(dims) >= 3 else dims + [50] if len(dims) == 2 else [60, 60, 100],
        "_source": "auto_extract",
        "_uncertain": dp.get("_uncertain", []),
        "_confidence": dp.get("confidence", "low"),
    }
    # Add wall thickness default
    if srp["type"] == "hollow_container":
        srp["wall"] = 3
        if "outer" not in dp.get("_uncertain", []):
            pass  # 3mm is a safe default
    # Add position (unknown, will need model placement)
    srp["position"] = None
    # Preserve table extra fields
    if "quantity" in dp: srp["_qty"] = dp["quantity"]
    if "material" in dp: srp["_material"] = dp["material"]
    if "notes" in dp: srp["_notes"] = dp["notes"]
    spec_ready_parts.append(srp)

result["spec_ready_parts"] = spec_ready_parts[:12]

# ── Run advanced image analysis pipeline (if available) ──
if not is_document_mode and _cia_available:
    try:
        advanced = cia.run_full_analysis(image_path, known_scale)
        # Merge advanced fields, preserving existing values as defaults
        for key in ["containment", "function_roles", "nested_components", "connectors",
                     "arrowheads", "scale", "_3d_estimates", "_method",
                     "_template_scores", "_evidence"]:
            if key in advanced:
                result[key] = advanced[key]
        # Merge component_graph_edges into existing component_graph
        if advanced.get("component_graph_edges"):
            if "component_graph" not in result:
                result["component_graph"] = {"nodes": [], "edges": []}
            result["component_graph"]["edges"] = advanced["component_graph_edges"]
        # Upgrade dimension_inferences with detected lines
        if advanced.get("dimension_inferences"):
            for di in advanced["dimension_inferences"]:
                if di not in result.get("dimension_inferences", []):
                    result.setdefault("dimension_inferences", []).append(di)
            result.setdefault("dimension_inferences", result.get("dimension_inferences", []))
            result["_dimension_detection"] = "cia_pipeline"
    except Exception as e:
        result["_cia_error"] = str(e)

# Build final result
result["pages"] = pages_text
result["page_count"] = len(pages_text)
result["total_text"] = "\\n\\n".join([p["text"] for p in pages_text])
all_text_for_count = " ".join([p["text"] for p in pages_text])
result["word_count"] = len(all_text_for_count.split())

# Dimension hints
dim_pattern = re.compile(r'(\\d+)\\s*[×xX]\\s*(\\d+)(?:\\s*[×xX]\\s*(\\d+))?')
for match in dim_pattern.finditer(all_doc_text):
    dim = {"text": match.group(0)}
    dim["values"] = [int(match.group(1)), int(match.group(2))]
    if match.group(3):
        dim["values"].append(int(match.group(3)))
    result["dimension_hints"].append(dim)

# Measurement phrases
for phrase in ["mm", "cm", "inch", "meter", "cm", "mm", "centimeter", "millimeter", "diameter", "radius"]:
    for m in re.finditer(r'(\\d+\\.?\\d*)\\s*' + re.escape(phrase), all_doc_text, re.IGNORECASE):
        measurement_phrases.append({"value": m.group(0), "unit": phrase})
result["measurement_phrases"] = measurement_phrases[:20]

print(json.dumps(result))
`;
          writeFileSync(pyScript, pyCode);

          try {
            const rawOut = execSync(`python3 "${pyScript}" "${args.image_path || args.file_path || ""}"${knownScale ? ` "${knownScale}"` : ""}`, { timeout: 30000, encoding: "utf-8" });
            const result = JSON.parse(rawOut.trim());

            const sourceExt = (args.image_path || args.file_path || "").split(".").pop().toLowerCase();
            let out = `## Analysis: ${basename(args.image_path || args.file_path || "(input)")}\n\n`;
            if (result.error) {
              out += `**Error:** ${result.error}\n\n`;
              out += "Try using `look_at` or a text editor to read the document contents directly.\n";
              return out;
            }

            out += `**Type:** ${sourceExt === "pdf" ? "PDF" : sourceExt === "docx" ? "DOCX" : "Image"}\n`;
            out += `**Pages extracted:** ${result.page_count}\n`;
            out += `**Total text:** ${result.word_count} words\n`;

            // ── Shape analysis for images ──
            if (result.shape) {
              out += `\n### Shape Analysis\n`;
              out += `- **Classification:** ${result.shape.classification}\n`;
              out += `- **Bounding box:** ${result.shape.bounding_box_px?.[0] || "?"}×${result.shape.bounding_box_px?.[1] || "?"} px\n`;
              out += `- **Metrics:** circularity=${result.shape.circularity}, rectangularity=${result.shape.rectangularity}, aspect_ratio=${result.shape.aspect_ratio}\n`;
              if (result.shape.symmetry_h !== undefined) {
                out += `- **Symmetry:** H=${result.shape.symmetry_h}, V=${result.shape.symmetry_v}\n`;
              }
              if (result.shape.multi_part) {
                out += `- **Multi-part:** ${result.shape.components_separated} components detected\n`;
                if (result.shape.parts) {
                  out += "- **Components:**\n";
                  for (const s of result.shape.parts.slice(0, 10)) {
                    out += `  - ${s.class} ${s.w_px}×${s.h_px}px @ (${s.cx},${s.cy})\n`;
                  }
                }
              }
              // Component graph
              if (result.component_graph) {
                out += `\n#### Component Graph (${result.component_graph.nodes.length} relationships)\n`;
                for (const n of result.component_graph.nodes) {
                  out += `- **${n.id}** (${n.shape_class}): role="${n.role}", ${n.w_px}×${n.h_px}px @ (${n.cx},${n.cy})\n`;
                }
                if (result.component_graph.suggested_assembly) {
                  out += `\n**Suggested Assembly:** base=<code>${result.component_graph.suggested_assembly.base_part_id}</code>\n`;
                  for (const rp of result.component_graph.suggested_assembly.relative_parts) {
                    out += `- ${rp.part_id} positioned **${rp.position}** as ${rp.role}\n`;
                  }
                }
              }
            }
            // Dimension inferences
            if (result.dimension_inferences && result.dimension_inferences.length > 0) {
              out += `\n### Dimension Inferences (${result.dimension_inferences.length})\n`;
              for (const d of result.dimension_inferences) {
                const mmStr = d.estimated_mm ? ` (~${d.estimated_mm}mm)` : d.length_mm_estimate ? ` (~${d.length_mm_estimate}mm)` : "";
                const labelStr = d.label_value ? ` label="${d.label_value}"` : "";
                const matchStr = d.matches_bbox_width || d.matches_bbox_height ? " [matches bbox]" : "";
                out += `- ${d.type} ${d.span_px || d.length_px || "?"}px${mmStr}${labelStr}${matchStr}`;
                if (d.associated_components?.length) out += ` [${d.associated_components.join(",")}]`;
                out += "\n";
              }
            }

            // Container hierarchy
            if (result.containment && result.containment.length > 0) {
              out += `\n### Containment Hierarchy (${result.containment.length})\n`;
              for (const c of result.containment) {
                out += `- ${c.container_id} → ${c.contained_id} (margin=${c.margin_px}px, confidence=${c.confidence})\n`;
              }
            }

            // Functional roles
            if (result.function_roles) {
              out += `\n### Functional Roles\n`;
              for (const [key, r] of Object.entries(result.function_roles)) {
                out += `- **${key}**: role="${r.role}", confidence=${r.confidence}\n`;
              }
            }

            // Connectors
            if (result.connectors && result.connectors.length > 0) {
              out += `\n### Connectors (${result.connectors.length})\n`;
              for (const c of result.connectors) {
                out += `- ${c.from} ↔ ${c.to}: ${c.type} (confidence=${c.confidence})\n`;
              }
            }

            // Scale reference
            if (result.scale) {
              out += `\n### Scale Reference\n`;
              out += `- Method: ${result.scale.method} (confidence=${result.scale.confidence})\n`;
              if (result.scale.scale_px_per_mm) out += `- Scale: ${result.scale.scale_px_per_mm} px/mm\n`;
              if (result.scale.tick_count) out += `- Ticks found: ${result.scale.tick_count}\n`;
            }

            // 3D estimates
            if (result._3d_estimates && result._3d_estimates.length > 0) {
              out += `\n### 3D Estimates (${result._3d_estimates.length} parts)\n`;
              for (const p3 of result._3d_estimates) {
                out += `- ${p3.name || "part"}: ${p3.w_px}×${p3.d_px}×${p3.h_px} px`;
                if (p3._width_mm) out += ` (${p3._width_mm}×${p3._depth || "?"}×${p3._height_mm || "?"} mm)`;
                if (p3._uncertain?.length) out += ` uncertain: [${p3._uncertain.join(",")}]`;
                out += "\n";
              }
            }

            // Analysis method
            if (result._method) {
              out += `\n- **Detection method:** ${result._method}\n`;
            }

            // Evidence report (from cad_image_analysis)
            if (result._evidence) {
              out += `\n### Evidence Report\n`;
              // Signals used
              out += `**Signals used:** ${result._evidence.signals_used.length}\n`;
              for (const s of result._evidence.signals_used) {
                out += `- ${s.signal}: \`${JSON.stringify(s.value)}\` (source: ${s.source})\n`;
              }
              // Signals ignored
              out += `**Signals explicitly ignored:** ${result._evidence.signals_ignored.length}\n`;
              for (const s of result._evidence.signals_ignored) {
                out += `- \`${s.signal}\` = "${s.value}" — ${s.reason}\n`;
              }
            }

            // Template scores
            if (result._template_scores) {
              const ts = result._template_scores;
              out += `**Template scores** (evidence-based, no metadata used):\n`;
              for (const s of ts.scores) {
                out += `- ${s.template}: **${s.score}** — ${s.reason}\n`;
              }
              out += `> Winner: **${ts.winner}** (score=${ts.winner_score}) — ${ts.winner_reason}\n`;
              if (ts.guards_triggered && ts.guards_triggered.length > 0) {
                out += `> Topology guards triggered: ${ts.guards_triggered.join(", ")}\n`;
              }
            }

            if (result.dimension_hints.length > 0) {
              out += `\n### Dimension Hints (${result.dimension_hints.length})\n`;
              for (const h of result.dimension_hints.slice(0, 10)) {
                out += `- \`${h.text}\` → [${h.values.join(", ")}]`;
                if (h.values.length === 3) out += " (3D dimension candidate)";
                out += "\n";
              }
            }

            if (result.measurement_phrases.length > 0) {
              out += `\n### Measurement References (${result.measurement_phrases.length})\n`;
              for (const m of result.measurement_phrases.slice(0, 10)) {
                out += `- \`${m.value}\`\n`;
              }
            }

            if (result.tables && result.tables.length > 0) {
              out += `\n### Tables Detected (${result.tables.length})\n`;
              for (const tbl of result.tables.slice(0, 5)) {
                const headerStr = tbl.headers ? tbl.headers.join(" | ") : "—";
                out += `- ${tbl.type} (${tbl.rows} rows × ${tbl.cols} cols): \`${headerStr.slice(0, 80)}\`\n`;
              }
            }

            if (result.draft_parts && result.draft_parts.length > 0) {
              out += `\n### Auto-Extracted Parts (${result.draft_parts.length})\n`;
              for (const p of result.draft_parts) {
                const dimStr = p.dimensions.join("×");
                out += `- \`${p.name}\` ${dimStr}mm (${p.suggested_type}, ${p.confidence})`;
                if (p._uncertain.length > 0) out += ` _uncertain: [${p._uncertain.join(", ")}]`;
                if (p.quantity) out += ` qty:${p.quantity}`;
                if (p.material) out += ` mat:${p.material}`;
                out += `\n`;
              }
              out += "\n> Edit and pass these to `cad_merge` with `_uncertain` markers as needed.\n";
            }

            if (result.spec_ready_parts && result.spec_ready_parts.length > 0) {
              out += `\n### Spec-Ready Parts (${result.spec_ready_parts.length})\n`;
              out += "These entries are ready for `cad_ingest`:\n\n";
              for (const srp of result.spec_ready_parts) {
                const outerStr = srp.outer.join("×");
                out += `- \`${srp.name}\`: ${srp.type} ${outerStr}mm`;
                if (srp._uncertain && srp._uncertain.length > 0) out += ` _uncertain:[${srp._uncertain.join(",")}]`;
                if (srp._qty) out += ` qty:${srp._qty}`;
                if (srp._material) out += ` mat:${srp._material}`;
                if (srp._notes) out += ` notes:${srp._notes}`;
                out += `\n`;
              }
              out += `\n> Pass to \`cad_ingest\` with \`auto_compile=true\` for direct spec → YAML → compile.\n`;
            }

            if (result.scanned_pages) {
              out += `\n### Scanned PDF — auto-rendered pages\n`;
              out += `${result.scanned_pages} page(s) image-based. ${result.scanned_pages_with_img || 0} analyzed via image pipeline.\n`;
              out += "\n| Page | Size | Renderer | Edge | Comps | Rect | Lines (H/V) | OCR Numbers |\n";
              out += "|------|------|----------|------|-------|------|-------------|-------------|\n";
              for (const p of result.pages) {
                if (p.scanned || p.scanned_only) {
                  const ia = p.image_analysis || {};
                  const sz = ia.width_px ? `${ia.width_px}×${ia.height_px}` : "—";
                  const ocrNums = p.ocr_numbers ? p.ocr_numbers.join(", ") : "—";
                  const renderer = ia.renderer || "—";
                  out += `| Page ${p.page} | ${sz} | ${renderer} | ${ia.edge_density ?? "—"} | ${ia.components ?? "—"} | ${ia.rects ?? "—"} | ${ia.horiz_lines ?? "—"}/${ia.vert_lines ?? "—"} | ${ocrNums.slice(0, 40)} |\n`;
                }
              }
              if (result.image_dimension_hints) {
                out += "\n**Dimension hints from OCR**\n";
                for (const dh of result.image_dimension_hints) {
                  out += `- Page ${dh.page}: \`${dh.text}\` → [${dh.values.join(", ")}] (OCR)\n`;
                }
              }
              out += "\n";
            }

            out += `\n### Pages\n`;
            for (const p of result.pages) {
              const excerpt = p.text.slice(0, 300) + (p.text.length > 300 ? "..." : "");
              if (p.scanned_only) {
                out += `\n**Page ${p.page}** — \`[image-based, no extractable text]\`\n`;
              } else {
                out += `\n**Page ${p.page}** (${p.char_count} chars)${p.scanned ? " — scanned/image page" : ""}\n\`\`\`\n${excerpt}\n\`\`\`\n`;
              }
            }

            out += `\n### Source Reference\n`;
            const fp = args.image_path || args.file_path || "input";
            out += `File: \`${basename(fp)}\`, Pages: 1-${result.page_count}\n`;
            out += `Use \`cad_merge\` with \`source: "${basename(fp)}"\` and extracted part data.\n`;

            // Auto-feed spec-ready parts into cad_ingest
            if (args.auto_ingest && result.spec_ready_parts && result.spec_ready_parts.length > 0) {
              const state = findProject(ctx.directory);
              if (state) {
                try {
                  const ingestResult = await runIngestCore({
                    project_name: state.name,
                    parts: result.spec_ready_parts.map(srp => ({
                      name: srp.name,
                      type: srp.type,
                      outer: srp.outer,
                      wall: srp.wall || 3,
                      _uncertain: srp._uncertain || [],
                    })),
                    assembly: Object.fromEntries(result.spec_ready_parts.map((srp, i) => [
                      `${srp.name}#1`, null
                    ])),
                    output: { per_part: true, combined: true },
                    auto_compile: true,
                  }, ctx);
                  out += `\n### Auto-Ingest (auto_ingest=true)\n\n`;
                  // Show full output if failure detected, else first 600 chars
                  const isFailure = ingestResult.includes("Failed") || ingestResult.includes("error") || ingestResult.includes("⚠️");
                  const ingestSummary = isFailure ? ingestResult : ingestResult.slice(0, 600);
                  out += `\`\`\`\n${ingestSummary}\n\`\`\`\n`;
                  if (isFailure) {
                    out += "\n> Auto-ingest completed with issues. The compile pipeline attempted auto-fix/retry.\n";
                    out += "> Review the spec-ready parts above and manually run `cad_ingest` or `cad_revise`.\n";
                  }
                } catch (ingestErr) {
                  out += `\n**Auto-ingest failed:** ${ingestErr.message.slice(0, 200)}\n`;
                  out += "Retry path: The compile pipeline would have attempted auto-fix if it reached FreeCAD.\n";
                  out += "To retry manually: `cad_revise` the spec, then `cad_compile`\n";
                }
              } else {
                out += "\n**Auto-ingest skipped:** No active project. Run `cad_init` first, then set `auto_ingest=true`.\n";
              }
            }

            return out;
          } catch (e) {
            return `Document extraction failed: ${e.message.slice(0, 200)}`;
          } finally {
            try { execSync(`rm -f "${pyScript}"`, { timeout: 3000 }); } catch {}
          }
        },
      }),

      cad_ingest_images: tool({
        description: "Batch-analyze a directory of images and merge structural data into a single draft spec with source references.",
        args: {
          directory: tool.schema.string().describe("Directory containing image files (PNG, JPG, JPEG, WEBP, BMP)."),
          known_scale: tool.schema.number().optional().describe("Pixel-to-mm ratio if all images share the same scale."),
          max_images: tool.schema.number().optional().describe("Maximum images to process (default: 10)."),
          auto_ingest: tool.schema.boolean().optional().describe("Auto-ingest spec-ready parts when extraction is clearly ready (default: false). Requires existing project."),
        },
        async execute(args, ctx) {
          const scanDir = args.directory;
          if (!existsSync(scanDir)) return "Directory not found: " + scanDir;
          if (!statSync(scanDir).isDirectory()) return "Not a directory: " + scanDir;

          const imageExt = /\.(png|jpg|jpeg|gif|webp|bmp)$/i;
          const allFiles = readdirSync(scanDir, { withFileTypes: true })
            .filter(e => e.isFile() && imageExt.test(e.name))
            .map(e => join(scanDir, e.name))
            .sort();
          if (allFiles.length === 0) return "No image files found in " + scanDir;

          const maxImages = args.max_images || 10;
          const toProcess = allFiles.slice(0, maxImages);
          const results = [];
          const draftParts = [];

          for (const fp of toProcess) {
            const imageName = basename(fp);
            try {
              const pyScript = "/tmp/cad_batch_img_" + Date.now() + ".py";
              const escaped = fp.replace(/"/g, '\\"');
              const pyCode = [
                'import sys,json,math',
                'from PIL import Image,ImageFilter,ImageStat',
                'fp="' + escaped + '"',
                'img=Image.open(fp); w,h=img.size',
                'gray=img.convert("L"); edges=gray.filter(ImageFilter.FIND_EDGES)',
                'es=ImageStat.Stat(edges); ed=round(es.mean[0]/255.0,4) if es.mean else 0',
                'edge=edges.load(); v=[[False]*w for _ in range(h)]',
                'def ff(sx,sy):',
                '  st=[(sx,sy)]; px=[]',
                '  while st and len(px)<5000:',
                '    x,y=st.pop()',
                '    if x<0 or x>=w or y<0 or y>=h or v[y][x] or edge[x,y]<=64: continue',
                '    v[y][x]=True; px.append((x,y))',
                '    for dx,dy in [(1,0),(-1,0),(0,1),(0,-1)]: st.append((x+dx,y+dy))',
                '  return px',
                'rc=0; comps=[]',
                'for y in range(0,h,2):',
                '  for x in range(0,w,2):',
                '    if not v[y][x] and edge[x,y]>64:',
                '      p=ff(x,y)',
                '      if len(p)>15:',
                '        xs=[px[0] for px in p]; ys=[px[1] for px in p]',
                '        bx,by,bx2,by2=min(xs),min(ys),max(xs),max(ys)',
                '        cw,ch=bx2-bx,by2-by; area=cw*ch; asp=max(cw,ch)/max(min(cw,ch),1) if ch>0 else 1',
                '        comps.append({"bbox":[bx,by,bx2,by2],"size":[cw,ch],"count":len(p)})',
                '        if area>500 and asp<3.0: rc+=1',
                'hlines=sum(1 for y in range(0,h,max(1,h//50)) if sum(1 for x in range(0,w,2) if edge[x,y]>128)>w*0.3)',
                'vlines=sum(1 for x in range(0,w,max(1,w//50)) if sum(1 for y in range(0,h,2) if edge[x,y]>128)>h*0.3)',
                '# Shape classification',
                'def ing_cls(comps, w, h, edge):',
                '  mp=[[False]*w for _ in range(h)]',
                '  for c in comps:',
                '    bx,by,bx2,by2=c["bbox"]',
                '    if c["count"]>20:',
                '      for yy in range(max(0,by),min(h,by2+1)):',
                '        for xx in range(max(0,bx),min(w,bx2+1)):',
                '          if edge[xx,yy]>64: mp[yy][xx]=True',
                '  st_pt=None',
                '  for yy in range(0,h,3):',
                '    for xx in range(0,w,3):',
                '      if mp[yy][xx]:',
                '        for dx,dy in [(1,0),(-1,0),(0,1),(0,-1)]:',
                '          nx,ny=xx+dx,yy+dy',
                '          if nx<0 or nx>=w or ny<0 or ny>=h or not mp[ny][nx]: st_pt=(xx,yy); break',
                '        if st_pt: break',
                '    if st_pt: break',
                '  if not st_pt: return {"class":"unclear"}',
                '  cont=[]; vc=set(); cu=st_pt; pd=7; dirs=[(1,0),(1,1),(0,1),(-1,1),(-1,0),(-1,-1),(0,-1),(1,-1)]',
                '  for _ in range(20000):',
                '    if cu in vc: break',
                '    vc.add(cu); cont.append(cu); fnd=False',
                '    for i in range(8):',
                '      d=(pd+1+i)%8; nx,ny=cu[0]+dirs[d][0],cu[1]+dirs[d][1]',
                '      if 0<=nx<w and 0<=ny<h and mp[ny][nx]: cu=(nx,ny); pd=(d+4)%8; fnd=True; break',
                '    if not fnd: break',
                '  if len(cont)<15: return {"class":"unclear"}',
                '  def simp(pts,eps):',
                '    if len(pts)<=2: return pts',
                '    dm,idx=0,0; x1,y1=pts[0]; x2,y2=pts[-1]',
                '    for i in range(1,len(pts)):',
                '      xi,yi=pts[i]; den=((x2-x1)**2+(y2-y1)**2)**0.5',
                '      if den==0: d=((xi-x1)**2+(yi-y1)**2)**0.5',
                '      else: d=abs((x2-x1)*(y1-yi)-(x1-xi)*(y2-y1))/den',
                '      if d>dm: dm=d; idx=i',
                '    if dm>eps:',
                '      L=simp(pts[:idx+1],eps); R=simp(pts[idx:],eps); return L[:-1]+R',
                '    return [pts[0],pts[-1]]',
                '  sp=simp(cont,2.0)',
                '  xs2=[p[0] for p in sp]; ys2=[p[1] for p in sp]',
                '  sw2,sh2=max(xs2)-min(xs2),max(ys2)-min(ys2)',
                '  a2=0',
                '  for i in range(len(sp)):',
                '    j=(i+1)%len(sp); a2+=sp[i][0]*sp[j][1]-sp[j][0]*sp[i][1]',
                '  a2=abs(a2)/2.0',
                '  p2=sum(((sp[i][0]-sp[(i+1)%len(sp)][0])**2+(sp[i][1]-sp[(i+1)%len(sp)][1])**2)**0.5 for i in range(len(sp)))',
                '  circ=(4*3.14159*a2)/(p2*p2) if p2>0 else 0',
                '  rect=a2/(sw2*sh2) if sw2*sh2>0 else 0',
                '  ar2=sw2/max(sh2,1)',
                '  cls="unclear"',
                '  if circ>0.70: cls="circular"',
                '  elif rect>0.70 and ar2<1.7: cls="square_like"',
                '  elif rect>0.60 and ar2>=1.7: cls="elongated_rect"',
                '  elif rect>0.50: cls="rectangular"',
                '  elif a2>0: cls="irregular"',
                '  return {"class":cls,"circ":round(circ,3),"rect":round(rect,3),"ar":round(ar2,3),"pts":len(sp)}',
                'shape_cls=ing_cls(comps, w, h, edge)',
                'print(json.dumps({"w":w,"h":h,"ar":round(w/h,3),"edge":ed,"comps":len(comps),"rects":rc,"hlines":hlines,"vlines":vlines,"shape":shape_cls}))',
              ].join("\n");
              writeFileSync(pyScript, pyCode);

              const rawOut = execSync('python3 "' + pyScript + '"', { timeout: 30000, encoding: "utf-8" });
              const a = JSON.parse(rawOut.trim());

              const shapeClass = a.shape && a.shape.class !== "unclear" ? a.shape.class : null;
              const structured = a.hlines > 2 && a.vlines > 2;
              const partName = imageName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
              const uncertain = shapeClass === "circular" ? ["outer", "height"] : ["outer", "size", "type"];
              const inferredType = shapeClass === "circular" ? "cylinder" : "hollow_container";
              draftParts.push({
                name: partName,
                type: inferredType,
                _source_file: imageName,
                _image_ref: imageName,
                _uncertain: uncertain,
                _shape_class: shapeClass,
                _extraction_note: shapeClass ? shapeClass : (structured ? "structured" : "unstructured sketch"),
                _analysis: { edge_density: a.edge, components: a.comps, rects: a.rects, shape: a.shape },
              });
              results.push({ file: imageName, edge: a.edge, comps: a.comps, rects: a.rects, shape: shapeClass, structured });

              try { execSync('rm -f "' + pyScript + '"', { timeout: 3000 }); } catch {}
            } catch (e) {
              results.push({ file: basename(fp), error: e.message.slice(0, 100) });
            }
          }

          let out = "## Batch Image Ingestion: " + scanDir + "\n\n";
          const ok = results.filter(function(r) { return !r.error; });
          out += "**Processed:** " + ok.length + "/" + toProcess.length + "\n";
          out += "\n| Image | Edge | Comps | Rectangles | Shape | Structure |\n";
          out += "|-------|------|-------|------------|-------|-----------|\n";
          for (const r of results) {
            if (r.error) out += "| " + r.file + " | — | — | — | — | ❌ " + r.error.slice(0, 40) + " |\n";
            else out += "| " + r.file + " | " + r.edge + " | " + r.comps + " | " + r.rects + " | " + (r.shape || "—") + " | " + (r.structured ? "structured" : "simple") + " |\n";
          }

          out += "\n### Draft Parts (" + draftParts.length + ")\n\n";
          for (const p of draftParts) {
            out += "- `" + p.name + "` (type: " + p.type + ", shape: " + (p._shape_class || "unclear") + ") — " + p._extraction_note + " — _source: " + p._source_file + "\n";
          }

          out += "\n### Source Traceability\n\n";
          for (const r of ok) {
            out += "- `" + r.file + "`: edge density " + r.edge + ", " + r.comps + " components, " + r.rects + " rectangles";
            if (r.shape) out += ", shape: " + r.shape;
            out += "\n";
          }

          out += "\n### Next steps\n";
          out += "1. `cad_extract_dimensions` on key images for measurements\n";
          out += "2. `cad_merge` with measured data and source references\n";
          out += "3. `cad_ingest` to build YAML spec\n";

          // Auto-ingest if requested and threshold met
          if (args.auto_ingest && draftParts.length > 0) {
            const threshold = checkAutoBuildThreshold(draftParts, "cad_ingest_images");
            out += `\n### Auto-Ingest Check\n\n`;
            out += `**Status:** ${threshold.status}\n`;
            out += `**Reason:** ${threshold.reason}\n\n`;
            if (threshold.ready) {
              const state = findProject(ctx.directory);
              if (state) {
                try {
                  const ingestResult = await runIngestCore({
                    project_name: state.name,
                    parts: threshold.auto_parts,
                    assembly: Object.fromEntries(threshold.auto_parts.map((ap, i) => [`${ap.name}#1`, null])),
                    output: { per_part: true, combined: true },
                    auto_compile: true,
                  }, ctx);
                  out += `**Auto-ingest triggered:**\n\`\`\`\n${ingestResult.slice(0, 400)}\n\`\`\`\n`;
                } catch (ie) {
                  out += `**Auto-ingest failed:** ${ie.message.slice(0, 200)}\n`;
                  out += "The extracted parts remain available as drafts above.\n";
                }
              } else {
                out += "**Auto-ingest skipped:** No active project. Run `cad_init` first.\n";
              }
            } else {
              out += "Not auto-ingesting. Review draft parts and use `cad_merge` + `cad_ingest` manually.\n";
            }
          }

          return out;
        },
      }),
      cad_draft: tool({
        description: "Generate a structured extraction template from source material. Accept file paths and directories. Guides the model on extracting parts, dimensions, and layout from images and documents into a cad_ingest call.",
        args: {
          prompt: tool.schema.string().describe("Describe the design: parts, dimensions, layout, constraints, and what was learned from source files."),
          source_paths: tool.schema.string().optional().describe("Comma-separated paths to source documents/images that were already read by the model."),
          source_dirs: tool.schema.string().optional().describe("Comma-separated directory paths to scan for source files (images, documents, etc.)."),
        },
        async execute(args, ctx) {
          const nameMatch = args.prompt.match(/(?:called|named)\s+['"]?(\w+)['"]?/i) || args.prompt.match(/^(\w+)/m);
          const name = nameMatch ? nameMatch[1].replace(/[^a-zA-Z0-9_-]/g, "_") : "Untitled";
          const hasDimensions = /\d+\s*[×xX*]\s*\d+/.test(args.prompt);
          const hasBase = /base|plate|platform/i.test(args.prompt);
          const hasBins = /bin|container|tray|box|compartment/i.test(args.prompt);
          const hasImages = /screenshot|image|png|jpg|jpeg|photo|picture|diagram|sketch/i.test(args.prompt);
          const hasDocs = /doc|pdf|word|document|criterion|criteria/i.test(args.prompt);

          const extraFiles = [];
          if (args.source_dirs) {
            const dirs = args.source_dirs.split(",").map(s => s.trim());
            for (const d of dirs) {
              if (!existsSync(d)) { extraFiles.push(`[not found: ${d}]`); continue; }
              const stat = statSync(d);
              if (!stat.isDirectory()) { extraFiles.push(`[not a dir: ${d}]`); continue; }
              try {
                const entries = readdirSync(d, { withFileTypes: true });
                for (const e of entries) {
                  if (e.isFile() && /\.(png|jpg|jpeg|gif|webp|bmp|svg|pdf|doc|docx|txt|md|rtf|csv|json|yaml|yml|stl)$/i.test(e.name)) {
                    extraFiles.push(join(d, e.name));
                  }
                }
              } catch {}
            }
          }

          let out = `## Source-to-Spec: ${name}\n\n`;

          const allPaths = [];
          if (args.source_paths) {
            for (const p of args.source_paths.split(",").map(s => s.trim())) {
              allPaths.push(p);
            }
          }
          if (extraFiles.length > 0) {
            for (const p of extraFiles) {
              if (!allPaths.includes(p)) allPaths.push(p);
            }
          }

          if (allPaths.length > 0) {
            out += `**Source files (${allPaths.length}):**\n`;
            for (const p of allPaths) out += `- \`${p}\`\n`;
            out += "\n";

            const exts = allPaths.map(p => { const m = p.match(/\.(\w+)$/); return m ? m[1].toLowerCase() : null; }).filter(Boolean);
            const imageExts = exts.filter(e => ["png","jpg","jpeg","gif","bmp","webp","svg"].includes(e));
            const docExts = exts.filter(e => ["pdf","doc","docx","txt","md","rtf"].includes(e));
            if (imageExts.length > 0) out += `  ${imageExts.length} image file(s) detected — use \`look_at\` to examine\n`;
            if (docExts.length > 0) out += `  ${docExts.length} document(s) detected — use \`read\` to extract text\n`;
            out += "\n";
          }

          out += `### Extraction\n\n`;
          out += "Read each source file and extract the following structured data. Use the appropriate tool per file type:\n\n";
          out += "- **Images/screenshots** → `look_at` for visual dimensions, layout, features\n";
          out += "  - If you can see measurement annotations in the image, extract them directly.\n";
          out += "  - If you must estimate dimensions, add each estimated field to `_uncertain: [...]`.\n";
          out += "  - For ambiguous fit or layout, mark the affected assembly positions with `null`.\n";
          out += "- **Documents/text** → `read` for explicit dimensions, materials, constraints.\n\n";

          out += "**Parts:** name, type (hollow_container | solid_block), outer [W, D, H], wall, top_fillet, features (friction_tab), slots\n";
          out += "**Base:** type (solid_block), size [W, D, H], top_fillet, slots for each bin\n";
          out += "**Assembly:** BasePlate at [0,0,0], each bin instance at [x, y, 0]\n\n";

          if (allPaths.some(p => /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(p))) {
            out += "### Image Extraction Notes\n\n";
            out += "For screenshots/sketches with visible measurements:\n";
            out += '1. Call `look_at` on each image with goal="extract dimensions and layout"\n';
            out += '2. Check for annotation arrows, dimension lines, or labels in the image\n';
            out += '3. For any measurement you estimate instead of read: add `_uncertain: ["field"]` to the part\n';
            out += '4. For ambiguous positions in assembly: use `null` and the system will fill default layout\n\n';
          }

          out += "### Summary\n\n";
          out += `| Feature | Status |\n`;
          out += `|---------|--------|\n`;
          out += `| Parts identified | ${hasBins ? "OK" : "check source"}\n`;
          out += `| Base/plate | ${hasBase ? "OK" : "check source"}\n`;
          out += `| Dimensions | ${hasDimensions ? "OK" : "extract from source"}\n`;
          out += `| Images | ${hasImages || allPaths.some(p => /\.(png|jpg|jpeg|gif|bmp|webp|svg)$/i.test(p)) ? "examine with look_at" : "none"}\n`;
          out += `| Documents | ${hasDocs || allPaths.some(p => /\.(pdf|doc|docx|txt|md|rtf)$/i.test(p)) ? "scan for specs" : "none"}\n`;
          out += `| Source files | ${allPaths.length > 0 ? allPaths.length + " found" : "none specified"}\n\n`;

          out += "### Fill this JSON and call cad_ingest\n\n";
          out += "```json\n";
          out += `{\n`;
          out += `  "project_name": "${name}",\n`;
          out += `  "parts": [\n`;
          out += `    {"name": "PartName", "type": "hollow_container", "outer": [W, D, H], "wall": 3, "top_fillet": 5, "features": [...]}\n`;
          out += `  ],\n`;
          out += `  "assembly": {"PartName#ID": [x, y]},\n`;
          out += `  "source_notes": "extracted from source files"\n`;
          out += `}\n`;
          out += "```\n\n";

          out += "### Call:\n";
          out += "```\n";
          out += `cad_ingest project_name="${name}" parts='[{"name":"PartName",...}]' assembly='{"PartName#ID":[x,y]}' auto_compile=true\n`;
          out += "```\n";

          return out;
        },
      }),

      // ── VALIDATE: Pre-compile spec check ―――――――――――――――――――――――
      cad_validate: tool({
        description: "Validate a YAML CAD spec before compiling. Catches missing fields, mismatched names, and potential geometry issues.",
        args: {
          spec: tool.schema.string().describe("YAML spec content to validate"),
          spec_path: tool.schema.string().optional().describe("Path to a YAML spec file (alternative to inline spec)"),
        },
        async execute(args, ctx) {
          let yamlContent = args.spec;
          if (args.spec_path && existsSync(args.spec_path)) {
            yamlContent = readFileSync(args.spec_path, "utf-8");
          }
          if (!yamlContent) return "No spec provided. Pass `spec` (inline YAML) or `spec_path`.";

          // Naive YAML parse for validation
          const spec = { parts: [], assembly: {} };
          try {
            // Extract parts by scanning YAML structure
            const partBlocks = yamlContent.match(/- name:\s*(\S+)([\s\S]*?)(?=\n\s*- name:|\n\s*assembly:|\n\s*output:|\n\s*$)/g);
            if (partBlocks) {
              for (const block of partBlocks) {
                const n = block.match(/- name:\s*(\S+)/);
                if (!n) continue;
                const part = { name: n[1], geometry: {} };
                const gt = block.match(/type:\s*(\S+)/);
                if (gt) part.geometry.type = gt[1];
                const out = block.match(/outer:\s*\[([\d.,\s]+)\]/);
                if (out) part.geometry.outer = out[1].split(",").map(s => parseFloat(s.trim()));
                const sz = block.match(/size:\s*\[([\d.,\s]+)\]/);
                if (sz) part.geometry.size = sz[1].split(",").map(s => parseFloat(s.trim()));
                const w = block.match(/wall:\s*([\d.]+)/);
                if (w) part.geometry.wall = parseFloat(w[1]);
                const f = block.match(/top_fillet:\s*([\d.]+)/);
                if (f) part.geometry.top_fillet = parseFloat(f[1]);
                // features
                const featBlocks = block.match(/- type:\s*(\S+)([\s\S]*?)(?=\n\s*- type:|\n\s*$)/g);
                if (featBlocks) {
                  part.features = [];
                  for (const fb of featBlocks) {
                    const ft = fb.match(/- type:\s*(\S+)/);
                    if (!ft) continue;
                    const feat = { type: ft[1] };
                    const fsz = fb.match(/size:\s*\[([\d.,\s]+)\]/);
                    if (fsz) feat.size = fsz[1].split(",").map(s => parseFloat(s.trim()));
                    const fat = fb.match(/at:\s*([\[][\d.,\s\]]+|bottom|top)/);
                    if (fat) feat.at = fat[1];
                    const fc = fb.match(/clearance:\s*([\d.]+)/);
                    if (fc) feat.clearance = parseFloat(fc[1]);
                    part.features.push(feat);
                  }
                }
                spec.parts.push(part);
              }
            }

            // Extract assembly
            const assemMatch = yamlContent.match(/assembly:\s*\n([\s\S]*?)(?=\n\s*output:|$)/);
            if (assemMatch) {
              const lines = assemMatch[1].split("\n");
              for (const line of lines) {
                const m = line.match(/^\s*(\S+):\s*\[([\d.,\s-]+)\]/);
                if (m) {
                  spec.assembly[m[1]] = m[2].split(",").map(s => parseFloat(s.trim()));
                }
              }
            }
          } catch {}

          const issues = validateSpec(spec);
          const result = formatValidation(issues);

          if (issues.length === 0) {
            return "## Spec Validation: ✅ PASS\n\n" + result;
          }
          return "## Spec Validation\n\n" + result + "\nFix the errors and re-validate, or run `cad_revise` to edit and re-compile.";
        },
      }),

      // ── COMPILE ―――――――――――――――――――――――――――――――――――――――――――
      cad_compile: tool({
        description: "Compile a YAML CAD spec into 3D geometry via FreeCAD. Creates STL files + FCStd document.",
        args: {
          spec: tool.schema.string().describe("YAML spec content (inline) or path to .yaml file").optional(),
          spec_path: tool.schema.string().optional().describe("Path to YAML spec file (alternative to inline spec)"),
        },
        async execute(args, ctx) {
          let state = findProject(ctx.directory);
          if (!state) return "No CAD project found. Run `cad_init` first.";

          let specPath = args.spec_path;
          if (args.spec && !args.spec_path) {
            specPath = join(state.root, "design.yaml");
            writeFileSync(specPath, args.spec);
          }
          if (!specPath || !existsSync(specPath)) {
            return "Spec not found. Provide `spec` (inline YAML) or `spec_path` (path to .yaml file).";
          }

          let specContent = readFileSync(specPath, "utf-8");
          writeFileSync(specPath, specContent.replace(/output_dir:\s*.+/, `output_dir: "${state.root}"`));

          // Preserve STLs for unchanged parts (incremental compile)
          const specText = readFileSync(specPath, "utf-8");
          const prevRevs = state.revision_history || [];
          const prevCompileSpec = prevRevs.length > 0 ? prevRevs[prevRevs.length - 1].spec_full : null;
          const compileChanges = prevCompileSpec ? detectChanges(prevCompileSpec, specText) : null;
          const stlDir = join(state.root, "STLs");
          let preserveDir = null;
          if (compileChanges && compileChanges.same.length > 0) {
            preserveDir = preserveUnchangedStls(stlDir, compileChanges);
          }

          let autoFixAttempted = false;
          let autoFixInfo = null;
          const { cmd: compileCmdStr, cleanup: tmpWrapper } = compileCmd(specPath);
          let result = run(compileCmdStr);
          try { execSync(`rm -f "${tmpWrapper}"`, { timeout: 5000 }); } catch {}

          let summary = null;
          if (result.output) {
            const m = result.output.match(/=== COMPILER OUTPUT ===\n(.+?)(?:\n|$)/s);
            if (m) { try { summary = JSON.parse(m[1]); } catch {} }
          }

          if (!summary || summary.status !== "ok") {
            const errors = parseCompileError(result.stderr || result.output || result.error || "");
            state.last_compile_error = errors;
            state.compiled = false;

            if (!autoFixAttempted && errors.length > 0) {
              autoFixAttempted = true;
              autoFixInfo = autoFixAndRetry(specPath, errors);
              if (autoFixInfo && autoFixInfo.recovered) {
                summary = autoFixInfo.summary;
              } else if (autoFixInfo && !autoFixInfo.recovered) {
                saveState(state);
                let msg = `## Compilation Failed (auto-fix attempted)\n\n**Original error:** ${errors[0]}\n`;
                msg += `**Auto-fix applied:** ${autoFixInfo.fixes.map(f => f.msg).join("; ")}\n`;
                msg += `**Retry error:** ${autoFixInfo.retry_errors.length > 0 ? autoFixInfo.retry_errors[0] : "Unknown"}\n\n`;
                msg += `**Raw output:**\n\`\`\`\n${(result.stderr || result.output || result.error || "").slice(0, 1000)}\n\`\`\`\n\n`;
                msg += `The auto-fix didn't resolve the issue. Edit spec manually with \`cad_revise\`.`;
                return msg;
              }
            }

            if (!summary || summary.status !== "ok") {
              saveState(state);
              let msg = `## Compilation Failed\n\n**Root cause:** ${errors.length > 0 ? errors[0] : "Unknown FreeCAD error"}\n\n`;
              if (errors.length > 1) msg += `**Additional:** ${errors.slice(1).join("; ")}\n\n`;
              msg += `**Raw output:**\n\`\`\`\n${(result.stderr || result.output || result.error || "").slice(0, 2000)}\n\`\`\`\n\n`;
              msg += `Run \`cad_validate\` to check the spec, or \`cad_revise\` to edit.`;
              return msg;
            }
          }

          state.compiled = true;
          state.spec = specPath;
          state.last_compile_error = null;

          // Restore unchanged STLs from preserve
          let restoredList = [];
          if (preserveDir) {
            restoredList = restoreStls(stlDir, preserveDir);
          }

          // Refresh part list
          if (existsSync(stlDir)) state.parts = readdirSync(stlDir).filter(f => f.endsWith(".stl"));
          const newStls = {};
          for (const p of state.parts) {
            const name = p.replace(".stl", "");
            const fp = join(stlDir, p);
            newStls[name] = existsSync(fp) ? stlDims(fp) : null;
          }

          // Get old STL dimensions for delta reporting
          const lastRevision = prevRevs.length > 0 ? prevRevs[prevRevs.length - 1] : null;
          const oldStls = lastRevision ? lastRevision.stl_snapshot : null;
          const deltas = perPartDeltas(newStls, oldStls);

          // Record revision with full spec + STL snapshot
          state.revision_history = prevRevs;
          state.revision_history.push({
            at: new Date().toISOString(),
            action: "compile",
            notes: compileChanges ? `${compileChanges.changed.length} part(s) changed, ${compileChanges.same.length} unchanged` : "Initial compile",
            spec_full: readFileSync(specPath, "utf-8"),
            stl_snapshot: JSON.parse(JSON.stringify(newStls)),
          });
          saveState(state);

          ctx.metadata({ title: `Compiled: ${state.name}`, metadata: { parts: state.parts.length, stls: stlDir } });

          let out = `## Compilation Complete: ${state.name}\n\n`;

          // Incremental compile info
          if (restoredList.length > 0) {
            out += `♻️ **Incremental:** ${restoredList.length} parts restored from cache (${restoredList.join(", ")})\n\n`;
          }
          if (compileChanges && compileChanges.changed.length > 0) {
            out += `**Rebuilt:** ${compileChanges.changed.concat(compileChanges.added || []).join(", ")}\n\n`;
          }

          if (autoFixInfo && autoFixInfo.recovered && autoFixInfo.fixes.length > 0) {
            out += `### 🔧 Auto-fix Applied\n`;
            for (const f of autoFixInfo.fixes) out += `- ${f.msg} (${f.part})\n`;
            out += "\n";
          }

          out += `**${state.parts.length} parts**\n\n`;
          if (compileChanges && (compileChanges.changed.length > 0 || compileChanges.added.length > 0 || compileChanges.removed.length > 0)) {
            if (compileChanges.changed.length > 0) out += `📝 Changed: ${compileChanges.changed.join(", ")}\n`;
            if (compileChanges.added.length > 0) out += `➕ Added: ${compileChanges.added.join(", ")}\n`;
            if (compileChanges.removed.length > 0) out += `➖ Removed: ${compileChanges.removed.join(", ")}\n`;
            if (compileChanges.same.length > 0) out += `⏺ Same: ${compileChanges.same.join(", ")}\n`;
            out += "\n";
          }

          for (const p of state.parts) {
            const name = p.replace(".stl", "");
            const dims = newStls[name];
            const sz = `${(statSync(join(stlDir, p)).size / 1024).toFixed(0)}KB`;
            const dimStr = dims ? ` — ${dims.x}×${dims.y}×${dims.z} mm` : "";
            const deltaStr = deltas && deltas[name] && deltas[name] !== "unchanged" ? ` **[${deltas[name]}]**` : "";
            out += `- \`${p}\` ${sz}${dimStr}${deltaStr}\n`;
          }
          out += `\nNext: \`cad_render\` (screenshots), \`cad_preview\` (3D), or \`cad_revise\` (iterate)`;
          return out;
        },
      }),

      // ── RENDER ――――――――――――――――――――――――――――――――――――――――――――――
      cad_render: tool({
        description: "Render annotated screenshots from a compiled FreeCAD document. Versions previous screenshots and generates a comparison view.",
        args: {
          keep_versions: tool.schema.number().optional().describe("Number of previous screenshot versions to keep (default: 2)"),
        },
        async execute(args, ctx) {
          const state = findProject(ctx.directory);
          if (!state || !state.compiled) return "No compiled project found. Run `cad_compile` first.";
          const fcstd = join(state.root, `${state.name}.FCStd`);
          if (!existsSync(fcstd)) return `FCStd not found at \`${fcstd}\`. Run \`cad_compile\` again.`;

          // Version existing screenshots before rendering new ones
          const hadPrevShots = existsSync(join(state.root, "screenshots")) &&
            readdirSync(join(state.root, "screenshots")).some(f => f.endsWith(".png"));
          if (hadPrevShots) {
            rotateScreenshots(state.root, args.keep_versions || 2);
          }

          const result = run(`"${FREECAD}" "${RENDER_SCRIPT}" "${fcstd}" "${state.root}"`);
          let summary = null;
          if (result.output) {
            const m = result.output.match(/=== RENDERER OUTPUT ===\n(.+?)(?:\n|$)/s);
            if (m) { try { summary = JSON.parse(m[1]); } catch {} }
          }

          if (!summary || summary.status !== "ok") {
            return `## Screenshot Capture\n\nRenderer ran. Check: \`${join(state.root, "screenshots")}\`\n\n\`\`\`\n${(result.output || "").slice(0, 1500)}\n\`\`\``;
          }

          // Generate comparison artifact
          const comparePath = renderCompareHtml(state.root);

          state.rendered = true;
          saveState(state);

          const shotDir = join(state.root, "screenshots");
          const shots = existsSync(shotDir) ? readdirSync(shotDir).filter(f => f.endsWith(".png")) : [];
          const hasCompare = comparePath && existsSync(comparePath);

          let out = `## Screenshots Captured (${shots.length})\n\nDirectory: \`${shotDir}\`\n`;
          if (hadPrevShots) {
            out += `Previous screenshots preserved in \`${shotDir}/v1/\`\n`;
          }
          if (hasCompare) {
            out += `Comparison view: \`${comparePath}\`\n`;
          }
          out += `\nNext: \`cad_preview\` (3D) or \`cad_revise\` (iterate)`;
          return out;
        },
      }),

      // ── REVISE (edit → auto-fix → diff → compile → report) ―――――――――
      cad_revise: tool({
        description: "Edit the current YAML spec, auto-fix common issues, detect changes, re-compile, and report what changed. Supports inline edits or find/replace patches.",
        args: {
          spec: tool.schema.string().describe("New full YAML spec, or partial edit (see edit_mode)").optional(),
          edit_mode: tool.schema.string().optional().describe("'replace' (default) or 'patch' (find/replace pair)"),
          find: tool.schema.string().optional().describe("Text to find (patch mode)"),
          replace: tool.schema.string().optional().describe("Replacement text (patch mode)"),
          change_notes: tool.schema.string().optional().describe("Describe what changed and why (recorded in revision history)"),
          auto_render: tool.schema.boolean().optional().describe("Also version and render screenshots after compile (default: false)"),
          skip_autofix: tool.schema.boolean().optional().describe("Skip auto-fix of missing defaults (default: false)"),
        },
        async execute(args, ctx) {
          const state = findProject(ctx.directory);
          if (!state) return "No CAD project found. Run `cad_init` first.";

          const specPath = state.spec || join(state.root, "design.yaml");
          let currentSpec = existsSync(specPath) ? readFileSync(specPath, "utf-8") : "";
          let prevSpec = currentSpec;

          // Apply edit
          const mode = args.edit_mode || "replace";
          let edited = "";
          if (mode === "replace" && args.spec) {
            edited = args.spec;
          } else if (mode === "patch" && args.find && args.replace !== undefined) {
            if (!currentSpec.includes(args.find)) return `Patch failed: text not found. Use \`cad_status\` to see current spec.`;
            edited = currentSpec.replace(args.find, args.replace);
          } else if (args.spec) {
            edited = args.spec;
          } else {
            return "No edit provided. Pass `spec` (full YAML) or use `edit_mode=patch` + `find`/`replace`.";
          }

          // Auto-fix
          const { text: fixed, fixes } = args.skip_autofix ? { text: edited, fixes: [] } : autoFixYaml(edited);
          writeFileSync(specPath, fixed);

          // Detect changes against previous spec
          const changes = detectChanges(prevSpec, fixed);
          const changeCount = changes.changed.length + changes.added.length + changes.removed.length;

          state.spec = specPath;
          state.compiled = false;
          state.rendered = false;
          saveState(state);

          // Re-compile
          const patched = readFileSync(specPath, "utf-8").replace(/output_dir:\s*.+/, `output_dir: "${state.root}"`);
          writeFileSync(specPath, patched);

          // Preserve unchanged STLs for incremental compile
          const revisedSpec = readFileSync(specPath, "utf-8");
          const prevRevs = state.revision_history || [];
          const prevCompileSpec = prevRevs.length > 0 ? prevRevs[prevRevs.length - 1].spec_full : null;
          const compileChanges = prevCompileSpec ? detectChanges(prevCompileSpec, revisedSpec) : null;
          const stlDir = join(state.root, "STLs");
          let preserveDir = null;
          if (compileChanges && compileChanges.same.length > 0) {
            preserveDir = preserveUnchangedStls(stlDir, compileChanges);
          }

          let compileAutoFixInfo = null;
          let autoFixAttempted = false;
          const { cmd: compileCmdStr, cleanup: tmpWrapper } = compileCmd(specPath);
          let result = run(compileCmdStr);
          try { execSync(`rm -f "${tmpWrapper}"`, { timeout: 5000 }); } catch {}

          let summary = null;
          if (result.output) {
            const m = result.output.match(/=== COMPILER OUTPUT ===\n(.+?)(?:\n|$)/s);
            if (m) { try { summary = JSON.parse(m[1]); } catch {} }
          }

          if (!summary || summary.status !== "ok") {
            const errors = parseCompileError(result.stderr || result.output || result.error || "");
            state.last_compile_error = errors;
            state.compiled = false;

            if (!autoFixAttempted && errors.length > 0) {
              autoFixAttempted = true;
              compileAutoFixInfo = autoFixAndRetry(specPath, errors);
              if (compileAutoFixInfo && compileAutoFixInfo.recovered) {
                summary = compileAutoFixInfo.summary;
              } else if (compileAutoFixInfo && !compileAutoFixInfo.recovered) {
                saveState(state);
                let msg = `## Revision Failed (auto-fix attempted)\n\n**Original error:** ${errors[0]}\n`;
                msg += `**Auto-fix applied:** ${compileAutoFixInfo.fixes.map(f => f.msg).join("; ")}\n`;
                msg += `**Retry error:** ${compileAutoFixInfo.retry_errors.length > 0 ? compileAutoFixInfo.retry_errors[0] : "Unknown"}\n\n`;
                msg += `Edit manually with \`cad_revise\``;
                return msg;
              }
            }

            if (!summary || summary.status !== "ok") {
              saveState(state);
              let msg = `## Revision Failed\n\n**Fix:** ${errors.length > 0 ? errors[0] : "Unknown error"}\n\n`;
              if (errors.length > 1) msg += `More: ${errors.slice(1).join("; ")}\n\n`;
              msg += `Edit again with \`cad_revise\` or edit \`${specPath}\` directly.`;
              return msg;
            }
          }

          state.compiled = true;
          state.last_compile_error = null;

          // Restore unchanged STLs from preserve
          let restoredList = [];
          if (preserveDir) {
            restoredList = restoreStls(stlDir, preserveDir);
          }

          // Get STL dimensions
          if (existsSync(stlDir)) state.parts = readdirSync(stlDir).filter(f => f.endsWith(".stl"));
          const newStls = {};
          for (const p of state.parts) {
            const fp = join(stlDir, p);
            newStls[p.replace(".stl", "")] = existsSync(fp) ? stlDims(fp) : null;
          }

          // Get previous STL dimensions for delta reporting
          let oldStls = {};
          const revs = state.revision_history || [];
          if (revs.length > 0) {
            const lastRev = revs[revs.length - 1];
            if (lastRev.stl_snapshot) oldStls = lastRev.stl_snapshot;
          }
          const deltas = perPartDeltas(newStls, oldStls);

          // Record revision with full spec + STL snapshot
          state.revision_history = revs;
          state.revision_history.push({
            at: new Date().toISOString(),
            action: "revise",
            notes: args.change_notes || (changeCount > 0 ? `${changeCount} part(s) modified` : "Recompile"),
            spec_full: readFileSync(specPath, "utf-8"),
            stl_snapshot: JSON.parse(JSON.stringify(newStls)),
          });
          saveState(state);

          let out = `## Revision Complete: ${state.name}\n\n`;

          // Incremental compile info
          if (restoredList.length > 0) {
            out += `♻️ **Incremental:** ${restoredList.length} parts restored from cache (${restoredList.join(", ")})\n\n`;
          }
          if (compileChanges && compileChanges.changed.length > 0) {
            out += `**Rebuilt:** ${compileChanges.changed.concat(compileChanges.added || []).join(", ")}\n\n`;
          }

          // Auto-fix report (edit phase)
          if (fixes.length > 0) {
            out += `### 🔧 Pre-compile Auto-fixes (${fixes.length})\n`;
            for (const f of fixes) out += `- ${f.msg} (${f.part})\n`;
            out += "\n";
          }

          // Auto-fix report (compile retry phase)
          if (compileAutoFixInfo && compileAutoFixInfo.recovered && compileAutoFixInfo.fixes.length > 0) {
            out += `### 🔧 Compile Error Auto-fix\n`;
            for (const f of compileAutoFixInfo.fixes) out += `- ${f.msg} (${f.part})\n`;
            out += "\n";
          }

          // Change detection report
          if (changeCount > 0) {
            out += `### Changes Detected\n`;
            if (changes.changed.length > 0) out += `- 📝 **Changed:** ${changes.changed.join(", ")}\n`;
            if (changes.added.length > 0) out += `- ➕ **Added:** ${changes.added.join(", ")}\n`;
            if (changes.removed.length > 0) out += `- ➖ **Removed:** ${changes.removed.join(", ")}\n`;
            if (changes.same.length > 0) out += `- ⏺ **Unchanged:** ${changes.same.join(", ")}\n`;
            out += "\n";
          }

          // Dimension summary with deltas
          out += `### Parts (${state.parts.length})\n`;
          for (const p of state.parts) {
            const name = p.replace(".stl", "");
            const nd = newStls[name];
            const od = oldStls[name];
            const sz = `${(statSync(join(stlDir, p)).size / 1024).toFixed(0)}KB`;
            const dimStr = nd ? ` — ${nd.x}×${nd.y}×${nd.z} mm` : "";
            const oldStr = (od && deltas && deltas[name] && deltas[name] !== "unchanged" && deltas[name] !== "NEW") ? ` (was ${od.x}×${od.y}×${od.z})` : "";
            const deltaStr = deltas && deltas[name] && deltas[name] !== "unchanged" ? ` **[${deltas[name]}]**` : "";
            out += `- \`${p}\` ${sz}${dimStr}${deltaStr}${oldStr}\n`;
          }

          // Auto-render with screenshot versioning
          if (args.auto_render) {
            out += `\n### Rendering screenshots...\n`;
            const fcstd = join(state.root, `${state.name}.FCStd`);
            if (existsSync(fcstd)) {
              const hadPrev = existsSync(join(state.root, "screenshots")) &&
                readdirSync(join(state.root, "screenshots")).some(f => f.endsWith(".png"));
              if (hadPrev) rotateScreenshots(state.root, 2);

              const r2 = run(`"${FREECAD}" "${RENDER_SCRIPT}" "${fcstd}" "${state.root}"`);
              const rm = r2.output.match(/=== RENDERER OUTPUT ===\n(.+?)(?:\n|$)/s);
              if (rm) { try { const rs = JSON.parse(rm[1]); if (rs.status === "ok") {
                state.rendered = true; saveState(state);
                out += `Screenshots: \`${rs.screenshots_dir}\`\n`;
                const cp = renderCompareHtml(state.root);
                if (cp) out += `Comparison: \`${cp}\`\n`;
                // Generate diff.png showing dimension changes
                const revNum = (state.revision_history || []).length;
                const diffPng = renderDiffPng(state.root, state.name, revNum - 1, revNum, changes, oldStls, newStls);
                if (diffPng) out += `Diff: \`${diffPng}\`\n`;
              } } catch {} }
            }
          }

          out += `\nNext: \`cad_preview\` (3D) or \`cad_revise\` again.`;
          return out;
        },
      }),

      // ── PREVIEW ―――――――――――――――――――――――――――――――――――――――――――――――
      cad_preview: tool({
        description: "Launch a 3D preview of the compiled STL parts in the browser. Supports individual part viewing, assembly view, and exploded view.",
        args: {},
        async execute(_args, ctx) {
          const state = findProject(ctx.directory);
          if (!state || !existsSync(join(state.root, "STLs"))) return "No compiled project found. Run `cad_compile` first.";
          const stlDir = join(state.root, "STLs");
          const stls = readdirSync(stlDir).filter(f => f.endsWith(".stl"));
          if (stls.length === 0) return "No STL files found.";

          const partsMeta = [];
          for (const f of stls) {
            const fp = join(stlDir, f);
            const dims = existsSync(fp) ? stlDims(fp) : null;
            partsMeta.push({ name: f.replace(".stl", ""), dims });
          }

          const stlOptions = stls.map(f => `<option value="${f}">${f.replace(".stl","")}</option>`).join("\n");
          const revHistory = (state.revision_history || []).slice(-5);
          const revJson = JSON.stringify(revHistory.map(r => ({ at: r.at, notes: r.notes || r.action })));
          const stlListJson = JSON.stringify(stls);
          const stlDirJson = JSON.stringify(stlDir.replace(/\\/g, "/"));
          const partsDimJson = JSON.stringify(partsMeta);

          const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>CAD Preview: ${state.name}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#1a1a2e;color:#eee;overflow:hidden;display:flex;flex-direction:column;height:100vh}
#bar{display:flex;align-items:center;gap:8px;padding:8px 16px;background:#16213e;border-bottom:1px solid #0f3460;flex-wrap:wrap}
#bar select,#bar button{background:#0f3460;color:#eee;border:1px solid #533483;padding:5px 12px;border-radius:4px;font-size:13px;cursor:pointer}
#bar select:hover,#bar button:hover{background:#533483;border-color:#7777cc}
#bar label{font-size:12px;color:#a0a0c0}
#bar .title{font-weight:600;font-size:14px;color:#8888cc;margin-right:12px}
#info{position:absolute;bottom:12px;left:12px;background:rgba(0,0,0,0.75);padding:6px 12px;border-radius:4px;font-size:12px;color:#888}
#pname{position:absolute;top:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);padding:4px 16px;border-radius:4px;font-size:14px;color:#ccc;pointer-events:none;display:none}
#dims{position:absolute;bottom:12px;right:12px;background:rgba(0,0,0,0.75);padding:6px 12px;border-radius:4px;font-size:12px;color:#888}
#rev{position:absolute;top:12px;right:12px;background:rgba(0,0,0,0.7);padding:6px 12px;border-radius:4px;font-size:11px;color:#666;max-width:260px;text-align:right;line-height:1.4}
#view{flex:1;position:relative}
#bar .badge{font-size:11px;background:#0f3460;padding:2px 8px;border-radius:10px;color:#8888cc}
.exploded-btn.active{background:#533483 !important;border-color:#8888cc !important}
#screenshot-msg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,200,100,0.9);color:#000;padding:12px 24px;border-radius:8px;font-size:16px;pointer-events:none;opacity:0;transition:opacity 0.3s}
</style></head><body>
<div id="bar"><span class="title">${state.name}</span>
<label>Part:</label><select id="sel"><option value="__all__">Assembly (all)</option>${stlOptions}</select>
<button id="btnExplode" class="exploded-btn">Explode</button>
<button id="btnScreenshot">Screenshot</button>
<button id="btnReset">Fit</button>
<span class="badge" id="count">${stls.length} parts</span>
</div>
<div id="view"><div id="info">Drag: rotate | Scroll: zoom | Right-drag: pan</div>
<div id="pname"></div><div id="dims">Select a part</div>
<div id="rev"></div>
<div id="screenshot-msg">Screenshot saved</div>
</div>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
<script type="module">
import*as THREE from"three";import{OrbitControls}from"three/addons/controls/OrbitControls.js";import{STLLoader}from"three/addons/loaders/STLLoader.js";
const c=document.getElementById("view"),sel=document.getElementById("sel"),reset=document.getElementById("btnReset"),countEl=document.getElementById("count"),revEl=document.getElementById("rev"),pnameEl=document.getElementById("pname"),dimsEl=document.getElementById("dims"),btnExplode=document.getElementById("btnExplode"),btnScreenshot=document.getElementById("btnScreenshot");
const s=new THREE.Scene();s.background=new THREE.Color(0x1a1a2e);
const cam=new THREE.PerspectiveCamera(40,c.clientWidth/c.clientHeight,1,5000);cam.position.set(200,150,300);
const r=new THREE.WebGLRenderer({antialias:true});r.setSize(c.clientWidth,c.clientHeight);r.setPixelRatio(Math.min(window.devicePixelRatio,2));c.appendChild(r.domElement);
const o=new OrbitControls(cam,r.domElement);o.enableDamping=true;o.dampingFactor=0.15;
s.add(new THREE.AmbientLight(0x606080,0.6));
const dl=new THREE.DirectionalLight(0xffffff,1.5);dl.position.set(200,300,200);s.add(dl);
const dl2=new THREE.DirectionalLight(0xffffff,0.5);dl2.position.set(-200,100,-200);s.add(dl2);
s.add(new THREE.GridHelper(600,20,0x444466,0x333355));
const ld=new STLLoader(),meshes={},dims={};
const colors=[0x8888cc,0x66aacc,0x88bb88,0xcc8866,0xcc66aa,0xaacc66,0x6699cc,0xccaa66,0x66cc88,0xaa88cc,0xcc8888,0x88aacc];
const partNames={};let exploded=false,explodeOffsets={};
function fit(){const b=new THREE.Box3();Object.values(meshes).forEach(m=>{if(m.visible)b.expandByObject(m)});if(b.isEmpty())return;const sz=b.getSize(new THREE.Vector3()).length(),ct=b.getCenter(new THREE.Vector3());o.target.copy(ct);cam.position.set(ct.x+sz,ct.y+sz*0.7,ct.z+sz*0.7);o.update()}
function toggleExplode(){exploded=!exploded;btnExplode.textContent=exploded?"Assemble":"Explode";btnExplode.classList.toggle("active");Object.entries(meshes).forEach(([n,m])=>{const idx=stls.indexOf(n);const offset=exploded?(idx+1)*20:explodeOffsets[n]||0;m.position.y=offset});fit()}
function updateDims(){const v=sel.value;pnameEl.style.display=v==="__all__"?"none":"block";pnameEl.textContent=v==="__all__"?"":v.replace(".stl","");dimsEl.textContent=v==="__all__"?stls.length+" parts loaded":(dims[v]||"")}
const revData=${revJson};if(revData.length>0){revEl.innerHTML=revData.slice(-3).map(r=>{const d=new Date(r.at);return d.toLocaleString().slice(0,17)+" - "+r.notes}).join("<br>")}
const dir=${stlDirJson},files=${stlListJson};let loaded=0;
for(let i=0;i<files.length;i++){const f=files[i];const fn=f.replace(".stl","");partNames[f]=fn;countEl.textContent=(i+1)+"/"+files.length;
await new Promise(res=>{ld.load(dir+"/"+f,g=>{g.computeVertexNormals();
const m=new THREE.Mesh(g,new THREE.MeshPhongMaterial({color:colors[i%colors.length],specular:0x222244,shininess:30}));
const b=new THREE.Box3().setFromObject(m);
const cx=(b.min.x+b.max.x)/2,cy=(b.min.y+b.max.y)/2,cz=(b.min.z+b.max.z)/2;
m.position.set(-cx,-cy,-cz);explodeOffsets[f]=0;
m.name=f;meshes[f]=m;s.add(m);
dims[f]=(b.max.x-b.min.x).toFixed(1)+"\\u00d7"+(b.max.y-b.min.y).toFixed(1)+"\\u00d7"+(b.max.z-b.min.z).toFixed(1)+" mm";
loaded++;res()},undefined,()=>res())})}
countEl.textContent=loaded+" parts";fit();
sel.addEventListener("change",()=>{const v=sel.value;Object.entries(meshes).forEach(([n,m])=>{m.visible=v==="__all__"||n===v;m.position.y=exploded?(files.indexOf(n)+1)*20:0});const p=dims[v];if(v!=="__all__"&&p)countEl.textContent=p;else countEl.textContent=loaded+" parts";updateDims();fit()});
reset.addEventListener("click",fit);
btnExplode.addEventListener("click",toggleExplode);
btnScreenshot.addEventListener("click",()=>{r.render(s,cam);const a=document.createElement("a");a.href=r.domElement.toDataURL("image/png");a.download=state.name.replace(/\\s+/g,"_")+"_preview.png";a.click();const m=document.getElementById("screenshot-msg");m.style.opacity=1;setTimeout(()=>m.style.opacity=0,1500)});
window.addEventListener("resize",()=>{cam.aspect=c.clientWidth/c.clientHeight;cam.updateProjectionMatrix();r.setSize(c.clientWidth,c.clientHeight)});
(function loop(){requestAnimationFrame(loop);o.update();r.render(s,cam)})();
</script></body></html>`;

          const previewPath = join(state.root, "preview.html");
          writeFileSync(previewPath, html);

          ctx.metadata({ title: `Preview: ${state.name}`, metadata: { parts: stls.length, file: previewPath } });

          let out = `## 3D Preview: ${state.name}\n\n`;
          out += `📐 **Open:** \`${previewPath}\` in a browser\n\n`;
          out += `**${stls.length} parts**\n`;
          for (const pm of partsMeta) {
            const d = pm.dims;
            out += `- ${pm.name}${d ? ` — ${d.x} × ${d.y} × ${d.z} mm` : ""}\n`;
          }

          if (state.revision_history && state.revision_history.length > 0) {
            const last = state.revision_history[state.revision_history.length - 1];
            const count = state.revision_history.length;
            out += `\n**Revisions:** ${count}`;
            if (last.notes) out += ` (last: ${last.notes})`;
            out += "\n";
          }

          out += `\nControls: part selector dropdown, Explode for offset view, Screenshot to capture, Fit to reset camera.`;
          return out;
        },
      }),

      // ── STATUS ―――――――――――――――――――――――――――――――――――――――――――――――
      cad_status: tool({
        description: "Show the current CAD project state: parts, dimensions, files, errors, revision history.",
        args: {},
        async execute(_args, ctx) {
          const state = findProject(ctx.directory);
          if (!state) return "No CAD project found. Run `cad_init` first.";

          let out = `## Project: ${state.name}\n\n`;
          out += `Root: \`${state.root}\`\n`;
          out += `State: ${state.compiled ? "✅ Compiled" : "❌ Not compiled"} | ${state.rendered ? "✅ Rendered" : "❌ Not rendered"}\n\n`;

          // Extraction sources
          if (state.extraction_sources && state.extraction_sources.length > 0) {
            out += `### Source Material\n`;
            for (const src of state.extraction_sources) out += `- ${src.source}\n`;
            out += "\n";
          }

          const pendingConflicts = (state.conflicts || []).filter(c => !c.resolved);
          if (pendingConflicts.length > 0) {
            out += `### ⚠️ Unresolved Conflicts (${pendingConflicts.length})\n`;
            for (const c of pendingConflicts) {
              out += `- \`${c.part}.${c.field}\`: ${c.sources.map((s, i) => `${s}=${JSON.stringify(c.values[i])}`).join(" vs ")}\n`;
            }
            out += "Resolve each with `cad_revise`.\n\n";
          }

          // Revisions
          if (state.revision_history && state.revision_history.length > 0) {
            out += `### Revision History (${state.revision_history.length})\n`;
            for (const rev of state.revision_history.slice(-5)) {
              out += `- ${rev.at.slice(0, 19)}: ${rev.notes || rev.action}\n`;
            }
            if (state.revision_history.length > 5) out += `  ... ${state.revision_history.length - 5} earlier\n`;
            out += "\n";
          }

          // Errors
          if (state.last_compile_error && state.last_compile_error.length > 0) {
            out += `### Last Compile Errors\n`;
            for (const e of state.last_compile_error) out += `- ${e}\n`;
            out += "\n";
          }

          const stlDir = join(state.root, "STLs");
          if (existsSync(stlDir)) {
            const stls = readdirSync(stlDir).filter(f => f.endsWith(".stl"));
            if (stls.length > 0) {
              out += `### STL Files (${stls.length})\n`;
              for (const f of stls) {
                const fp = join(stlDir, f);
                const dims = existsSync(fp) ? stlDims(fp) : null;
                const sz = existsSync(fp) ? `${(statSync(fp).size / 1024).toFixed(0)}KB` : "?";
                out += `- \`${f}\` (${sz})${dims ? ` — ${dims.x}×${dims.y}×${dims.z} mm` : ""}\n`;
              }
              out += "\n";
            }
          }

          const shotDir = join(state.root, "screenshots");
          if (existsSync(shotDir)) {
            const shots = readdirSync(shotDir).filter(f => f.endsWith(".png"));
            if (shots.length > 0) out += `### Screenshots (${shots.length}) in \`${shotDir}\`\n\n`;
          }

          out += `**Suggested next:** ${state.compiled ? "`cad_preview`, `cad_render`, or `cad_revise`" : "`cad_compile` or `cad_ingest`"}`;
          return out;
        },
      }),

      cad_source_report: tool({
        description: "Merge all extraction sources for a project into one unified source report. Lists what was extracted, what was inferred, what is uncertain, and where each item came from. Supports cross-source comparison mode.",
        args: {
          project: tool.schema.string().describe("Project name to report on."),
          sources: tool.schema.string().optional().describe("Optional JSON array of source descriptions for cross-source comparison. Each entry: {name, type, parts, source_type, file}"),
          mode: tool.schema.string().optional().describe("Report mode: 'single' (default) for one source, 'cross' for cross-source comparison and conflict detection."),
          auto_resolve: tool.schema.boolean().optional().describe("Auto-resolve obvious cross-source conflicts using deterministic confidence rules (default: false)."),
        },
        async execute(args, ctx) {
          const projDir = join(STATE_DIR, args.project);
          let state = loadState(projDir);
          let rootDir = projDir;

          if (!state) {
            const candidates = listProjects().filter(p => p.name === args.project);
            if (candidates.length > 0) {
              state = candidates[0];
              rootDir = state.root;
            }
          }

          // Parse inline sources for cross-source / multi-source mode
          let inlineSources = [];
          if (args.sources) {
            try { inlineSources = JSON.parse(args.sources); } catch {}
          }

          const dirs = [rootDir, join(rootDir, "sources"), join(rootDir, "extractions"), STATE_DIR];

          let sources = [];
          if (state && state.merged_parts) {
            for (const p of state.merged_parts) {
              sources.push({
                source: p._source || "(merged)",
                type: "part",
                name: p.name,
                dims: p.outer || p.size || null,
                fields: Object.keys(p).filter(k => !k.startsWith("_") && !["name", "type", "outer", "size", "position"].includes(k)),
                _uncertain: p._uncertain || [],
                _source_file: p._source_file || p._source || null,
              });
            }
          }

          const crossSourceData = {};
          if (inlineSources.length > 0) {
            for (const is of inlineSources) {
              const key = is.name || is.file || "unnamed";
              crossSourceData[key] = {
                source_type: is.source_type || "unknown",
                file: is.file || "—",
                part_count: (is.parts || []).length,
                parts: (is.parts || []).map(p => ({
                  name: p.name || "?",
                  dims: p.outer || p.size || p.dimensions || null,
                  type: p.type || "part",
                  uncertain: p._uncertain || [],
                  fields: Object.keys(p).filter(k => !k.startsWith("_") && !["name","type","outer","size","position","dimensions"].includes(k)),
                })),
                dims: (is.parts || []).filter(p => p.outer || p.size || p.dimensions).length,
              };
            }
          }

          let conflicts = [];
          if (state && state.conflicts) {
            for (const [key, conflict] of Object.entries(state.conflicts)) {
              conflicts.push({
                field: key,
                values: conflict.values || conflict,
                sources: conflict.sources || [],
              });
            }
          }

          const crossConflicts = [];
          if (args.mode === "cross" && inlineSources.length >= 2) {
            const nameToParts = {};
            for (const is of inlineSources) {
              for (const p of (is.parts || [])) {
                const n = p.name;
                if (!nameToParts[n]) nameToParts[n] = {};
                nameToParts[n][is.name || is.file] = p;
              }
            }
            for (const [partName, srcParts] of Object.entries(nameToParts)) {
              const srcEntries = Object.entries(srcParts);
              if (srcEntries.length < 2) continue;
              const dimsBySrc = {};
              for (const [src, p] of srcEntries) {
                const d = p.outer || p.size || p.dimensions;
                if (d) dimsBySrc[src] = d;
              }
              const dimEntries = Object.entries(dimsBySrc);
              if (dimEntries.length >= 2) {
                const firstVal = JSON.stringify(dimEntries[0][1]);
                const allMatch = dimEntries.every(([,v]) => JSON.stringify(v) === firstVal);
                if (!allMatch) {
                  crossConflicts.push({
                    part: partName,
                    field: "dims",
                    sources: dimEntries.map(([s,v]) => `${s}=${JSON.stringify(v)}`),
                  });
                }
              }
            }
          }

          const extractionFiles = [];
          for (const d of dirs) {
            if (!existsSync(d)) continue;
            for (const f of readdirSync(d)) {
              if (f.endsWith(".json") && !f.startsWith(".")) {
                extractionFiles.push(join(d, f));
              }
            }
          }

          const sourceFiles = new Set();
          if (state && state.merged_parts) {
            for (const p of state.merged_parts) {
              if (p._source_file) sourceFiles.add(p._source_file);
              if (p._source) sourceFiles.add(p._source);
            }
          }
          // Add inline source files
          for (const is of inlineSources) {
            if (is.file) sourceFiles.add(is.file);
          }

          let out = "## Source Report: " + args.project + "\n\n";
          out += "**Generated from:** tool extraction + merge records\n\n";

          // Multi-source summary
          if (inlineSources.length > 0) {
            out += "### Source Summary (" + inlineSources.length + " sources)\n\n";
            out += "| Source | Type | File | Parts | With Dims |\n";
            out += "|--------|------|------|-------|-----------|\n";
            for (const is of inlineSources) {
              const key = is.name || is.file || "unnamed";
              const cd = crossSourceData[key] || {};
              out += "| " + key + " | " + (is.source_type || "—") + " | " + (is.file || "—") + " | " + cd.part_count + " | " + (cd.dims || 0) + " |\n";
            }
            out += "\n";
          }

          if (crossConflicts.length > 0) {
            let displayConflicts = crossConflicts;
            let autoResolved = [];

            if (args.auto_resolve) {
              // Build conflict objects for resolveConflicts
              const resolvableConflicts = crossConflicts.map(cc => ({
                part: cc.part,
                field: cc.field,
                sources: cc.sources.map(s => {
                  const eqIdx = s.indexOf("=");
                  return eqIdx > 0 ? s.slice(0, eqIdx) : s;
                }),
                values: cc.sources.map(s => {
                  const eqIdx = s.indexOf("=");
                  return eqIdx > 0 ? JSON.parse(s.slice(eqIdx + 1)) : null;
                }),
                chosen: cc.sources[0],
              }));
              const result = resolveConflicts(resolvableConflicts);
              if (result.resolved.length > 0) {
                for (const r of result.resolved) {
                  autoResolved.push(r);
                }
              }
              if (result.unresolved.length > 0) {
                displayConflicts = result.unresolved.map(u => ({
                  part: u.part,
                  field: u.field,
                  sources: u.sources.map((s, i) => `${s}=${JSON.stringify(u.values[i])}`),
                }));
              } else {
                displayConflicts = [];
              }
            }

            if (autoResolved.length > 0) {
              out += "### ✅ Auto-Resolved Conflicts (" + autoResolved.length + ")\n\n";
              for (const ar of autoResolved) {
                out += "- `" + ar.part + "." + ar.field + "`: " + ar.reason + "\n";
                if (ar.overwritten) {
                  out += "  → old: " + ar.overwritten + ", new: " + JSON.stringify(ar.chosen) + "\n";
                }
              }
              out += "\n";
            }

            if (displayConflicts.length > 0) {
              out += "### ⚠️ Unresolved Conflicts (" + displayConflicts.length + ")\n\n";
              for (const dc of displayConflicts) {
                out += "- `" + dc.part + "." + dc.field + "`: " + dc.sources.join(" vs ") + "\n";
              }
              out += "Resolve via `cad_revise` before `cad_ingest`.\n\n";
            }
          }

          if (sources.length > 0) {
            out += "### Extracted Parts (" + sources.length + ")\n\n";
            out += "| Part | Source | Type | Dims | Fields | Uncertain |\n";
            out += "|------|--------|------|------|--------|-----------|\n";
            for (const s of sources) {
              const dimStr = s.dims ? (Array.isArray(s.dims) ? s.dims.join("×") : s.dims) : "—";
              const uncStr = s._uncertain.length > 0 ? s._uncertain.join(", ") : "—";
              const srcStr = s.source || "—";
              out += "| " + s.name + " | " + srcStr + " | " + s.type + " | " + dimStr + " | " + s.fields.join(", ") + " | " + uncStr + " |\n";
            }
          } else {
            out += "### Extracted Parts\n\n*No extracted parts found in project state.*\n";
          }

          // Cross-source part detail
          if (args.mode === "cross" && inlineSources.length >= 2) {
            out += "\n### Per-Source Part Detail\n\n";
            for (const [srcName, cd] of Object.entries(crossSourceData)) {
              out += "**" + srcName + "** (" + cd.source_type + ", " + cd.part_count + " parts)\n\n";
              for (const p of cd.parts) {
                const dimStr = p.dims ? (Array.isArray(p.dims) ? p.dims.join("×") : p.dims) : "—";
                out += "- `" + p.name + "`: " + p.type + " " + dimStr;
                if (p.uncertain.length > 0) out += " _uncertain:[" + p.uncertain.join(",") + "]";
                out += "\n";
              }
              out += "\n";
            }
          }

          if (conflicts.length > 0) {
            out += "\n### Unresolved Conflicts (" + conflicts.length + ")\n\n";
            for (const c of conflicts) {
              out += "- `" + c.field + "`: " + JSON.stringify(c.values) + "\n";
            }
          } else {
            out += "\n### Conflicts\n\n*None.*\n";
          }

          if (sourceFiles.size > 0) {
            out += "\n### Source Files\n\n";
            for (const sf of sourceFiles) {
              const exists = existsSync(sf) ? "present" : "not found";
              out += "- `" + sf + "` (" + exists + ")\n";
            }
          } else {
            out += "\n### Source Files\n\n*No source file references found.*\n";
          }

          if (extractionFiles.length > 0) {
            out += "\n### Extraction Artifacts (" + extractionFiles.length + ")\n\n";
            for (const ef of extractionFiles) {
              try {
                const size = statSync(ef).size;
                out += "- " + basename(ef) + " (" + size + " bytes)\n";
              } catch {
                out += "- " + basename(ef) + "\n";
              }
            }
          }

          const highConf = sources.filter(s => !s._uncertain || s._uncertain.length === 0).length;
          const lowConf = sources.filter(s => s._uncertain && s._uncertain.length > 0).length;
          out += "\n### Confidence Summary\n\n";
          out += "- **High-confidence dimensions:** " + highConf + "/" + sources.length + "\n";
          out += "- **Has uncertainties:** " + lowConf + "/" + sources.length + "\n";
          out += "- **Conflicts remaining:** " + conflicts.length + "\n";

          // Auto-build readiness
          const autoBuildCheck = checkAutoBuildThreshold(sources, "source_report");
          out += "- **Auto-build readiness:** " + autoBuildCheck.status + "\n";
          if (autoBuildCheck.ready) {
            out += "- **Auto-build:** Ready — use `cad_ingest(..., auto_compile=true)`\n";
          } else if (autoBuildCheck.status === "partial") {
            out += "- **Auto-build:** Partial — review uncertain parts first\n";
          } else {
            out += "- **Auto-build:** Not ready — extract more data\n";
          }

          out += "\n### Recommended next steps\n\n";
          if (conflicts.length > 0) out += "1. Resolve " + conflicts.length + " conflict(s) via `cad_merge` with explicit source priority\n";
          if (lowConf > 0) out += "2. Review uncertain parts and update dimensions via `cad_revise`\n";
          if (autoBuildCheck.ready) {
            out += "3. `cad_ingest` with `auto_compile=true` to build and compile\n";
          } else if (autoBuildCheck.status === "partial") {
            out += "3. Review draft parts, then `cad_ingest` to build YAML\n";
          } else {
            out += "3. Extract more data from source documents/images\n";
          }

          return out;
        },
      }),
      cad_measure_directory: tool({
        description: "Batch-run measurement extraction on every image in a directory. Returns per-image measurements, structural hints, OCR results, and confidence values in one call.",
        args: {
          directory: tool.schema.string().describe("Directory path containing images (PNG, JPG, WEBP, BMP)."),
          known_scale: tool.schema.number().optional().describe("Pixel-to-mm ratio for converting px measurements to mm."),
          max_images: tool.schema.number().optional().describe("Maximum images to process (default: 20)."),
        },
        async execute(args, ctx) {
          const dir = args.directory;
          if (!existsSync(dir)) return `Directory not found: ${dir}`;
          const exts = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif"]);
          const files = readdirSync(dir).filter(f => exts.has(f.split(".").pop().toLowerCase())).sort();
          const max = args.max_images || 20;
          const batch = files.slice(0, max);
          if (batch.length === 0) return `No supported image files found in ${dir}`;

          const results = [];
          for (const f of batch) {
            const fp = join(dir, f);
            try {
              const pyScript = `/tmp/cad_measure_${Date.now()}_${Math.random().toString(36).slice(2,6)}.py`;
              const knownScale = args.known_scale || null;
              const pyCode = `
import sys, json, os, math
sys.path.insert(0, "${SKILL_DIR.replace(/"/g, '\\"')}/scripts")
try: import cad_image_analysis as cia; cia_ok = True
except: cia_ok = False
from PIL import Image, ImageFilter, ImageStat
img = Image.open("${fp.replace(/"/g, '\\"')}")
w, h = img.size
gray = img.convert("L")
edges = gray.filter(ImageFilter.FIND_EDGES)
estat = ImageStat.Stat(edges)
edge_ratio = round(estat.mean[0] / 255.0 if estat.mean else 0, 4)
gray_px = gray.load()
edge_px = edges.load()
# Simple component detection
visited = [[False]*w for _ in range(h)]
comps = []
for y in range(2, h-2, 2):
  for x in range(2, w-2, 2):
    if not visited[y][x] and edge_px[x,y] > 64:
      stack, pxls = [(x,y)], []
      while stack and len(pxls) < 10000:
        cx,cy = stack.pop()
        if cx<0 or cx>=w or cy<0 or cy>=h or visited[cy][cx] or edge_px[cx,cy]<=64: continue
        visited[cy][cx] = True; pxls.append((cx,cy))
        for dx,dy in [(1,0),(-1,0),(0,1),(0,-1)]: stack.append((cx+dx,cy+dy))
      if len(pxls) > 50:
        xs = [p[0] for p in pxls]; ys = [p[1] for p in pxls]
        cw = max(xs)-min(xs); ch = max(ys)-min(ys)
        comps.append({"bbox":[min(xs),min(ys),max(xs),max(ys)],"w":cw,"h":ch,"area":len(pxls)})
comps = [c for c in comps if c["w"]>20 and c["h"]>20]
rects = sum(1 for c in comps if 0.5 < c["w"]/max(c["h"],1) < 3.0 and c["w"]*c["h"]>2000)
hlines = sum(1 for y in range(0, h, max(1,h//50)) if sum(1 for x in range(0,w,5) if edge_px[x,y]>128)>w*0.3)
vlines = sum(1 for x in range(0, w, max(1,w//50)) if sum(1 for y in range(0,h,5) if edge_px[x,y]>128)>h*0.3)
shape_cls = "rectangular" if rects > 0 else ("grid_like" if hlines>2 and vlines>2 else "simple")
# Advanced analysis if available
advanced = {}
if cia_ok:
  try:
    advanced = cia.run_full_analysis("${fp.replace(/"/g, '\\"')}", ${knownScale || "None"})
  except: pass
result = {"file":"${f.replace(/"/g, '\\"')}","w":w,"h":h,"edge":edge_ratio,"comps":len(comps),"rects":rects,"hlines":hlines,"vlines":vlines,"shape":shape_cls,"dimensions":advanced.get("dimension_inferences",[])[:5] if advanced.get("dimension_inferences") else [],"_advanced":bool(advanced)}
print(json.dumps(result))
`;
              writeFileSync(pyScript, pyCode);
              const rawOut = execSync(`python3 "${pyScript}"`, { timeout: 30000, encoding: "utf-8" });
              try { execSync(`rm -f "${pyScript}"`, { timeout: 2000 }); } catch {}
              results.push(JSON.parse(rawOut.trim()));
            } catch (e) {
              results.push({ file: f, error: e.message.slice(0, 100) });
            }
          }

          let out = `## Batch Image Measurement: ${dir}\n\n`;
          out += `**${batch.length} images analyzed**\n\n`;
          for (const r of results) {
            out += `- **${r.file}** — ${r.w}×${r.h}px, edge=${r.edge}`;
            if (r.comps !== undefined) out += `, ${r.comps} components, ${r.rects} rectangular`;
            out += `, shape=${r.shape || "?"}`;
            if (r.dimensions && r.dimensions.length > 0) {
              for (const d of r.dimensions.slice(0, 3)) {
                out += ` [${d.orientation || d.type}: ${d.length_px || d.span_px}px`;
                if (d.estimated_mm) out += `→${d.estimated_mm}mm`;
                out += "]";
              }
            }
            if (r._advanced) out += " [full analysis]";
            out += "\n";
          }

          out += "\n### Next Steps\n";
          out += "1. Review measurements above for uncertain/draft dimensions\n";
          out += "2. Use `cad_ingest` with parts derived from these measurements\n";
          out += "3. Or use `cad_ingest_images` to auto-convert strong results to spec\n";
          return out;
        },
      }),
      cad_extract_document: tool({
        description: "Extract text from PDF or DOCX files with page-level tracking. Returns structured text per page/section with dimension hints, confidence markers, and source references.",
        args: {
          file_path: tool.schema.string().describe("Path to the PDF or DOCX file."),
          max_pages: tool.schema.number().optional().describe("Maximum pages to process (default: 20)."),
        },
        async execute(args, ctx) {
          if (!existsSync(args.file_path)) return `File not found: ${args.file_path}`;
          const fp = args.file_path;
          const ext = fp.split(".").pop().toLowerCase();
          if (!["pdf", "docx"].includes(ext)) return `Unsupported format: .${ext}. Use PDF or DOCX.`;

          // Reuse cad_extract_dimensions logic by running its embedded Python
          const pyScript = `/tmp/cad_extract_doc_${Date.now()}.py`;
          writeFileSync(pyScript, `
import sys, json, os, math, subprocess, re, tempfile
from PIL import Image, ImageFilter, ImageStat
from collections import defaultdict
file_path = "${fp.replace(/"/g, '\\"')}"
max_pages = ${args.max_pages || 20}
ext = file_path.rsplit(".",1)[-1].lower()
pages_text = []; tables_data = []; draft_parts = []; dimension_hints = []; measurement_phrases = []
# PDF extraction
if ext == "pdf":
    import struct, zlib
    with open(file_path, "rb") as f: data = f.read()
    objs = re.findall(rb'<(\\d+)\\s+(\\d+)\\s+obj[^>]*>(.*?)endobj', data, re.DOTALL)
    page_num = 0
    for oid, gen, content in objs:
        if b'/Type\\s*/Page' in content[:200]:
            page_num += 1
            if page_num > max_pages: break
            text = ""
            for bt_block in re.findall(rb'BT(.*?)ET', content, re.DOTALL):
                for tj in re.findall(rb'\\(([^)]*?)\\)\\s*Tj', bt_block):
                    text += tj.decode("latin-1", errors="replace") + " "
            pages_text.append({"page": page_num, "text": text.strip(), "char_count": len(text), "scanned": len(text) < 30})
    if page_num == 0:
        try:
            pimg = Image.open(file_path)
            for pi in range(min(pimg.n_frames if hasattr(pimg,"n_frames") else 1, max_pages)):
                pimg.seek(pi); pages_text.append({"page": pi+1, "text": "", "char_count": 0, "scanned": True})
        except: pass
elif ext == "docx":
    try:
        import docx
        doc = docx.Document(file_path)
        for i, para in enumerate(doc.paragraphs):
            t = para.text.strip()
            if t: pages_text.append({"page": i//50+1, "text": t, "char_count": len(t), "scanned": False})
    except: pass
# Dimension pattern scanning
all_text = " ".join(p.get("text","") for p in pages_text)
dim_pattern = re.compile(r'(\\d+)\\s*[×xX]\\s*(\\d+)(?:\\s*[×xX]\\s*(\\d+))?')
for m in dim_pattern.finditer(all_text):
    dim = {"text": m.group(0), "values": [int(m.group(1)), int(m.group(2))]}
    if m.group(3): dim["values"].append(int(m.group(3)))
    dimension_hints.append(dim)
for phrase in ["mm","cm","inch","meter","centimeter","millimeter","diameter","radius"]:
    for m in re.finditer(r'(\\d+\\.?\\d*)\\s*' + re.escape(phrase), all_text, re.IGNORECASE):
        measurement_phrases.append({"value": m.group(0), "unit": phrase})
result = {"pages": pages_text, "page_count": len(pages_text), "total_text": all_text, "word_count": len(all_text.split()), "dimension_hints": dimension_hints[:20], "measurement_phrases": measurement_phrases[:20]}
print(json.dumps(result))
`);
          try {
            const rawOut = execSync(`python3 "${pyScript}"`, { timeout: 30000, encoding: "utf-8" });
            try { execSync(`rm -f "${pyScript}"`, { timeout: 2000 }); } catch {}
            const result = JSON.parse(rawOut.trim());
            let out = `## Document Extraction: ${basename(args.file_path)}\n\n`;
            out += `**${result.page_count} pages**\n`;
            out += `**${result.word_count} words extracted**\n\n`;
            if (result.pages) {
              for (const p of result.pages.slice(0, 5)) {
                const label = p.scanned ? " [SCANNED — use cad_extract_dimensions for image analysis]" : "";
                out += `- Page ${p.page}: ${p.char_count} chars${label}\n`;
                if (p.text && !p.scanned) {
                  out += `  \`${p.text.slice(0, 120).replace(/\n/g, " ")}\`\n`;
                }
              }
              if (result.pages.length > 5) out += `- ... and ${result.pages.length - 5} more pages\n`;
            }
            if (result.dimension_hints && result.dimension_hints.length > 0) {
              out += `\n### Dimension Hints (${result.dimension_hints.length})\n`;
              for (const d of result.dimension_hints.slice(0, 10)) {
                out += `- \`${d.text}\` → [${d.values.join(", ")}]`;
                if (d.values.length === 3) out += " (3D)";
                out += "\n";
              }
            }
            if (result.measurement_phrases && result.measurement_phrases.length > 0) {
              out += `\n### Measurement References (${result.measurement_phrases.length})\n`;
              for (const m of result.measurement_phrases.slice(0, 5)) {
                out += `- \`${m.value}\`\n`;
              }
            }
            return out;
          } catch (e) {
            try { execSync(`rm -f "${pyScript}"`, { timeout: 2000 }); } catch {}
            return `Extraction failed: ${e.message.slice(0, 200)}`;
          }
        },
      }),
      cad_bootstrap: tool({
        description: "Scan a mixed directory of PDFs, DOCX, images, JSON extraction files, and text files; route each to the correct extraction path; merge results via resolveConflicts; check auto-build threshold; and optionally auto-compile.",
        args: {
          directory: tool.schema.string().describe("Directory path with source files to bootstrap from."),
          project_name: tool.schema.string().optional().describe("Project name (defaults to directory basename)."),
          max_pages: tool.schema.number().optional().describe("Max pages per document (default: 10)."),
          auto_ingest: tool.schema.boolean().optional().describe("Auto-compile if all parts are spec-ready (default: false)."),
        },
        async execute(args, ctx) {
          const dir = args.directory;
          const projName = args.project_name || basename(dir) || "bootstrap_project";
          const maxPages = args.max_pages || 10;

          if (!existsSync(dir)) return `Directory not found: ${dir}`;

          // Scan files
          const allFiles = readdirSync(dir).sort();
          const extImage = new Set(["png", "jpg", "jpeg", "webp", "bmp", "gif"]);
          const extDoc = new Set(["pdf", "docx"]);
          const extText = new Set(["txt", "md", "csv", "json"]);

          const imageFiles = allFiles.filter(f => extImage.has(f.split(".").pop().toLowerCase()));
          const docFiles = allFiles.filter(f => extDoc.has(f.split(".").pop().toLowerCase()));
          const textFiles = allFiles.filter(f => extText.has(f.split(".").pop().toLowerCase()));
          const unsupported = allFiles.filter(f => {
            const e = f.split(".").pop().toLowerCase();
            return !extImage.has(e) && !extDoc.has(e) && !extText.has(e);
          });

          let out = `## Bootstrap: ${basename(dir)}\n\n`;
          out += `**Found:** ${imageFiles.length} images, ${docFiles.length} documents, ${textFiles.length} text files`;
          if (unsupported.length) out += `, ${unsupported.length} unsupported`;
          out += "\n\n";

          // Step 1: Process image files with 16-type shape classification
          const imageResults = [];
          if (imageFiles.length > 0) {
            out += `### Step 1: Image Analysis (${imageFiles.length} files)\n`;
            for (const img of imageFiles.slice(0, 10)) {
              const fp = join(dir, img);
              try {
                const pyScript = `/tmp/cad_boot_img_${Date.now()}_${Math.random().toString(36).slice(2,6)}.py`;
                writeFileSync(pyScript, `
import sys, json, os, math
sys.path.insert(0, "${SKILL_DIR.replace(/"/g, '\\"')}/scripts")
try: import cad_image_analysis as cia; cok=True
except: cok=False
from PIL import Image, ImageFilter, ImageStat
img = Image.open("${fp.replace(/"/g, '\\"')}")
w, h = img.size
gray = img.convert("L")
edges = gray.filter(ImageFilter.FIND_EDGES)
estat = ImageStat.Stat(edges)
er = round(estat.mean[0]/255.0 if estat.mean else 0, 4)
edge_px = edges.load()
visited = [[False]*w for _ in range(h)]
comps = []
for y in range(2,h-2,2):
  for x in range(2,w-2,2):
    if not visited[y][x] and edge_px[x,y]>64:
      stack, pxls = [(x,y)], []
      while stack and len(pxls)<10000:
        cx,cy = stack.pop()
        if cx<0 or cx>=w or cy<0 or cy>=h or visited[cy][cx] or edge_px[cx,cy]<=64: continue
        visited[cy][cx]=True; pxls.append((cx,cy))
        for dx,dy in [(1,0),(-1,0),(0,1),(0,-1)]: stack.append((cx+dx,cy+dy))
      if len(pxls)>50:
        xs=[p[0] for p in pxls]; ys=[p[1] for p in pxls]
        cw=max(xs)-min(xs); ch=max(ys)-min(ys)
        comps.append({"bbox":[min(xs),min(ys),max(xs),max(ys)],"w":cw,"h":ch,"area":len(pxls),"cx":(min(xs)+max(xs))/2,"cy":(min(ys)+max(ys))/2})
comps = [c for c in comps if c["w"]>20 and c["h"]>20]
# 16-type shape classification from component metrics
if len(comps)>0:
  largest = max(comps, key=lambda c:c["area"])
  ar = largest["w"]/max(largest["h"],1)
  circ = 4*math.pi*largest["area"]/((2*(largest["w"]+largest["h"]))**2+1)
  rect = largest["area"]/max(largest["w"]*largest["h"],1)
  nested = sum(1 for c2 in comps if c2["cx"]>largest["bbox"][0] and c2["cx"]<largest["bbox"][2] and c2["cy"]>largest["bbox"][1] and c2["cy"]<largest["bbox"][3] and c2["area"]<largest["area"]*0.5)
  num_comp = len(comps)
  has_inner = nested > 0
  if circ > 0.7:
    shape_cls = "cylinder" if ar > 1.5 else "sphere"
  elif rect > 0.7:
    if ar < 1.5 and num_comp >= 2 and has_inner: shape_cls = "slot"
    elif ar < 1.7: shape_cls = "solid_block"
    elif ar < 5.0: shape_cls = "hollow_container" if has_inner else "extrusion"
    else: shape_cls = "extrusion"
  elif rect > 0.5:
    shape_cls = "lshape" if ar > 2.0 and ar < 4.0 else "irregular"
  else:
    shape_cls = "irregular"
  shape_cls = shape_cls.replace("block","solid_block").replace("shape","lshape")
else:
  shape_cls = "unclear"
result = {"file":"${img}","w":w,"h":h,"edge":er,"components":len(comps),"shape":shape_cls,"comps_detail":comps[:5]}
if cok:
  try:
    adv = cia.run_full_analysis("${fp.replace(/"/g, '\\"')}")
    result["cia"] = {"containment": len(adv.get("containment",[])), "roles": list(adv.get("function_roles",{}).keys()), "dims": adv.get("dimension_inferences",[])[:3], "graph": adv.get("component_graph_edges",[])[:3], "_3d": adv.get("_3d_estimates",[]), "evidence": adv.get("_evidence",{}), "templates": adv.get("_template_scores",{})}
  except: pass
print(json.dumps(result))
`);
                const rawOut = execSync(`python3 "${pyScript}"`, { timeout: 30000, encoding: "utf-8" });
                try { execSync(`rm -f "${pyScript}"`, { timeout: 2000 }); } catch {}
                const r = JSON.parse(rawOut.trim());
                imageResults.push(r);
                out += `- **${r.file}** — ${r.w}×${r.h}px, shape=**${r.shape}**, ${r.components} components`;
                if (r.cia) {
                  out += ` [`;
                  if (r.cia.dims && r.cia.dims.length > 0) out += `${r.cia.dims.length} dims, `;
                  if (r.cia.containment > 0) out += `${r.cia.containment} contain, `;
                  if (r.cia.roles && r.cia.roles.length > 0) out += `roles: ${r.cia.roles.join(",")}, `;
                  if (r.cia.graph && r.cia.graph.length > 0) out += `${r.cia.graph.length} edges`;
                  out += `]`;
                  // Evidence report (from CIA)
                  if (r.cia.evidence && r.cia.evidence.signals_ignored) {
                    out += ` [metadata ignored: ${r.cia.evidence.signals_ignored.length} signals]`;
                  }
                  if (r.cia.templates && r.cia.templates.winner) {
                    out += ` [template: ${r.cia.templates.winner} @ ${r.cia.templates.winner_score}]`;
                  }
                }
                out += "\n";
              } catch (e) { out += `- ${img}: ${e.message.slice(0, 80)}\n`; }
            }
            if (imageFiles.length > 10) out += `- ... and ${imageFiles.length - 10} more images\n`;

            // Multi-view fusion for 2+ images
            if (imageResults.length >= 2) {
              try {
                const imagePaths = imageResults.map(r => r.file).map(f => join(dir, f));
                const pathsJson = JSON.stringify(imagePaths);
                const fusionScript = `/tmp/cad_fusion_${Date.now()}.py`;
                writeFileSync(fusionScript, `
import sys, json, os
sys.path.insert(0, "${SKILL_DIR.replace(/"/g, '\\"')}/scripts")
try:
  import cad_image_analysis as cia
  f_paths = json.loads('${pathsJson.replace(/'/g, "\\'").replace(/\\/g, "/")}')
  results = []
  for fp in f_paths:
    if os.path.exists(fp):
      try: results.append(cia.run_full_analysis(fp))
      except: pass
  if len(results) >= 2:
    fused = cia.fuse_image_analyses(results, f_paths[:len(results)])
    print(json.dumps({"fused":True,"parts":len(fused.get("parts",[])),"views":len(results),"_3d_method":fused.get("method",""),"_3d_confident":fused.get("_3d_confident",False),"dim_confs":fused.get("dimension_confidence",{})}))
  else:
    print(json.dumps({"fused":False,"reason":"insufficient_views"}))
except Exception as e:
  print(json.dumps({"fused":False,"error":str(e)[:200]}))
`);
                const fOut = execSync(`python3 "${fusionScript}"`, { timeout: 30000, encoding: "utf-8" });
                try { execSync(`rm -f "${fusionScript}"`, { timeout: 2000 }); } catch {}
                const fusion = JSON.parse(fOut.trim());
                if (fusion.fused) {
                  out += `\n**Multi-view fusion:** ${fusion.views} views merged → ${fusion.parts} parts (3D method: ${fusion._3d_method}, confident: ${fusion._3d_confident})\n`;
                  if (fusion.dim_confs && Object.keys(fusion.dim_confs).length > 0) out += `  Dimension confidence: ${JSON.stringify(fusion.dim_confs)}\n`;
                }
              } catch (e) { out += `\nMulti-view fusion skipped: ${e.message.slice(0, 80)}\n`; }
            }
            out += "\n";
          }

          // Step 2: Process document files
          if (docFiles.length > 0) {
            out += `### Step 2: Document Extraction (${docFiles.length} files)\n`;
            for (const doc of docFiles.slice(0, 3)) {
              const fp = join(dir, doc);
              try {
                const pyScript = `/tmp/cad_boot_doc_${Date.now()}.py`;
                const ext = doc.split(".").pop().toLowerCase();
                writeFileSync(pyScript, `
import sys, json, os, re, subprocess
file_path = "${fp.replace(/"/g, '\\"')}"
ext = "${ext}"
max_pages = ${maxPages}
pages_text = []; dimension_hints = []; measurement_phrases = []
if ext == "pdf":
    import struct, zlib
    with open(file_path, "rb") as f: data = f.read()
    objs = re.findall(rb'<(\\d+)\\s+(\\d+)\\s+obj[^>]*>(.*?)endobj', data, re.DOTALL)
    pn = 0
    for oid, gen, content in objs:
        if b'/Type\\s*/Page' in content[:200]:
            pn += 1
            if pn > max_pages: break
            text = ""
            for bt in re.findall(rb'BT(.*?)ET', content, re.DOTALL):
                for tj in re.findall(rb'\\(([^)]*?)\\)\\s*Tj', bt):
                    text += tj.decode("latin-1", errors="replace") + " "
            pages_text.append({"page": pn, "text": text.strip(), "chars": len(text), "scanned": len(text)<30})
elif ext == "docx":
    try:
        import docx
        doc = docx.Document(file_path)
        for i, p in enumerate(doc.paragraphs):
            t = p.text.strip()
            if t: pages_text.append({"page": i//50+1, "text": t, "chars": len(t), "scanned": False})
    except: pass
all_t = " ".join(p.get("text","") for p in pages_text)
for m in re.finditer(r'(\\d+)\\s*[×xX]\\s*(\\d+)(?:\\s*[×xX]\\s*(\\d+))?', all_t):
    dim = {"text": m.group(0), "values": [int(m.group(1)), int(m.group(2))]}
    if m.group(3): dim["values"].append(int(m.group(3)))
    dimension_hints.append(dim)
r = {"pages": len(pages_text), "words": len(all_t.split()), "dims": dimension_hints[:10], "scanned_pages": sum(1 for p in pages_text if p.get("scanned"))}
print(json.dumps(r))
`);
                const rawOut = execSync(`python3 "${pyScript}"`, { timeout: 30000, encoding: "utf-8" });
                try { execSync(`rm -f "${pyScript}"`, { timeout: 2000 }); } catch {}
                const r = JSON.parse(rawOut.trim());
                out += `- **${doc}** — ${r.pages} pages, ${r.words} words`;
                if (r.scanned_pages > 0) out += `, ${r.scanned_pages} scanned (run cad_extract_dimensions manually)`;
                if (r.dims && r.dims.length > 0) out += `, ${r.dims.length} dimension hints`;
                out += "\n";
              } catch (e) { out += `- ${doc}: ${e.message.slice(0, 80)}\n`; }
            }
            if (docFiles.length > 3) out += `- ... and ${docFiles.length - 3} more documents\n`;
            out += "\n";
          }

          // Step 3: Process JSON extraction files
          const jsonFiles = textFiles.filter(f => f.endsWith(".json"));
          if (jsonFiles.length > 0) {
            out += `### Step 3: Extraction Files (${jsonFiles.length} JSON)\n`;
            for (const jf of jsonFiles) {
              try {
                const jd = JSON.parse(readFileSync(join(dir, jf), "utf-8"));
                const parts = jd.parts ? jd.parts.length : (Array.isArray(jd) ? jd.length : 0);
                out += `- **${jf}** — ${parts} parts defined\n`;
              } catch { out += `- **${jf}** — unparseable JSON\n`; }
            }
            out += "\n";
          }

          // Step 4: Initialize project + merge
          out += `### Step 4: Initialize & Merge\n`;
          const initName = projName.replace(/[^a-zA-Z0-9_-]/g, "_");
          let projectDir = null;

          // Try to find or create project
          const cadOutputDir = join(dir, "cad-output", initName);
          mkdirSync(cadOutputDir, { recursive: true });
          const statePath = join(cadOutputDir, ".cad_state.json");
          if (!existsSync(statePath)) {
            const state = { name: initName, root: cadOutputDir, created: new Date().toISOString(), spec: null, compiled: false, rendered: false, parts: [], revision_history: [], extraction_sources: [] };
            writeFileSync(statePath, JSON.stringify(state, null, 2));
            out += "✓ Project initialized\n";
          } else {
            out += "✓ Project found\n";
          }
          projectDir = cadOutputDir;

          // Step 5: Auto-compile threshold and next steps
          out += `\n### Step 5: Auto-Build Assessment\n`;
          const autoBuild = args.auto_ingest;

          // Auto-ingest: extract parts from image dimensions and compile
          if (autoBuild && imageResults.length > 0) {
            const specsOut = [];
            for (const r of imageResults) {
              if (r.cia && r.cia.dims && r.cia.dims.length > 0) {
                const baseName = r.file.replace(/\.[^.]+$/, "");
                for (const d of r.cia.dims) {
                  const lenPx = d.length_px || d.span_px || 0;
                  if (lenPx > 0) {
                    specsOut.push({ name: `${baseName}_${d.orientation || d.type || "dim"}`, type: "solid_block", size: [Math.round(lenPx * 0.5) || 30, 30, 30] });
                  }
                }
              }
            }
            if (specsOut.length > 0) {
              out += `\n**Auto-ingest:** ${specsOut.length} draft parts extracted\n`;
              const specPath = join(projectDir, `${initName}.yaml`);
              const yamlParts = specsOut.map((p, i) => `  ${p.name}_${i}:\n    geometry:\n      type: ${p.type}\n      size: [${p.size.join(", ")}]\n      wall: 3\n`).join("\n");
              const yamlContent = `meta:\n  name: "${initName}"\n  _source: "bootstrap_auto"\n  _3d_method: "single_view_projection"\nparts:\n${yamlParts}\nassembly:\n`;
              writeFileSync(specPath, yamlContent);
              out += `> Spec written to \`${specPath}\`\n`;
            } else {
              out += "No dimension data for auto-ingest. Manually extract dimensions.\n";
            }
          } else if (imageFiles.length >= 1 || docFiles.length >= 1 || jsonFiles.length >= 1) {
            out += "Source material found. To continue:\n";
            out += "- For images: use `cad_ingest_images` with `auto_ingest=true`\n";
            out += "- For documents: review extracted text then use `cad_ingest`\n";
            out += "- For JSON extraction files: use `cad_merge_all` to merge\n";
            out += "- Then: `cad_compile` → `cad_render` → `cad_preview`\n";
          } else {
            out += "No source material found to extract.\n";
          }

          const summary = `# ${initName}\n\nBootstrapped from ${dir}\nFiles: ${imageFiles.length} images, ${docFiles.length} documents, ${textFiles.length} text files\n`;
          writeFileSync(join(projectDir, "BOOTSTRAP.md"), summary);

          out += `\nProject: \`${projectDir}\`\n`;
          return out;
        },
      }),
    },
  };
  Object.assign(_crossTools, plugin.tool);
  return plugin;
};
