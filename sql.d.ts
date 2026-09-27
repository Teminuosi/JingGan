// Vite 的 ?raw 导入：构建期把文件内容内联成字符串。
// db/migrations.ts 靠它直接复用 drizzle/*.sql，避免建表语句在 .ts 和 .sql 两处重复维护。
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
