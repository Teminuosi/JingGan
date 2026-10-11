import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGemini } from '../worker/previs/gemini.mjs';
import { runAutomaticPrevis } from '../worker/previs/engine.mjs';
import { restPose } from '../worker/previs/prompts.mjs';

const connection = { baseUrl: 'https://example.com', model: 'gemini-3.1-pro-preview', apiKey: 'private-test-key' };
const schema = { type: 'object', properties: { schema_version: { type: 'string', enum: ['motion-shot.v2'] } } };
const events = [];
let attempts = 0;
const timeout = createGemini(connection, { onCall: event => events.push(event), fetchImpl: async () => {
  attempts++;
  return new Response('Private provider error body', { status: 524, headers: { 'cf-ray': 'abcdef0123456789-HKG' } });
} });
await assert.rejects(timeout({ prompt: 'Synthetic plan', schema }), error => {
  assert.match(error.message, /524/);
  assert.match(error.message, /计费.*无法|无法.*计费/);
  assert.equal(error.requestFailure.status, 524);
  return true;
});
assert.equal(attempts, 1, 'An ambiguous timeout must never trigger an automatic paid retry');
assert.equal(events.at(-1).stage, 'failed');
assert.equal(events.at(-1).status, 524);
assert.equal(events.at(-1).cfRay, 'abcdef0123456789-HKG');
assert.ok(Number.isFinite(events.at(-1).ms));
assert.doesNotMatch(JSON.stringify(events), /private-test-key|Private provider error body/);

const successfulBody = { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] };
const requestConfigs = [];
const success = model => createGemini({ ...connection, model }, { fetchImpl: async (_target, options) => {
  requestConfigs.push(JSON.parse(options.body).generationConfig);
  return new Response(`data: ${JSON.stringify(successfulBody)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
} });
await success(connection.model)({ prompt: 'Single shot', schema });
assert.equal(requestConfigs.at(-1).thinkingConfig.thinkingLevel, 'low');
assert.deepEqual(requestConfigs.at(-1).responseSchema, schema, 'Reducing latency must preserve the complete-initial-state contract');
assert.equal(requestConfigs.at(-1).maxOutputTokens, 32768, 'Do not shorten output into a truncated plan');
await success(connection.model)({ prompt: 'Shared library', schema: { properties: { schema_version: { enum: ['motion-library.v1'] } } } });
assert.equal(requestConfigs.at(-1).thinkingConfig, undefined);
await success('gemini-2.5-pro')({ prompt: 'Different generation', schema });
assert.equal(requestConfigs.at(-1).thinkingConfig, undefined, 'Do not send unsupported Gemini 3 thinkingLevel to older models');

let rejectedAttempts = 0;
const rejected = createGemini(connection, { fetchImpl: async () => {
  rejectedAttempts++;
  return new Response('Unsupported configuration', { status: 400 });
} });
await assert.rejects(rejected({ prompt: 'Single shot', schema }), /HTTP 400/);
assert.equal(rejectedAttempts, 1, 'Do not silently drop the latency setting or response schema on rejection');

const fallbackRequests = [];
const missingStream = createGemini(connection, { fetchImpl: async (target, options) => {
  fallbackRequests.push({ target, config: JSON.parse(options.body).generationConfig });
  return fallbackRequests.length === 1
    ? new Response('No streaming route', { status: 404 })
    : Response.json(successfulBody);
} });
const fallbackResult = await missingStream({ prompt: 'Single shot', schema });
assert.equal(fallbackRequests.length, 2);
assert.match(fallbackRequests[1].target, /:generateContent$/);
assert.equal(fallbackRequests[1].config.thinkingConfig.thinkingLevel, 'low');
assert.deepEqual(fallbackRequests[1].config.responseSchema, schema);
assert.equal(fallbackResult.streamed, false);

let disconnectedAttempts = 0;
const disconnectedEvents = [];
const disconnected = createGemini(connection, { onCall: event => disconnectedEvents.push(event), fetchImpl: async () => {
  disconnectedAttempts++; throw new Error('network disconnected with private-test-key');
} });
await assert.rejects(disconnected({ prompt: 'x', schema }), error => !error.message.includes(connection.apiKey) && error.requestFailure.finishReason === 'NETWORK_ERROR');
assert.equal(disconnectedAttempts, 1);
assert.equal(disconnectedEvents.at(-1).stage, 'failed');
assert.doesNotMatch(JSON.stringify(disconnectedEvents), /private-test-key/);

// A 524 request is an attempted call, even though it returns no model result.
const directory = path.resolve('.worker/automatic-previs-tests', `timeout-${randomUUID()}`);
await fs.mkdir(directory, { recursive: true });
const source = path.join(directory, 'source.bin'); await fs.writeFile(source, 'synthetic');
const analysis = { source: { duration_seconds: 2 }, source_roles: [{ role_id: 'A' }], beats: [{ beat_id: 'ONE', start_seconds: 0, end_seconds: 2, role_ids: ['A'] }] };
const library = { schema_version: 'motion-library.v1', actors: [{ id: 'A', kind: 'human', height: 1.7, color: [.2, .3, .4], skin: [.5, .5, .5] }], props: [], poses: [{ id: 'REST', joints: restPose }] };
const savedLibrary = JSON.stringify({ data: library });
await fs.writeFile(path.join(directory, 'library-response.json'), savedLibrary);
await assert.rejects(runAutomaticPrevis({ analysis, source, directory, model: timeout, media: { async probe() { return { duration: 2, width: 960, height: 540 }; } } }), /524/);
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
assert.equal(manifest.newModelCalls, 1);
assert.equal(manifest.reusedModelCalls, 1);
assert.equal(manifest.modelCalls, 2);
const failure = JSON.parse(await fs.readFile(path.join(directory, 'shot-001-response.json'), 'utf8'));
assert.equal(failure.data, null);
assert.equal(failure.requestFailure.status, 524);
assert.equal(failure.requestFailure.billingStatus, 'unknown');
assert.equal(await fs.readFile(path.join(directory, 'library-response.json'), 'utf8'), savedLibrary);
console.log('Previs timeout: 524/network evidence preserved, no automatic retries, attempted calls counted, lower thinking only for supported text-only shot planning.');
