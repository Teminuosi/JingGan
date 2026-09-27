// Blender 预演协议。
//
// 规格第八至十二章。要解决的问题：视频模型不理解空间。
// 「A 站在 B 的左后方，镜头从 A 的右肩越过去看 B」这种关系，用文字描述模型照做不了，
// 但如果先在 3D 里把人和机位摆好，渲一张灰模图或一段路径动画，
// 再把「空间关系已锁定」这件事写进提示词并附上预演图，成片率会高一大截。
//
// 本机没装 Blender。所以这一层的做法是：**把协议、场景构建、Python 生成器全做实，
// 渲染那一步用 Mock 撑住**。等装了 Blender，只要把 Mock 换成真的 subprocess 调用，
// 上面所有东西一行不用改。
//
// TODO_REAL_PROVIDER_INTEGRATION：真实渲染未验证。
//
// 坐标系约定（一定要写死，否则生成的 Python 和场景理解会打架）：
//   Blender 默认右手系，+Z 向上，+Y 向前（远离默认视角），+X 向右。
//   「画面左侧」= 相机视角的左 = 世界坐标 -X（相机放在 -Y 朝 +Y 看时）。
//   所有单位为米。

import { shotDuration, type ScreenPosition, type ShotDna } from '../shot-dna/types';

export interface Vec3 { x: number; y: number; z: number }

export interface BlenderActor {
  id: string;
  /** 站位。脚底贴地，z 为 0。 */
  position: Vec3;
  /** 朝向角度（度）。0 = 面向 +Y（背对相机），180 = 面向相机。 */
  rotationZ: number;
  /** 身高（米），用于生成代理几何体的比例。 */
  height: number;
  /** 关键帧走位：时间（秒）→ 位置。空数组表示全程不动。 */
  path: Array<{ at: number; position: Vec3; rotationZ?: number }>;
  /**
   * 出场窗口：时间（秒）→ 这一刻在不在画面里。空数组表示全程在场（逐镜预演就是这样）。
   *
   * 全片预演必须有它：所有镜头的角色合并在同一个 3D 场景里，
   * 不管可见性的话，只在第 3 镜出现的人会从第 0 秒就杵在画面中。
   * 后果不只是多一个人——相机要框住所有人，多站一个就被往后推，
   * 说好的近景被撑成全景，景别整个失真。
   */
  visibility?: Array<{ at: number; visible: boolean }>;
}

export interface BlenderCamera {
  position: Vec3;
  /** 看向哪个点。用 track-to 约束，比直接给欧拉角稳。 */
  lookAt: Vec3;
  focalLength: number;
  /**
   * 机位动画。空数组表示固定机位。
   * `cut: true` 表示这一帧是硬切入点（全片预演里的镜头切换），
   * 生成的 Python 会把它前面的关键帧设成常量插值，避免相机平滑飞过去。
   */
  path: Array<{ at: number; position: Vec3; lookAt: Vec3; focalLength?: number; cut?: boolean }>;
}

export interface BlenderLight {
  type: 'SUN' | 'AREA' | 'POINT';
  position: Vec3;
  energy: number;
  /** 色温（K）。 */
  temperature: number;
}

export interface BlenderScene {
  schema_version: 'blender-scene.v1';
  shotId: string;
  durationSeconds: number;
  fps: number;
  /**
   * 画幅，例如 '9:16'。**必须跟着源片走。**
   *
   * 预演的作用是锁构图和走位，画幅对不上等于给了个错的构图：
   * 在 16:9 里"站在画面左边"的角色，换到 9:16 根本就在画外。
   * 这条参考视频最后要喂给出片模型，两边画幅打架比不给还糟。
   */
  aspectRatio: string;
  /** 场地尺寸（米），用于摆地面和墙。 */
  room: { width: number; depth: number; height: number; interior: boolean };
  actors: BlenderActor[];
  props: Array<{ id: string; name: string; position: Vec3; size: Vec3 }>;
  camera: BlenderCamera;
  lights: BlenderLight[];
  /**
   * 机位偏离了分析结论时的说明，例如"大特写装不下三个人，退到 3.4m"。
   * 偏离必须说出来：预演最后会以"已按 3D 预演锁定"的名义写进出片提示词，
   * 闷着改等于拿一个我们自己改过的构图去冒充分析结论。
   */
  framingNote?: string;
  /** 渲染什么。灰模够用且快；需要看清走位时才渲路径动画。 */
  outputs: Array<'first_frame' | 'last_frame' | 'path_animation' | 'depth' | 'layout_diagram'>;
}

