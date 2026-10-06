"""Export the generated kukuhou mascot as application and Windows tray icons."""
from pathlib import Path
from PIL import Image, ImageOps

resources = Path(__file__).resolve().parents[1] / "resources"
source = Image.open(resources / "kukuhou-icon.png").convert("RGBA")
sizes = [(size, size) for size in (16, 24, 32, 48, 64, 128, 256)]
source.save(resources / "icon.ico", sizes=sizes, append_images=[source.resize(size, Image.Resampling.NEAREST) for size in sizes])
tray_sizes = [(size, size) for size in (16, 20, 24, 32, 48, 256)]
source.save(resources / "tray.ico", sizes=tray_sizes, append_images=[source.resize(size, Image.Resampling.NEAREST) for size in tray_sizes])
stopped = ImageOps.grayscale(source).convert("RGBA")
stopped.putalpha(source.getchannel("A"))
stopped.save(resources / "trayStopped.ico", sizes=tray_sizes, append_images=[stopped.resize(size, Image.Resampling.NEAREST) for size in tray_sizes])
for size, name in ((24, "tray.png"), (48, "tray@2x.png")):
    source.resize((size, size), Image.Resampling.NEAREST).save(resources / name)
    stopped.resize((size, size), Image.Resampling.NEAREST).save(resources / name.replace("tray", "trayStopped"))
for size in (512, 1024):
    source.resize((size, size), Image.Resampling.NEAREST).save(resources / "icons" / f"{size}x{size}.png")
print("Exported kukuhou app and tray icons with alpha transparency.")
