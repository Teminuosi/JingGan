-- 任务依赖。
--
-- 0001 里只有 parent_task_id，那只能表达「谁派生了谁」，表达不了「拼接要等全部 12 个镜头都出片」。
-- 编排一条真实管线必须有多对多依赖，所以单开一张边表。
--
-- 认领时用 NOT EXISTS 过滤掉还有未完成依赖的任务：
-- 依赖没满足的任务就该在队列里待着，而不是被 worker 取走再自己判断一次——
-- 那样会白占一个并发位，还要处理「取了又放回去」的状态回退。
CREATE TABLE IF NOT EXISTS task_deps (
  task_id       TEXT NOT NULL,
  depends_on    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_upstream ON task_deps(depends_on);