export interface BlenderResult {
  shotId: string;
  /** 产出文件的对象存储 key。 */
  artifacts: Array<{ kind: string; key: string; contentType: string }>;
  /** 给提示词用的空间关系描述。这是 Blender 最终交给视频模型的东西。 */
  blocking: string;
  cameraPath: string;
  renderSeconds: number;
}

// ---------- 场景构建 ----------

/** 屏幕位置 → 世界坐标 X。相机在 -Y 朝 +Y 看，所以画面左 = -X。 */
/** 预演长边像素。走位看得清就够，渲得快更重要。 */
const PREVIS_LONG_EDGE = 960;

/**
 * 把 '9:16' 这样的画幅换算成渲染分辨率。
 *
 * 画幅必须跟着源片走：预演是要喂给出片模型的参考视频，
 * 画幅不一致等于给了个错的构图，比不给还糟。
 * 认不出来的写法一律抛错，不偷偷退回 16:9——那正是踩过的坑。
 */
export function resolutionFor(aspectRatio: string): { width: number; height: number } {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)\s*$/.exec(aspectRatio ?? '');
  if (!m) throw new Error(`画幅「${aspectRatio}」认不出来，预演不能瞎猜一个比例去渲`);
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (!(w > 0 && h > 0)) throw new Error(`画幅「${aspectRatio}」不是正数比例`);
  // H.264 要求宽高都是偶数，取偶后再算另一边。
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return w >= h
    ? { width: even(PREVIS_LONG_EDGE), height: even(PREVIS_LONG_EDGE * h / w) }
    : { width: even(PREVIS_LONG_EDGE * w / h), height: even(PREVIS_LONG_EDGE) };
}

/**
 * 相机在主体平面上能拍到的半宽（米）。摆位的基准。
 *
 * 传感器按 Blender 默认的 36mm / AUTO：**36mm 落在画面的长边上**。
 * 所以竖屏的水平视野比横屏窄得多——9:16 的等效水平传感器只有 36×9/16 = 20.25mm。
 * 不按真实画幅算的话，竖屏里所有人都会被摆到画外去。
 */
export function frameHalfWidth(distance: number, focalMm: number, aspectRatio: string): number {
  const { width, height } = resolutionFor(aspectRatio);
  const sensorH = 36 * (width >= height ? 1 : width / height);
  return distance * (sensorH / 2) / focalMm;
}

/**
 * 画面位置 → **画面半宽的比例**，不是写死的米数。
 *
 * 这里踩过一次大的：原来写死成世界坐标 ±2 米，不管什么景别都是 4 米宽。
 * 相机为了把人都框进去被推到 7.5 米外，而景别表里 MCU 明明写着 2.0 米——
 * 结果不管分析说 ECU 还是 LS，渲出来永远是「刚好框住所有人」的那个距离，
 * 景别这一半信息整个失真。
 *
 * 根子在于 screen_position 是**画面里的位置**，不是世界位置：
 * 近景里的「站左边」可能只离画面中心 0.3 米，不是 2 米。
 * 所以先按景别算出该距离下的画面宽度，再把左中右放到这个宽度的固定比例上，
 * 相机就能稳稳停在景别该在的距离，所有人天然在画内。
 *
 * ±0.72 而不是 ±1.0：边上留出身体的宽度，不然人会被画框切掉一半。
 */
/** 相机在某个距离上能拍到的半高（米）。竖屏时 36mm 落在高上，所以竖画框特别高。 */
export function frameHalfHeight(distance: number, focalMm: number, aspectRatio: string): number {
  const { width, height } = resolutionFor(aspectRatio);
  const sensorV = 36 * (height >= width ? 1 : height / width);
  return distance * (sensorV / 2) / focalMm;
}

