// 迁移统一入口。
//
// 老项目把建表语句同时写在 db/schema.ts 和 drizzle/*.sql 两处，内容重复、容易漂。
// 这里改成只认 .sql 文件：Vite 的 ?raw 在构建期把文件内容内联进 bundle，
// Workers 运行时读不了磁盘也没关系，而 SQL 仍然是那一份可以直接给 DBA 看的原文。
//
// 所有语句都是 IF NOT EXISTS，重复执行无害，所以不需要额外的版本记录表。

import corePipelineSql from '../drizzle/0001_core_pipeline.sql?raw';
import taskDepsSql from '../drizzle/0002_task_deps.sql?raw';
import accountVisitsSql from '../drizzle/0003_account_visits.sql?raw';
import { VIDEO_PROJECTS_SCHEMA } from './schema';

/** 把一个 .sql 文件切成可以逐条 prepare 的语句。 */
function statementsOf(sql: string): string[] {
  return sql
    // 去掉整行注释，避免它们被当成语句的一部分
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 按顺序执行。老表放最前面：现有项目必须先能打开，新管线才谈得上。
 */
export const MIGRATIONS: readonly string[] = [
  ...VIDEO_PROJECTS_SCHEMA,
  ...statementsOf(corePipelineSql),
  ...statementsOf(taskDepsSql),
  ...statementsOf(accountVisitsSql),
];
