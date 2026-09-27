"""Reference-based blocking study for cd18... shot 2, not a generic video reconstructor.

Evidence: source 26.4-29.6s. Large dog starts foreground left, turns and walks
away; small dog remains foreground right and raises a paw after the turn.
Assets are original procedural proxies; likeness and facial acting are not final.
"""
import bpy
import math
from mathutils import Vector

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
s = bpy.context.scene
s.render.engine = 'BLENDER_EEVEE'
s.render.resolution_x = 540
s.render.resolution_y = 960
s.render.resolution_percentage = 50
s.render.fps = 24
s.frame_start = 1
s.frame_end = 77
s.world.use_nodes = True
s.world.node_tree.nodes.get('Background').inputs['Color'].default_value = (0.65, 0.72, 0.78, 1)
s.world.node_tree.nodes.get('Background').inputs['Strength'].default_value = 0.5
s.view_settings.view_transform = 'AgX'


def material(name, color, roughness=0.7):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = roughness
    return m


orange = material('Prison orange', (0.62, 0.18, 0.038))
dark = material('Dark charcoal fur', (0.065, 0.057, 0.050))
tan = material('Warm tan fur', (0.45, 0.26, 0.10))
cream = material('Muzzle cream', (0.72, 0.62, 0.42))
grey = material('Husky grey', (0.23, 0.27, 0.30))
black = material('Nose and boots', (0.018, 0.019, 0.019))
navy = material('Guard uniform', (0.025, 0.065, 0.10))
metal = material('Gate steel', (0.16, 0.20, 0.22), 0.6)
concrete = material('Concrete', (0.32, 0.32, 0.28))
nodes = concrete.node_tree.nodes
noise = nodes.new('ShaderNodeTexNoise')
noise.inputs['Scale'].default_value = 7
bump = nodes.new('ShaderNodeBump')
bump.inputs['Strength'].default_value = 0.22
bump.inputs['Distance'].default_value = 0.055
concrete.node_tree.links.new(noise.outputs['Fac'], bump.inputs['Height'])
concrete.node_tree.links.new(bump.outputs['Normal'], nodes.get('Principled BSDF').inputs['Normal'])


def empty(name, location, parent=None):
    obj = bpy.data.objects.new(name, None)
    s.collection.objects.link(obj)
    obj.parent = parent
    obj.location = location
    return obj