const POSITION_FRACTION: Record<ScreenPosition, number> = {
  left: -0.72, center_left: -0.36, center: 0, center_right: 0.36, right: 0.72,
  offscreen: -1.7,   // 画外：放在视锥外，走位动画里能从这儿走进来
};

/** 景深层 → **景别距离的比例**。前景比主体近，背景比主体远。 */
const DEPTH_FRACTION: Record<string, number> = { foreground: 0.68, midground: 1.0, background: 1.65 };

/** 相邻两人之间至少留这么宽（米），否则胶囊体会穿模。 */
const MIN_BODY_GAP = 0.6;

/** 景别 → 相机到主体的距离（米）与焦距（mm）。这张表是 Blender 摆机位的全部依据。 */
const FRAMING: Record<string, { distance: number; focal: number }> = {
  ECU: { distance: 0.6, focal: 85 },
  CU: { distance: 1.2, focal: 85 },
  MCU: { distance: 2.0, focal: 50 },
  MS: { distance: 3.0, focal: 50 },
  MLS: { distance: 4.5, focal: 35 },
  LS: { distance: 7.0, focal: 28 },
  ELS: { distance: 14.0, focal: 24 },
  unknown: { distance: 3.5, focal: 40 },
};

const ANGLE_HEIGHT: Record<string, number> = {
  eye_level: 1.6, high: 3.0, low: 0.5, overhead: 6.0, dutch: 1.6,
  over_shoulder: 1.6, pov: 1.6, unknown: 1.6,
};

/**
 * 从 Shot DNA 构建 3D 场景。
 *
 * 这是纯函数，不碰 Blender，也不碰文件系统——这样它可以被直接测试：
 * 「两个角色的位置有没有重叠」「相机会不会穿墙」这种事不该等渲染完才发现。
 */
