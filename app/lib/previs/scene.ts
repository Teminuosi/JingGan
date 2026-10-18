// Three.js 灰模场景：外形、尺寸、颜色照搬 worker/previs/render.py（Blender Workbench），
// 物体的位置/朝向/缩放全部由 kinematics.mjs 算出，这里只负责把它们画出来。
import * as THREE from 'three';
import { fovFor, stateAt, type MotionPlan, type PrevisCamera, type PrevisObject } from './film';

const linear = (rgb: readonly number[]) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);

// Blender 基本体：UV 球 12×8、半径 1；圆柱/圆锥 12 边、半径 1、高 2 沿 Z；圆环 0.75/0.25 在 XY 平面；立方体边长 2。
function geometries() {
  const cylinder = new THREE.CylinderGeometry(1, 1, 2, 12); cylinder.rotateX(Math.PI / 2);
  const cone = new THREE.ConeGeometry(1, 2, 12); cone.rotateX(Math.PI / 2);
  return {
    sphere: new THREE.SphereGeometry(1, 12, 8),
    cylinder, cone,
    torus: new THREE.TorusGeometry(.75, .25, 8, 16),
    box: new THREE.BoxGeometry(2, 2, 2),
  } as Record<string, THREE.BufferGeometry>;
}

export interface PrevisScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** 摆到某镜的某一刻（镜内秒数）。 */
  pose(plan: MotionPlan, local: number, aspect: { width: number; height: number }): PrevisCamera;
  dispose(): void;
}

export function createPrevisScene(): PrevisScene {
  const scene = new THREE.Scene();
  scene.background = linear([.10, .12, .14]);
  const geo = geometries();
  const materials = new Map<string, THREE.MeshLambertMaterial>();
  const material = (color: readonly number[]) => {
    const key = color.join(',');
    let value = materials.get(key);
    if (!value) { value = new THREE.MeshLambertMaterial({ color: linear(color), flatShading: true }); materials.set(key, value); }
    return value;
  };
  // 近似 Workbench 的工作室光：主光跟着镜头（朝向镜头的面最亮），天光从 +Z 补暗部，
  // 再加一盏只负责投影的顶光。观感接近即可，预演只用来看走位和构图。
  const sky = new THREE.HemisphereLight(0xffffff, 0x2a2e33, .04);
  sky.position.set(0, 0, 1);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xffffff, .32);
  sun.position.set(-4, -6, 14); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: .5, far: 60 });
  sun.shadow.bias = -.0005;
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(geo.box, material([.24, .27, .28]));
  ground.position.set(0, 0, -.08); ground.scale.set(30, 30, .08); ground.receiveShadow = true;
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(40, 1, .1, 500);
  camera.up.set(0, 0, 1);
  const key = new THREE.DirectionalLight(0xffffff, .7);
  key.position.set(-.35, .35, 1); // 镜头坐标：略偏左上的正前方
  key.target.position.set(0, 0, -1);
  camera.add(key, key.target);
  scene.add(camera);
  const meshes = new Map<string, THREE.Mesh>();
  const basis = new THREE.Matrix4(), scaled = new THREE.Matrix4();

  const place = (o: PrevisObject) => {
    let mesh = meshes.get(o.name);
    const geometry = geo[o.shape] ?? geo.box;
    if (!mesh || mesh.geometry !== geometry) {
      if (mesh) scene.remove(mesh);
      mesh = new THREE.Mesh(geometry, material(o.color));
      mesh.matrixAutoUpdate = false; mesh.castShadow = true;
      meshes.set(o.name, mesh); scene.add(mesh);
    }
    mesh.material = material(o.color);
    const r = o.rotation;
    basis.set(r[0], r[1], r[2], o.position[0], r[3], r[4], r[5], o.position[1], r[6], r[7], r[8], o.position[2], 0, 0, 0, 1);
    scaled.makeScale(o.scale[0], o.scale[1], o.scale[2]);
    mesh.matrix.multiplyMatrices(basis, scaled);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.visible = o.visible;
  };

  return {
    scene, camera,
    pose(plan, local, aspect) {
      const { objects, camera: cam } = stateAt(plan, local);
      const seen = new Set<string>();
      for (const o of objects) { place(o); seen.add(o.name); }
      // 换镜后上一镜独有的角色/道具不能留在画面里。
      for (const [name, mesh] of meshes) if (!seen.has(name)) mesh.visible = false;
      camera.aspect = aspect.width / aspect.height;
      camera.fov = fovFor(cam.lens, aspect.width, aspect.height);
      camera.position.set(cam.position[0], cam.position[1], cam.position[2]);
      camera.lookAt(cam.target[0], cam.target[1], cam.target[2]);
      camera.rotateZ(cam.roll * Math.PI / 180);
      camera.updateProjectionMatrix();
      return cam;
    },
    dispose() {
      for (const g of Object.values(geo)) g.dispose();
      for (const m of materials.values()) m.dispose();
      meshes.clear();
    },
  };
}

export function createRenderer(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number, preserveDrawingBuffer = false) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Blender 4.5 默认用 AgX 视图变换，同样的线性颜色在它那里更暗、更不艳；对齐它。
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  return renderer;
}
