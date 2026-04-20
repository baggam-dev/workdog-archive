const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { execFileSync } = require('child_process');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const { parse: parseHwp } = require('hwp.js/build/cjs.js');

const app = express();
const PORT = 3030;

const LEGACY_PUBLIC_DIR = path.join(__dirname, 'public');
const REACT_DIST_DIR = path.join(__dirname, '..', 'workdog-archive-web', 'dist');
const FRONTEND_DIR = process.env.WORKDOG_FRONTEND_DIR
  ? path.resolve(process.env.WORKDOG_FRONTEND_DIR)
  : (fs.existsSync(path.join(REACT_DIST_DIR, 'index.html')) ? REACT_DIST_DIR : LEGACY_PUBLIC_DIR);

const DATA_DIR = path.join(__dirname, 'data');
const FILES_DIR = path.join(__dirname, 'files');
const LEGACY_UPLOAD_DIR = path.join(__dirname, 'uploads'); // migration-only fallback
const FOLDERS_FILE = path.join(DATA_DIR, 'folders.json');
const DOCUMENTS_FILE = path.join(DATA_DIR, 'documents.json');
const GENERATED_DOCUMENTS_FILE = path.join(DATA_DIR, 'generated-documents.json');
const ALLOWED_EXT = new Set(['hwp', 'pdf', 'xlsx', 'xls', 'txt']);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
if (!fs.existsSync(FOLDERS_FILE)) fs.writeFileSync(FOLDERS_FILE, '[]\n', 'utf8');
if (!fs.existsSync(DOCUMENTS_FILE)) fs.writeFileSync(DOCUMENTS_FILE, '[]\n', 'utf8');
if (!fs.existsSync(GENERATED_DOCUMENTS_FILE)) fs.writeFileSync(GENERATED_DOCUMENTS_FILE, '[]\n', 'utf8');

function normalizeOriginalName(name) {
  if (!name || typeof name !== 'string') return 'file';
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    return name;
  }
}

function ensureFolderFilesDir(folderId) {
  const dir = path.join(FILES_DIR, folderId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveStoredPath(doc) {
  const storedName = String(doc?.storedName || '');
  if (!storedName) return '';
  if (storedName.includes('/')) return path.join(FILES_DIR, storedName);

  // legacy fallback (only when old uploads file actually exists)
  const legacyPath = path.join(LEGACY_UPLOAD_DIR, storedName);
  if (fs.existsSync(legacyPath)) return legacyPath;

  return path.join(FILES_DIR, storedName);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const originalName = normalizeOriginalName(file.originalname);
    const ext = path.extname(originalName).replace('.', '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(new Error('unsupported file type'));
    cb(null, true);
  },
});

app.use(express.json());

// CORS: React 프론트(3000)에서 API(3030) 호출 허용
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(FRONTEND_DIR));
app.use('/uploads', express.static(FILES_DIR));

function readJson(file, fallback = []) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const readFolders = () => readJson(FOLDERS_FILE, []);
const writeFolders = (folders) => writeJson(FOLDERS_FILE, folders);
const readDocuments = () => readJson(DOCUMENTS_FILE, []);
const writeDocuments = (docs) => writeJson(DOCUMENTS_FILE, docs);
const readGeneratedDocuments = () => readJson(GENERATED_DOCUMENTS_FILE, []);
const writeGeneratedDocuments = (docs) => writeJson(GENERATED_DOCUMENTS_FILE, docs);
const findFolder = (id) => readFolders().find((f) => f.id === id);

function ensureFilesLayout() {
  const folders = readFolders();
  folders.forEach((f) => ensureFolderFilesDir(f.id));

  const docs = readDocuments();
  let changed = false;

  for (const doc of docs) {
    if (!doc?.folderId || !doc?.storedName) continue;
    const currentStored = String(doc.storedName);
    const currentPath = resolveStoredPath(doc);
    const nextStored = currentStored.includes('/') ? currentStored : `${doc.folderId}/${currentStored}`;
    const nextPath = path.join(FILES_DIR, nextStored);

    ensureFolderFilesDir(doc.folderId);

    if (currentPath !== nextPath && fs.existsSync(currentPath)) {
      fs.renameSync(currentPath, nextPath);
      doc.storedName = nextStored;
      changed = true;
      continue;
    }

    if (!currentStored.includes('/') && fs.existsSync(nextPath)) {
      doc.storedName = nextStored;
      changed = true;
    }
  }

  if (changed) writeDocuments(docs);
}