export function buildScene(dna: ShotDna, opts: { fps?: number; aspectRatio: string }): BlenderScene {
  const duration = shotDuration(dna);
  const fps = opts.fps ?? 24;
  const interior = dna.environment.interior_exterior !== 'exterior';

  // 先定景别，再摆人——顺序反过来就是上一版的错法。
  const framing = FRAMING[dna.camera.shot_size] ?? FRAMING.unknown;
  const focal = dna.camera.lens_mm ?? framing.focal;

  // 相邻画面位置之间最小的比例差（0.36）。按它反推出"身体不穿模"所需的最小画面宽度，
  // 再看景别给的距离够不够。三个人挤一个大特写在物理上就是不成立的，这时只能往后退。
  const occupied = [...new Set(dna.actors.map((a) => POSITION_FRACTION[a.screen_position] ?? 0))].sort((x, y) => x - y);
  const minGap = occupied.length > 1
    ? Math.min(...occupied.slice(1).map((v, i) => v - occupied[i]))
    : 0;
  const needHalfWidth = minGap > 0 ? MIN_BODY_GAP / minGap : 0;

  let distance = framing.distance;
  let halfWidth = frameHalfWidth(distance, focal, opts.aspectRatio);
  let framingNote: string | undefined;
  if (halfWidth < needHalfWidth) {
    // 退到刚好放得下为止。退了多少要说出来——这是对分析结论的偏离，不能闷着。
    distance = +(distance * needHalfWidth / halfWidth).toFixed(2);
    halfWidth = needHalfWidth;
    framingNote = `${dna.camera.shot_size} 装不下 ${dna.actors.length} 个人，机位从 ${framing.distance}m 退到 ${distance}m 才不穿模`;
  }

  const actors: BlenderActor[] = dna.actors.map((a) => {
    const base: Vec3 = {
      x: +((POSITION_FRACTION[a.screen_position] ?? 0) * halfWidth).toFixed(3),
      y: +(distance * (DEPTH_FRACTION[a.depth_layer] ?? 1)).toFixed(3),
      z: 0,
    };
    // 朝向：默认面向相机（180°）。侧身的从 facing 文字里认。
    let rotationZ = 180;
    if (/向左|朝左|面左|turned_left|facing_left/.test(a.facing)) rotationZ = 90;
    else if (/向右|朝右|面右|turned_right|facing_right/.test(a.facing)) rotationZ = 270;
    else if (/背对|转身|背向|away_from_camera/.test(a.facing)) rotationZ = 0;

    // 走位：中途入画的人从画外走到目标位；其余全程站定。
    const path: BlenderActor['path'] = [];
    if (a.entry_at !== undefined && a.entry_at > 0) {
      const fromX = (base.x <= 0 ? -1 : 1) * 1.7 * halfWidth;   // 从最近的一侧进来
      path.push({ at: 0, position: { ...base, x: fromX }, rotationZ });
      path.push({ at: a.entry_at, position: base, rotationZ });
    }
    if (a.exit_at !== undefined) {
      path.push({ at: a.exit_at, position: base, rotationZ });
      path.push({ at: Math.min(duration, a.exit_at + 1), position: { ...base, x: (base.x <= 0 ? -1 : 1) * 1.7 * halfWidth }, rotationZ });
    }

    return { id: a.character_id, position: base, rotationZ, height: 1.72, path };
  });

  // 相机对准**画面中心**，不是角色重心。
  //
  // 这点很容易搞反：原来取所有角色位置的平均值当视线焦点，
  // 结果一个「站在画右」的独角戏会被摆到画面正中——screen_position 整个白写了。
  // 画面位置是相对画框说的，所以画框必须钉死在 x=0，让人相对它站开。
  const focus: Vec3 = { x: 0, y: +(distance * (DEPTH_FRACTION.midground ?? 1)).toFixed(3), z: 1.5 };
  const camHeight = ANGLE_HEIGHT[dna.camera.angle] ?? 1.6;

  // 机位就停在景别该在的距离。人是按这个距离下的画面宽度摆开的，天然都在画内，
  // 不需要再为了「框住所有人」把相机往后拖——那正是上一版把景别搞没的原因。
  const camera: BlenderCamera = {
    position: { x: 0, y: +(focus.y - distance).toFixed(3), z: camHeight },
    lookAt: focus,
    focalLength: focal,
    path: [],
  };

  // 运镜动画：把 DNA 里的运镜类型翻译成机位路径。
  // 只处理能确定的几种；认不出的就固定机位——编一条错的路径比不动更糟。
  if (dna.camera.movement === 'dolly_in') {
    camera.path = [
      { at: 0, position: camera.position, lookAt: focus },
      { at: duration, position: { ...camera.position, y: camera.position.y + distance * 0.45 }, lookAt: focus },
    ];
  } else if (dna.camera.movement === 'dolly_out') {
    camera.path = [
      { at: 0, position: camera.position, lookAt: focus },
      { at: duration, position: { ...camera.position, y: camera.position.y - distance * 0.45 }, lookAt: focus },
    ];
  } else if (dna.camera.movement === 'truck') {
    camera.path = [
      { at: 0, position: { ...camera.position, x: camera.position.x - 1.5 }, lookAt: focus },
      { at: duration, position: { ...camera.position, x: camera.position.x + 1.5 }, lookAt: focus },
    ];
  } else if (dna.camera.movement === 'orbit') {
    // 环绕：绕焦点转 60 度，采样四个点。
    const r = distance;
    camera.path = [0, 1, 2, 3].map((i) => {
      const angle = (-30 + (60 * i) / 3) * (Math.PI / 180);
      return {
        at: +((duration * i) / 3).toFixed(2),
        position: { x: focus.x + r * Math.sin(angle), y: focus.y - r * Math.cos(angle), z: camHeight },
        lookAt: focus,
      };
    });
  } else if (dna.camera.movement === 'crane') {
    camera.path = [
      { at: 0, position: { ...camera.position, z: camHeight }, lookAt: focus },
      { at: duration, position: { ...camera.position, z: camHeight + 2.5 }, lookAt: focus },
    ];
  }

  // 灯光：主光方向从 DNA 的文字里认，认不出就给一个标准三点布光的主光。
  const lights: BlenderLight[] = [{
    type: interior ? 'AREA' : 'SUN',
    position: lightPosition(dna.lighting.direction || dna.lighting.key_light, focus),
    energy: interior ? 200 : 4,
    temperature: /冷|蓝|cool|blue/.test(dna.lighting.color_temperature + dna.lighting.key_light) ? 6500 : 4500,
  }];

  return {
    schema_version: 'blender-scene.v1',
    shotId: dna.shot_id,
    durationSeconds: duration,
    fps,
    aspectRatio: opts.aspectRatio,
    framingNote,
    // 房间按实际需要长大，不写死。
    // 写死 12×12 时，一个「框住四个人」的广角机位会被推到房间外面，
    // 校验器报「相机在房间外」直接拒渲——可房间只是块背景板，该让它长大而不是拦住相机。
    room: roomFor(actors, camera, interior, opts.aspectRatio),
    actors,
    props: dna.objects.map((o, i) => ({
      id: o.object_id,
      name: o.name,
      position: { x: +((POSITION_FRACTION[o.screen_position] ?? 0) * halfWidth).toFixed(3), y: +(distance * (DEPTH_FRACTION[o.depth_layer] ?? 1)).toFixed(3), z: 0.4 + i * 0.01 },
      size: { x: 0.8, y: 0.8, z: 0.8 },
    })),
    camera,
    lights,
    // 默认只渲首帧和布局图：够视频模型理解空间了，而且快。
    // 有走位动画时才渲路径，那是真正需要看清运动轨迹的情况。
    outputs: actors.some((a) => a.path.length) || camera.path.length
      ? ['first_frame', 'path_animation', 'layout_diagram']
      : ['first_frame', 'layout_diagram'],
  };
}

