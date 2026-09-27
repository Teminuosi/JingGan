import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

// Integration check against an isolated SQLite backup; never mutate the source DB.
const [sessionFile, reviewFile] = process.argv.slice(2);
if (!sessionFile || !reviewFile) throw new Error('Usage: node scripts/test-blender-publish.mjs SESSION REVIEW');
const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-publish-test-'));
const dbFile = path.join(dir, 'test.sqlite');
const source = new DatabaseSync(s.db, { readOnly: true });
await backup(source, dbFile); source.close();
const version = path.join(dir, review.version); fs.mkdirSync(version);
for (const f of ['preview.mp4', 'complete.json']) fs.copyFileSync(path.join(s.directory, review.version, f), path.join(version, f));
fs.copyFileSync(path.join(s.directory, 'reference.mp4'), path.join(dir, 'reference.mp4'));
const session = path.join(dir, 'session.json'), reviewPath = path.join(dir, 'review.json');
fs.writeFileSync(session, JSON.stringify({ ...s, db: dbFile, directory: dir, objectRoot: dir }));
const run = (r) => {
  fs.writeFileSync(reviewPath, JSON.stringify(r));
  return spawnSync(process.execPath, ['scripts/blender-review.mjs', 'publish', '--session', session, '--version', review.version, '--review', reviewPath], { encoding: 'utf8', windowsHide: true });
};
assert.notEqual(run({ ...review, watchedEntireClip: false }).status, 0);
assert.notEqual(run({ ...review, videoHash: 'wrong' }).status, 0);
assert.notEqual(run({ ...review, executionCorrections: { start_time: 0 } }).status, 0);
const db = new DatabaseSync(dbFile);
const before = db.prepare('SELECT revision FROM shot_dna WHERE shot_id=?').get(s.shotId).revision;
const result = run(review); assert.equal(result.status, 0, result.stderr);
const after = db.prepare('SELECT revision,actors_json,complexity_json FROM shot_dna WHERE shot_id=?').get(s.shotId);
assert.equal(after.revision, before + 1);
assert.deepEqual(JSON.parse(after.actors_json), review.executionCorrections.actors);
assert.equal(JSON.parse(after.complexity_json).previs.blocking, review.blocking);
assert.notEqual(run(review).status, 0, 'stale review must not publish twice');
db.close();
console.log('Publish integration passed: review/hash/field guards, atomic registration + execution corrections, stale input rejection. Temporary DB: ' + dbFile);
