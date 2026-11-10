import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import { buildAgentPack, classifyRun, createZip } from '../src/main/agentPack.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/agent-pack-finalized-run.json', import.meta.url), 'utf8'));
const options = { appName: 'AI Collab', appVersion: '1.7.0', now: new Date('2026-11-10T23:41:00.000Z') };
const systemBody = "You are the front-desk lead intake agent. Collect the visitor's name, reason, and urgency, then hand off to the right team.\n";
const leadBody = '# Lead intake\nAsk for name, contact, and reason for the visit. Do not promise an outcome.\n';
const followBody = '# Follow up\nSummarize the lead and the next action in one short note.\n';
const packPaths = [
  'README.md',
  'manifest.json',
  'skills/follow-up/SKILL.md',
  'skills/lead-intake/SKILL.md',
  'source/final_answer.md',
  'system_instructions.md',
];

function findEocd(buffer) {
  const start = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== 0x06054b50) continue;
    if (offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) return offset;
  }
  throw new Error('ZIP end of central directory not found');
}

function readZip(buffer) {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  if (buffer.readUInt16LE(eocd + 8) !== count) throw new Error('ZIP entry count mismatch');
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  let cursor = directoryOffset;
  const end = directoryOffset + directorySize;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP central directory is truncated');
    const flag = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const time = buffer.readUInt16LE(cursor + 12);
    const date = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local header missing for ${name}`);
    const localFlag = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc = buffer.readUInt32LE(localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength);
    if (localName !== name || localFlag !== flag || localMethod !== method || localCrc !== crc || localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) {
      throw new Error(`ZIP local header does not match the central directory for ${name}`);
    }
    if (method !== 8) throw new Error(`ZIP method ${method} is not deflate for ${name}`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const data = inflateRawSync(buffer.subarray(dataOffset, dataOffset + compressedSize));
    if (data.length !== uncompressedSize) throw new Error(`ZIP size mismatch for ${name}`);
    if ((crc32(data) >>> 0) !== crc) throw new Error(`ZIP CRC mismatch for ${name}`);
    entries.push({ name, data, method, flag, time, date });
  }
  if (cursor !== end) throw new Error('ZIP central directory size mismatch');
  return entries;
}

function textOf(entries, name) {
  const entry = entries.find(item => item.name === name);
  assert.ok(entry, `${name} is in the pack`);
  return entry.data.toString('utf8');
}

function block(filePath, body) {
  return `=== FILE: ${filePath} ===\n${body}\n=== END FILE ===`;
}

test('(a) finalized fixture pack round-trips delimited files with matching CRCs', async () => {
  const direct = createZip([{ name: 'note.md', data: 'café' }, { name: 'raw.bin', data: Buffer.from([0, 255, 10]) }]);
  const directEntries = readZip(direct);
  assert.deepEqual(directEntries.map(entry => entry.name), ['note.md', 'raw.bin']);
  assert.equal(directEntries[0].data.toString('utf8'), 'café');
  assert.deepEqual([...directEntries[1].data], [0, 255, 10]);
  assert.deepEqual(direct, createZip([{ name: 'note.md', data: 'café' }, { name: 'raw.bin', data: Buffer.from([0, 255, 10]) }]));

  const run = structuredClone(fixture);
  const pack = buildAgentPack(run, options);
  assert.equal(pack.kind, 'final');
  assert.equal(pack.slug, 'design-a-front-desk-lead-intake-agent');
  assert.equal(pack.zipName, 'design-a-front-desk-lead-intake-agent-11111111-q1.zip');
  assert.equal(pack.zipName.includes('_DRAFT'), false);
  assert.deepEqual(pack.zip, buildAgentPack(run, options).zip);
  const entries = readZip(pack.zip);
  assert.deepEqual(entries.map(entry => entry.name), packPaths);
  for (const entry of entries) {
    assert.equal(entry.method, 8);
    assert.equal(entry.flag & 0x0800, 0x0800);
    assert.equal(entry.time, 0);
    assert.equal(entry.date, 0x0021);
  }
  assert.equal(textOf(entries, 'system_instructions.md'), systemBody);
  assert.equal(textOf(entries, 'skills/lead-intake/SKILL.md'), leadBody);
  assert.equal(textOf(entries, 'skills/follow-up/SKILL.md'), followBody);
  assert.equal(textOf(entries, 'source/final_answer.md'), run.final.text);
  assert.equal(textOf(entries, 'README.md'), `Question: Design a front-desk lead intake agent.

Outcome: Agreed solution

Both reviewers approved.

Files:
- README.md
- manifest.json
- skills/follow-up/SKILL.md
- skills/lead-intake/SKILL.md
- source/final_answer.md
- system_instructions.md

Review the files, then copy system_instructions.md and the skills directory into the agent configuration.
`);
  assert.deepEqual(JSON.parse(textOf(entries, 'manifest.json')), pack.manifest);
  assert.equal(pack.manifest.parse.mode, 'delimited');
  assert.deepEqual(pack.manifest.parse.warnings, []);
  assert.equal(pack.manifest.kind, 'final');
  assert.equal(pack.manifest.createdAt, '2026-11-10T23:41:00.000Z');
  assert.deepEqual(pack.manifest.generator, { appName: 'AI Collab', appVersion: '1.7.0' });
  assert.deepEqual(pack.manifest.source, {
    runId: run.id,
    turnId: run.turnId,
    question: run.turns[0].question,
    conversationGoal: run.goal,
    runStatus: 'completed',
    decided: true,
    consensus: true,
    partial: false,
    reviewed: true,
    draftVersion: 2,
    author: 'claude',
    models: run.models,
    moderatorReason: 'Both reviewers approved.',
    error: null,
  });
  assert.deepEqual(pack.files.map(file => file.path), packPaths.filter(filePath => filePath !== 'manifest.json'));
  for (const file of pack.manifest.files) {
    const entry = entries.find(item => item.name === file.path);
    assert.equal(file.bytes, entry.data.length);
    assert.equal(file.sha256, createHash('sha256').update(entry.data).digest('hex'));
  }

  const disagreed = structuredClone(run);
  disagreed.final.consensus = false;
  assert.match(textOf(readZip(buildAgentPack(disagreed, options).zip), 'README.md'), /Outcome: Moderator decision, peer agreement not reached/);
  const followUp = structuredClone(run);
  followUp.turns.push({ id: 'turn-2', question: 'What is the second question?', status: 'completed' });
  followUp.turnId = 'turn-2';
  followUp.currentQuestion = 'ignored current question';
  followUp.goal = 'ignored goal';
  const second = buildAgentPack(followUp, options);
  assert.equal(second.manifest.source.question, 'What is the second question?');
  assert.equal(second.manifest.source.conversationGoal, 'ignored goal');
  assert.equal(second.zipName, 'what-is-the-second-question-11111111-q2.zip');
  const nameless = structuredClone(run);
  nameless.turns[0].question = '???';
  nameless.currentQuestion = '???';
  nameless.goal = '???';
  assert.equal(buildAgentPack(nameless, options).slug, 'agent');

  if (process.env.AGENT_PACK_SAMPLE_OUT) {
    await mkdir(path.dirname(process.env.AGENT_PACK_SAMPLE_OUT), { recursive: true });
    await writeFile(process.env.AGENT_PACK_SAMPLE_OUT, pack.zip);
  }
});

test('(b) plain Markdown final text falls back to system instructions and an unparsed skill', () => {
  const run = structuredClone(fixture);
  run.final.text = '# Front desk\n\nTake the lead\'s name and reason.';
  const pack = buildAgentPack(run, options);
  const entries = readZip(pack.zip);
  assert.equal(pack.manifest.parse.mode, 'fallback');
  assert.deepEqual(pack.manifest.parse.warnings, ['Answer had no system_instructions.md block or no valid skill blocks; using fallback.']);
  assert.equal(textOf(entries, 'system_instructions.md'), run.final.text);
  assert.equal(textOf(entries, 'skills/unparsed/SKILL.md'), 'This answer had no delimited skill sections.\n');
  assert.equal(textOf(entries, 'source/final_answer.md'), run.final.text);
  assert.equal(pack.kind, 'final');

  const mixed = structuredClone(fixture);
  mixed.final.text = [
    block('system_instructions.md', '\n  hello  '),
    block('skills/one/SKILL.md', '1'),
    block('skills/two/SKILL.md', '2'),
    block('notes.md', 'nope'),
    block('skills/three/SKILL.md', '3'),
    block('skills/four/SKILL.md', '4'),
    block('skills/two/SKILL.md', 'again'),
  ].join('\n');
  const parsed = buildAgentPack(mixed, options);
  const names = readZip(parsed.zip).map(entry => entry.name);
  assert.equal(parsed.manifest.parse.mode, 'delimited');
  assert.equal(textOf(readZip(parsed.zip), 'system_instructions.md'), 'hello\n');
  assert.deepEqual(names.filter(name => name.startsWith('skills/')), ['skills/one/SKILL.md', 'skills/three/SKILL.md', 'skills/two/SKILL.md']);
  assert.deepEqual(parsed.manifest.parse.warnings, [
    'Skipped unsupported path: notes.md',
    'Skipped skill beyond the first 3: skills/four/SKILL.md',
    'Skipped duplicate path: skills/two/SKILL.md',
  ]);

  for (const text of [block('system_instructions.md', 'only system'), [block('skills/one/SKILL.md', 'only skill')].join('\n')]) {
    const partial = structuredClone(fixture);
    partial.final.text = text;
    const fallback = buildAgentPack(partial, options);
    assert.equal(fallback.manifest.parse.mode, 'fallback');
    assert.equal(textOf(readZip(fallback.zip), 'system_instructions.md'), text);
    assert.equal(textOf(readZip(fallback.zip), 'skills/unparsed/SKILL.md'), 'This answer had no delimited skill sections.\n');
  }
});

test('(c) classifyRun accepts a finalized run, drafts with text, and nothing else', () => {
  assert.deepEqual(classifyRun(fixture), { kind: 'final', reason: 'Finalized run' });
  for (const status of ['timed_out', 'cancelled', 'failed']) {
    const draft = structuredClone(fixture);
    draft.status = status;
    draft.final.decided = false;
    assert.deepEqual(classifyRun(draft), { kind: 'draft', reason: 'Unreviewed draft' });
  }
  const failed = structuredClone(fixture);
  failed.status = 'failed';
  failed.final = null;
  assert.deepEqual(classifyRun(failed), { kind: null, reason: 'No final text' });
  assert.equal(buildAgentPack(failed, options), null);
  const interrupted = structuredClone(fixture);
  interrupted.status = 'interrupted';
  assert.deepEqual(classifyRun(interrupted), { kind: null, reason: 'Run was interrupted' });
  const awaiting = structuredClone(fixture);
  awaiting.status = 'awaiting_input';
  assert.deepEqual(classifyRun(awaiting), { kind: null, reason: 'Run is awaiting input' });
  const running = structuredClone(fixture);
  running.status = 'running';
  assert.deepEqual(classifyRun(running), { kind: null, reason: 'Run is still running' });
  const blank = structuredClone(fixture);
  blank.final.text = ' \n';
  assert.deepEqual(classifyRun(blank), { kind: null, reason: 'No final text' });
  assert.deepEqual(classifyRun(undefined), { kind: null, reason: 'Missing run' });
  assert.deepEqual(classifyRun({}), { kind: null, reason: 'No final text' });
  assert.equal(buildAgentPack(undefined), null);
  assert.equal(buildAgentPack({}), null);
});

test('(d) createZip rejects unsafe entry names', () => {
  for (const name of ['../x', '/x', 'a\\b']) assert.throws(() => createZip([{ name, data: 'x' }]), /Unsafe ZIP entry name/);
});

test('(e) a timed-out draft is labelled DRAFT', async () => {
  const run = structuredClone(fixture);
  run.status = 'timed_out';
  run.final.decided = false;
  run.final.partial = true;
  run.error = 'Time limit reached';
  const pack = buildAgentPack(run, options);
  assert.equal(pack.kind, 'draft');
  assert.equal(pack.zipName, 'design-a-front-desk-lead-intake-agent-11111111-q1_DRAFT.zip');
  assert.equal(pack.manifest.parse.mode, 'delimited');
  assert.equal(pack.manifest.source.runStatus, 'timed_out');
  assert.equal(pack.manifest.source.partial, true);
  assert.equal(pack.manifest.source.decided, false);
  assert.equal(pack.manifest.source.error, 'Time limit reached');
  const readme = textOf(readZip(pack.zip), 'README.md');
  assert.equal(readme.startsWith('DRAFT: UNREVIEWED. This run ended as timed_out before the moderator finalized it. Do not install without review.\n'), true);
  assert.match(readme, /Outcome: Draft \(timed_out\) \(incomplete\)/);
  assert.match(readme, /Time limit reached/);
  if (process.env.AGENT_PACK_SAMPLE_OUT) {
    const draftPath = process.env.AGENT_PACK_SAMPLE_OUT.replace(/\.zip$/i, '_DRAFT.zip');
    await mkdir(path.dirname(draftPath), { recursive: true });
    await writeFile(draftPath, pack.zip);
  }
});