/**
 * 要把所有角色都收进画面，相机至少得退多远。
 *
 * 用 36mm 全画幅等效：水平视角 = 2·atan(18/f)。
 * 再把纵深的一半加回去——站在最靠近相机那个人前面还要留出余量，
 * 否则他会被近裁剪面切掉。
 */
/** 场地尺寸：必须同时容得下所有角色、相机路径，四周还要留出余量。 */
function roomFor(
  actors: BlenderActor[], camera: BlenderCamera, interior: boolean, aspectRatio: string,
): BlenderScene['room'] {
  const xs = [camera.position.x, ...camera.path.map((k) => k.position.x),
    ...actors.flatMap((a) => [a.position.x, ...a.path.map((p) => p.position.x)])];
  const ys = [camera.position.y, ...camera.path.map((k) => k.position.y),
    ...actors.flatMap((a) => [a.position.y, ...a.path.map((p) => p.position.y)])];
  const reach = (vals: number[]) => Math.max(4, ...vals.map((v) => Math.abs(v)));
  const depth = +(reach(ys) * 2 + 4).toFixed(1);

  // 墙高按画框算，不能写死。
  // 写死 3.2 米时，9:16 的竖画框上面三分之一全是空的暗区——
  // 参考视频白白浪费三分之一，而它是要喂给出片模型的。
  // 竖屏尤其明显：36mm 传感器落在长边上，竖画框比横画框高得多。
  const camY = Math.min(camera.position.y, ...camera.path.map((k) => k.position.y));
  const camZ = Math.max(camera.position.z, ...camera.path.map((k) => k.position.z));
  const toBackWall = Math.max(1, depth / 2 - camY);
  const focal = Math.min(camera.focalLength, ...camera.path.map((k) => k.focalLength ?? camera.focalLength));
  const needed = camZ + frameHalfHeight(toBackWall, focal, aspectRatio) + 0.5;

  return {
    width: +(reach(xs) * 2 + 4).toFixed(1),
    depth,
    height: +Math.max(3.2, needed).toFixed(1),
    interior,
  };
}


