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
const ALLOWED_EXT = new Set(['hwp', 'pdf', 'xlsx', 'xls', 'txt']);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
if (!fs.existsSync(FOLDERS_FILE)) fs.writeFileSync(FOLDERS_FILE, '[]\n', 'utf8');
if (!fs.existsSync(DOCUMENTS_FILE)) fs.writeFileSync(DOCUMENTS_FILE, '[]\n', 'utf8');

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

async function extractHwpText(fullPath) {
  const errors = [];
  try { return { text: extractHwpViaHwp5txt(fullPath), method: 'hwp5txt' }; } catch (e) { errors.push(`hwp5txt: ${e.message}`); }
  try { return { text: await extractHwpViaHwpJs(fullPath), method: 'hwp.js' }; } catch (e) { errors.push(`hwp.js: ${e.message}`); }
  try { return { text: extractHwpViaStrings(fullPath), method: 'strings-fallback' }; } catch (e) { errors.push(`strings: ${e.message}`); }
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

async function runDocumentPipelineTask({ taskId, docId, folderId, title, originalName, ext, fileBuffer, maxRetry = 2 }) {
  const context = {
    storedName: '',
    fullPath: '',
    extractedText: '',
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
        return { method: context.extractMethod, extractedLength: context.extractedText.length };
      });

      await runStep('summarize', { extractedLength: context.extractedText.length }, async () => {
        const result = summarizeTextHeuristic(context.extractedText);
        context.summaryOneLine = result.summaryOneLine || '';
        context.keyPoints = Array.isArray(result.keyPoints) ? result.keyPoints : [];
        context.category = result.category || '기타';
        context.tags = Array.isArray(result.tags) ? result.tags : [];
        return { summaryOneLine: context.summaryOneLine, keyPointsCount: context.keyPoints.length };
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
