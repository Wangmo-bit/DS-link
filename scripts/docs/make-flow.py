"""Optional offline GIF assembly after npm run docs:assets (requires Pillow).
Frames are fictional component fixtures, not a live Host recording.
"""
from pathlib import Path
import hashlib
import json
from PIL import Image

root = Path(__file__).resolve().parents[2]
frames_dir = root / 'output/playwright/docs'
assets = root / 'docs/assets'
manifest_path = assets / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
for language in ('zh', 'en'):
    originals = [Image.open(frames_dir / f'flow-{language}-{i}.png').convert('RGB') for i in range(3)]
    size = (max(im.width for im in originals), max(im.height for im in originals))
    frames = []
    for image in originals:
        canvas = Image.new('RGB', size, '#131416')
        canvas.paste(image, (0, 0))
        frames.append(canvas.quantize(colors=128))
    path = assets / f'flow-{language}.gif'
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=[1400, 1700, 3500], loop=0, optimize=True, disposal=2)
    manifest['files'][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    for image in originals:
        image.close()
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print('Created two labelled synthetic flow animations; no DSH session was used.')