/**
 * 全片预演：把所有镜头拼成一条连续时间轴，渲成一条 MP4。
 *
 * 和逐镜预演的区别不只是「一次渲完」：
 *  - 相机在镜头边界**硬切**，不是平滑飞过去。飞过去等于把一部有剪辑的片子
 *    渲成了一条长镜头，节奏完全不对，喂给视频模型就是错误的运镜参考。
 *  - 角色的位置在整条时间轴上连续，能一眼看出「这个人从第 2 镜到第 3 镜位置跳了」——
 *    这正是连续性引擎在文字层面查的东西，在预演里是看得见的。
 *
 * 场地取所有镜头里最大的那个；室内外按多数镜头定。
 */
export function buildFilmScene(shots: ShotDna[], opts: { fps?: number; aspectRatio: string }): BlenderScene {
  if (!shots.length) throw new Error('没有镜头，无法构建全片预演');
  // 预演默认 12fps 而不是 24。
  // 一条 60 秒的片子按 24fps 是 1440 帧，EEVEE 也要渲十分钟；
  // 而预演要传达的是走位轨迹和运镜曲线，12fps 完全够看，渲染时间直接减半。
  // 真需要更顺可以传 fps 覆盖。
  const fps = opts.fps ?? 12;
  const ordered = [...shots].sort((a, b) => a.start_time - b.start_time);
  const total = Math.max(...ordered.map((s) => s.end_time));

  // 每镜先单独建一次场景，再把它们的时间轴拼起来——
  // 这样逐镜和全片两种模式共用同一套摆位逻辑，不会慢慢跑偏成两份。
  const perShot = ordered.map((dna) => ({ dna, scene: buildScene(dna, { fps, aspectRatio: opts.aspectRatio }) }));

  const actors = new Map<string, BlenderActor>();
  const camPath: BlenderCamera['path'] = [];

  // 每个角色在哪几段时间里真的在场。先收集，最后一次性转成可见性关键帧。
  const windows = new Map<string, Array<{ from: number; to: number }>>();

  for (const { dna, scene } of perShot) {
    const t0 = dna.start_time;

    for (const a of scene.actors) {
      const existing = actors.get(a.id);
      const target = existing ?? { ...a, path: [] as BlenderActor['path'] };
      if (!existing) actors.set(a.id, target);

      // 本镜里这个角色的在场区间。中途入画/出画的按 entry_at / exit_at 收窄。
      const src = dna.actors.find((x) => x.character_id === a.id);
      const from = Math.max(t0, src?.entry_at ?? t0);
      const to = Math.min(dna.end_time, src?.exit_at ?? dna.end_time);
      if (to > from) {
        const list = windows.get(a.id) ?? [];
        list.push({ from: +from.toFixed(3), to: +to.toFixed(3) });
        windows.set(a.id, list);
      }
      // 本镜内的走位换算到全片时间轴；没有走位的就在本镜起点钉一个关键帧，
      // 让他在这一镜里待在该待的地方。
      const keys = a.path.length
        ? a.path.map((p) => ({ ...p, at: +(t0 + p.at).toFixed(3) }))
        : [{ at: t0, position: a.position, rotationZ: a.rotationZ }];
      target.path.push(...keys);
    }

    // 相机：本镜起点是一次硬切，之后按本镜自己的运镜走
    const own = scene.camera.path.length
      ? scene.camera.path
      : [{ at: 0, position: scene.camera.position, lookAt: scene.camera.lookAt }];
    own.forEach((k, i) => {
      camPath.push({
        ...k,
        at: +(t0 + k.at).toFixed(3),
        focalLength: k.focalLength ?? scene.camera.focalLength,
        cut: i === 0,
      });
    });
  }

  // 把在场区间转成可见性关键帧。相邻区间接上的合并掉，免得在镜头边界闪一下。
  for (const [id, raw] of windows) {
    const merged: Array<{ from: number; to: number }> = [];
    for (const w of [...raw].sort((a, b) => a.from - b.from)) {
      const last = merged[merged.length - 1];
      if (last && w.from <= last.to + 0.001) last.to = Math.max(last.to, w.to);
      else merged.push({ ...w });
    }
    const actor = actors.get(id);
    if (!actor) continue;
    // 全程在场就什么都不写。多打一对恒真的关键帧没有意义，
    // 只会让 Blender 多一条曲线、让读脚本的人多猜一次。
    if (merged.length === 1 && merged[0].from <= 0.001 && merged[0].to >= total - 0.001) continue;
    const keys: NonNullable<BlenderActor['visibility']> = [];
    if (merged[0].from > 0.001) keys.push({ at: 0, visible: false });
    for (const w of merged) {
      keys.push({ at: w.from, visible: true });
      if (w.to < total - 0.001) keys.push({ at: w.to, visible: false });
    }
    actor.visibility = keys;
  }

  const first = perShot[0].scene;
  const interior = perShot.filter((p) => p.scene.room.interior).length >= perShot.length / 2;

  return {
    schema_version: 'blender-scene.v1',
    // 分隔符用 `-` 不用 `:`：这个 id 会被拼进对象存储 key 和本地路径，
    // Windows 上带冒号的路径直接 ENOENT。同一个坑在 shot_id 上已经踩过一次。
    shotId: `${ordered[0].project_id}-film`,
    durationSeconds: +total.toFixed(3),
    fps,
    aspectRatio: opts.aspectRatio,
    // 逐镜的机位退让汇总上来，别在拼成全片的时候把这些说明弄丢了
    framingNote: perShot.map((p) => p.scene.framingNote).filter(Boolean).join('；') || undefined,
    room: {
      width: Math.max(...perShot.map((p) => p.scene.room.width)),
      depth: Math.max(...perShot.map((p) => p.scene.room.depth)),
      height: Math.max(...perShot.map((p) => p.scene.room.height)),
      interior,
    },
    actors: [...actors.values()],
    // 道具按名字去重：同一张桌子在四个镜头里出现，只该建一次
    props: dedupeProps(perShot.flatMap((p) => p.scene.props)),
    camera: { ...first.camera, path: camPath },
    lights: first.lights,
    // 全片预演的产物就是那条 MP4；顺带一张顶视布局图给人看
    outputs: ['path_animation', 'layout_diagram'],
  };
}