function commandExists(cmd) {
  try {
    execFileSync('bash', ['-lc', `command -v ${cmd}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

ensureFilesLayout();

let kordocParsePromise = null;

async function getKordocParse() {
  if (!kordocParsePromise) {
    kordocParsePromise = import('kordoc').then((mod) => mod.parse);
  }
  return kordocParsePromise;
}

function mapKordocBlocks(blocks) {
  if (!Array.isArray(blocks)) return { blocks: [] };

  const normalized = blocks.map((block) => {
    if (!block || typeof block !== 'object') return null;

    if (block.type === 'heading') {
      return {
        type: 'heading',
        level: Number(block.level) || 2,
        text: String(block.text || '').trim(),
      };
    }

    if (block.type === 'table') {
      const sourceRows = Array.isArray(block.rows)
        ? block.rows
        : (Array.isArray(block.table?.cells) ? block.table.cells : []);
      const rows = sourceRows
        .map((row) => Array.isArray(row)
          ? row.map((cell) => String(cell?.text ?? cell ?? '').trim())
          : [String(row ?? '').trim()])
        .map((row) => row.map((cell) => cell || ' '))
        .filter((row) => row.length > 0);
      return { type: 'table', rows };
    }

    if (block.type === 'image') {
      return {
        type: 'image',
        src: String(block.src || block.path || ''),
        alt: String(block.alt || ''),
        caption: String(block.caption || ''),
      };
    }

    const text = String(block.text || block.content || '').trim();
    if (!text) return null;
    return { type: 'paragraph', text };
  }).filter(Boolean);

  return { blocks: normalized };
}

async function extractHwpViaKordoc(fullPath) {
  const parse = await getKordocParse();
  const buffer = fs.readFileSync(fullPath);
  const result = await parse(buffer);
  if (!result?.success) throw new Error(result?.error || 'kordoc parse failed');

  const markdown = String(result.markdown || '').trim();
  const structuredContent = mapKordocBlocks(result.blocks);
  if (!markdown && !structuredContent.blocks.length) throw new Error('kordoc returned empty output');

  return {
    text: markdown,
    method: 'kordoc',
    structuredContent,
  };
}

function extractHwpViaHwp5txt(fullPath) {
  const localHwp5txt = path.join(process.env.HOME || '/home/ubuntu', '.local', 'bin', 'hwp5txt');
  const bin = commandExists('hwp5txt') ? 'hwp5txt' : (fs.existsSync(localHwp5txt) ? localHwp5txt : null);
  if (!bin) throw new Error('hwp5txt not installed');

  const out = execFileSync(bin, [fullPath], { encoding: 'utf8', timeout: 20000 });
  if (!out || !out.trim()) throw new Error('hwp5txt returned empty text');
  return out;
}

function collectStringsDeep(input, acc = []) {
  if (input == null) return acc;
  if (typeof input === 'string') {
    const v = input.trim();
    if (v && v.length >= 2) acc.push(v);
    return acc;
  }
  if (Array.isArray(input)) {
    for (const item of input) collectStringsDeep(item, acc);
    return acc;
  }
  if (typeof input === 'object') {
    for (const key of Object.keys(input)) collectStringsDeep(input[key], acc);
  }
  return acc;
}

async function extractHwpViaHwpJs(fullPath) {
  const bin = fs.readFileSync(fullPath).toString('binary');
  const parsed = await parseHwp(bin);
  const strings = Array.from(new Set(collectStringsDeep(parsed)));
  const text = strings.join('\n').trim();
  if (!text) throw new Error('hwp.js parsed but extracted text is empty');
  return text;
}

function extractHwpViaStrings(fullPath) {
  if (!commandExists('strings')) throw new Error('strings command not available');
  const out = execFileSync('strings', ['-n', '8', fullPath], { encoding: 'utf8', timeout: 10000 });
  const filtered = out.split('\n').map((v) => v.trim()).filter(Boolean).filter((v) => /[가-힣A-Za-z0-9]/.test(v));
  const text = filtered.join('\n').trim();
  if (!text) throw new Error('strings fallback returned empty text');
  if (!/[가-힣]/.test(text)) throw new Error('strings fallback low confidence (no Hangul detected)');
  return text;
}

function extractHwpViaHwp5html(fullPath) {
  const localHwp5html = path.join(process.env.HOME || '/home/ubuntu', '.local', 'bin', 'hwp5html');
  const bin = commandExists('hwp5html') ? 'hwp5html' : (fs.existsSync(localHwp5html) ? localHwp5html : null);
  if (!bin) throw new Error('hwp5html not installed');

  const tempDir = fs.mkdtempSync(path.join('/tmp', 'workdog-hwp5html-'));
  execFileSync(bin, ['--output', tempDir, fullPath], { encoding: 'utf8', timeout: 30000 });
  const xhtmlPath = path.join(tempDir, 'index.xhtml');
  if (!fs.existsSync(xhtmlPath)) throw new Error('hwp5html did not produce index.xhtml');
  const html = fs.readFileSync(xhtmlPath, 'utf8');
  return {
    html,
    assetDir: path.join(tempDir, 'bindata'),
    tempDir,
  };
}

function extractHwpHtml(fullPath) {
  return extractHwpViaHwp5html(fullPath);
}

function postProcessHwpText(text) {
  const clean = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/<표>/g, '\n\n[TABLE]\n')
    .replace(/<그림>/g, '\n\n[IMAGE]\n')
    .trim();
  return clean;
}

async function extractHwpText(fullPath) {
  const errors = [];
  try {
    const result = await extractHwpViaKordoc(fullPath);
    return {
      ...result,
      text: postProcessHwpText(result.text),
      structuredContent: result.structuredContent,
    };
  } catch (e) { errors.push(`kordoc: ${e.message}`); }
  try {
    const result = { text: extractHwpViaHwp5txt(fullPath), method: 'hwp5txt' };
    return { ...result, text: postProcessHwpText(result.text) };
  } catch (e) { errors.push(`hwp5txt: ${e.message}`); }
  try {
    const result = { text: await extractHwpViaHwpJs(fullPath), method: 'hwp.js' };
    return { ...result, text: postProcessHwpText(result.text) };
  } catch (e) { errors.push(`hwp.js: ${e.message}`); }
  try {
    const result = { text: extractHwpViaStrings(fullPath), method: 'strings-fallback' };
    return { ...result, text: postProcessHwpText(result.text) };
  } catch (e) { errors.push(`strings: ${e.message}`); }
  throw new Error(`hwp extraction failed (${errors.join(' | ')})`);
}

async function extractTextFromFile(fullPath, fileType) {
  const type = String(fileType || '').toLowerCase();

  if (type === 'txt') {
    const raw = fs.readFileSync(fullPath);
    let text = raw.toString('utf8');
    if (text.includes('�')) text = raw.toString('latin1');
    return { text, method: 'txt-utf8' };
  }

  if (type === 'pdf') {
    const parsed = await pdfParse(fs.readFileSync(fullPath));
    return { text: parsed.text || '', method: 'pdf-parse' };
  }

  if (type === 'xlsx' || type === 'xls') {
    const wb = XLSX.readFile(fullPath, { cellDates: true });
    const chunks = wb.SheetNames.map((s) => `[Sheet: ${s}]\n${XLSX.utils.sheet_to_csv(wb.Sheets[s])}`);
    return { text: chunks.join('\n\n').trim(), method: 'xlsx' };
  }

  if (type === 'hwp') return extractHwpText(fullPath);
  throw new Error(`unsupported extractor: ${type}`);
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#13;/g, '\n')
    .replace(/&#10;/g, '\n')
    .replace(/&#9;/g, '\t')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtmlTags(html) {
  return decodeHtmlEntities(String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractHtmlTagBlocks(html, tagName) {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const blocks = [];
  let match;
  while ((match = regex.exec(String(html || '')))) {
    blocks.push(match[1]);
  }
  return blocks;
}

function buildTableBlockFromHtml(tableHtml) {
  const rowHtmls = extractHtmlTagBlocks(tableHtml, 'tr');
  const rows = rowHtmls.map((rowHtml) => {
    const cells = [];
    const cellRegex = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml))) {
      const text = stripHtmlTags(cellMatch[2]);
      cells.push(text || ' ');
    }
    return cells;
  }).filter((row) => row.length > 0);

  return rows.length ? { type: 'table', rows } : null;
}

function buildStructuredContentFromHtml(html) {
  const source = String(html || '').trim();
  if (!source) return { blocks: [] };

  const bodyMatch = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch ? bodyMatch[1] : source;
  const tokenRegex = /<(h[1-3]|p|table)\b[^>]*>[\s\S]*?<\/\1>/gi;
  const blocks = [];
  let match;

  while ((match = tokenRegex.exec(body))) {
    const token = match[0];
    const tag = String(match[1] || '').toLowerCase();

    if (tag === 'table') {
      const tableBlock = buildTableBlockFromHtml(token);
      if (tableBlock) blocks.push(tableBlock);
      continue;
    }

    if (tag === 'p') {
      const tableRegex = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
      let tableMatch;
      let tokenWithoutTables = token;
      while ((tableMatch = tableRegex.exec(token))) {
        const tableBlock = buildTableBlockFromHtml(tableMatch[0]);
        if (tableBlock) blocks.push(tableBlock);
        tokenWithoutTables = tokenWithoutTables.replace(tableMatch[0], ' ');
      }

      const images = [];
      const imgRegex = /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
      let imgMatch;
      while ((imgMatch = imgRegex.exec(tokenWithoutTables))) {
        images.push(imgMatch[1]);
      }
      for (const src of images) {
        blocks.push({ type: 'image', src, alt: '', caption: '' });
      }

      const text = stripHtmlTags(tokenWithoutTables.replace(/<img\b[^>]*>/gi, ' '));
      if (text) blocks.push({ type: 'paragraph', text });
      continue;
    }

    const text = stripHtmlTags(token);
    if (text) {
      const level = Number(tag.replace('h', '')) || 2;
      blocks.push({ type: 'heading', level, text });
    }
  }

  return { blocks };
}

function buildStructuredContent(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return { blocks: [] };

  const rawChunks = clean
    .split(/\n\s*\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const chunks = [];
  for (let i = 0; i < rawChunks.length; i += 1) {
    const current = rawChunks[i];
    if (current === '[TABLE]') {
      const next = rawChunks[i + 1] || '';
      if (next && next !== '[IMAGE]' && next !== '[TABLE]') {
        chunks.push(`[TABLE]\n${next}`);
        i += 1;
        continue;
      }
    }
    chunks.push(current);
  }

  const blocks = chunks.map((chunk) => {
    const normalized = chunk.replace(/[ \t]+/g, ' ').trim();

    if (normalized === '[IMAGE]') {
      return { type: 'image', alt: '그림', caption: '그림 영역' };
    }

    if (normalized === '[TABLE]') {
      return { type: 'table', rows: [['표 영역']] };
    }

    if (normalized.startsWith('[TABLE]')) {
      const payload = normalized.replace(/^\[TABLE\]\s*/, '').trim();
      const lines = payload.split('\n').map((line) => line.trim()).filter(Boolean);
      const rows = lines.map((line) => {
        if (/\t|,|\|/.test(line)) return line.split(/\t|,|\|/).map((cell) => cell.trim()).filter(Boolean);
        return [line];
      }).filter((row) => row.length > 0);
      return { type: 'table', rows: rows.length ? rows : [['표 영역']] };
    }

    const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
    const tableCandidate = lines.length >= 2 && lines.filter((line) => /,|\t|\|/.test(line)).length >= 2;
    if (tableCandidate) {
      const rows = lines.map((line) => line.split(/\t|,|\|/).map((cell) => cell.trim()).filter(Boolean)).filter((row) => row.length > 0);
      if (rows.length) return { type: 'table', rows };
    }

    if (/^(□|■|▪|▶|[0-9]+\.|[가-힣A-Za-z0-9 ]{2,40})$/.test(normalized) && normalized.length <= 50) {
      return { type: 'heading', level: 2, text: normalized };
    }

    return { type: 'paragraph', text: normalized.replace(/\s+/g, ' ') };
  });

  return { blocks };
}

function summarizeTextHeuristic(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('empty extractedText');

  const sentences = clean.split(/(?<=[.!?다요])\s+/).map((s) => s.trim()).filter((s) => s.length > 8);
  const summaryOneLine = (sentences[0] || clean).slice(0, 180);

  const words = (clean.match(/[가-힣A-Za-z0-9]{2,}/g) || []).map((w) => w.toLowerCase());
  const stop = new Set(['그리고', '하지만', '합니다', '대한', '위한', '에서', '으로', '입니다', '한다', '하는', '관련', '공지', '자료', 'the', 'and', 'for', 'with', 'this', 'that']);
  const freq = new Map();
  for (const w of words) {
    if (stop.has(w) || w.length < 2) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  const scored = sentences.map((s) => {
    const tokens = (s.match(/[가-힣A-Za-z0-9]{2,}/g) || []).map((w) => w.toLowerCase());
    let score = tokens.reduce((acc, t) => acc + (freq.get(t) || 0), 0);
    if (/\d{4}|\d{1,2}[:시]\d{0,2}|일정|계획|결과|회의/.test(s)) score += 4;
    return { s, score };
  }).sort((a, b) => b.score - a.score);

  const keyPoints = scored.slice(0, 5).map((x) => x.s).filter(Boolean).slice(0, Math.max(3, Math.min(5, scored.length)));

  const categoryRules = [
    { name: '계획서', keys: ['계획', '추진', '목표', '예정'] },
    { name: '결과보고', keys: ['결과', '실적', '완료', '성과', '보고'] },
    { name: '안내문', keys: ['안내', '공지', '알림', '유의'] },
    { name: '공문', keys: ['공문', '시행', '수신', '참조'] },
    { name: '일정표', keys: ['일정', '시간표', '타임테이블', '스케줄'] },
    { name: '회의자료', keys: ['회의', '안건', '의결', '회의록'] },
    { name: '참고자료', keys: ['참고', '매뉴얼', '가이드', '지침'] },
  ];

  let category = '기타';
  for (const r of categoryRules) {
    if (r.keys.some((k) => clean.includes(k))) { category = r.name; break; }
  }

  const tags = [];
  const pushTag = (v) => {
    const t = String(v || '').trim().replace(/[\[\]{}()]/g, '');
    if (!t || t.length < 2) return;
    if (tags.includes(t)) return;
    if (/^자료$|^문서$|^내용$|^업무$/.test(t)) return;
    tags.push(t);
  };

  // 우선순위 태그: 연도
  (clean.match(/20\d{2}년?/g) || []).forEach((y) => pushTag(y.replace(/년$/, '')));

  // 행사명/회의/교육 등
  (clean.match(/[가-힣A-Za-z0-9]{2,20}(행사|축제|대회|회의|세미나|워크숍|교육|훈련|캠프)/g) || []).forEach(pushTag);

  // 대상/장소/담당/일정 키워드 기반
  const priorities = ['대상', '장소', '담당', '일정', '시간', '일시'];
  priorities.forEach((k) => { if (clean.includes(k)) pushTag(k); });

  // 보강 태그(빈도 기반)
  Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).map(([w]) => w).forEach(pushTag);

  const finalTags = tags.slice(0, 8);
  while (finalTags.length < 3) {
    const fallback = ['업무', category, '문서'].find((x) => !finalTags.includes(x));
    if (!fallback) break;
    finalTags.push(fallback);
  }

  return {
    summaryOneLine,
    keyPoints: keyPoints.length ? keyPoints : [summaryOneLine],
    category,
    tags: finalTags,
  };
}

const taskStore = new Map();
const taskRetryHandlers = new Map();

function createTask(type) {
  const now = new Date().toISOString();
  const task = {
    id: crypto.randomUUID(),
    type,
    status: 'pending',
    steps: [
      { id: 'save-file', name: 'save file', status: 'pending', tool: 'fs.writeFileSync', input: null, output: null, error: '' },
      { id: 'extract-text', name: 'extract text', status: 'pending', tool: 'extractTextFromFile', input: null, output: null, error: '' },
      { id: 'summarize', name: 'summarize', status: 'pending', tool: 'summarizeTextHeuristic', input: null, output: null, error: '' },
      { id: 'generate-metadata', name: 'generate metadata', status: 'pending', tool: 'metadata-builder', input: null, output: null, error: '' },
      { id: 'save-result', name: 'save result', status: 'pending', tool: 'writeDocuments', input: null, output: null, error: '' },
    ],
    logs: [],
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  taskStore.set(task.id, task);
  return task;
}

function getTask(taskId) {
  return taskStore.get(taskId) || null;
}

function listTasks({ status } = {}) {
  const tasks = Array.from(taskStore.values());
  if (!status) return tasks;
  return tasks.filter((t) => t.status === status);
}

function updateTask(taskId, patch) {
  const task = taskStore.get(taskId);
  if (!task) return null;
  const next = { ...task, ...patch, updatedAt: new Date().toISOString() };
  taskStore.set(taskId, next);
  return next;
}

function appendTaskLog(taskId, message) {
  const task = taskStore.get(taskId);
  if (!task) return null;
  return updateTask(taskId, {
    logs: [...task.logs, { message: String(message), timestamp: new Date().toISOString() }],
  });
}

function updateTaskStep(taskId, stepId, patch) {
  const task = taskStore.get(taskId);
  if (!task) return null;
  const steps = task.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step));
  return updateTask(taskId, { steps });
}

function updateDocument(docId, patch) {
  const docs = readDocuments();
  const idx = docs.findIndex((d) => d.id === docId);
  if (idx === -1) return null;
  docs[idx] = { ...docs[idx], ...patch };
  writeDocuments(docs);
  return docs[idx];
}

async function runTaskWithRetry(taskId, runner, maxRetry = 2) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
    updateTask(taskId, { status: attempt === 0 ? 'running' : 'retrying', retryCount: attempt });
    appendTaskLog(taskId, `attempt ${attempt + 1} started`);

    try {
      await runner();
      updateTask(taskId, { status: 'done' });
      appendTaskLog(taskId, `attempt ${attempt + 1} succeeded`);
      return getTask(taskId);
    } catch (e) {
      lastError = e;
      appendTaskLog(taskId, `attempt ${attempt + 1} failed: ${e?.message || String(e)}`);
      if (attempt === maxRetry) {
        updateTask(taskId, { status: 'error', retryCount: attempt });
      }
    }
  }

  throw lastError || new Error('task failed');
}

function buildGenerationSourceDocuments(documentIds) {
  const ids = Array.isArray(documentIds) ? documentIds.map((v) => String(v)) : [];
  const docs = readDocuments();
  const sourceDocs = ids.map((id) => docs.find((doc) => doc.id === id)).filter(Boolean);

  const normalized = sourceDocs.map((doc) => {
    const extractedText = String(doc?.extractedText || '').trim();
    const summaryOneLine = String(doc?.summaryOneLine || '').trim();
    const summary = String(doc?.summary || '').trim();
    const structuredBlocks = Array.isArray(doc?.structuredContent?.blocks) ? doc.structuredContent.blocks : [];
    const structuredSnippet = structuredBlocks
      .map((block) => {
        if (block?.type === 'table' && Array.isArray(block?.rows)) {
          return block.rows.flat().map((cell) => String(cell || '').trim()).filter(Boolean).join(' | ');
        }
        return String(block?.text || '').trim();
      })
      .filter(Boolean)
      .slice(0, 5)
      .join('\n');
    const fallbackText = extractedText || summaryOneLine || summary || structuredSnippet || String(doc?.title || '').trim();

    return {
      id: doc.id,
      title: String(doc.title || '제목 없는 문서').trim() || '제목 없는 문서',
      category: String(doc.category || '기타').trim() || '기타',
      tags: Array.isArray(doc.tags) ? doc.tags : [],
      extractedText,
      summaryOneLine,
      summary,
      structuredBlocks,
      textForGeneration: fallbackText,
    };
  }).filter((doc) => doc.textForGeneration);

  if (!normalized.length) {
    throw new Error('유효한 문서를 찾을 수 없습니다. 추출 결과 또는 제목이 있는 문서를 선택해 주세요.');
  }

  return normalized;
}

function buildGenerationPromptTitle(prompt) {
  const clean = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '생성 문서 초안';
  return `${clean.slice(0, 80)} 초안`;
}

function generateDraftFromDocuments({ documents, prompt }) {
  const cleanPrompt = String(prompt || '').replace(/\s+/g, ' ').trim();
  const title = buildGenerationPromptTitle(cleanPrompt);

  const uniqueLines = (lines, max = 6) => {
    const seen = new Set();
    const out = [];
    for (const raw of lines) {
      const line = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
      if (out.length >= max) break;
    }
    return out;
  };

  const classifyDocType = (text) => {
    if (/가정통신문|안내문/.test(text)) return 'notice';
    if (/계획|운영/.test(text)) return 'plan';
    if (/보고|결과/.test(text)) return 'report';
    return 'general';
  };

  const docCoreLines = documents.map((doc) => {
    const headingLines = (doc.structuredBlocks || [])
      .filter((block) => block?.type === 'heading')
      .map((block) => block?.text);
    const paragraphLines = (doc.structuredBlocks || [])
      .filter((block) => block?.type === 'paragraph')
      .map((block) => block?.text);
    const tables = (doc.structuredBlocks || [])
      .filter((block) => block?.type === 'table' && Array.isArray(block?.rows));
    const tableLines = tables
      .flatMap((block) => block.rows.slice(0, 6).map((row) => row.map((cell) => String(cell || '').trim()).filter(Boolean).join(' | ')));

    const scheduleRows = [];
    for (const table of tables) {
      const rows = Array.isArray(table.rows) ? table.rows.filter((row) => Array.isArray(row)) : [];
      if (rows.length < 2) continue;
      const header = rows[0].map((cell) => String(cell || '').trim());
      const monthIdx = header.findIndex((v) => /월/.test(v));
      const dateIdx = header.findIndex((v) => /활동일|일정|시기/.test(v));
      const gradeIdx = header.findIndex((v) => /학년|대상/.test(v));
      const classIdx = header.findIndex((v) => /반|학급|운영/.test(v));
      const noteIdx = header.findIndex((v) => /비고|참고|메모/.test(v));
      if (monthIdx < 0 && dateIdx < 0 && gradeIdx < 0) continue;

      for (const row of rows.slice(1, 8)) {
        const cols = row.map((cell) => String(cell || '').trim());
        const month = monthIdx >= 0 ? cols[monthIdx] : '';
        const when = dateIdx >= 0 ? cols[dateIdx] : '';
        const grade = gradeIdx >= 0 ? cols[gradeIdx] : '';
        const klass = classIdx >= 0 ? cols[classIdx] : '';
        const note = noteIdx >= 0 ? cols[noteIdx] : '';
        if (![month, when, grade, klass, note].some(Boolean)) continue;
        scheduleRows.push({ month, when, grade, klass, note });
      }
    }

    const lines = uniqueLines([
      ...headingLines,
      ...paragraphLines,
      ...tableLines,
      doc.summaryOneLine,
      doc.summary,
      doc.title,
    ], 12);

    return {
      title: doc.title,
      lines,
      scheduleRows,
      type: classifyDocType(`${doc.title} ${doc.summaryOneLine} ${cleanPrompt}`),
    };
  });

  const dominantType = docCoreLines.reduce((acc, doc) => {
    acc[doc.type] = (acc[doc.type] || 0) + 1;
    return acc;
  }, {});
  const docType = Object.entries(dominantType).sort((a, b) => b[1] - a[1])[0]?.[0] || 'general';

  const targetPriorityLines = uniqueLines(docCoreLines.flatMap((doc) => doc.lines.filter((line) => /운영 대상|적용 대상|참여 대상|전교생|희망 학급/.test(line))), 4);
  const targetLines = uniqueLines([
    ...targetPriorityLines,
    ...docCoreLines.flatMap((doc) => doc.lines.filter((line) => /대상|학년|학생|학부모|교직원|교사|학급|참여/.test(line))),
  ], 5);
  const operationPriorityLines = uniqueLines(docCoreLines.flatMap((doc) => doc.lines.filter((line) => /추진 방향|주요 활동|세부추진계획|운영 기간/.test(line))), 4);
  const operationLines = uniqueLines([
    ...operationPriorityLines,
    ...docCoreLines.flatMap((doc) => doc.lines.filter((line) => /운영|활동|방법|절차|안내|추진/.test(line))),
  ], 5);
  const planLines = uniqueLines(docCoreLines.flatMap((doc) => doc.lines.filter((line) => /일정|계획|월|학기|주간|단계/.test(line))), 6);
  const effectLines = uniqueLines(docCoreLines.flatMap((doc) => doc.lines.filter((line) => /기대|효과|개선|도움|지원/.test(line))), 4);
  const tableEvidence = uniqueLines(docCoreLines.flatMap((doc) => doc.lines.filter((line) => line.includes(' | '))), 8);
  const scheduleNarratives = uniqueLines(docCoreLines.flatMap((doc) => (doc.scheduleRows || []).map((row) => {
    const month = row.month || '해당 시기';
    const target = row.grade || '대상 학년';
    const when = row.when || '운영 시기';
    const klass = row.klass ? `${row.klass} 기준으로 ` : '';
    const note = row.note ? ` ${row.note}` : '';
    return `${month}에는 ${target}을 대상으로 ${klass}${when}에 운영합니다.${note}`.trim();
  })), 6);

  const introByType = {
    plan: `${cleanPrompt}에 맞춰 바로 수정 가능한 계획서 초안 형태로 정리합니다.`,
    notice: `${cleanPrompt}에 맞춰 전달 대상이 바로 이해할 수 있는 안내문 초안 형태로 정리합니다.`,
    report: `${cleanPrompt}에 맞춰 경과와 핵심 내용을 빠르게 파악할 수 있는 보고 초안 형태로 정리합니다.`,
    general: `${cleanPrompt}에 맞춰 참고 문서를 바탕으로 바로 수정 가능한 초안 형태로 정리합니다.`,
  };

  const cleanedTargetText = (targetLines.join(' ') || '적용 대상과 범위를 구체적으로 적습니다.')
    .replace(/(가|나|다)\.\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cleanedOperationText = (operationLines.join(' ') || '핵심 운영 내용과 절차를 실무 중심으로 정리합니다.')
    .replace(/(가|나|다)\.\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const sectionsByType = {
    plan: [
      ['1. 추진 배경 및 목적', introByType[docType]],
      ['2. 운영 대상', cleanedTargetText || '적용 대상과 범위를 구체적으로 적습니다.'],
      ['3. 운영 내용', cleanedOperationText || '핵심 운영 내용과 절차를 실무 중심으로 정리합니다.'],
      ['4. 세부 일정', scheduleNarratives.join(' ') || planLines.join(' ') || '월별 또는 단계별 일정과 준비 흐름을 정리합니다.'],
      ['5. 참고할 세부 항목', tableEvidence.join(' / ') || '표에 있는 세부 항목과 준비 요소를 반영해 보완합니다.'],
      ['6. 기대 효과', effectLines.join(' ') || '기대 효과와 활용 가치를 간단명료하게 정리합니다.'],
    ],
    notice: [
      ['1. 안내 개요', introByType[docType]],
      ['2. 안내 대상', cleanedTargetText || '안내 대상과 적용 범위를 분명하게 적습니다.'],
      ['3. 주요 안내 사항', cleanedOperationText || '꼭 전달해야 할 핵심 내용을 먼저 정리합니다.'],
      ['4. 일정 및 참여 방법', scheduleNarratives.join(' ') || planLines.join(' ') || '일정, 참여 방법, 준비 사항을 정리합니다.'],
      ['5. 참고할 세부 항목', tableEvidence.join(' / ') || '세부 항목과 주의 사항을 보완합니다.'],
    ],
    report: [
      ['1. 보고 개요', introByType[docType]],
      ['2. 대상 및 범위', cleanedTargetText || '대상과 범위를 분명하게 적습니다.'],
      ['3. 주요 추진 내용', cleanedOperationText || '주요 추진 내용을 간결하게 요약합니다.'],
      ['4. 일정 및 경과', scheduleNarratives.join(' ') || planLines.join(' ') || '시기별 경과와 주요 일정을 정리합니다.'],
      ['5. 시사점', effectLines.join(' ') || '성과, 효과, 향후 보완점을 정리합니다.'],
    ],
    general: [
      ['1. 목적', introByType[docType]],
      ['2. 대상', cleanedTargetText || '적용 대상을 구체적으로 적습니다.'],
      ['3. 핵심 내용', cleanedOperationText || '핵심 내용을 실무 중심으로 정리합니다.'],
      ['4. 일정 또는 절차', scheduleNarratives.join(' ') || planLines.join(' ') || '일정이나 절차를 순서대로 정리합니다.'],
      ['5. 참고할 세부 항목', tableEvidence.join(' / ') || '표나 세부 요소를 반영해 보완합니다.'],
      ['6. 기대 효과', effectLines.join(' ') || '기대 효과를 정리합니다.'],
    ],
  };

  const sourceSummaryLines = docCoreLines.map((doc, index) => {
    const joined = uniqueLines(doc.lines, 4).join(' / ');
    return `${index + 1}. ${doc.title}: ${joined || '참고 내용이 있습니다.'}`;
  });

  const sectionLines = (sectionsByType[docType] || sectionsByType.general)
    .flatMap(([heading, body]) => [heading, body, '']);

  let contentText = [
    cleanPrompt || '생성 문서 초안',
    '',
    ...sectionLines,
    '참고 문서',
    sourceSummaryLines.join('\n'),
  ].join('\n');

  if (contentText.length < 500) {
    contentText += '\n\n참고 문서를 바탕으로 정리한 1차 초안입니다. 실제 적용 전에는 연도, 대상, 일정, 담당자, 세부 운영 방식과 준비 사항을 현재 상황에 맞게 반드시 보정해 주세요.';
  }

  const htmlSections = contentText.split('\n\n').map((chunk, index) => {
    const trimmed = chunk.trim();
    if (!trimmed) return '';
    if (index === 0) return `<h1>${trimmed}</h1>`;
    if (/^참고 문서$/.test(trimmed)) return '<h2>참고 문서</h2>';
    if (/^\d+\./.test(trimmed)) {
      const [first, ...rest] = trimmed.split('\n');
      return `<h3>${first}</h3>${rest.length ? `<p>${rest.join('<br />')}</p>` : ''}`;
    }
    return `<p>${trimmed.replace(/\n/g, '<br />')}</p>`;
  }).filter(Boolean).join('\n');

  return {
    title,
    contentText,
    contentHtml: htmlSections,
    structuredContent: buildStructuredContent(contentText),
  };
}

async function runDocumentPipelineTask({ taskId, docId, folderId, title, originalName, ext, fileBuffer, maxRetry = 2 }) {
  const context = {
    storedName: '',
    fullPath: '',
    extractedText: '',
    structuredContent: { blocks: [] },
    extractMethod: '',
    summaryOneLine: '',
    keyPoints: [],
    category: '',
    tags: [],
  };

  async function runStep(stepId, input, fn) {
    updateTaskStep(taskId, stepId, { status: 'running', input, error: '' });
    appendTaskLog(taskId, `[${stepId}] started`);

    try {
      const output = await fn();
      updateTaskStep(taskId, stepId, { status: 'done', output, error: '' });
      appendTaskLog(taskId, `[${stepId}] done`);
      return output;
    } catch (e) {
      const msg = e?.message ? String(e.message) : String(e);
      updateTaskStep(taskId, stepId, { status: 'error', error: msg });
      appendTaskLog(taskId, `[${stepId}] error: ${msg}`);
      throw e;
    }
  }

  try {
    await runTaskWithRetry(taskId, async () => {
      await runStep('save-file', { folderId, originalName }, async () => {
        const fileName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
        const folderDir = ensureFolderFilesDir(folderId);
        const fullPath = path.join(folderDir, fileName);
        fs.writeFileSync(fullPath, fileBuffer);

        context.storedName = `${folderId}/${fileName}`;
        context.fullPath = fullPath;

        return { storedName: context.storedName };
      });

      await runStep('extract-text', { fileType: ext }, async () => {
        const result = await extractTextFromFile(context.fullPath, ext);
        context.extractedText = result.text || '';
        context.extractMethod = result.method || '';
        if (result.structuredContent && Array.isArray(result.structuredContent.blocks)) {
          context.structuredContent = result.structuredContent;
        }
        return { method: context.extractMethod, extractedLength: context.extractedText.length };
      });

      await runStep('summarize', { extractedLength: context.extractedText.length }, async () => {
        if (!Array.isArray(context.structuredContent?.blocks) || context.structuredContent.blocks.length === 0) {
          context.structuredContent = buildStructuredContent(context.extractedText);
        }

        if (ext === 'hwp' && (!Array.isArray(context.structuredContent?.blocks) || context.structuredContent.blocks.length === 0)) {
          try {
            const htmlResult = extractHwpHtml(context.fullPath);
            const htmlStructured = buildStructuredContentFromHtml(htmlResult.html);
            if (Array.isArray(htmlStructured?.blocks) && htmlStructured.blocks.length > 0) {
              context.structuredContent = htmlStructured;
            }
          } catch (e) {
            appendTaskLog(taskId, `[summarize] hwp html fallback skipped: ${e?.message ? String(e.message) : String(e)}`);
          }
        }

        const result = summarizeTextHeuristic(context.extractedText);
        context.summaryOneLine = result.summaryOneLine || '';
        context.keyPoints = Array.isArray(result.keyPoints) ? result.keyPoints : [];
        context.category = result.category || '기타';
        context.tags = Array.isArray(result.tags) ? result.tags : [];
        return {
          summaryOneLine: context.summaryOneLine,
          keyPointsCount: context.keyPoints.length,
          blocksCount: Array.isArray(context.structuredContent?.blocks) ? context.structuredContent.blocks.length : 0,
        };
      });

      await runStep('generate-metadata', { category: context.category }, async () => ({
        category: context.category,
        tags: context.tags,
      }));

      await runStep('save-result', { docId }, async () => {
        const updated = updateDocument(docId, {
          title,
          fileName: originalName,
          storedName: context.storedName,
          fileType: ext,
          size: fileBuffer.length,
          status: 'DONE',
          extractedText: context.extractedText,
          extractStatus: 'success',
          extractError: '',
          extractMethod: context.extractMethod,
          structuredContent: context.structuredContent,
          summaryOneLine: context.summaryOneLine,
          keyPoints: context.keyPoints,
          category: context.category,
          tags: context.tags,
          aiStatus: 'success',
          aiError: '',
          updatedAt: new Date().toISOString(),
        });

        if (!updated) throw new Error('document not found while saving result');
        return { documentId: updated.id, status: updated.status };
      });
    }, maxRetry);
  } catch (e) {
    updateDocument(docId, {
      status: 'ERROR',
      extractStatus: 'failed',
      extractError: e?.message ? String(e.message) : 'pipeline failed',
      aiStatus: 'failed',
      aiError: e?.message ? String(e.message) : 'pipeline failed',
      updatedAt: new Date().toISOString(),
    });
  }
}

app.get('/api/folders', (req, res) => res.json(readFolders()));
app.get('/api/folders/:id', (req, res) => {
  const folder = findFolder(req.params.id);
  if (!folder) return res.status(404).json({ error: 'folder not found' });
  return res.json(folder);
});

app.post('/api/folders', (req, res) => {
  const { name, description = '', color = '#F59E0B' } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name is required' });

  const folders = readFolders();
  const folder = { id: crypto.randomUUID(), name: name.trim(), description: typeof description === 'string' ? description.trim() : '', color: typeof color === 'string' && color.trim() ? color.trim() : '#F59E0B', createdAt: new Date().toISOString() };
  folders.push(folder);
  writeFolders(folders);
  ensureFolderFilesDir(folder.id);
  return res.status(201).json(folder);
});

app.put('/api/folders/:id', (req, res) => {
  const folders = readFolders();
  const idx = folders.findIndex((f) => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'folder not found' });
  const { name, description, color } = req.body || {};
  if (typeof name === 'string' && name.trim()) folders[idx].name = name.trim();
  if (typeof description === 'string') folders[idx].description = description.trim();
  if (typeof color === 'string' && color.trim()) folders[idx].color = color.trim();
  writeFolders(folders);
  return res.json(folders[idx]);
});

app.delete('/api/folders/:id', (req, res) => {
  const id = req.params.id;
  const folders = readFolders();
  const next = folders.filter((f) => f.id !== id);
  if (next.length === folders.length) return res.status(404).json({ error: 'folder not found' });
  writeFolders(next);

  const docs = readDocuments();
  const remains = [];
  for (const doc of docs) {
    if (doc.folderId === id) {
      const fullPath = resolveStoredPath(doc);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } else remains.push(doc);
  }
  const folderFilesDir = path.join(FILES_DIR, id);
  if (fs.existsSync(folderFilesDir)) fs.rmSync(folderFilesDir, { recursive: true, force: true });
  writeDocuments(remains);
  return res.json({ deletedId: id });
});

app.get('/api/folders/:id/documents', (req, res) => {
  const folderId = req.params.id;
  if (!findFolder(folderId)) return res.status(404).json({ error: 'folder not found' });
  return res.json(readDocuments().filter((d) => d.folderId === folderId).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
});

app.get('/api/documents/:docId', (req, res) => {
  const doc = readDocuments().find((d) => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'document not found' });
  return res.json(doc);
});

app.get('/tasks/summary', (req, res) => {
  const tasks = listTasks();
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const runningCount = tasks.filter((t) => t.status === 'running' || t.status === 'retrying').length;
  const failedCount = tasks.filter((t) => t.status === 'error').length;
  const completedToday = tasks.filter((t) => t.status === 'done' && new Date(t.updatedAt) >= startOfToday).length;
  const recentTasks = tasks
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 5);

  return res.json({
    runningCount,
    failedCount,
    completedToday,
    recentTasks,
  });
});

app.get('/tasks', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  const tasks = listTasks({ status: status || undefined })
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return res.json(tasks);
});

app.get('/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  return res.json(task);
});

app.post('/tasks/:id/retry', async (req, res) => {
  const taskId = req.params.id;
  const task = getTask(taskId);
  if (!task) return res.status(404).json({ error: 'task not found' });

  const handler = taskRetryHandlers.get(taskId);
  if (!handler) {
    return res.status(400).json({ error: 'retry handler not found for task' });
  }

  updateTask(taskId, { status: 'pending' });
  appendTaskLog(taskId, 'manual retry requested');
  task.steps.forEach((step) => updateTaskStep(taskId, step.id, { status: 'pending', error: '' }));

  handler();
  return res.status(202).json({ task_id: taskId, status: 'pending' });
});

// backward compatibility
app.get('/api/tasks/:taskId', (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'task not found' });
  return res.json(task);
});

app.post('/api/generations', (req, res) => {
  const documentIds = Array.isArray(req.body?.documentIds) ? req.body.documentIds.map((v) => String(v)) : [];
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  if (!documentIds.length) return res.status(400).json({ error: 'documentIds is required' });
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  let sourceDocs;
  try {
    sourceDocs = buildGenerationSourceDocuments(documentIds);
  } catch (e) {
    return res.status(400).json({ error: e?.message || '유효한 문서를 찾을 수 없습니다.' });
  }

  const draft = generateDraftFromDocuments({ documents: sourceDocs, prompt });
  const now = new Date().toISOString();
  const generatedDoc = {
    id: crypto.randomUUID(),
    title: draft.title,
    prompt,
    status: 'draft',
    sourceDocumentIds: sourceDocs.map((doc) => doc.id),
    sourceDocumentsPreview: sourceDocs.map((doc) => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
    })),
    contentText: draft.contentText,
    contentHtml: draft.contentHtml || '',
    structuredContent: draft.structuredContent || { blocks: [] },
    createdAt: now,
    updatedAt: now,
  };

  const generatedDocs = readGeneratedDocuments();
  generatedDocs.push(generatedDoc);
  writeGeneratedDocuments(generatedDocs);

  return res.status(201).json(generatedDoc);
});

app.get('/api/generated-documents', (req, res) => {
  const docs = readGeneratedDocuments()
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .map((doc) => ({
      id: doc.id,
      title: doc.title,
      status: doc.status || 'draft',
      createdAt: doc.createdAt,
      sourceDocumentIds: Array.isArray(doc.sourceDocumentIds) ? doc.sourceDocumentIds : [],
      contentText: doc.contentText,
      updatedAt: doc.updatedAt,
      prompt: doc.prompt,
      sourceDocumentsPreview: doc.sourceDocumentsPreview,
      regeneratedFromId: doc.regeneratedFromId,
    }));
  return res.json(docs);
});

app.get('/api/generated-documents/:id', (req, res) => {
  const doc = readGeneratedDocuments().find((item) => item.id === req.params.id);
  if (!doc) return res.status(404).json({ error: 'generated document not found' });
  return res.json(doc);
});

app.patch('/api/generated-documents/:id', (req, res) => {
  const docs = readGeneratedDocuments();
  const idx = docs.findIndex((item) => item.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'generated document not found' });

  const { title, prompt, contentText, contentHtml } = req.body || {};

  if (typeof title === 'string') docs[idx].title = title.trim() || docs[idx].title;
  if (typeof prompt === 'string') docs[idx].prompt = prompt.trim() || docs[idx].prompt;
  let contentUpdated = false;
  if (typeof contentText === 'string') {
    docs[idx].contentText = contentText;
    docs[idx].structuredContent = buildStructuredContent(contentText);
    contentUpdated = true;
  }
  if (typeof contentHtml === 'string') {
    docs[idx].contentHtml = contentHtml;
    contentUpdated = true;
  }
  if (contentUpdated) docs[idx].status = 'edited';
  docs[idx].updatedAt = new Date().toISOString();

  writeGeneratedDocuments(docs);
  return res.json(docs[idx]);
});

app.post('/api/generated-documents/:id/regenerate', (req, res) => {
  const docs = readGeneratedDocuments();
  const baseDoc = docs.find((item) => item.id === req.params.id);
  if (!baseDoc) return res.status(404).json({ error: 'generated document not found' });

  const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
    ? req.body.prompt.trim()
    : String(baseDoc.prompt || '').trim();

  let sourceDocs;
  try {
    sourceDocs = buildGenerationSourceDocuments(baseDoc.sourceDocumentIds || []);
  } catch (e) {
    return res.status(400).json({ error: e?.message || '유효한 문서를 찾을 수 없습니다.' });
  }

  const draft = generateDraftFromDocuments({ documents: sourceDocs, prompt });
  const now = new Date().toISOString();
  const regeneratedDoc = {
    id: crypto.randomUUID(),
    title: draft.title,
    prompt,
    status: 'draft',
    sourceDocumentIds: sourceDocs.map((doc) => doc.id),
    sourceDocumentsPreview: sourceDocs.map((doc) => ({
      id: doc.id,
      title: doc.title,
      category: doc.category,
    })),
    contentText: draft.contentText,
    contentHtml: draft.contentHtml || '',
    structuredContent: draft.structuredContent || { blocks: [] },
    regeneratedFromId: baseDoc.id,
    createdAt: now,
    updatedAt: now,
  };

  docs.push(regeneratedDoc);
  writeGeneratedDocuments(docs);
  return res.status(201).json(regeneratedDoc);
});

app.patch('/api/documents/:docId', (req, res) => {
  const docs = readDocuments();
  const idx = docs.findIndex((d) => d.id === req.params.docId);
  if (idx === -1) return res.status(404).json({ error: 'document not found' });

  const { memo, isImportant } = req.body || {};
  if (typeof memo === 'string') docs[idx].memo = memo;
  if (typeof isImportant === 'boolean') docs[idx].isImportant = isImportant;

  writeDocuments(docs);
  return res.json(docs[idx]);
});

app.delete('/api/folders/:folderId/documents/:docId', (req, res) => {
  const { folderId, docId } = req.params;
  if (!findFolder(folderId)) return res.status(404).json({ error: 'folder not found' });
  const docs = readDocuments();
  const target = docs.find((d) => d.id === docId && d.folderId === folderId);
  if (!target) return res.status(404).json({ error: 'document not found' });
  const fullPath = resolveStoredPath(target);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  writeDocuments(docs.filter((d) => d.id !== docId));
  return res.json({ deletedId: docId });
});

app.post('/api/folders/:folderId/documents/bulk-delete', (req, res) => {
  const { folderId } = req.params;
  if (!findFolder(folderId)) return res.status(404).json({ error: 'folder not found' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((v) => String(v)) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids is required' });

  const docs = readDocuments();
  const set = new Set(ids);
  const targets = docs.filter((d) => d.folderId === folderId && set.has(d.id));
  for (const doc of targets) {
    const fullPath = resolveStoredPath(doc);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }
  writeDocuments(docs.filter((d) => !(d.folderId === folderId && set.has(d.id))));
  return res.json({ deletedIds: targets.map((d) => d.id), requestedCount: ids.length, deletedCount: targets.length });
});

app.post('/api/folders/:id/documents', (req, res) => {
  const folderId = req.params.id;
  if (!findFolder(folderId)) return res.status(404).json({ error: 'folder not found' });

  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'upload failed' });
    if (!req.file) return res.status(400).json({ error: 'file is required' });

    const originalName = normalizeOriginalName(req.file.originalname);
    const ext = path.extname(originalName).replace('.', '').toLowerCase();
    const titleRaw = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const title = titleRaw || path.parse(originalName).name;

    const task = createTask('archive.document.process');
    const docId = crypto.randomUUID();

    const doc = {
      id: docId,
      folderId,
      title,
      fileName: originalName,
      storedName: '',
      fileType: ext,
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'PROCESSING',
      taskId: task.id,
      extractedText: '',
      extractStatus: 'pending',
      extractError: '',
      extractMethod: '',
      structuredContent: { blocks: [] },
      summaryOneLine: '',
      keyPoints: [],
      category: '',
      tags: [],
      aiStatus: 'pending',
      aiError: '',
      memo: '',
      isImportant: false,
    };

    const docs = readDocuments();
    docs.push(doc);
    writeDocuments(docs);

    const runPipeline = () => runDocumentPipelineTask({
      taskId: task.id,
      docId,
      folderId,
      title,
      originalName,
      ext,
      fileBuffer: req.file.buffer,
      maxRetry: 2,
    });

    taskRetryHandlers.set(task.id, runPipeline);
    runPipeline();

    return res.status(202).json({
      task_id: task.id,
      document_id: docId,
      status: task.status,
    });
  });
});

app.get('*', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
app.listen(PORT, () => console.log(`workdog-archive listening on ${PORT} (frontend: ${FRONTEND_DIR})`));
