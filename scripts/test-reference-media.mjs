// 参考视频（本段 3D 预演）链路：请求体形状、提示词措辞、指纹稳定、签名链接、上传口防滥用。
// 全部离线：不发任何模型 / 中转请求，R2 用内存假对象。
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function load(entry) {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}
globalThis.fetch = () => { throw new Error('Network/model requests forbidden'); };

const models = await load('app/lib/video-models.ts');
const segments = await load('app/lib/post/segments.ts');
const media = await load('app/lib/server/reference-media.ts');

// ---- 1. 请求体：全能档 images/videos 对象形状；非全能档不变 ----
const omni = models.videoModel('seedance-2.5');
const plan = { model: omni.id, seconds: 8, prompt: 'p', referenceImages: ['data:image/jpeg;base64,AA', 'https://cdn.example/b.png'] };
const noVideo = models.buildVideoRequest(omni, plan);
assert.deepEqual(noVideo.images, [
  { url: 'data:image/jpeg;base64,AA', role: 'reference_image' },
  { url: 'https://cdn.example/b.png', role: 'reference_image' },
]);
assert.equal(noVideo.reference_images, undefined, '文档没有 reference_images 字段');
assert.equal(noVideo.input_reference, undefined, '2.5 的 input_reference 是按序转场首帧，不能放身份图');
assert.equal(noVideo.videos, undefined);
const signed = 'https://jinggan.example/api/reference-media/0b0e3f4a-1111-4222-8333-444455556666.mp4?exp=1&sig=abc';
const withVideo = models.buildVideoRequest(omni, { ...plan, referenceVideos: [signed] });
assert.deepEqual(withVideo.videos, [{ url: signed, role: 'reference_video' }]);
assert.deepEqual(withVideo.images, noVideo.images);
assert.equal(models.buildVideoRequest(omni, { ...plan, referenceVideos: ['data:video/mp4;base64,AA', 'http://127.0.0.1/x.mp4'] }).videos, undefined, '只放行公网 https 链接');
for (const model of models.VIDEO_MODELS.filter(item => item.referenceStyle !== 'omni' && item.maxReferenceImages > 0)) {
  const body = models.buildVideoRequest(model, { ...plan, model: model.id, seconds: model.fixedSeconds ?? 6, referenceVideos: [signed] });
  assert.equal(body.videos, undefined, `${model.id} 不发参考视频`);
  assert.equal(body.images, undefined, `${model.id} 仍走 input_reference`);
  assert.ok(body.input_reference !== undefined, `${model.id} 仍走 input_reference`);
}
const single = models.VIDEO_MODELS.find(item => item.referenceStyle === 'single');
assert.equal(typeof models.buildVideoRequest(single, { ...plan, model: single.id, seconds: 6 }).input_reference, 'string', '单素材档仍只给一张');
assert.equal(models.paramSource(omni, 'reference_videos'), 'documented');

// ---- 2. 提示词：有/无参考视频两种措辞 ----
const web = '[素材绑定：图片]\n\nCHAR_A = 【角色A图片】\n\n3D 参考 = 【本段预演视频】；仅参考走位。\n\n9.6 秒。绑定本段 3D 预演作为走位、构图与运镜参考；以文字动作和角色图为准，不生成灰模外观。\n\n动作：举手';
const plain = models.toApiPrompt(web, ['CHAR_A'], omni);
assert.ok(plain.includes('只用角色图和以下文字分镜，不需要参考视频。'));
assert.ok(!plain.includes('参考视频 ='));
assert.ok(!plain.includes('3D 参考 ='));
const attached = models.toApiPrompt(web, ['CHAR_A'], omni, { referenceVideo: true });
assert.ok(attached.startsWith('参考图按顺序对应：第 1 张 = CHAR_A。'), attached);
assert.ok(attached.includes(models.REFERENCE_VIDEO_LINE));
assert.ok(!attached.includes('不需要参考视频'));
assert.ok(!attached.includes('绑定本段 3D 预演'));
assert.ok(!attached.includes('3D 参考 ='));
assert.ok(attached.includes('动作：举手'));
const defaultText = '9.6 秒。只用角色图和以下文字分镜，不需要参考视频。\n\n动作：举手';
assert.ok(!models.toApiPrompt(defaultText, ['CHAR_A'], omni, { referenceVideo: true }).includes('不需要参考视频'));
const twoZero = models.VIDEO_MODELS.find(item => item.referenceStyle !== 'omni' && item.maxReferenceImages > 0);
assert.ok(!models.toApiPrompt(defaultText, ['CHAR_A'], twoZero, { referenceVideo: true }).includes('参考视频 ='), '非全能档不会说有参考视频');

