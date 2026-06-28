"""
Quick preview: render district_borders.svg from data/subdistricts.json.

Rendering approach:
  - Districts: solid thick outline, no fill
  - Subdistricts: subtle filled polygon (same district color, low opacity)
    with a thin dashed outline. The edge of each filled zone IS the visible
    dividing line — no explicit midline computation required.
  - Labels: subdistrict names at geometric centroid, district names larger

Output: scripts/output/district_borders.svg
"""
import json
import os
from shapely.geometry import Polygon as ShapelyPolygon

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT   = os.path.dirname(SCRIPT_DIR)
OUTPUT_DIR  = os.path.join(SCRIPT_DIR, "output")
DATA_DIR    = os.path.join(REPO_ROOT, "data")

from map_constants import (
    WORLD_MIN_X, WORLD_MAX_X, WORLD_MIN_Y, WORLD_MAX_Y,
    IMG_SIZE, cet_to_pixel,
)

# Colors from game Ink styles (see docs/district-hierarchy.md)
DISTRICT_COLORS = {
    "city_center":    "#ffd741",   # MainColors.Yellow
    "watson":         "#ff3e34",   # MainColors.CombatRed
    "westbrook":      "#ff5100",   # MainColors.Orange
    "heywood":        "#1ded83",   # MainColors.Green
    "santo_domingo":  "#5ef6ff",   # MainColors.Blue
    "pacifica":       "#ff6158",   # MainColors.Red
    "dogtown":        "#00a32c",   # MainColors.DarkGreen
    "ncx_morro_rock": "#349197",   # MainColors.MildBlue
    "badlands":       "#c8a882",   # Sandy brown (Badlands aesthetic)
}


def world_to_pixel(wx, wy):
    return cet_to_pixel(wx, wy)


def pts_str(coords):
    return " ".join(
        f"{world_to_pixel(x, y)[0]:.1f},{world_to_pixel(x, y)[1]:.1f}"
        for x, y in coords
    )


def polygon_centroid(coords):
    """Compute the geometric centroid of a polygon in pixel space using Shapely.

    Shapely's centroid is the center of mass, which handles non-convex and
    irregular polygons correctly (unlike a simple vertex average).
    """
    shape = ShapelyPolygon(coords)
    c = shape.centroid
    # Convert CET centroid to pixel space
    return world_to_pixel(c.x, c.y)


