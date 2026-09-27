// Worker 侧的仓储与 FFmpeg 实现。
//
// handler 只认接口，真正碰数据库、碰磁盘、碰 ffmpeg 子进程的代码都在这里。
// 这样 handler 能在测试里用假实现驱动，不需要装 FFmpeg 也不需要真数据库。
//
// FFmpeg 未装时：probe/concat 会抛出可读的错误而不是神秘的 ENOENT。
// TODO_REAL_PROVIDER_INTEGRATION：ffmpeg 路径未在本机验证过。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createRepo(db) {
  const now = () => Date.now();

  /** Shot DNA 在库里是十来个 JSON 列，这里负责两边的转换。 */
  const rowToDna = (row) => ({
    schema_version: row.schema_version,
    shot_id: row.shot_id,
    project_id: row.project_id,
    idx: row.idx ?? 0,
    start_time: row.start_time ?? 0,
    end_time: row.end_time ?? 0,
    scene_id: row.scene_id ?? '',
    narrative_function: row.narrative_function ?? '',
    summary: row.summary ?? '',
    camera: JSON.parse(row.camera_json),
    actors: JSON.parse(row.actors_json),
    objects: JSON.parse(row.objects_json),
    environment: JSON.parse(row.environment_json),
    lighting: JSON.parse(row.lighting_json),
    action_timeline: JSON.parse(row.action_timeline),
    expression_timeline: JSON.parse(row.expression_timeline),
    continuity: JSON.parse(row.continuity_json),
    visual_style: JSON.parse(row.visual_style_json),
    complexity: JSON.parse(row.complexity_json),
    dialogue: JSON.parse(row.dialogue_json ?? '{"speaker_id":"","text":"","delivery":""}'),
    sound: row.sound ?? '',
    transition_in: row.transition_in ?? '',
    corrected_by_user: Boolean(row.corrected_by_user),
    revision: row.revision ?? 1,
  });

  return {
    async getShotDna(shotId) {
      // idx / 起止时间 / 场景在 shots 表上，必须 join，不然投影出来的 DNA 时间轴全是 0
      const row = await db.prepare(
        `SELECT d.*, s.idx, s.start_time, s.end_time, s.scene_id
         FROM shot_dna d JOIN shots s ON s.id = d.shot_id WHERE d.shot_id = ?`,
      ).bind(shotId).first();
      return row ? rowToDna(row) : null;
    },

    async saveShotDna(dna) {
      const t = now();
      // shots 行先要存在：shot_dna.shot_id 是它的外键
      await db.prepare(
        `INSERT OR IGNORE INTO shots (id,project_id,scene_id,idx,start_time,end_time,duration,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(dna.shot_id, dna.project_id, dna.scene_id, dna.idx, dna.start_time, dna.end_time,
        dna.end_time - dna.start_time, t, t).run();

      await db.prepare(
        `INSERT INTO shot_dna (shot_id,project_id,schema_version,narrative_function,summary,
           dialogue_json,sound,transition_in,camera_json,actors_json,objects_json,
           environment_json,lighting_json,action_timeline,expression_timeline,continuity_json,
           visual_style_json,complexity_json,corrected_by_user,revision,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(shot_id) DO UPDATE SET
           narrative_function=excluded.narrative_function, summary=excluded.summary,
           dialogue_json=excluded.dialogue_json, sound=excluded.sound,
           transition_in=excluded.transition_in,
           camera_json=excluded.camera_json, actors_json=excluded.actors_json,
           objects_json=excluded.objects_json, environment_json=excluded.environment_json,
           lighting_json=excluded.lighting_json, action_timeline=excluded.action_timeline,
           expression_timeline=excluded.expression_timeline, continuity_json=excluded.continuity_json,
           visual_style_json=excluded.visual_style_json, complexity_json=excluded.complexity_json,
           corrected_by_user=excluded.corrected_by_user, revision=excluded.revision,
           updated_at=excluded.updated_at`,
      ).bind(dna.shot_id, dna.project_id, dna.schema_version,
        dna.narrative_function, dna.summary, JSON.stringify(dna.dialogue), dna.sound, dna.transition_in,
        JSON.stringify(dna.camera), JSON.stringify(dna.actors), JSON.stringify(dna.objects),
        JSON.stringify(dna.environment), JSON.stringify(dna.lighting),
        JSON.stringify(dna.action_timeline), JSON.stringify(dna.expression_timeline),
        JSON.stringify(dna.continuity), JSON.stringify(dna.visual_style), JSON.stringify(dna.complexity),
        dna.corrected_by_user ? 1 : 0, dna.revision, t, t).run();
    },

    async listShotDna(projectId) {
      const res = await db.prepare(
        `SELECT d.*, s.idx, s.start_time, s.end_time, s.scene_id
         FROM shot_dna d JOIN shots s ON s.id = d.shot_id
         WHERE d.project_id = ? ORDER BY s.idx ASC`,
      ).bind(projectId).all();
      return (res.results ?? []).map(rowToDna);
    },

    async compileContext(projectId) {
      const res = await db.prepare('SELECT * FROM characters WHERE project_id = ?').bind(projectId).all();
      const characters = {};
      for (const row of res.results ?? []) {
        const profile = JSON.parse(row.profile_json || '{}');
        characters[row.source_role_id || row.id] = {
          character_id: row.id,
          name: row.name || row.source_role_id,
          appearance: profile.appearance ?? '',
          wardrobe: profile.wardrobe ?? '',
          referenceSlot: profile.referenceSlot,
        };
      }
      const cfg = await db.prepare("SELECT value_json FROM system_config WHERE key = 'style_lock'").first();
      const styleLock = cfg ? JSON.parse(cfg.value_json) : {};
      return {
        characters,
        styleLock: {
          pacing: styleLock.pacing ?? '', camera: styleLock.camera ?? '',
          visual: styleLock.visual ?? '', performance: styleLock.performance ?? '',
          sound: styleLock.sound ?? '', negativeConstraints: styleLock.negativeConstraints ?? [],
        },
        dialogueLanguage: styleLock.dialogueLanguage ?? '中文',
      };
    },

    async registerAsset({ projectId, shotId, kind, key, contentType, bytes, duration, meta }) {
      const id = crypto.randomUUID();
      await db.prepare(
        `INSERT INTO assets (id,project_id,owner_id,kind,store,object_key,content_type,bytes,width,height,duration,meta_json,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(id, projectId, '', kind, 'local', key, contentType, bytes, 0, 0, duration ?? 0,
        JSON.stringify({ shotId, ...(meta ?? {}) }), now()).run();
      return id;
    },

    async assetsOf(projectId, kind) {
      const res = await db.prepare(
        'SELECT id, object_key, duration, meta_json FROM assets WHERE project_id = ? AND kind = ? ORDER BY created_at ASC',
      ).bind(projectId, kind).all();
      return (res.results ?? []).map((r) => ({
        id: r.id,
        shotId: JSON.parse(r.meta_json || '{}').shotId ?? '',
        key: r.object_key,
        duration: r.duration,
      }));
    },

    async saveQaReport(report, decision) {
      await db.prepare(
        `INSERT INTO quality_reports (id,shot_id,outcome,score,primary_failure,findings_json,decision,decision_note,created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(crypto.randomUUID(), report.shotId, report.verdict, report.score,
        report.primaryFailure ?? '', JSON.stringify(report.findings),
        decision?.strategy ?? '', decision?.explanation ?? '', now()).run();
    },

    /**
     * 每一镜最新的质检结论。
     * 用 MAX(created_at) 分组取最新那条——重试过的镜头会有多份报告，
     * 拿旧的那份判断等于用上一次的失败挡住这一次的成功。
     */
    async latestQaOutcomes(projectId) {
      const res = await db.prepare(
        `SELECT q.shot_id, q.outcome FROM quality_reports q
         JOIN shots s ON s.id = q.shot_id
         WHERE s.project_id = ?
           AND q.created_at = (SELECT MAX(created_at) FROM quality_reports WHERE shot_id = q.shot_id)`,
      ).bind(projectId).all();
      return Object.fromEntries((res.results ?? []).map((r) => [r.shot_id, r.outcome]));
    },

    /** 某一镜最新的成片。重试过的镜头有多份，取最后写入的那份。 */
    async latestClip(projectId, shotId) {
      const res = await db.prepare(
        `SELECT object_key, meta_json FROM assets
         WHERE project_id = ? AND kind = 'video_result' ORDER BY created_at DESC`,
      ).bind(projectId).all();
      for (const r of res.results ?? []) {
        try {
          if (JSON.parse(r.meta_json || '{}').shotId === shotId) return { key: r.object_key };
        } catch { /* meta 坏了就跳过这条 */ }
      }
      return null;
    },

    async latestQa(projectId) {
      const res = await db.prepare(
        `SELECT q.* FROM quality_reports q
         JOIN shots s ON s.id = q.shot_id
         WHERE s.project_id = ?
           AND q.created_at = (SELECT MAX(created_at) FROM quality_reports WHERE shot_id = q.shot_id)`,
      ).bind(projectId).all();
      return (res.results ?? []).map((r) => ({
        shotId: r.shot_id,
        report: {
          shotId: r.shot_id,
          verdict: r.outcome,
          score: r.score,
          findings: JSON.parse(r.findings_json || '[]'),
          primaryFailure: r.primary_failure || undefined,
        },
      }));
    },

    /** 这一镜历史上用过哪些重试策略。按时间正序，重试引擎据此避免重复用招。 */
    async usedStrategies(shotId) {
      const res = await db.prepare(
        "SELECT decision FROM quality_reports WHERE shot_id = ? AND decision <> '' ORDER BY created_at ASC",
      ).bind(shotId).all();
      return (res.results ?? []).map((r) => r.decision);
    },

    /**
     * 这一镜的花费。
     *
     * 数据来自 tasks.output_json 而不是 provider_requests：后者的 shot_id 是 Gateway 写的，
     * 而 Gateway 只认 VideoGenerateInput，拿不到 shotId，那一列永远是空的。
     * 出片任务的 output 里 estimateCents / chargedCents 都是实打实记下来的。
     *
     * spent 累加所有成功出片（含重试）的实扣；estimate 取第一次那笔——
     * 成本闸比的是「重试到现在花的」对「原本该花的」，基数必须是第一次。
     */
    async spending(shotId) {
      const res = await db.prepare(
        "SELECT output_json FROM tasks WHERE shot_id = ? AND type='video' AND status='succeeded' ORDER BY created_at ASC",
      ).bind(shotId).all();
      const rows = (res.results ?? []).map((r) => JSON.parse(r.output_json || '{}'));
      // byok 模式下 chargedCents 是 0（平台不经手钱），此时退回用预估算，
      // 否则成本闸对自带 Key 的用户永远不会触发。
      const spentCents = rows.reduce((sum, o) => sum + (o.chargedCents || o.estimateCents || 0), 0);
      return { spentCents, estimateCents: rows[0]?.estimateCents ?? 0 };
    },

    async recordDecision(shotId, report, decision) {
      // 决定写回这一镜最新那份质检报告，而不是新插一条——
      // 报告和处置是同一件事的两面，分开存会让「这次判废之后做了什么」查不清楚。
      await db.prepare(
        `UPDATE quality_reports SET decision = ?, decision_note = ?
         WHERE shot_id = ? AND created_at = (SELECT MAX(created_at) FROM quality_reports WHERE shot_id = ?)`,
      ).bind(decision.strategy, decision.explanation, shotId, shotId).run();
    },

    async blenderEnabled(shotId) {
      const row = await db.prepare('SELECT complexity_json FROM shot_dna WHERE shot_id = ?').bind(shotId).first();
      return Boolean(row && JSON.parse(row.complexity_json || '{}').needs_blender);
    },

    /**
     * 项目画幅，例如 '9:16'。3D 预演按它渲。
     * 查不到返回 undefined，让调用方明确失败，而不是退回一个写死的比例。
     */
    async aspectRatioOf(projectId) {
      const row = await db.prepare('SELECT aspect_ratio, source_width, source_height FROM projects WHERE id = ?')
        .bind(projectId).first();
      if (!row) return undefined;
      if (row.aspect_ratio) return String(row.aspect_ratio);
      // 没登记画幅就用实测分辨率反推，比猜一个默认值靠谱。
      if (row.source_width > 0 && row.source_height > 0) return `${row.source_width}:${row.source_height}`;
      return undefined;
    },

    async shotShape(shotId) {
      const row = await db.prepare(
        `SELECT s.start_time, s.end_time, d.action_timeline, d.revision
         FROM shots s JOIN shot_dna d ON d.shot_id = s.id WHERE s.id = ?`,
      ).bind(shotId).first();
      if (!row) return { seconds: 0, actionBeats: 0, revision: 1 };
      return {
        seconds: +(row.end_time - row.start_time).toFixed(3),
        actionBeats: JSON.parse(row.action_timeline || '[]').length,
        revision: row.revision ?? 1,
      };
    },

    async setShotPrompt(shotId, prompt) {
      await db.prepare('UPDATE shots SET prompt_text=?, prompt_template=?, updated_at=? WHERE id=?')
        .bind(prompt.text, `${prompt.template}@${prompt.version}`, now(), shotId).run();
    },
  };
}

// ---------- FFmpeg ----------

export function createFfmpeg(objectRoot, opts = {}) {
  const ffmpeg = opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const ffprobe = opts.ffprobePath ?? process.env.FFPROBE_PATH ?? 'ffprobe';
  const full = (key) => path.join(objectRoot, key);

  const run = async (bin, args) => {
    try {
      return await execFileAsync(bin, args, { maxBuffer: 16 * 1024 * 1024 });
    } catch (err) {
      if (err.code === 'ENOENT') {
        // 说清楚是环境缺东西，而不是抛一个 ENOENT 让人猜半天
        throw new Error(`找不到 ${bin}。请安装 FFmpeg，或用 FFMPEG_PATH / FFPROBE_PATH 指定路径`);
      }
      throw new Error(`${path.basename(bin)} 执行失败：${(err.stderr || err.message || '').slice(-600)}`);
    }
  };

  return {
    async probe(key) {
      const file = full(key);
      if (!fs.existsSync(file)) throw new Error(`文件不存在：${key}`);
      const { stdout } = await run(ffprobe, [
        '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
      ]);
      const info = JSON.parse(stdout);
      const video = (info.streams ?? []).find((s) => s.codec_type === 'video');
      const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio');
      return {
        durationSeconds: +(Number(info.format?.duration ?? 0)).toFixed(3),
        width: video?.width ?? 0,
        height: video?.height ?? 0,
        bytes: Number(info.format?.size ?? fs.statSync(file).size),
        frameRate: video?.r_frame_rate ? eval_fraction(video.r_frame_rate) : undefined,
        hasAudio: Boolean(audio),
      };
    },

    async cut(sourceKey, start, end, outKey) {
      const out = full(outKey);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // -ss 放在 -i 之前是快速定位，但会对齐到关键帧；镜头边界要准，所以重编码。
      await run(ffmpeg, ['-y', '-ss', String(start), '-to', String(end), '-i', full(sourceKey),
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', out]);
      return { key: outKey, bytes: fs.statSync(out).size };
    },

    async extractFrames(key, atSeconds) {
      const out = [];
      for (const t of atSeconds) {
        const tmp = full(`${key}.frame-${t}.jpg`);
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        await run(ffmpeg, ['-y', '-ss', String(t), '-i', full(key), '-frames:v', '1', '-q:v', '4', tmp]);
        out.push(`data:image/jpeg;base64,${fs.readFileSync(tmp).toString('base64')}`);
        fs.unlinkSync(tmp);
      }
      return out;
    },

    /**
     * 合成一段指定时长的黑场 mp4。
     * 只给 Mock Provider 用：让「没接真模型」时产出的也是一个真能播、真能被 ffprobe 读的文件，
     * 否则失败会以「moov atom not found」的形式出现在质检那一步，
     * 指向的方向跟真正的原因完全无关。
     */
    async synthClip(seconds) {
      const out = full(`_mock/${Date.now()}-${Math.round(seconds * 1000)}.mp4`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await run(ffmpeg, ['-y', '-f', 'lavfi', '-i', `color=c=0x0d1f19:s=480x854:d=${seconds}`,
        '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono:d=${seconds}`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', out]);
      const bytes = fs.readFileSync(out);
      fs.rmSync(out, { force: true });
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },

    /**
     * PNG 序列 → MP4。给 Blender 预演用。
     * yuv420p 是硬要求：不转的话很多播放器和上游解码器直接不认。
     */
    async encodeFrames(framesDir, fps, outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      await run(ffmpeg, ['-y', '-framerate', String(fps), '-i', path.join(framesDir, 'f_%04d.png'),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', outPath]);
      return { bytes: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0 };
    },

    async concat(keys, outKey) {
      const out = full(outKey);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const listPath = `${out}.concat.txt`;
      // concat demuxer 要求路径里的单引号转义，否则文件名带引号会把列表语法搞坏
      fs.writeFileSync(listPath, keys.map((k) => `file '${full(k).replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
      try {
        await run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', out]);
      } catch {
        // 各镜头编码参数不一致时 -c copy 会失败，退回重编码。慢，但一定成。
        await run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath,
          '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', out]);
      } finally {
        fs.rmSync(listPath, { force: true });
      }
      const { stdout } = await run(ffprobe, ['-v', 'error', '-show_format', '-print_format', 'json', out]);
      return {
        key: outKey,
        bytes: fs.statSync(out).size,
        durationSeconds: +(Number(JSON.parse(stdout).format?.duration ?? 0)).toFixed(3),
      };
    },
  };
}

/** ffprobe 的帧率是 "30000/1001" 这种分数形式。 */
function eval_fraction(text) {
  const [a, b] = String(text).split('/').map(Number);
  return b ? +(a / b).toFixed(3) : a;
}

/** 本地磁盘对象存储。 */
/**
 * 对象 key → 本地路径。
 *
 * key 是业务层拼的，可能带上 id 里的任意字符。Windows 对 : * ? " < > | 一律拒收，
 * 报的还是「找不到目录」这种完全误导的错。上游已经规定 id 不许带这些字符，
 * 这里再挡一道——两处都守住，换个平台或换个 id 方案时才不会突然炸。
 */
const ILLEGAL = /[:*?"<>|]/g;
const safeKey = (key) => key.split('/').map((seg) => seg.replace(ILLEGAL, '_')).join('/');

export function createDiskStore(root) {
  const full = (key) => path.join(root, safeKey(key));
  return {
    async put(key, body, contentType) {
      const file = full(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(body));
      return { key, bytes: body.byteLength, contentType };
    },
    async get(key) {
      const file = full(key);
      return fs.existsSync(file) ? fs.readFileSync(file).buffer : null;
    },
    async head(key) {
      const file = full(key);
      if (!fs.existsSync(file)) return null;
      return { key, bytes: fs.statSync(file).size, contentType: '' };
    },
    async delete(key) { fs.rmSync(full(key), { force: true }); },
    url(key) { return `/api/objects/${key}`; },
  };
}
