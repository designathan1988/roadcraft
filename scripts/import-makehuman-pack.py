"""Imports MakeHuman community asset-pack items (.mhclo + .obj + .mhmat + textures) into the game's proxy format.

Writes, per item, `<name>.json` + `<name>.bin` (roadcraft-people-proxy/1), `<name>.webp` (its diffuse texture, 512 px RGBA) and
`<name>-thumb.webp` (160 px), and adds it to `community.json` (dropping it from `skipped`). Items already imported are left alone.

The format, as the earlier importer wrote it (checked against items it made):
  - one game vertex per .obj texture coordinate (vertices split at UV seams), positioned by the .mhclo line of the .obj vertex that uses it;
  - refs u32 x3, weights f32 x3, offsets f32 x3 copied from the .mhclo; uvs f32 x2 with v flipped (1 - v); quads split (a,b,c) (a,c,d);
  - scaleRefs [x0 x1 y0 y1 z0 z1] and scaleBase [x y z] from x_scale / y_scale / z_scale; deleteVerts from delete_verts ranges.

Usage: python -I scripts/import-makehuman-pack.py <pack-folder> <pack-name> <pack-url> <licence-default>
"""
import json
import os
import struct
import sys

from PIL import Image, ImageFile, PngImagePlugin

# Some packs' PNGs carry huge EXIF/zTXt chunks that pass Pillow's safety limit (the earlier importer skipped them for that).
PngImagePlugin.MAX_TEXT_CHUNK = 1 << 28
ImageFile.LOAD_TRUNCATED_IMAGES = True

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'models', 'people', 'proxies')

# The kind of item a pack holds (by the pack's name), as the wardrobe sorts them; packs of body parts and animals are not worn here.
KINDS = {
    'hair': 'hair', 'dress': 'dress', 'pants': 'bottom', 'shirts': 'top', 'skirts': 'skirt', 'suits': 'suit', 'shoes': 'shoes', 'hats': 'hat',
    'glasses': 'glasses', 'gloves': 'gloves', 'masks': 'mask', 'equipment': 'equipment', 'underwear': 'underwear', 'eyebrows': 'eyebrows',
    'eyelashes': 'eyelashes',
}
LICENCES = {'cc0': 'CC0-1.0', 'cc-by': 'CC-BY-4.0', 'ccby': 'CC-BY-4.0', 'cc by': 'CC-BY-4.0'}


def licence_of(text, default):
    t = text.strip().lower()
    for k, v in LICENCES.items():
        if t.startswith(k):
            return v
    return default


def parse_mhclo(path):
    info = {'tags': [], 'verts': [], 'delete': [], 'scale': {}, 'author': 'unknown', 'licence': None, 'z_depth': 50}
    lines = open(path, encoding='utf8', errors='replace').read().split('\n')
    section = None
    for raw in lines:
        line = raw.strip()
        if line.startswith('#'):
            body = line[1:].strip()
            if body.lower().startswith('author:'):
                info['author'] = body.split(':', 1)[1].strip() or 'unknown'
            elif body.lower().startswith('license:'):
                info['licence'] = body.split(':', 1)[1].strip()
            continue
        if not line:
            if section == 'verts':
                section = None
            continue
        parts = line.split()
        key = parts[0]
        if key == 'verts':
            section = 'verts'
            continue
        if key == 'delete_verts':
            section = 'delete'
            continue
        if section == 'verts' and key[0].isdigit():
            nums = parts
            if len(nums) >= 9:
                info['verts'].append(([int(nums[0]), int(nums[1]), int(nums[2])], [float(x) for x in nums[3:6]], [float(x) for x in nums[6:9]]))
            else:
                info['verts'].append(([int(nums[0])] * 3, [1.0, 0.0, 0.0], [0.0, 0.0, 0.0]))
            continue
        if section == 'delete' and (key[0].isdigit() or key == '-'):
            tokens = parts
            i = 0
            while i < len(tokens):
                if i + 2 < len(tokens) and tokens[i + 1] == '-':
                    info['delete'].extend(range(int(tokens[i]), int(tokens[i + 2]) + 1))
                    i += 3
                else:
                    if tokens[i] != '-':
                        info['delete'].append(int(tokens[i]))
                    i += 1
            continue
        section = None if section == 'delete' and not key[0].isdigit() else section
        if key == 'tag':
            info['tags'].append(' '.join(parts[1:]).lower())
        elif key in ('obj_file', 'material', 'name'):
            info[key] = ' '.join(parts[1:])
        elif key in ('x_scale', 'y_scale', 'z_scale'):
            info['scale'][key[0]] = (int(parts[1]), int(parts[2]), float(parts[3]))
        elif key == 'z_depth':
            info['z_depth'] = int(parts[1])
    return info


