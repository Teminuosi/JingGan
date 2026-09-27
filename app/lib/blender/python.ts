// Blender Python 脚本生成器。
//
// Blender 的自动化入口是 `blender --background --python script.py`。
// 这里把 BlenderScene 编译成一份自包含的 Python 脚本。
//
// 两条设计约束：
//  1. **脚本必须自包含**。不读外部配置、不联网、不依赖 Blender 版本特有的插件。
//     渲染机可能是另一台机器，调试一个「在我这儿能跑」的脚本代价太高。
//  2. **场景数据以 JSON 内联**，而不是拼进代码里。
//     拼字符串迟早会被某个带引号的角色名炸掉，JSON 序列化不会。
//
// 生成的脚本用代理几何体（胶囊代表人）而不是真实角色模型：
// 预演要的是空间关系，不是好看。灰模渲染秒级完成，真人模型要分钟级还得有资产库。

import { resolutionFor, type BlenderScene } from './protocol';

export interface PythonOptions {
  buildOnly?: boolean;
  /** 渲染产物写到哪个目录（渲染机本地路径）。 */
  outputDir: string;
  /** 预览分辨率。预演不需要高清，够看清站位即可。 */
  width?: number;
  height?: number;
  /** 渲染引擎。EEVEE 快得多，预演够用；CYCLES 只在需要真实光影时用。 */
  /**
   * 渲染引擎。留空则由脚本按当前 Blender 版本自动挑——
   * 这个枚举名跨大版本改过（4.x 的 BLENDER_EEVEE_NEXT 在 5.x 不存在），写死会直接崩。
   */
  engine?: string;
}

