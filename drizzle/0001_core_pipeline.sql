-- 极客版核心管线表。
--
-- 老表 video_projects 一个字段都不改：现有项目必须继续能打开。
-- 新管线走这套表，projects.legacy_project_id 指回老表，需要时再迁，不强制。
--
-- D1 是 SQLite：没有 ENUM，状态用 TEXT + CHECK；没有 JSONB，结构化数据用 TEXT 存 JSON。
-- 所有金额一律用整数「分」存，绝不用浮点——浮点做账迟早对不平。

-- ---------- 用户与钱包 ----------

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 余额分三部分：可用、冻结、累计充值。
-- 任务开始前冻结预估金额，结束后按真实消耗结算，差额解冻。
CREATE TABLE IF NOT EXISTS wallets (
  user_id        TEXT PRIMARY KEY REFERENCES users(id),
  balance_cents  INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  frozen_cents   INTEGER NOT NULL DEFAULT 0 CHECK (frozen_cents >= 0),
  topup_cents    INTEGER NOT NULL DEFAULT 0,
  currency       TEXT NOT NULL DEFAULT 'CNY',
  updated_at     INTEGER NOT NULL
);

-- 每一分钱的变动都必须有流水，余额只能由流水推出来，不许直接 UPDATE balance。
-- idempotency_key 唯一：同一个业务动作重放多少次都只记一笔。
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  kind             TEXT NOT NULL CHECK (kind IN ('topup','freeze','unfreeze','charge','refund','adjust')),
  amount_cents     INTEGER NOT NULL,
  balance_after    INTEGER NOT NULL,
  frozen_after     INTEGER NOT NULL,
  ref_type         TEXT NOT NULL DEFAULT '',
  ref_id           TEXT NOT NULL DEFAULT '',
  idempotency_key  TEXT NOT NULL UNIQUE,
  memo             TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wtx_user_created ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wtx_ref ON wallet_transactions(ref_type, ref_id);

-- ---------- 项目 / 场景 / 镜头 ----------

