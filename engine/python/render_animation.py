"""Render bounded scene data from the configured Harness author. No model code execution."""
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
font_path = sys.argv[3]
fonts = {}
def font(size):
    if size not in fonts:
        fonts[size] = ImageFont.truetype(font_path, size)
    return fonts[size]

def state(frames, frame):
    if not frames:
        return (0, 0, 1)
    if frame <= frames[0]["f"]:
        p = frames[0]
        return p["dx"], p["dy"], p["opacity"]
    for a, b in zip(frames, frames[1:]):
        if frame <= b["f"]:
            t = (frame-a["f"])/(b["f"]-a["f"])
            t = t*t*(3-2*t)
            return tuple(a[k]+(b[k]-a[k])*t for k in ("dx","dy","opacity"))
    p = frames[-1]
    return p["dx"], p["dy"], p["opacity"]

cmd = ["ffmpeg","-nostdin","-v","error","-n","-f","rawvideo","-pix_fmt","rgb24","-s","540x960",
       "-r","30","-i","-","-vf","scale=1080:1920:flags=lanczos","-an","-c:v","libx264","-threads","4",
       "-preset","fast","-pix_fmt","yuv420p",sys.argv[2]]
process = subprocess.Popen(cmd, stdin=subprocess.PIPE)
try:
    start = 0
    for scene in spec["scenes"]:
        for frame in range(scene["end"]-start):
            im = Image.new("RGB",(540,960),scene["background"])
            draw = ImageDraw.Draw(im, "RGBA")
            for el in scene["elements"]:
                dx, dy, opacity = state(el.get("motion"), frame)
                if opacity == 0:
                    continue
                x, y = round((el["x"]+dx)/2), round((el["y"]+dy)/2)
                fill = (*bytes.fromhex(el["fill"][1:]), round(255*opacity))
                if el["type"] == "rect":
                    bounds = (x,y,x+el["w"]//2,y+el["h"]//2)
                    draw.rounded_rectangle(bounds,radius=el.get("radius",0)//2,fill=fill)
                else:
                    draw.text((x,y),el["text"],font=font(max(1,el["size"]//2)),fill=fill)
            process.stdin.write(im.tobytes())
        start = scene["end"]
finally:
    process.stdin.close()
    if process.wait():
        raise RuntimeError("FFmpeg could not encode Harness animation")
