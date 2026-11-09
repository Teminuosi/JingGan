// friendlyError 的状态码判断只认 HTTP/status/code 后面的数字，不能把「已收到 413 个分片」这类裸数字误翻成 413/524。
// 直接从源码里取 isHttpStatus 的实现来测（gemini.ts 是浏览器端 TS，不便整体导入）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../app/lib/gemini.ts', import.meta.url), 'utf8');
const body = src.match(/function isHttpStatus\(raw: string, code: string\) \{\n {2}return (.*);\n\}/)?.[1];
assert.ok(body, '找不到 isHttpStatus');
const isHttpStatus = new Function('raw', 'code', `return ${body}`);
assert.equal(isHttpStatus('{"error":{"message":"<html>413 Payload Too Large</html>","code":413,"status":""}}', '413'), true);
assert.equal(isHttpStatus('Error code 524 A timeout occurred', '524'), true);
assert.equal(isHttpStatus('HTTP 502', '502'), true);
assert.equal(isHttpStatus('status: 503', '503'), true);
assert.equal(isHttpStatus('分析结果在传输途中断了（已收到 413 个分片、524 字符，JSON 不完整）', '413'), false);
assert.equal(isHttpStatus('分析结果在传输途中断了（已收到 413 个分片、524 字符，JSON 不完整）', '524'), false);
assert.equal(isHttpStatus('预计输入约 127,413 token', '413'), false);
console.log('error status ok');