CREATE TABLE IF NOT EXISTS projects (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL,
  title              TEXT NOT NULL DEFAULT '',
  mode               TEXT NOT NULL DEFAULT 'standard' CHECK (mode IN ('fast','standard','director')),
  status             TEXT NOT NULL DEFAULT 'created',
  source_asset_id    TEXT NOT NULL DEFAULT '',
  source_duration    REAL NOT NULL DEFAULT 0,
  source_fps         REAL NOT NULL DEFAULT 0,
  source_width       INTEGER NOT NULL DEFAULT 0,
  source_height      INTEGER NOT NULL DEFAULT 0,
  aspect_ratio       TEXT NOT NULL DEFAULT '',
  visual_style_json  TEXT NOT NULL DEFAULT '{}',
  settings_json      TEXT NOT NULL DEFAULT '{}',
  estimated_cents    INTEGER NOT NULL DEFAULT 0,
  actual_cents       INTEGER NOT NULL DEFAULT 0,
  final_video_asset  TEXT NOT NULL DEFAULT '',
  -- 老项目可以挂过来，不强制迁移
  legacy_project_id  TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS scenes (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  idx         INTEGER NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  start_time  REAL NOT NULL DEFAULT 0,
  end_time    REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenes_project ON scenes(project_id, idx);

-- Shot 是最核心的执行单位。规格第三章列的字段全部落在这里或 shot_dna 里。
CREATE TABLE IF NOT EXISTS shots (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id),
  scene_id            TEXT NOT NULL DEFAULT '',
  idx                 INTEGER NOT NULL,
  start_time          REAL NOT NULL DEFAULT 0,
  end_time            REAL NOT NULL DEFAULT 0,
  duration            REAL NOT NULL DEFAULT 0,
  source_clip_asset   TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'pending',
  complexity_score    REAL NOT NULL DEFAULT 0,
  needs_blender       INTEGER NOT NULL DEFAULT 0,
  prompt_text         TEXT NOT NULL DEFAULT '',
  prompt_template     TEXT NOT NULL DEFAULT '',
  result_asset_id     TEXT NOT NULL DEFAULT '',
  quality_score       REAL,
  generation_attempts INTEGER NOT NULL DEFAULT 0,
  cost_cents          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shots_project ON shots(project_id, idx);

-- Shot DNA 是所有下游模型的唯一真相源，单独存一张表并带版本，
-- 因为它会被人工修正（沿用老项目 corrected_by_user 的做法），要能追溯改了什么。
-- 注：2026-09-17 补了 narrative_function / summary / dialogue_json / sound / transition_in 五列。
-- 直接改这份建表语句而不是加一条 ALTER 迁移，因为这套新表还没上过任何环境
-- （唯一的库是本地 .worker/pipeline.sqlite，删了重建即可）。
-- 一旦上了生产，这份文件就该冻结，后续变更必须走新的迁移文件。
CREATE TABLE IF NOT EXISTS shot_dna (
  shot_id            TEXT PRIMARY KEY REFERENCES shots(id),
  project_id         TEXT NOT NULL,
  schema_version     TEXT NOT NULL DEFAULT 'shot-dna.v1',
  narrative_function TEXT NOT NULL DEFAULT '',
  summary            TEXT NOT NULL DEFAULT '',
  dialogue_json      TEXT NOT NULL DEFAULT '{}',
  sound              TEXT NOT NULL DEFAULT '',
  transition_in      TEXT NOT NULL DEFAULT '',
  camera_json        TEXT NOT NULL DEFAULT '{}',
  actors_json        TEXT NOT NULL DEFAULT '[]',
  objects_json       TEXT NOT NULL DEFAULT '[]',
  environment_json   TEXT NOT NULL DEFAULT '{}',
  lighting_json      TEXT NOT NULL DEFAULT '{}',
  action_timeline    TEXT NOT NULL DEFAULT '[]',
  expression_timeline TEXT NOT NULL DEFAULT '[]',
  continuity_json    TEXT NOT NULL DEFAULT '{}',
  visual_style_json  TEXT NOT NULL DEFAULT '{}',
  complexity_json    TEXT NOT NULL DEFAULT '{}',
  corrected_by_user  INTEGER NOT NULL DEFAULT 0,
  revision           INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  source_role_id TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL DEFAULT '',
  profile_json   TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_project ON characters(project_id);

CREATE TABLE IF NOT EXISTS character_references (
  id            TEXT PRIMARY KEY,
  character_id  TEXT NOT NULL REFERENCES characters(id),
  asset_id      TEXT NOT NULL,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  prompt_used   TEXT NOT NULL DEFAULT '',
  retired       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charrefs_character ON character_references(character_id);

-- ---------- 资产（只存元数据，二进制进对象存储） ----------

CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL DEFAULT '',
  owner_id      TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL CHECK (kind IN (
                  'source_video','clip','frame','keyframe','character_ref',
                  'blender_preview','blender_data','video_result','final_video','audio','other')),
  store         TEXT NOT NULL DEFAULT 'local',
  object_key    TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT '',
  bytes         INTEGER NOT NULL DEFAULT 0,
  width         INTEGER NOT NULL DEFAULT 0,
  height        INTEGER NOT NULL DEFAULT 0,
  duration      REAL NOT NULL DEFAULT 0,
  meta_json     TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_project ON assets(project_id, kind);

-- ---------- 任务与事件 ----------

-- 队列就是这张表：pending 行按优先级取，取到就写租约（locked_by + lease_until）。
-- worker 崩了租约到期自动回到 pending，不需要额外的 Redis。
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL DEFAULT '',
  shot_id          TEXT NOT NULL DEFAULT '',
  parent_task_id   TEXT NOT NULL DEFAULT '',
  type             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  priority         INTEGER NOT NULL DEFAULT 100,
  attempt          INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  input_json       TEXT NOT NULL DEFAULT '{}',
  output_json      TEXT NOT NULL DEFAULT '{}',
  error_text       TEXT NOT NULL DEFAULT '',
  failure_class    TEXT NOT NULL DEFAULT '',
  -- 同一个业务动作只允许产生一个任务，避免刷新页面重复提交
  idempotency_key  TEXT NOT NULL UNIQUE,
  locked_by        TEXT NOT NULL DEFAULT '',
  lease_until      INTEGER NOT NULL DEFAULT 0,
  heartbeat_at     INTEGER NOT NULL DEFAULT 0,
  run_after        INTEGER NOT NULL DEFAULT 0,
  trace_id         TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(status, run_after, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(status, lease_until);

-- 状态每变一次写一条，排查时能还原整条时间线
CREATE TABLE IF NOT EXISTS task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id),
  from_status TEXT NOT NULL DEFAULT '',
  to_status   TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  data_json   TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);

-- ---------- Provider 调用与账务 ----------

-- 每一次第三方调用都留底：延迟、成本、原始响应。
-- 这是对账和「到底扣没扣钱」的唯一依据——老项目吃过没有这个的亏。
CREATE TABLE IF NOT EXISTS provider_requests (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL DEFAULT '',
  project_id        TEXT NOT NULL DEFAULT '',
  shot_id           TEXT NOT NULL DEFAULT '',
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL DEFAULT '',
  operation         TEXT NOT NULL DEFAULT '',
  upstream_job_id   TEXT NOT NULL DEFAULT '',
  request_json      TEXT NOT NULL DEFAULT '{}',
  response_json     TEXT NOT NULL DEFAULT '{}',
  http_status       INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  provider_cost_cents INTEGER NOT NULL DEFAULT 0,
  error_text        TEXT NOT NULL DEFAULT '',
  trace_id          TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provreq_task ON provider_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_provreq_job ON provider_requests(upstream_job_id);

-- 成本 / 售价 / 利润三者必须分开记
CREATE TABLE IF NOT EXISTS billing_records (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  project_id          TEXT NOT NULL DEFAULT '',
  task_id             TEXT NOT NULL DEFAULT '',
  provider_cost_cents INTEGER NOT NULL DEFAULT 0,
  user_cost_cents     INTEGER NOT NULL DEFAULT 0,
  profit_cents        INTEGER NOT NULL DEFAULT 0,
  pricing_rule_id     TEXT NOT NULL DEFAULT '',
  settled             INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_billing_project ON billing_records(project_id);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL DEFAULT '',
  unit           TEXT NOT NULL CHECK (unit IN ('second','clip','image','ktoken','call')),
  cost_cents     INTEGER NOT NULL DEFAULT 0,
  markup_percent INTEGER NOT NULL DEFAULT 0,
  min_charge_cents INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pricing_lookup ON pricing_rules(provider, model, active);

-- ---------- 生成尝试与质检 ----------

CREATE TABLE IF NOT EXISTS generation_attempts (
  id             TEXT PRIMARY KEY,
  shot_id        TEXT NOT NULL REFERENCES shots(id),
  task_id        TEXT NOT NULL DEFAULT '',
  attempt        INTEGER NOT NULL,
  provider       TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  prompt_text    TEXT NOT NULL DEFAULT '',
  seed           INTEGER,
  result_asset_id TEXT NOT NULL DEFAULT '',
  quality_score  REAL,
  failure_class  TEXT NOT NULL DEFAULT '',
  cost_cents     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_shot ON generation_attempts(shot_id, attempt);

-- 两个结论必须分开存，它们回答的是不同问题：
--   outcome  = 这条片子合不合格（质检的结论）
--   decision = 不合格时下一步怎么打（重试引擎的决定）
-- 早先这张表只有一个 verdict 列，枚举里混着 accept/retry/use_blender 这类处置动作，
-- 结果是「质检说了什么」和「系统决定做什么」被压成一个字段，查起来分不清是谁的判断。
CREATE TABLE IF NOT EXISTS quality_reports (
  id             TEXT PRIMARY KEY,
  shot_id        TEXT NOT NULL REFERENCES shots(id),
  attempt_id     TEXT NOT NULL DEFAULT '',
  outcome        TEXT NOT NULL DEFAULT 'pass' CHECK (outcome IN ('pass','warn','fail')),
  score          REAL NOT NULL DEFAULT 0,
  primary_failure TEXT NOT NULL DEFAULT '',
  findings_json  TEXT NOT NULL DEFAULT '[]',
  decision       TEXT NOT NULL DEFAULT '' CHECK (decision IN ('','regenerate_same','reinforce_prompt','regenerate_keyframe','enable_blender','split_shot','switch_provider','reduce_complexity','manual')),
  decision_note  TEXT NOT NULL DEFAULT '',
  raw_json       TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_shot ON quality_reports(shot_id, created_at DESC);

-- ---------- 提示词模板与系统配置 ----------

-- Prompt 升级不能影响历史任务：任务记下用的是哪个 template id，模板本身不可变更，只能出新版本。
CREATE TABLE IF NOT EXISTS prompt_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL,
  target      TEXT NOT NULL CHECK (target IN ('gemini','image','video','blender','qa')),
  body        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  UNIQUE (name, version)
);

-- 阈值、重试次数、超时、模型名、价格一律进这张表，代码里不许写死
CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'global',
  updated_at  INTEGER NOT NULL
);

PRAGMA optimize;