function dedupeProps(props: BlenderScene['props']): BlenderScene['props'] {
  const seen = new Map<string, BlenderScene['props'][number]>();
  for (const p of props) if (!seen.has(p.name)) seen.set(p.name, p);
  return [...seen.values()];
}

function lightPosition(text: string, focus: Vec3): Vec3 {
  if (/侧逆|逆光|backlit|rim/.test(text)) return { x: focus.x, y: focus.y + 4, z: 3.5 };
  if (/左/.test(text)) return { x: focus.x - 3, y: focus.y - 1, z: 3 };
  if (/右/.test(text)) return { x: focus.x + 3, y: focus.y - 1, z: 3 };
  if (/顶光|顶/.test(text)) return { x: focus.x, y: focus.y, z: 4.5 };
  return { x: focus.x - 2.5, y: focus.y - 2.5, z: 3 };   // 标准主光：左前上
}

// ---------- 场景校验 ----------

export interface SceneIssue { code: string; message: string }

/**
 * 场景合理性检查。渲染很慢，错误的场景不该等渲完才发现。
 */
export function validateScene(scene: BlenderScene): SceneIssue[] {
  const issues: SceneIssue[] = [];

  // 角色重叠：两个人站在同一个点上，渲出来就是穿模
  for (let i = 0; i < scene.actors.length; i += 1) {
    for (let j = i + 1; j < scene.actors.length; j += 1) {
      const a = scene.actors[i]; const b = scene.actors[j];
      const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
      if (d < 0.5) {
        issues.push({
          code: 'actor_overlap',
          message: `${a.id} 与 ${b.id} 相距只有 ${d.toFixed(2)} 米，会穿模。多半是两人的屏幕位置都没填，都落到了中央`,
        });
      }
    }
  }

  // 相机穿墙
  if (scene.room.interior) {
    const half = scene.room.depth / 2;
    if (Math.abs(scene.camera.position.y) > half || Math.abs(scene.camera.position.x) > scene.room.width / 2) {
      issues.push({ code: 'camera_outside', message: '相机在房间外面，室内镜头会拍到墙背面' });
    }
  }

  if (!(scene.camera.focalLength > 0)) {
    issues.push({ code: 'bad_focal', message: `焦距 ${scene.camera.focalLength} 不合法` });
  }
  if (!scene.actors.length && !scene.props.length) {
    issues.push({ code: 'empty_scene', message: '场景里既没有角色也没有道具，渲出来是一片空地' });
  }
  for (const actor of scene.actors) {
    for (const p of actor.path) {
      if (p.at < 0 || p.at > scene.durationSeconds + 0.01) {
        issues.push({ code: 'path_out_of_range', message: `${actor.id} 的走位关键帧 ${p.at}s 超出本镜 0–${scene.durationSeconds}s` });
      }
    }
  }
  return issues;
}