export function generateBlenderPython(scene: BlenderScene, opts: PythonOptions): string {
  // 显式传入的分辨率优先（测试和特殊需求用），否则按场景画幅算。
  const fit = resolutionFor(scene.aspectRatio);
  const payload = JSON.stringify({
    scene,
    opts: { ...opts, width: opts.width ?? fit.width, height: opts.height ?? fit.height, engine: opts.engine ?? null },
  }, null, 2);

  return `# 自动生成，请勿手改。来源：app/lib/blender/python.ts
# 用法：blender --background --python this_script.py
#
# 这份脚本只做一件事：把 Shot DNA 推导出的空间关系摆成 3D 场景并渲出预览。
# 用胶囊体代表人——预演要的是「谁在谁左后方」，不是像不像。

import bpy
import json
import math
import os

DATA = json.loads(r"""
${payload}
""")

SCENE = DATA["scene"]
OPTS = DATA["opts"]


def clear_scene():
    """从空场景开始。Blender 默认带一个立方体、一盏灯和一台相机，不清会混进渲染结果。"""
    if OPTS.get("buildOnly"):
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)


def pick_engine():
    """渲染引擎名字跨版本改过：4.x 叫 BLENDER_EEVEE_NEXT，5.x 又改回 BLENDER_EEVEE。
    写死任何一个都会在另一个版本上直接抛 TypeError，所以按偏好顺序挑一个当前版本真有的。"""
    available = [e.identifier for e in
                 bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    for name in [OPTS.get("engine"), "BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH", "CYCLES"]:
        if name and name in available:
            return name
    return available[0]


def setup_render():
    s = bpy.context.scene
    s.render.engine = pick_engine()
    s.render.resolution_x = OPTS["width"]
    s.render.resolution_y = OPTS["height"]
    s.render.resolution_percentage = 100
    s.render.film_transparent = False
    s.frame_start = 1
    s.render.fps = SCENE["fps"]
    # 时长换算成帧。至少一帧，否则时长为 0 的镜头会渲不出东西。
    s.frame_end = max(1, int(round(SCENE["durationSeconds"] * SCENE["fps"])))


def sec_to_frame(t):
    return max(1, int(round(t * SCENE["fps"])) + 1)


def build_room():
    room = SCENE["room"]
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 0))
    floor = bpy.context.object
    floor.name = "Floor"
    floor.scale = (room["width"], room["depth"], 1)
    if room["interior"]:
        # 只建后墙和两侧墙，不封顶——封了顶室内会全黑，而预演不需要顶。
        specs = [
            ("WallBack", (0, room["depth"] / 2, room["height"] / 2), (room["width"], room["height"], 1), (math.pi / 2, 0, 0)),
            ("WallLeft", (-room["width"] / 2, 0, room["height"] / 2), (room["depth"], room["height"], 1), (math.pi / 2, 0, math.pi / 2)),
            ("WallRight", (room["width"] / 2, 0, room["height"] / 2), (room["depth"], room["height"], 1), (math.pi / 2, 0, math.pi / 2)),
        ]
        for name, loc, scale, rot in specs:
            bpy.ops.mesh.primitive_plane_add(size=1, location=loc)
            w = bpy.context.object
            w.name = name
            w.scale = scale
            w.rotation_euler = rot


def build_actor(actor):
    """一个人 = 一个胶囊体。高度按 height 缩放，脚底贴地。"""
    h = actor["height"]
    bpy.ops.mesh.primitive_cylinder_add(radius=0.22, depth=h, location=(
        actor["position"]["x"], actor["position"]["y"], h / 2))
    obj = bpy.context.object
    obj.name = "ACTOR_" + actor["id"]
    obj.rotation_euler = (0, 0, math.radians(actor["rotationZ"]))

    # 加一个小球当头，用来一眼看出朝向
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.13, location=(
        actor["position"]["x"], actor["position"]["y"], h + 0.1))
    head = bpy.context.object
    head.name = "HEAD_" + actor["id"]
    head.parent = obj
    head.matrix_parent_inverse = obj.matrix_world.inverted()

    # 鼻子：一个小锥体指向朝向，渲出来就能看出人物面朝哪边
    bpy.ops.mesh.primitive_cone_add(radius1=0.06, depth=0.18, location=(
        actor["position"]["x"], actor["position"]["y"] - 0.18, h + 0.1))
    nose = bpy.context.object
    nose.name = "NOSE_" + actor["id"]
    nose.rotation_euler = (math.radians(90), 0, 0)
    nose.parent = obj
    nose.matrix_parent_inverse = obj.matrix_world.inverted()

    for key in actor["path"]:
        obj.location = (key["position"]["x"], key["position"]["y"], h / 2)
        if key.get("rotationZ") is not None:
            obj.rotation_euler = (0, 0, math.radians(key["rotationZ"]))
        obj.keyframe_insert(data_path="location", frame=sec_to_frame(key["at"]))
        obj.keyframe_insert(data_path="rotation_euler", frame=sec_to_frame(key["at"]))

    # 出场窗口：不在这一镜里的人必须真的消失。
    # 父子关系在 Blender 里**不传递可见性**，所以身体、头、鼻子要各打各的关键帧。
    # 插值必须是 CONSTANT，否则 Blender 会在可见与不可见之间做线性过渡，
    # 人会半透明地淡进淡出——预演要的是"在/不在"，不是转场效果。
    for part in (obj, head, nose):
        for key in actor.get("visibility") or []:
            frame = sec_to_frame(key["at"])
            part.hide_viewport = not key["visible"]
            part.hide_render = not key["visible"]
            part.keyframe_insert(data_path="hide_viewport", frame=frame)
            part.keyframe_insert(data_path="hide_render", frame=frame)
        set_constant_interpolation(part)
    return obj


def build_prop(prop):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(
        prop["position"]["x"], prop["position"]["y"], prop["position"]["z"]))
    obj = bpy.context.object
    obj.name = "PROP_" + prop["id"]
    obj.scale = (prop["size"]["x"], prop["size"]["y"], prop["size"]["z"])
    return obj


def build_camera():
    cam_data = bpy.data.cameras.new("Camera")
    cam = bpy.data.objects.new("Camera", cam_data)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam

    c = SCENE["camera"]
    cam.location = (c["position"]["x"], c["position"]["y"], c["position"]["z"])
    cam_data.lens = c["focalLength"]

    # 用 track-to 约束对准目标，而不是自己算欧拉角。
    # 手算旋转在相机越过目标正上方时会翻转（万向锁），约束不会。
    target = bpy.data.objects.new("CamTarget", None)
    bpy.context.collection.objects.link(target)
    target.location = (c["lookAt"]["x"], c["lookAt"]["y"], c["lookAt"]["z"])
    con = cam.constraints.new(type="TRACK_TO")
    con.target = target
    con.track_axis = "TRACK_NEGATIVE_Z"
    con.up_axis = "UP_Y"

    for key in c["path"]:
        cam.location = (key["position"]["x"], key["position"]["y"], key["position"]["z"])
        target.location = (key["lookAt"]["x"], key["lookAt"]["y"], key["lookAt"]["z"])
        if key.get("focalLength"):
            cam_data.lens = key["focalLength"]
            cam_data.keyframe_insert(data_path="lens", frame=sec_to_frame(key["at"]))
        cam.keyframe_insert(data_path="location", frame=sec_to_frame(key["at"]))
        target.keyframe_insert(data_path="location", frame=sec_to_frame(key["at"]))

    # 镜头之间是硬切，不是运镜。
    # 不把切点前一个关键帧设成 CONSTANT 的话，相机会从上一镜的机位平滑飞到下一镜，
    # 渲出来是一条连续长镜头——那跟原片的剪辑节奏完全是两回事。
    set_constant_before_cuts(cam, c["path"])
    set_constant_before_cuts(target, c["path"])
    return cam


def set_constant_interpolation(obj):
    """把出场窗口的关键帧全设成 CONSTANT。

    可见性是布尔量，做插值没有意义：Blender 默认的 BEZIER 会让人半透明地淡进淡出，
    而预演要表达的是"这一镜他在不在场"，不是一个转场效果。
    只动 hide_* 这两条曲线，别碰走位和运镜——那些该保持平滑。
    """
    for fcurve in iter_fcurves(obj):
        if not fcurve.data_path.startswith("hide_"):
            continue
        for key in fcurve.keyframe_points:
            key.interpolation = "CONSTANT"


def iter_fcurves(obj):
    """取出一个物体的所有 F-Curve。

    Blender 4.4 起动画数据换成了 layers/slots 结构，Action 上不再直接挂 fcurves，
    老写法会抛 AttributeError。两种结构都要认，否则换个版本就崩。
    """
    ad = obj.animation_data
    if not ad or not ad.action:
        return []
    act = ad.action
    if hasattr(act, "fcurves"):
        return list(act.fcurves)
    out = []
    slot = getattr(ad, "action_slot", None)
    for layer in getattr(act, "layers", []):
        for strip in getattr(layer, "strips", []):
            bag = None
            if slot is not None and hasattr(strip, "channelbag"):
                try:
                    bag = strip.channelbag(slot)
                except Exception:
                    bag = None
            if bag is None:
                bags = list(getattr(strip, "channelbags", []))
                bag = bags[0] if bags else None
            if bag is not None:
                out.extend(list(bag.fcurves))
    return out


def set_constant_before_cuts(obj, keys):
    """镜头切换处做硬切。

    对每个切点，只把它**紧前面那一个**关键帧设成 CONSTANT：
    这样上一镜保持自己的机位直到切点，然后瞬间跳到下一镜。
    如果把切点之前的关键帧全设成常量，镜头内部的推拉摇移也会一起被冻住——
    那就从「有剪辑的片子」变成了「一串静止画面」。
    """
    cuts = sorted({sec_to_frame(k["at"]) for k in keys if k.get("cut")})
    if not cuts:
        return
    for fcurve in iter_fcurves(obj):
        points = sorted(fcurve.keyframe_points, key=lambda p: p.co[0])
        for cut in cuts:
            prev = None
            for kp in points:
                if int(round(kp.co[0])) < cut:
                    prev = kp
                else:
                    break
            if prev is not None:
                prev.interpolation = "CONSTANT"
        fcurve.update()


def build_lights():
    for i, light in enumerate(SCENE["lights"]):
        data = bpy.data.lights.new(name="Light%d" % i, type=light["type"])
        data.energy = light["energy"]
        if light["type"] == "AREA":
            data.size = 3.0
        obj = bpy.data.objects.new("Light%d" % i, data)
        bpy.context.collection.objects.link(obj)
        obj.location = (light["position"]["x"], light["position"]["y"], light["position"]["z"])
        # 灯也用 track-to 对准场地中心，免得照到墙背面
        target = bpy.data.objects.new("LightTarget%d" % i, None)
        bpy.context.collection.objects.link(target)
        target.location = (0, 3.0, 1.2)
        con = obj.constraints.new(type="TRACK_TO")
        con.target = target
        con.track_axis = "TRACK_NEGATIVE_Z"
        con.up_axis = "UP_Y"

    # 预演要的是「看得清谁站在哪、怎么动」，不是好看。
    # 只给主光的话，逆光和低机位的镜头会渲成一团黑剪影——
    # 实测第 2 镜（低机位 + 侧逆光）就整个糊成了黑块，走位完全读不出来，
    # 而这恰恰是要喂给视频模型当运镜参考的东西。
    # 所以环境光给得足，再补一盏跟着相机的正面补光，保证没有死黑。
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.85
    bpy.context.scene.world = world

    fill_data = bpy.data.lights.new(name="CameraFill", type="AREA")
    fill_data.energy = 400
    fill_data.size = 6.0
    fill = bpy.data.objects.new("CameraFill", fill_data)
    bpy.context.collection.objects.link(fill)
    cam = bpy.context.scene.camera
    if cam:
        # 贴着相机走：相机动到哪，补光跟到哪，任何机位都不会出现死黑面
        fill.location = cam.location
        con = fill.constraints.new(type="COPY_LOCATION")
        con.target = cam
        track = fill.constraints.new(type="TRACK_TO")
        track.target = bpy.data.objects.get("CamTarget")
        track.track_axis = "TRACK_NEGATIVE_Z"
        track.up_axis = "UP_Y"


def render_outputs():
    out = OPTS["outputDir"]
    os.makedirs(out, exist_ok=True)
    scene = bpy.context.scene
    produced = []

    if "first_frame" in SCENE["outputs"]:
        scene.frame_set(scene.frame_start)
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = os.path.join(out, "first_frame.png")
        bpy.ops.render.render(write_still=True)
        produced.append("first_frame.png")

    if "last_frame" in SCENE["outputs"]:
        scene.frame_set(scene.frame_end)
        scene.render.filepath = os.path.join(out, "last_frame.png")
        bpy.ops.render.render(write_still=True)
        produced.append("last_frame.png")

    if "layout_diagram" in SCENE["outputs"]:
        # 顶视图：一张图看清所有人的平面站位，比任何文字都直观。
        # 用一台独立的正交相机，不去动主相机——改主相机再改回来，
        # 约束的 mute 状态和依赖图更新顺序很容易出错（第一版就渲出了一整片地板）。
        room = SCENE["room"]
        top_data = bpy.data.cameras.new("TopCamera")
        top_data.type = "ORTHO"
        # 正交尺寸直接按场地宽度给，不用算视角，也就不会框错
        top_data.ortho_scale = max(room["width"], room["depth"]) * 0.9
        top_cam = bpy.data.objects.new("TopCamera", top_data)
        bpy.context.collection.objects.link(top_cam)
        top_cam.location = (0, 0, 20.0)
        top_cam.rotation_euler = (0, 0, 0)   # 默认看向 -Z，正好俯视
        prev_cam = scene.camera
        scene.camera = top_cam
        scene.frame_set(scene.frame_start)
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = os.path.join(out, "layout_top.png")
        bpy.ops.render.render(write_still=True)
        produced.append("layout_top.png")
        scene.camera = prev_cam

    if "path_animation" in SCENE["outputs"]:
        # Blender 5.x 的 image_settings.file_format 里已经没有 FFMPEG 了，
        # 原生导 mp4 这条路没了。改成渲 PNG 序列，交给外部 ffmpeg 编码——
        # 帧率、编码、时长全由我们说了算，也少一层 Blender 版本依赖。
        frames_dir = os.path.join(out, "frames")
        os.makedirs(frames_dir, exist_ok=True)
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = os.path.join(frames_dir, "f_")
        bpy.ops.render.render(animation=True)
        produced.append("frames/")

    # 把产出清单写成 JSON，调用方据此登记 asset，而不是去猜文件名
    with open(os.path.join(out, "result.json"), "w", encoding="utf-8") as f:
        json.dump({"shotId": SCENE["shotId"], "artifacts": produced}, f, ensure_ascii=False)
    return produced


def main():
    clear_scene()
    setup_render()
    build_room()
    for actor in SCENE["actors"]:
        build_actor(actor)
    for prop in SCENE["props"]:
        build_prop(prop)
    # 顺序有要求：补光要贴着相机走，所以相机必须先建好
    build_camera()
    build_lights()
    if OPTS.get("buildOnly"):
        return
    produced = render_outputs()
    print("BLENDER_DONE " + json.dumps(produced))


main()
`;
}