def ellipsoid(name, location, scale, mat, parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12)
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.parent = parent
    obj.location = location
    obj.scale = scale
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def box(name, location, scale, mat, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.parent = parent
    obj.location = location
    obj.scale = scale
    obj.data.materials.append(mat)
    bevel = obj.modifiers.new('Soft edges', 'BEVEL')
    bevel.width = 0.035
    bevel.segments = 2
    return obj


def dog(name, location, height, fur, slim=False, human=False):
    root = empty(name, location)
    h = height
    cloth = navy if human else orange
    width = 0.135 if slim else 0.19
    ellipsoid(name + '_torso', (0, 0, h * 0.63), (h * width, h * 0.105, h * 0.25), cloth, root)
    ellipsoid(name + '_hips', (0, 0, h * 0.44), (h * width * 0.85, h * 0.095, h * 0.11), cloth, root)
    head = empty(name + '_head', (0, 0, h * 0.91), root)
    ellipsoid(name + '_skull', (0, 0, 0), (h * 0.12, h * 0.10, h * 0.135), fur, head)
    ellipsoid(name + '_muzzle', (0, -h * 0.096, -h * 0.034), (h * 0.082, h * 0.080, h * 0.062), cream if slim else fur, head)
    ellipsoid(name + '_nose', (0, -h * 0.169, -h * 0.018), (h * 0.036, h * 0.022, h * 0.026), black, head)
    for side in (-1, 1):
        ellipsoid(name + '_eye', (side * h * 0.061, -h * 0.09, h * 0.026), (h * 0.019, h * 0.017, h * 0.022), black, head)
        if not human:
            bpy.ops.mesh.primitive_cone_add(vertices=20, radius1=h * (0.065 if slim else 0.045), radius2=0.004, depth=h * (0.20 if slim else 0.095))
            ear = bpy.context.view_layer.objects.active
            ear.name = name + '_ear'
            ear.parent = head
            ear.location = (side * h * 0.10, 0, h * (0.16 if slim else 0.13))
            ear.rotation_euler.y = side * 0.38
            ear.data.materials.append(fur)
    if human:
        box(name + '_cap', (0, -h * 0.01, h * 0.12), (h * 0.26, h * 0.24, h * 0.04), navy, head)
    arms, legs = [], []
    for side in (-1, 1):
        arm = empty(name + '_arm_' + str(side), (side * h * width, 0, h * 0.77), root)
        ellipsoid('Sleeve', (0, 0, -h * 0.115), (h * 0.057, h * 0.059, h * 0.14), cloth, arm)
        forearm = empty('Elbow', (0, 0, -h * 0.22), arm)
        ellipsoid('Forearm', (0, 0, -h * 0.08), (h * 0.040, h * 0.043, h * 0.10), fur, forearm)
        ellipsoid('Paw', (0, -h * 0.009, -h * 0.18), (h * 0.048, h * 0.043, h * 0.055), fur, forearm)
        arms.append(arm)
        leg = empty(name + '_leg_' + str(side), (side * h * 0.085, 0, h * 0.43), root)
        ellipsoid('Trouser', (0, 0, -h * 0.105), (h * 0.070, h * 0.070, h * 0.14), cloth, leg)
        ellipsoid('Lower trouser', (0, 0, -h * 0.29), (h * 0.057, h * 0.058, h * 0.12), cloth, leg)
        ellipsoid('Foot', (0, -h * 0.040, -h * 0.395), (h * 0.065, h * 0.110, h * 0.041), black, leg)
        legs.append(leg)
    if slim:
        tail = ellipsoid('Tail', (0, h * 0.17, h * 0.39), (h * 0.04, h * 0.19, h * 0.04), tan, root)
        tail.rotation_euler.x = 0.4
    return root, arms, legs


box('Ground', (0, 1, -0.08), (20, 20, 0.15), concrete)
box('Left wall', (-3.3, 1.7, 1.65), (0.22, 9, 3.3), concrete)
box('Back wall left', (-1.65, 4, 1.65), (3.3, 0.20, 3.3), concrete)
box('Back wall right', (3.25, 4, 1.65), (2, 0.20, 3.3), concrete)
box('Gate lintel', (1.10, 4, 3.20), (2.35, 0.24, 0.22), concrete)
for x in (0.0, 2.25):
    box('Gate post', (x, 4, 1.5), (0.13, 0.20, 3), metal)
gate = empty('Gate hinged leaf', (2.22, 3.96, 0))
box('Gate panel', (-1.1, 0, 1.00), (2.2, 0.09, 2.0), metal, gate)
for n in range(12):
    box('Gate bar', (-n * 0.19, 0, 2.50), (0.032, 0.06, 1.0), metal, gate)
box('Gate top rail', (-1.1, 0, 3.0), (2.25, 0.06, 0.06), metal, gate)
for n in range(18):
    bpy.ops.mesh.primitive_torus_add(major_radius=0.13, minor_radius=0.009, major_segments=16, minor_segments=6, location=(-3 + n * 0.35, 4, 3.48))
    bpy.context.view_layer.objects.active.rotation_euler.x = math.pi / 2
    bpy.context.view_layer.objects.active.data.materials.append(metal)

A, Aarms, Aleg = dog('ROLE_A', (0.30, -1.65, 0), 1.55, tan, slim=True)
D, Darms, Dleg = dog('ROLE_D', (-0.60, -2.25, 0), 2.48, dark)
B, _, _ = dog('ROLE_B', (-1.30, 3.45, 0), 2.15, grey)
C, _, _ = dog('ROLE_C', (-0.67, 3.35, 0), 2.12, dark)
E, _, _ = dog('ROLE_E', (1.45, 3.1, 0), 2.05, dark, human=True)
B.rotation_euler.z = -0.12
C.rotation_euler.z = 0.12
E.rotation_euler.z = -1.2


def ease(x):
    x = min(1, max(0, x))
    return x * x * (3 - 2 * x)


for frame in range(1, 78):
    t = (frame - 1) / 24
    depart = max(0, t - 0.85) / 2.35
    phase = max(0, t - 0.85) * 8.8
    swing = math.sin(phase) * 0.23 * ease((t - 0.85) / 0.25)
    # Keep the lowest sole on the floor while the simple proxy hips swing.
    sole_z = 2.48 * (0.43 - 0.395 * math.cos(swing) - 0.04 * abs(math.sin(swing)) - 0.041)
    D.location = (-0.60 + 0.64 * depart, -2.25 + 3.80 * depart, -sole_z)
    D.rotation_euler.z = math.radians(75 + 105 * ease((t - 0.70) / 0.65))
    D.keyframe_insert(data_path='location', frame=frame)
    D.keyframe_insert(data_path='rotation_euler', frame=frame)
    for i in range(2):
        Dleg[i].rotation_euler.x = swing * (-1 if i else 1)
        Darms[i].rotation_euler.x = swing * (1 if i else -1)
        Dleg[i].keyframe_insert(data_path='rotation_euler', frame=frame)
        Darms[i].keyframe_insert(data_path='rotation_euler', frame=frame)
    A.rotation_euler.z = math.radians(-70 - 90 * ease((t - 1.00) / 0.8))
    A.keyframe_insert(data_path='rotation_euler', frame=frame)
    raised = ease((t - 1.25) / 0.40) * (1 - 0.30 * ease((t - 2.90) / 0.30))
    Aarms[1].rotation_euler.y = -raised * 0.55
    Aarms[1].keyframe_insert(data_path='rotation_euler', frame=frame)
    elbow = next(c for c in Aarms[1].children if c.type == 'EMPTY')
    elbow.rotation_euler.y = -raised * (1.9 + 0.14 * math.sin((t - 1.5) * 10))
    elbow.keyframe_insert(data_path='rotation_euler', frame=frame)
    gate.rotation_euler.z = -0.60 * ease((t - 1.5) / 1.3)
    gate.keyframe_insert(data_path='rotation_euler', frame=frame)

bpy.ops.object.camera_add(location=(0, -5.0, 1.60))
camera = bpy.context.view_layer.objects.active
camera.name = 'Review camera'
camera.data.lens = 50
camera.rotation_euler = (Vector((0, 2, 1.35)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
s.camera = camera
bpy.ops.object.light_add(type='AREA', location=(-3, -2, 7))
light = bpy.context.view_layer.objects.active
light.data.energy = 1700
light.data.shape = 'DISK'
light.data.size = 8
light.rotation_euler = (Vector((0, 1, 0)) - light.location).to_track_quat('-Z', 'Y').to_euler()
bpy.ops.object.light_add(type='AREA', location=(1, -5, 3))
light = bpy.context.view_layer.objects.active
light.data.energy = 220
light.data.size = 5
light.rotation_euler = (Vector((0, 1, 1)) - light.location).to_track_quat('-Z', 'Y').to_euler()
s.frame_set(1)
print('Reference-based proxy scene ready: 5 roles, departure + farewell, original geometry.')