// ---- 3. 指纹 / 缓存键：签名链接变了不算变，带不带 3D 才算 ----
const shapeA = models.buildVideoRequest(omni, { ...plan, referenceVideos: [signed] });
const shapeB = models.buildVideoRequest(omni, { ...plan, referenceVideos: [signed.replace('sig=abc', 'sig=xyz').replace('exp=1', 'exp=2')] });
const identity = 'browser:dna:123:shot-1:0-6';
const fpA = await segments.requestFingerprint(shapeA, ['asset-a'], identity);
assert.deepEqual(await segments.requestFingerprint(shapeB, ['asset-a'], identity), fpA, '重新上传同一段 3D 不算改动');
assert.notEqual((await segments.requestFingerprint(shapeA, ['asset-a'])).requestHash, fpA.requestHash, '带 3D 与不带 3D 是参数变化');
assert.notEqual((await segments.requestFingerprint(shapeA, ['asset-a'], 'browser:dna:124:shot-1:0-6')).requestHash, fpA.requestHash, '预演重跑算参数变化');
const legacy = { model: 'seedance-2.5', prompt: 'p', seconds: '8', reference_images: ['data:...'] };
assert.deepEqual(await segments.requestFingerprint(legacy, ['asset-a']), await segments.requestFingerprint({ model: 'seedance-2.5', prompt: 'p', seconds: '8' }, ['asset-a']), '不带 3D 时旧指纹不变');

globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
const relay = await load('app/lib/relay-client.ts');
const keyA = await relay.videoCacheKey('p1', 'RUN_01', shapeA, identity);
assert.equal(await relay.videoCacheKey('p1', 'RUN_01', shapeB, identity), keyA, '缓存键不含签名链接');
assert.notEqual(await relay.videoCacheKey('p1', 'RUN_01', shapeA), keyA, '带 3D 的任务和不带 3D 的分开记');
assert.equal(await relay.videoCacheKey('p1', 'RUN_01', noVideo), await relay.videoCacheKey('p1', 'RUN_01', { ...noVideo }), '不带 3D 时键与原算法一致');

// ---- 4. 签名链接 ----
const secret = 'unit-test-secret-unit-test-secret-0123456789';
const id = '0b0e3f4a-1111-4222-8333-444455556666.mp4';
const now = 1_800_000_000_000;
const exp = Math.floor(now / 1000) + 3600;
const sig = await media.signReferenceMedia(secret, id, exp);
assert.equal(await media.verifyReferenceMedia(secret, id, String(exp), sig, now), true);
assert.equal(await media.verifyReferenceMedia(secret, id, String(exp), sig, (exp + 1) * 1000), false, '过期');
assert.equal(await media.verifyReferenceMedia(secret, id, String(exp + 60), sig, now), false, '改了过期时间');
assert.equal(await media.verifyReferenceMedia(secret, id, String(exp), sig.slice(0, -2) + (sig.endsWith('AA') ? 'BB' : 'AA'), now), false, '签名被改');
assert.equal(await media.verifyReferenceMedia(secret, '0b0e3f4a-1111-4222-8333-444455556667.mp4', String(exp), sig, now), false, '换了 id');
assert.equal(await media.verifyReferenceMedia(secret, '../x.mp4', String(exp), sig, now), false, '非法 id');
assert.equal(await media.verifyReferenceMedia('another-secret-another-secret-0123456789', id, String(exp), sig, now), false, '换了密钥');
assert.equal(await media.verifyReferenceMedia(secret, id, null, sig, now), false);
assert.throws(() => media.referenceMediaSecret({}, false), /media_signing_not_configured/, '生产没配密钥必须报错，不能用默认值');
assert.throws(() => media.referenceMediaSecret({ MIRROR_MEDIA_SIGNING_SECRET: 'short' }, false), /media_signing_not_configured/);
assert.equal(media.referenceMediaSecret({ MIRROR_MEDIA_SIGNING_SECRET: secret }, false), secret);
assert.ok(media.referenceMediaSecret({}, true).length >= 32, '本机开发用进程内随机密钥');

