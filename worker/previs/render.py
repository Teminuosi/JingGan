"""Render validated declarative motion data. No generated Python or source-specific actions."""
import bpy
import json
import math
import sys
from pathlib import Path
from mathutils import Vector, Euler

args = sys.argv[sys.argv.index('--') + 1:]
plan = json.loads(Path(args[0]).read_text(encoding='utf-8'))
out = Path(args[1])
fps, width, height, frames = map(int, args[2:6])
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'STUDIO'
scene.display.shading.color_type = 'MATERIAL'
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scene.display.shading.background_type = 'WORLD'
scene.world = bpy.data.worlds.new('World')
scene.world.color = (.10, .12, .14)
scene.render.resolution_x, scene.render.resolution_y = width, height
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.fps = fps
scene.frame_start, scene.frame_end = 1, frames
materials = {}


def material(color):
    key = tuple(color)
    if key not in materials:
        m = bpy.data.materials.new(str(key))
        m.diffuse_color = (*key, 1)
        materials[key] = m
    return materials[key]


def primitive(name, shape, color):
    if shape == 'sphere':
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=1)
    elif shape == 'cylinder':
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=1, depth=2)
    elif shape == 'cone':
        bpy.ops.mesh.primitive_cone_add(vertices=12, radius1=1, depth=2)
    elif shape == 'torus':
        bpy.ops.mesh.primitive_torus_add(major_segments=16, minor_segments=8, major_radius=.75, minor_radius=.25)
    else:
        bpy.ops.mesh.primitive_cube_add(size=2)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(material(color))
    return obj


def segment(obj, a, b, radius):
    a, b = Vector(a), Vector(b)
    delta = b-a
    obj.location = (a+b)/2
    obj.scale = (radius, radius, max(delta.length/2, .001))
    if delta.length > .0001:
        obj.rotation_euler = delta.to_track_quat('Z', 'Y').to_euler()


def sample(keys, t):
    left = keys[0]
    for right in keys[1:]:
        if t < right['at']:
            u = (t-left['at'])/(right['at']-left['at'])
            if right.get('cut'):
                return left
            def mix(a, b):
                if isinstance(a, list):
                    return [mix(x, y) for x, y in zip(a, b)]
                if isinstance(a, dict):
                    return {k: mix(v, b.get(k, v)) for k, v in a.items()}
                if isinstance(a, (float, int)) and not isinstance(a, bool):
                    return a+(b-a)*u
                return a
            # Discrete attachments remain on the left state until the exact switch.
            mixed = mix({k: v for k, v in left.items() if k != 'attach'}, {k: v for k, v in right.items() if k != 'attach'})
            mixed['attach'] = left.get('attach')
            return mixed
        left = right
    return left


edges = [
    ('pelvis', 'chest', .105), ('chest', 'neck', .075),
    ('chest', 'left_shoulder', .07), ('chest', 'right_shoulder', .07),
    ('pelvis', 'left_hip', .065), ('pelvis', 'right_hip', .065),
    ('left_shoulder', 'left_elbow', .04), ('left_elbow', 'left_hand', .033),
    ('right_shoulder', 'right_elbow', .04), ('right_elbow', 'right_hand', .033),
    ('left_hip', 'left_knee', .055), ('left_knee', 'left_foot', .045),
    ('right_hip', 'right_knee', .055), ('right_knee', 'right_foot', .045),
]
actors = {}
for actor in plan['actors']:
    name, skin, color = actor['id'], actor['skin'], actor['color']
    segments = [(a, b, r, primitive(name+'_'+a+'_'+b, 'sphere', color)) for a, b, r in edges]
    head = primitive(name+'_head', 'sphere', skin)
    nose = primitive(name+'_nose', 'sphere', skin if actor['kind'] != 'human' else [.2, .15, .1])
    eyes = [primitive(name+'_eye_'+str(i), 'sphere', [.02, .02, .025]) for i in (-1, 1)]
    mouth = primitive(name+'_mouth', 'sphere', [.045, .025, .025])
    ears = [primitive(name+'_ear_'+str(i), 'cone', skin) for i in (-1, 1)] if actor['kind'] != 'human' else []
    extremities = {j: primitive(name+'_'+j, 'sphere', skin if 'hand' in j else [.07, .07, .08]) for j in ('left_hand', 'right_hand', 'left_foot', 'right_foot')}
    actors[name] = dict(spec=actor, segments=segments, head=head, nose=nose, eyes=eyes, mouth=mouth, ears=ears, extremities=extremities)