def parse_obj(path):
    vs, vts, faces = 0, [], []
    for line in open(path, encoding='utf8', errors='replace'):
        p = line.split()
        if not p:
            continue
        if p[0] == 'v':
            vs += 1
        elif p[0] == 'vt':
            vts.append((float(p[1]), float(p[2])))
        elif p[0] == 'f':
            faces.append([tuple(int(x) - 1 if x else -1 for x in (c.split('/') + [''])[:2]) for c in p[1:]])
    return vs, vts, faces


def parse_mhmat(path):
    mat = {'transparent': False, 'backfaceCull': True, 'diffuseTexture': None}
    if not os.path.exists(path):
        return mat
    for line in open(path, encoding='utf8', errors='replace'):
        p = line.split(None, 1)
        if len(p) < 2:
            continue
        if p[0] == 'transparent':
            mat['transparent'] = p[1].strip().lower() == 'true'
        elif p[0] == 'backfaceCull':
            mat['backfaceCull'] = p[1].strip().lower() == 'true'
        elif p[0] == 'diffuseTexture':
            mat['diffuseTexture'] = p[1].strip()
    return mat


def long_path(path):
    """A Windows path opened through the extended-length prefix (deep pack folders pass 260 characters)."""
    path = os.path.abspath(path)
    prefix = '\\\\?\\'
    return prefix + path if os.name == 'nt' and not path.startswith(prefix) else path