// ---- 5. 上传口 / 读取口 ----
const store = new Map();
const bucket = {
  async put(key, value, options) { store.set(key, { bytes: new Uint8Array(value), ...options }); },
  async get(key) { const item = store.get(key); return item ? { body: new Blob([item.bytes]).stream(), size: item.bytes.length, httpEtag: '"e"', customMetadata: item.customMetadata, httpMetadata: item.httpMetadata } : null; },
};
const deps = (owner = 'user-1') => ({
  requireOwner: async () => { if (!owner) throw new Error('unauthorized'); return owner; },
  bucket: () => bucket, secret: () => secret, now: () => now, randomId: () => '0b0e3f4a-1111-4222-8333-444455556666',
});
const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
const upload = (body, headers = {}) => new Request('https://jinggan.example/api/reference-media', { method: 'POST', headers: { 'content-type': 'video/mp4', ...headers }, body });
await assert.rejects(media.handleReferenceUpload(upload(mp4), deps('')), /unauthorized/, '未登录不能上传');
assert.equal(store.size, 0);
assert.equal((await media.handleReferenceUpload(upload(mp4, { 'content-type': 'image/png' }), deps())).status, 415, '非视频类型');
assert.equal((await media.handleReferenceUpload(upload(mp4, { 'content-type': 'text/html' }), deps())).status, 415);
assert.equal((await media.handleReferenceUpload(upload(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), deps())).status, 400, '内容头不是 mp4');
assert.equal((await media.handleReferenceUpload(upload(mp4, { 'content-length': String(31 * 1024 * 1024) }), deps())).status, 413, '声明超限');
const big = new Uint8Array(media.MAX_REFERENCE_VIDEO_BYTES + 1); big.set(mp4);
assert.equal((await media.handleReferenceUpload(upload(big), deps())).status, 413, '实际超限');
assert.equal((await media.handleReferenceUpload(upload(mp4, { origin: 'https://evil.example' }), deps())).status, 403, '跨站上传');
assert.equal(store.size, 0, '被拒的请求一个字节都没写进 R2');
const ok = await media.handleReferenceUpload(upload(mp4), deps());
assert.equal(ok.status, 200);
const { url, expiresAt } = await ok.json();
assert.match(url, /^https:\/\/jinggan\.example\/api\/reference-media\/0b0e3f4a-1111-4222-8333-444455556666\.mp4\?exp=\d+&sig=[A-Za-z0-9_-]+$/);
assert.equal(expiresAt, (Math.floor(now / 1000) + media.REFERENCE_MEDIA_TTL_SECONDS) * 1000);
const saved = store.get('reference-media/0b0e3f4a-1111-4222-8333-444455556666.mp4');
assert.equal(saved.customMetadata.owner, 'user-1');
assert.equal(saved.httpMetadata.contentType, 'video/mp4');

const parsed = new URL(url);
const fileId = parsed.pathname.split('/').pop();
const served = await media.handleReferenceDownload(new Request(url), fileId, deps());
assert.equal(served.status, 200, '上游不带登录头也能取');
assert.equal(served.headers.get('content-type'), 'video/mp4');
assert.deepEqual(new Uint8Array(await served.arrayBuffer()), mp4);
assert.equal((await media.handleReferenceDownload(new Request(url.replace(/sig=[^&]+/, 'sig=AAAA')), fileId, deps())).status, 403, '签名错');
assert.equal((await media.handleReferenceDownload(new Request(url), fileId, { ...deps(), now: () => expiresAt + 1 })).status, 403, '过期');
assert.equal((await media.handleReferenceDownload(new Request(url), '0b0e3f4a-1111-4222-8333-444455556666.webm', deps())).status, 403, '换扩展名');

console.log('Reference media: omni images/videos shape, prompt wording, stable fingerprints, signed URLs, upload guards passed; no network calls.');