props = {}
for p in plan['props']:
    objects = []
    for i, part in enumerate(p['parts']):
        obj = primitive(p['id']+'_'+str(i), part['shape'], part['color'])
        objects.append((obj, part))
    props[p['id']] = (p, objects)

floor = primitive('Ground', 'box', [.24, .27, .28])
floor.location, floor.scale = (0, 0, -.08), (30, 30, .08)
bpy.ops.object.camera_add()
camera = bpy.context.object
camera.data.clip_end = 500
camera.data.sensor_width = 36
scene.camera = camera
metrics = {'frames': frames, 'fps': fps, 'width': width, 'height': height, 'nonfinite': 0, 'max_limb_length_change': 0, 'max_unreachable_target_m': 0, 'attachment_count': 0, 'attachment_switches': []}
baseline = {}
previous_props = {}


def solve_limb(joints, original, start, middle, end, height, root_rotation):
    """Preserve bone lengths; use the planned elbow/knee as the bend-plane hint."""
    a, desired, hint = joints[start], joints[end], joints[middle]
    length_a = (Vector(original[start])-Vector(original[middle])).length*height
    length_b = (Vector(original[middle])-Vector(original[end])).length*height
    delta = desired-a
    direction = delta.normalized() if delta.length > .00001 else root_rotation @ Vector((0, 0, -1))
    distance = min(max(delta.length, abs(length_a-length_b)+.00001), length_a+length_b-.00001)
    actual = a+direction*distance
    metrics['max_unreachable_target_m'] = max(metrics['max_unreachable_target_m'], (actual-desired).length)
    bend = hint-a-direction*(hint-a).dot(direction)
    if bend.length < .00001:
        bend = root_rotation @ Vector((0, -1, 0))
        bend -= direction*bend.dot(direction)
        if bend.length < .00001:
            bend = direction.cross(Vector((1, 0, 0)))
    bend.normalize()
    along = (length_a**2-length_b**2+distance**2)/(2*distance)
    side = math.sqrt(max(0, length_a**2-along**2))
    joints[middle], joints[end] = a+direction*along+bend*side, actual


def actor_pose(actor, t):
    pose = sample(actor['keys'], t)
    rotation = Euler(tuple(math.radians(v) for v in pose['rotation']), 'XYZ').to_matrix()
    h, origin = actor['height'], Vector(pose['position'])
    joints = {j: origin + rotation @ (Vector(v)*h) for j, v in pose['joints'].items()}
    for side in ('left', 'right'):
        for names in (('shoulder', 'elbow', 'hand'), ('hip', 'knee', 'foot')):
            solve_limb(joints, actor['keys'][0]['joints'], *(side+'_'+n for n in names), h, rotation)
    return pose, joints, rotation


# At a free→held transition the interpolation endpoint is the actual grip,
# not the placeholder position stored in an attached key. Otherwise a cup
# slides toward the origin before pickup and teleports back into the hand.
for prop, objects in props.values():
    for pkey in prop['keys']:
        if pkey.get('attach'):
            att = pkey['attach']
            _, joints, rotation = actor_pose(actors[att['actor']]['spec'], pkey['at'])
            pkey['position'] = list(joints[att['joint']] + rotation @ Vector(att['offset']))


def key(obj, visible=True):
    for channel in ('location', 'rotation_euler', 'scale'):
        obj.keyframe_insert(data_path=channel)
    obj.hide_render = not visible
    obj.keyframe_insert(data_path='hide_render')


