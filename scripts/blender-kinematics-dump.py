"""对照基准：用当前 render.py 搭场景（跳过出图），逐帧导出每个物体的世界变换与 motion-check。
用法：blender -b --factory-startup --python scripts/blender-kinematics-dump.py -- plan.json out.json fps width height frames step
"""
import bpy
import json
import sys
import tempfile
from pathlib import Path

args = sys.argv[sys.argv.index('--') + 1:]
plan_path, out_path = args[0], Path(args[1])
fps, width, height, frames, step = map(int, args[2:7])
work = Path(tempfile.mkdtemp(prefix='kin-'))
source = (Path(__file__).resolve().parent.parent / 'worker' / 'previs' / 'render.py').read_text(encoding='utf-8')
# 只跳过渲染出图和存 .blend，其余计算与线上助手完全相同。
for line in ("bpy.ops.render.render(animation=True)", "bpy.ops.wm.save_as_mainfile(filepath=str(out/'scene.blend'))"):
    assert line in source, line
    source = source.replace(line, 'pass')
sys.argv = ['blender', '--', plan_path, str(work), str(fps), str(width), str(height), str(frames)]
namespace = {'__name__': '__render__'}
exec(compile(source, 'render.py', 'exec'), namespace)

scene = bpy.context.scene
samples = []
for frame in range(1, frames + 1, step):
    scene.frame_set(frame)
    objects = {}
    for obj in scene.objects:
        m = obj.matrix_world
        objects[obj.name] = {
            'matrix': [list(m[r][:3]) for r in range(3)],
            'position': list(m.translation),
            'visible': not obj.hide_render,
        }
        if obj.type == 'CAMERA':
            objects[obj.name]['lens'] = obj.data.lens
    samples.append({'frame': frame, 't': (frame - 1) / fps, 'objects': objects})
check = json.loads((work / 'motion-check.json').read_text(encoding='utf-8'))
out_path.write_text(json.dumps({'motionCheck': check, 'samples': samples}), encoding='utf-8')
print('DUMP_DONE', len(samples))
