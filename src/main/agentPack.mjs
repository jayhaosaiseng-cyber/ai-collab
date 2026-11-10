import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';

// MS-DOS timestamp for 1980-01-01 00:00:00, the ZIP epoch, so packs are byte-stable.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const ZIP_UTF8 = 0x0800;
const ZIP_VERSION = 20;
const FILE_START = /^=== FILE: (.+) ===$/;
const FILE_END = '=== END FILE ===';
const SKILL_PATH = /^skills\/([a-z0-9][a-z0-9-]{0,39})\/SKILL\.md$/;
const UNPARSED_SKILL = 'This answer had no delimited skill sections.\n';
const FALLBACK_WARNING = 'Answer had no system_instructions.md block or no valid skill blocks; using fallback.';
const USE_LINE = 'Review the files, then copy system_instructions.md and the skills directory into the agent configuration.';

function assertSafeZipName(name) {
  if (name.length === 0 || name.includes('\\') || name.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe ZIP entry name: ${name}`);
  }
}

function entryBytes(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (Buffer.isBuffer(data)) return data;
  throw new TypeError('ZIP entry data must be a string or Buffer');
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Default string sort is UTF-16 code-unit order. README.md sorts before manifest.json.
function sortedPaths(paths) {
  return [...paths].sort();
}

export function createZip(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  if (entries.length > 0xffff) throw new Error('ZIP entry count exceeds 65535');
  const prepared = entries.map(entry => {
    if (!entry || typeof entry !== 'object') throw new TypeError('ZIP entry must be an object');
    if (typeof entry.name !== 'string') throw new TypeError('ZIP entry name must be a string');
    assertSafeZipName(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 0xffff) throw new Error(`ZIP entry name is too long: ${entry.name}`);
    const data = entryBytes(entry.data);
    if (data.length > 0xffffffff) throw new Error(`ZIP entry is too large: ${entry.name}`);
    const compressed = deflateRawSync(data);
    if (compressed.length > 0xffffffff) throw new Error(`ZIP entry is too large: ${entry.name}`);
    return { name, data, compressed, crc: crc32(data) >>> 0 };
  });

  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const entry of prepared) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(ZIP_UTF8, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, entry.name, entry.compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(ZIP_UTF8, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, entry.name);
    offset += local.length + entry.name.length + entry.compressed.length;
    if (offset > 0xffffffff) throw new Error('ZIP exceeds 4 GiB');
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralDirectory, eocd]);
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function classifyRun(run) {
  try {
    if (!run || typeof run !== 'object') return { kind: null, reason: 'Missing run' };
    const textOk = nonEmptyText(run.final?.text);
    if (run.status === 'completed' && run.final?.decided === true && textOk) return { kind: 'final', reason: 'Finalized run' };
    if ((run.status === 'timed_out' || run.status === 'cancelled' || run.status === 'failed') && textOk && run.final?.decided !== true) {
      return { kind: 'draft', reason: 'Unreviewed draft' };
    }
    if (!textOk) return { kind: null, reason: 'No final text' };
    if (run.status === 'interrupted') return { kind: null, reason: 'Run was interrupted' };
    if (run.status === 'awaiting_input') return { kind: null, reason: 'Run is awaiting input' };
    if (run.status === 'running') return { kind: null, reason: 'Run is still running' };
    if (run.status === 'completed') return { kind: null, reason: 'Completed run is not a decided final' };
    return { kind: null, reason: 'Run is not a finalized or unreviewed draft' };
  } catch {
    return { kind: null, reason: 'Run could not be classified' };
  }
}

function parseAnswer(text) {
  const warnings = [];
  const lines = String(text).split(/\r?\n/);
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (current && line === FILE_END) {
      blocks.push(current);
      current = null;
      continue;
    }
    const started = !current && FILE_START.exec(line);
    if (started) {
      current = { path: started[1].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) warnings.push(`Unclosed file block: ${current.path}`);

  const accepted = [];
  const seen = new Set();
  let skills = 0;
  for (const block of blocks) {
    const filePath = block.path;
    const isSystem = filePath === 'system_instructions.md';
    const isSkill = SKILL_PATH.test(filePath);
    if (!isSystem && !isSkill) {
      warnings.push(`Skipped unsupported path: ${filePath}`);
      continue;
    }
    if (seen.has(filePath)) {
      warnings.push(`Skipped duplicate path: ${filePath}`);
      continue;
    }
    if (isSkill && skills >= 3) {
      warnings.push(`Skipped skill beyond the first 3: ${filePath}`);
      continue;
    }
    seen.add(filePath);
    if (isSkill) skills += 1;
    accepted.push({ path: filePath, data: `${block.lines.join('\n').trim()}\n` });
  }

  const hasSystem = accepted.some(file => file.path === 'system_instructions.md');
  if (!hasSystem || skills === 0) {
    warnings.push(FALLBACK_WARNING);
    return {
      mode: 'fallback',
      warnings,
      files: [
        { path: 'system_instructions.md', data: text },
        { path: 'skills/unparsed/SKILL.md', data: UNPARSED_SKILL },
      ],
    };
  }
  return { mode: 'delimited', warnings, files: accepted };
}

function slugify(question) {
  const slug = String(question ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug || 'agent';
}

function questionNumber(run) {
  const turns = Array.isArray(run.turns) ? run.turns : [];
  const index = turns.findIndex(turn => turn && turn.id === run.turnId);
  return index >= 0 ? index + 1 : 1;
}

function buildReadme({ kind, run, question, paths }) {
  const final = run.final;
  const lines = [];
  if (kind === 'draft') {
    lines.push(`DRAFT: UNREVIEWED. This run ended as ${run.status} before the moderator finalized it. Do not install without review.`);
    lines.push('');
  }
  lines.push(`Question: ${question}`);
  lines.push('');
  let outcome;
  if (kind === 'final') outcome = final.consensus ? 'Agreed solution' : 'Moderator decision, peer agreement not reached';
  else outcome = `Draft (${run.status})${final.partial ? ' (incomplete)' : ''}`;
  lines.push(`Outcome: ${outcome}`);
  if (typeof final.moderation?.reason === 'string' && final.moderation.reason) lines.push('', final.moderation.reason);
  if (Array.isArray(final.unresolved) && final.unresolved.length) {
    lines.push('', 'Unresolved:', ...final.unresolved.map(item => `- ${item}`));
  }
  if (typeof run.error === 'string' && run.error) lines.push('', run.error);
  lines.push('', 'Files:', ...paths.map(filePath => `- ${filePath}`), '', USE_LINE, '');
  return lines.join('\n');
}

export function buildAgentPack(run, options = {}) {
  const classification = classifyRun(run);
  if (classification.kind == null) return null;
  const { appName, appVersion, now } = options ?? {};
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('buildAgentPack requires options.now to be a Date');

  const kind = classification.kind;
  const turn = Array.isArray(run.turns) ? run.turns.find(item => item && item.id === run.turnId) : undefined;
  const question = turn?.question ?? run.currentQuestion ?? run.goal ?? '';
  const answer = run.final.text;
  const parsed = parseAnswer(answer);
  const content = new Map(parsed.files.map(file => [file.path, file.data]));
  content.set('source/final_answer.md', answer);

  const paths = sortedPaths([...content.keys(), 'README.md', 'manifest.json']);
  content.set('README.md', buildReadme({ kind, run, question, paths }));

  const files = sortedPaths([...content.keys()]).map(filePath => {
    const bytes = Buffer.from(content.get(filePath), 'utf8');
    return { path: filePath, bytes: bytes.length, sha256: sha256Hex(bytes) };
  });
  const manifest = {
    format: 'ai-collab-agent-pack',
    formatVersion: 1,
    kind,
    createdAt: now.toISOString(),
    generator: { appName: appName ?? null, appVersion: appVersion ?? null },
    source: {
      runId: run.id ?? null,
      turnId: run.turnId ?? null,
      question,
      conversationGoal: run.goal ?? null,
      runStatus: run.status ?? null,
      decided: run.final.decided ?? null,
      consensus: run.final.consensus ?? null,
      partial: run.final.partial ?? null,
      reviewed: run.final.reviewed ?? null,
      draftVersion: run.final.version ?? null,
      author: run.final.author ?? null,
      models: run.models ?? null,
      moderatorReason: run.final.moderation?.reason ?? null,
      error: run.error ?? null,
    },
    parse: { mode: parsed.mode, warnings: parsed.warnings },
    files,
  };

  const slug = slugify(question);
  const runId = String(run.id ?? '');
  const draftMark = kind === 'draft' ? '_DRAFT' : '';
  const zipEntries = sortedPaths([...content.keys(), 'manifest.json']).map(name => ({
    name,
    data: name === 'manifest.json' ? `${JSON.stringify(manifest, null, 2)}\n` : content.get(name),
  }));
  return { kind, slug, zipName: `${slug}-${runId.slice(0, 8)}-q${questionNumber(run)}${draftMark}.zip`, files, manifest, zip: createZip(zipEntries) };
}