def convert(folder, name, pack, url, default_licence):
    folder = long_path(folder)
    mhclo = os.path.join(folder, name + '.mhclo')
    info = parse_mhclo(mhclo)
    obj_path = os.path.join(folder, info.get('obj_file', name + '.obj'))
    nv, vts, faces = parse_obj(obj_path)
    if len(info['verts']) != nv:
        raise ValueError(f'{len(info["verts"])} mhclo vertices for {nv} obj vertices')
    if not vts:
        raise ValueError('no texture coordinates')
    # One game vertex per texture coordinate, from the obj vertex that uses it.
    vert_of_vt = [-1] * len(vts)
    index = []
    for f in faces:
        ids = []
        for v, vt in f:
            if vt < 0:
                raise ValueError('a face without texture coordinates')
            if vert_of_vt[vt] < 0:
                vert_of_vt[vt] = v
            ids.append(vt)
        for k in range(1, len(ids) - 1):
            index += [ids[0], ids[k], ids[k + 1]]
    n = len(vts)
    refs, weights, offsets, uvs = [], [], [], []
    for i in range(n):
        v = vert_of_vt[i] if vert_of_vt[i] >= 0 else 0
        r, w, o = info['verts'][v]
        refs += r; weights += w; offsets += o
        uvs += [vts[i][0], 1.0 - vts[i][1]]
    delete = sorted(set(info['delete']))
    sections = [('refs', 'I', refs), ('weights', 'f', weights), ('offsets', 'f', offsets), ('uvs', 'f', uvs), ('index', 'I', index), ('deleteVerts', 'I', delete)]
    blob = bytearray()
    layout = {}
    for key, fmt, data in sections:
        layout[key] = {'byteOffset': len(blob), 'count': len(data)}
        blob += struct.pack(f'<{len(data)}{fmt}', *data)
    mat = parse_mhmat(os.path.join(folder, info.get('material', name + '.mhmat')))
    texture = None
    average = [128, 128, 128]
    if mat['diffuseTexture'] and os.path.exists(os.path.join(folder, mat['diffuseTexture'])):
        img = Image.open(os.path.join(folder, mat['diffuseTexture']))
        img.load()
        img = img.convert('RGBA').resize((512, 512), Image.Resampling.BILINEAR)
        img.save(os.path.join(OUT, name + '.webp'), 'WEBP', quality=90)
        texture = name + '.webp'
        px = [p for p in img.resize((64, 64)).get_flattened_data() if p[3] > 128] or [(128, 128, 128, 255)]
        average = [round(sum(p[c] for p in px) / len(px)) for c in range(3)]
    thumb = os.path.join(folder, name + '.thumb')
    if os.path.exists(thumb):
        try:
            t = Image.open(thumb)
            t.load()
            t.convert('RGB').resize((160, 160), Image.Resampling.BILINEAR).save(os.path.join(OUT, name + '-thumb.webp'), 'WEBP', quality=85)
        except Exception as error:  # a broken thumbnail is said, the item still imported
            print(f'  {name}: no thumbnail ({error})')
    # Without scale lines MakeHuman does not scale the offsets: axes whose base lengths are their lengths on the base mesh (a scale of 1 there).
    s = info['scale'] or {'x': (5399, 11998, 1.398), 'y': (791, 881, 2.2048), 'z': (962, 5320, 1.8461)}
    licence = licence_of(info['licence'], default_licence) if info['licence'] else default_licence
    kind = KINDS[pack.rstrip('0123456789')]
    meta = {
        'format': 'roadcraft-people-proxy/1', 'name': name, 'kind': kind, 'vertexCount': n, 'triangleCount': len(index) // 3,
        'scaleRefs': [s['x'][0], s['x'][1], s['y'][0], s['y'][1], s['z'][0], s['z'][1]], 'scaleBase': [s['x'][2], s['y'][2], s['z'][2]],
        'zDepth': info['z_depth'], 'transparent': mat['transparent'], 'doubleSided': not mat['backfaceCull'], 'layout': layout, 'texture': texture,
        'license': licence, 'source': {'pack': url, 'path': os.path.relpath(folder, os.path.dirname(os.path.dirname(folder))).replace('\\', '/')},
        'average': average, 'author': info['author'], 'tags': info['tags'], 'street': True, 'community': True,
    }
    open(os.path.join(OUT, name + '.bin'), 'wb').write(blob)
    json.dump(meta, open(os.path.join(OUT, name + '.json'), 'w', encoding='utf8'))
    return {'name': name, 'kind': kind, 'pack': pack, 'license': licence, 'author': info['author'], 'tags': info['tags'], 'street': True,
            'vertices': n, 'triangles': len(index) // 3}


def main():
    root, pack, url, default_licence = sys.argv[1:5]
    if pack.rstrip('0123456789') not in KINDS:
        print(f'{pack}: body parts or animals, not worn here; skipped')
        return
    community_path = os.path.join(OUT, 'community.json')
    community = json.load(open(community_path, encoding='utf8'))
    have = {i['name'] for i in community['items']}
    done = 0
    for dirpath, _, files in os.walk(root):
        for f in files:
            if not f.endswith('.mhclo'):
                continue
            name = f[:-6]
            if name in have:
                continue
            try:
                item = convert(dirpath, name, pack, url, default_licence)
            except Exception as error:
                print(f'  {name}: {error}')
                community['skipped'] = [x for x in community['skipped'] if x['name'] != name] + [{'name': name, 'pack': pack, 'why': str(error)}]
                continue
            community['items'].append(item)
            community['skipped'] = [x for x in community['skipped'] if x['name'] != name]
            have.add(name)
            done += 1
            print(f'  {name}: {item["kind"]}, {item["vertices"]} vertices')
    json.dump(community, open(community_path, 'w', encoding='utf8'), indent=1)
    print(f'{pack}: {done} imported')


if __name__ == '__main__':
    main()