for frame in range(1, frames+1):
    scene.frame_set(frame)
    t = (frame-1)/fps
    worlds = {}
    for name, rig in actors.items():
        a = rig['spec']
        pose, joints, rotation = actor_pose(a, t)
        h = a['height']
        worlds[name] = (joints, rotation)
        for ja, jb, radius, obj in rig['segments']:
            segment(obj, joints[ja], joints[jb], radius*h)
            length = (joints[ja]-joints[jb]).length
            limb_key = (name, ja, jb)
            baseline.setdefault(limb_key, max(length, .01))
            metrics['max_limb_length_change'] = max(metrics['max_limb_length_change'], abs(length/baseline[limb_key]-1))
            key(obj, pose['visible'])
        head = rig['head']
        head_rotation = rotation @ Euler(tuple(math.radians(v) for v in pose.get('head_rotation', [0, 0, 0])), 'XYZ').to_matrix()
        head.location, head.scale, head.rotation_euler = joints['head'], (h*.095, h*.085, h*.115), head_rotation.to_euler()
        key(head, pose['visible'])
        # Faces point toward local -Y. Head gaze can be expressed by neck/head positions.
        rig['nose'].location = joints['head'] + head_rotation @ Vector((0, -h*.095, -h*.018))
        rig['nose'].scale = (h*.055, h*.07, h*.042) if a['kind'] != 'human' else (h*.022, h*.034, h*.025)
        rig['nose'].rotation_euler = head_rotation.to_euler()
        key(rig['nose'], pose['visible'])
        rig['mouth'].location = joints['head'] + head_rotation @ Vector((0, -h*.092, -h*.072))
        rig['mouth'].scale = (h*.038, h*.018, h*(.007+.018*pose.get('mouth_open', 0)))
        rig['mouth'].rotation_euler = head_rotation.to_euler()
        key(rig['mouth'], pose['visible'])
        for side, obj in zip((-1, 1), rig['eyes']):
            obj.location = joints['head'] + head_rotation @ Vector((side*h*.046, -h*.080, h*.028))
            obj.scale = (h*.014, h*.013, h*.014)
            key(obj, pose['visible'])
        for side, obj in zip((-1, 1), rig['ears']):
            obj.location = joints['head'] + head_rotation @ Vector((side*h*.065, 0, h*.12))
            obj.scale = (h*.04, h*.035, h*.075)
            obj.rotation_euler = head_rotation.to_euler()
            key(obj, pose['visible'])
        for joint, obj in rig['extremities'].items():
            obj.location = joints[joint]
            obj.scale = (h*.037, h*(.055 if 'foot' in joint else .035), h*.028)
            obj.rotation_euler = rotation.to_euler()
            key(obj, pose['visible'])
    for p, objects in props.values():
        pose = sample(p['keys'], t)
        rot = Euler(tuple(math.radians(v) for v in pose['rotation']), 'XYZ').to_matrix()
        position = Vector(pose['position'])
        if pose.get('attach'):
            att = pose['attach']
            joints, parent_rot = worlds[att['actor']]
            position = joints[att['joint']] + parent_rot @ Vector(att['offset'])
            rot = parent_rot @ rot
            metrics['attachment_count'] += 1
        previous_prop = previous_props.get(p['id'])
        if previous_prop and previous_prop['attach'] != pose.get('attach'):
            metrics['attachment_switches'].append({'id': p['id'], 'at': t, 'distance_from_previous_frame_m': (position-previous_prop['position']).length, 'attached': bool(pose.get('attach'))})
        previous_props[p['id']] = {'attach': pose.get('attach'), 'position': position.copy()}
        for obj, part in objects:
            obj.location = position + rot @ Vector(part['position'])
            obj.rotation_euler = (rot @ Euler(tuple(math.radians(v) for v in part['rotation']), 'XYZ').to_matrix()).to_euler()
            obj.scale = Vector(part['size'])/2
            key(obj, pose['visible'])
    cam = sample(plan['camera'], t)
    camera.location = cam['position']
    direction = Vector(cam['target'])-camera.location
    camera.rotation_euler = (direction.to_track_quat('-Z', 'Y').to_matrix() @ Euler((0, 0, math.radians(cam['roll']))).to_matrix()).to_euler()
    camera.data.lens = cam['lens']
    key(camera)
    camera.data.keyframe_insert(data_path='lens')

out.mkdir(parents=True, exist_ok=True)
(out/'frames').mkdir(exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(out/'scene.blend'))
scene.render.filepath = str(out/'frames'/'f_')
bpy.ops.render.render(animation=True)
(out/'motion-check.json').write_text(json.dumps(metrics, indent=2), encoding='utf-8')
(out/'result.json').write_text(json.dumps({**metrics, 'artifacts': ['frames/', 'scene.blend', 'motion-check.json']}), encoding='utf-8')
print('BLENDER_DONE')