// ---------- 空间关系描述 ----------

/**
 * 把 3D 场景翻译回文字，写进提示词。
 *
 * 这一步才是 Blender 对成片的真正贡献：视频模型读不懂 .blend 文件，
 * 但它能读懂「A 在画面左侧中景，B 在他右后方两米」——而这句话是从确定的坐标推出来的，
 * 不是分析模型随口写的。
 */
export function describeBlocking(scene: BlenderScene): string {
  if (!scene.actors.length) return '';
  const parts = scene.actors.map((a) => {
    const side = a.position.x < -0.5 ? '画面左侧' : a.position.x > 0.5 ? '画面右侧' : '画面中央';
    const depth = a.position.y < 2.5 ? '近景' : a.position.y > 5 ? '远景' : '中景';
    const facing = a.rotationZ === 180 ? '面向镜头' : a.rotationZ === 0 ? '背对镜头'
      : a.rotationZ === 90 ? '侧身朝左' : '侧身朝右';
    const enter = a.path.length && a.path[0].position.x !== a.position.x
      ? `，从${a.path[0].position.x < 0 ? '画左' : '画右'}走入并在第 ${a.path[1]?.at ?? 0} 秒到位`
      : '';
    return `${a.id} 在${side}${depth}，${facing}${enter}`;
  });

  // 相对关系比绝对位置更有用：模型更容易照做「B 在 A 右后方」
  const rel: string[] = [];
  for (let i = 0; i < scene.actors.length - 1; i += 1) {
    const a = scene.actors[i]; const b = scene.actors[i + 1];
    const lr = b.position.x > a.position.x ? '右' : '左';
    const fb = b.position.y > a.position.y ? '后' : '前';
    rel.push(`${b.id} 位于 ${a.id} 的${lr}${fb}方约 ${Math.hypot(b.position.x - a.position.x, b.position.y - a.position.y).toFixed(1)} 米`);
  }
  return [...parts, ...rel].join('；');
}

export function describeCameraPath(scene: BlenderScene): string {
  const c = scene.camera;
  const lens = `${Math.round(c.focalLength)}mm 镜头`;
  const height = c.position.z > 2.5 ? '高机位俯拍' : c.position.z < 1.0 ? '低机位仰拍' : '平视机位';
  if (!c.path.length) return `${lens}，${height}，全程固定不动`;
  const first = c.path[0]; const last = c.path[c.path.length - 1];
  const moves: string[] = [];
  if (Math.abs(last.position.y - first.position.y) > 0.2) {
    moves.push(last.position.y > first.position.y ? '匀速推近' : '匀速拉远');
  }
  if (Math.abs(last.position.x - first.position.x) > 0.2) {
    moves.push(last.position.x > first.position.x ? '向右横移' : '向左横移');
  }
  if (Math.abs(last.position.z - first.position.z) > 0.2) {
    moves.push(last.position.z > first.position.z ? '向上升起' : '向下降落');
  }
  if (c.path.length > 2) moves.push('围绕主体弧线运动');
  return `${lens}，${height}，${scene.durationSeconds} 秒内${moves.join('并')}，始终对准主体`;
}