def main():
    with open(os.path.join(DATA_DIR, "subdistricts.json")) as f:
        data = json.load(f)

    svg_groups = []
    label_lines = []  # Collect labels separately so they render on top

    for district in data["districts"]:
        color = DISTRICT_COLORS.get(district["id"], "#ffffff")
        is_badlands = district.get("polygon") is None
        lines = [f'  <g id="{district["id"]}" data-name="{district["name"]}">']

        subs = district.get("subdistricts", [])

        if subs:
            for sub in subs:
                # Skip non-canonical subdistricts in standard rendering
                # (they get their own distinct style below)
                if not sub.get("canonical", True):
                    cx, cy = polygon_centroid(sub["polygon"])
                    # Render with a distinct "cut content" style
                    lines.append(
                        f'    <polygon points="{pts_str(sub["polygon"])}" '
                        f'fill="{color}" fill-opacity="0.08" '
                        f'stroke="{color}" stroke-width="2" '
                        f'stroke-dasharray="4,8" stroke-opacity="0.4" '
                        f'id="{sub["id"]}" data-name="{sub["name"]}"/>'
                    )
                    label_lines.append(
                        f'    <text x="{cx:.0f}" y="{cy:.0f}" '
                        f'fill="{color}" font-size="22" font-family="sans-serif" '
                        f'font-style="italic" text-anchor="middle" '
                        f'dominant-baseline="central" opacity="0.6">'
                        f'{sub["name"]} ✦</text>'
                    )
                    continue
                if is_badlands:
                    # Badlands subdistricts: fill + dashed border
                    lines.append(
                        f'    <polygon points="{pts_str(sub["polygon"])}" '
                        f'fill="{color}" fill-opacity="0.10" '
                        f'stroke="{color}" stroke-width="2" '
                        f'stroke-dasharray="8,12" stroke-opacity="0.6" '
                        f'id="{sub["id"]}" data-name="{sub["name"]}"/>'
                    )
                else:
                    # City subdistricts: subtle fill + dashed border
                    lines.append(
                        f'    <polygon points="{pts_str(sub["polygon"])}" '
                        f'fill="{color}" fill-opacity="0.15" '
                        f'stroke="{color}" stroke-width="3" '
                        f'stroke-dasharray="8,12" stroke-opacity="0.5" '
                        f'id="{sub["id"]}" data-name="{sub["name"]}"/>'
                    )
                # Label at geometric centroid
                cx, cy = polygon_centroid(sub["polygon"])
                label_lines.append(
                    f'    <text x="{cx:.0f}" y="{cy:.0f}" '
                    f'fill="{color}" font-size="28" font-family="sans-serif" '
                    f'text-anchor="middle" dominant-baseline="central" '
                    f'opacity="0.9">{sub["name"]}</text>'
                )
        else:
            # No subdistricts (Dogtown, NCX) — fill the district itself
            if district.get("polygon"):
                lines.append(
                    f'    <polygon points="{pts_str(district["polygon"])}" '
                    f'fill="{color}" fill-opacity="0.15" stroke="none"/>'
                )

        # District outline on top — solid, no fill, always visible
        if district.get("polygon"):
            lines.append(
                f'    <polygon points="{pts_str(district["polygon"])}" '
                f'fill="none" stroke="{color}" stroke-width="3" stroke-opacity="0.8"/>'
            )
            # District name label (larger)
            cx, cy = polygon_centroid(district["polygon"])
            label_lines.append(
                f'    <text x="{cx:.0f}" y="{cy:.0f}" '
                f'fill="{color}" font-size="42" font-weight="bold" font-family="sans-serif" '
                f'text-anchor="middle" dominant-baseline="central" '
                f'opacity="0.7">{district["name"]}</text>'
            )
        elif is_badlands and subs:
            # Badlands has no single polygon — place label halfway between
            # Red Peaks and Vasquez Pass on X axis, use union centroid for Y
            from shapely.ops import unary_union
            union = unary_union([ShapelyPolygon(s["polygon"]).buffer(0) for s in subs])
            c = union.centroid
            _, cy = world_to_pixel(c.x, c.y)

            # Find Red Peaks and Vasquez Pass centroids for X midpoint
            rp = next((s for s in subs if s["id"] == "red_peaks"), None)
            vp = next((s for s in subs if s["id"] == "vasquez_pass"), None)
            if rp and vp:
                rp_c = ShapelyPolygon(rp["polygon"]).centroid
                vp_c = ShapelyPolygon(vp["polygon"]).centroid
                mid_x = (rp_c.x + vp_c.x) / 2
                cx, _ = world_to_pixel(mid_x, c.y)
            else:
                cx, _ = world_to_pixel(c.x, c.y)

            label_lines.append(
                f'    <text x="{cx:.0f}" y="{cy:.0f}" '
                f'fill="{color}" font-size="42" font-weight="bold" font-family="sans-serif" '
                f'text-anchor="middle" dominant-baseline="central" '
                f'opacity="0.7">{district["name"]}</text>'
            )

        lines.append("  </g>")
        svg_groups.append("\n".join(lines))

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {IMG_SIZE} {IMG_SIZE}" style="background:#0a192f">\n'
        + "\n".join(svg_groups)
        + '\n  <g id="labels">\n'
        + "\n".join(label_lines)
        + "\n  </g>"
        + "\n</svg>\n"
    )

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out = os.path.join(OUTPUT_DIR, "district_borders.svg")
    with open(out, "w", encoding="utf-8") as f:
        f.write(svg)

    total_subs = sum(len(d.get("subdistricts", [])) for d in data["districts"])
    print(f"Written {out}")
    print(f"  {len(data['districts'])} districts, {total_subs} sub-districts")


if __name__ == "__main__":
    main()
