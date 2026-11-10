/**
 * A local stand-in for the parts of Supabase Structura uses, so the app runs end to end
 * with no external project. The real supabase-js clients talk to it unchanged: only
 * SUPABASE_URL differs. Data lives in server/.local-data (gitignored).
 *
 * Local development only: it has no access control, so it binds to loopback and refuses
 * to start in production. Realtime isn't served; the frontend polls in local mode.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request, type Response } from 'express';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, '../../../test-assets');
const DEFAULT_DATA_DIR = path.join(HERE, '../../.local-data');
const DEFAULT_PORT = 54321;

const DEMO_USER = { id: '00000000-0000-4000-8000-000000000001', email: 'judge@structura.local', password: 'structura-local' };
const TABLES = ['projects', 'files', 'messages', 'outputs', 'contractor_answers'] as const;
type Row = Record<string, unknown>;
type Db = Record<string, Row[]>;

/** The table constraints the app relies on, so local runs fail the way a real database would. */
const CHECKS: Record<string, Record<string, string[]>> = {
  contractor_answers: { question_type: ['text', 'number', 'choice', 'measurement'] },
  projects: { status: ['ready', 'uploading', 'processing', 'processing-phase1', 'awaiting-answers', 'processing-phase2', 'completed', 'failed'] },
};

function seed(): Db {
  const now = new Date().toISOString();
  const recorded = (name: string) => fs.readFileSync(path.join(ASSETS_DIR, name), 'utf-8');
  const project = (id: string, flow_type: string, project_name: string) => ({
    id, user_id: DEMO_USER.id, flow_type, project_name, project_address: '1232 N Jefferson St', city: 'Placentia',
    status: 'ready', error_message: null, applicant_name: 'Kiet Le', is_demo: true, created_at: now, updated_at: now,
  });
  const file = (project_id: string, file_type: string, filename: string) => {
    const relative = `corrections/${filename}`;
    return {
      id: randomUUID(), project_id, file_type, filename, storage_path: `crossbeam-demo-assets/${relative}`, mime_type: 'application/pdf',
      size_bytes: fs.statSync(path.join(ASSETS_DIR, relative)).size, created_at: now,
    };
  };
  const CITY = 'b0000000-0000-0000-0000-000000000001';
  const CONTRACTOR = 'b0000000-0000-0000-0000-000000000002';
  return {
    projects: [
      project(CITY, 'city-review', '1232 N Jefferson St ADU review'),
      project(CONTRACTOR, 'corrections-analysis', '1232 N Jefferson St ADU corrections'),
    ],
    files: [
      // The binder comes first: extract.ts takes the first PDF as the plan set.
      file(CITY, 'plan-binder', 'Binder-1232-N-Jefferson.pdf'),
      file(CONTRACTOR, 'plan-binder', 'Binder-1232-N-Jefferson.pdf'),
      file(CONTRACTOR, 'corrections-letter', '2nd-Review-Corrections-1232-Jefferson-St-Placentia.pdf'),
    ],
    messages: [],
    outputs: [
      // The dashboard's "showcase" links, filled with this project's recorded run.
      {
        id: 'ba31b41d-7e81-4028-9ea1-47453f313f61', project_id: CITY, flow_phase: 'review', version: 1,
        corrections_letter_md: recorded('corrections/DRAFT-CORRECTIONS-1232-N-Jefferson.md'), created_at: now,
      },
      {
        id: '1868588c-fcb0-416b-86fc-416f517b3914', project_id: CONTRACTOR, flow_phase: 'response', version: 1,
        response_letter_md: recorded('correction-01/output-02/response_letter.md'),
        professional_scope_md: recorded('correction-01/output-02/professional_scope.md'),
        corrections_report_md: recorded('correction-01/output-02/corrections_report.md'),
        created_at: now,
      },
    ],
    contractor_answers: [],
  };
}

function tokenFor(user: typeof DEMO_USER): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp: expires })}.local`;
}

function userFromToken(token: string | undefined): boolean {
  if (!token) return false;
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub === DEMO_USER.id;
  } catch {
    return false;
  }
}

function publicUser() {
  return {
    id: DEMO_USER.id, aud: 'authenticated', role: 'authenticated', email: DEMO_USER.email,
    app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00.000Z',
  };
}

function matcher(expression: string): ((value: unknown) => boolean) | null {
  const dot = expression.indexOf('.');
  const op = expression.slice(0, dot);
  const operand = expression.slice(dot + 1);
  switch (op) {
    case 'eq': return (value) => String(value) === operand;
    case 'neq': return (value) => String(value) !== operand;
    case 'is': return (value) => (operand === 'null' ? value === null || value === undefined : String(value) === operand);
    case 'in': {
      const options = operand.replace(/^\(|\)$/g, '').split(',').map((item) => item.replace(/^"|"$/g, ''));
      return (value) => options.includes(String(value));
    }
    case 'like': {
      const pattern = operand.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*');
      const regex = new RegExp(`^${pattern}$`, 's');
      return (value) => regex.test(String(value));
    }
    default: return null;
  }
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict']);

export function createCompatApp(dataDir: string = DEFAULT_DATA_DIR) {
  const dbPath = path.join(dataDir, 'db.json');
  const storageDir = path.join(dataDir, 'storage');
  fs.mkdirSync(storageDir, { recursive: true });
  const db: Db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf-8')) : seed();

  let saveTimer: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fs.writeFileSync(dbPath, JSON.stringify(db)), 100);
  };
  const flush = () => {
    clearTimeout(saveTimer);
    fs.writeFileSync(dbPath, JSON.stringify(db));
  };
  let nextMessageId = Math.max(0, ...db.messages.map((row) => Number(row.id))) + 1;

  const app = express();

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', String(req.headers['access-control-request-headers'] ?? '*'));
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  });

  // --- Auth ---

  const auth = express.Router();
  auth.use(express.json());
  auth.post('/token', (req, res) => {
    const passwordOk = req.query.grant_type === 'password' && req.body?.email === DEMO_USER.email && req.body?.password === DEMO_USER.password;
    if (!passwordOk && !(req.query.grant_type === 'refresh_token' && req.body?.refresh_token === 'local-refresh')) {
      return res.status(400).json({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    }
    const expiresIn = 7 * 24 * 3600;
    return res.json({
      access_token: tokenFor(DEMO_USER), token_type: 'bearer', expires_in: expiresIn,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn, refresh_token: 'local-refresh', user: publicUser(),
    });
  });
  auth.get('/user', (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    return userFromToken(token) ? res.json(publicUser()) : res.status(401).json({ code: 401, msg: 'Invalid token' });
  });
  auth.post('/logout', (_req, res) => res.status(204).end());
  app.use('/auth/v1', auth);

  // --- Storage ---

  const objectFile = (bucket: string, objectPath: string, root: string): string | null => {
    const resolved = path.resolve(root, bucket, objectPath);
    return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
  };
  const objectPathOf = (req: Request) => {
    const parts = (req.params as unknown as { path: string[] }).path;
    return Array.isArray(parts) ? parts.join('/') : String(parts);
  };

  app.get('/storage/v1/object/:bucket/*path', (req, res) => {
    const objectPath = objectPathOf(req);
    const uploaded = objectFile(req.params.bucket, objectPath, storageDir);
    const demoAsset = req.params.bucket === 'crossbeam-demo-assets' ? path.resolve(ASSETS_DIR, objectPath) : null;
    const insideAssets = demoAsset?.startsWith(path.resolve(ASSETS_DIR) + path.sep);
    const found = uploaded && fs.existsSync(uploaded) ? uploaded : insideAssets && demoAsset && fs.existsSync(demoAsset) ? demoAsset : null;
    if (!found) return res.status(404).json({ statusCode: '404', error: 'not_found', message: 'Object not found' });
    // The data folder is a dot-directory, which sendFile refuses by default. Paths are checked above.
    return res.sendFile(found, { dotfiles: 'allow' });
  });

  const upload = (req: Request, res: Response) => {
    const target = objectFile(req.params.bucket as string, objectPathOf(req), storageDir);
    if (!target) return res.status(400).json({ statusCode: '400', error: 'invalid_path', message: 'Invalid path' });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, req.body as Buffer);
    return res.json({ Key: `${req.params.bucket}/${objectPathOf(req)}`, Id: randomUUID() });
  };
  const rawBody = express.raw({ type: () => true, limit: '500mb' });
  app.post('/storage/v1/object/:bucket/*path', rawBody, upload);
  app.put('/storage/v1/object/:bucket/*path', rawBody, upload);

  // --- Tables (the subset of PostgREST that supabase-js sends for this app) ---

  const rest = express.Router();
  rest.use(express.json({ limit: '100mb' }));

  type Filtered = { rows: Row[]; error?: string };
  const filtered = (req: Request, table: string): Filtered => {
    const tests: Array<[string, (value: unknown) => boolean]> = [];
    for (const [key, value] of Object.entries(req.query)) {
      if (RESERVED.has(key)) continue;
      const test = matcher(String(value));
      if (!test) return { rows: [], error: `Unsupported filter ${key}=${String(value)}` };
      tests.push([key, test]);
    }
    return { rows: db[table].filter((row) => tests.every(([key, test]) => test(row[key]))) };
  };

  const project = (rows: Row[], select: unknown): Row[] => {
    if (!select || select === '*') return rows;
    const columns = String(select).split(',').map((column) => column.trim());
    return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
  };

  const send = (req: Request, res: Response, status: number, rows: Row[]) => {
    const body = project(rows, req.query.select);
    if (!String(req.headers.accept ?? '').includes('vnd.pgrst.object')) return res.status(status).json(body);
    if (body.length !== 1) {
      return res.status(406).json({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${body.length} rows`, hint: null });
    }
    return res.status(status).json(body[0]);
  };
  const wantsRows = (req: Request) => String(req.headers.prefer ?? '').includes('return=representation');
  const violation = (table: string, row: Row): string | null => {
    for (const [column, allowed] of Object.entries(CHECKS[table] ?? {})) {
      if (row[column] !== undefined && !allowed.includes(String(row[column]))) return `${table}_${column}_check: ${String(row[column])}`;
    }
    return null;
  };

  rest.use('/:table', (req, res, next) => {
    if (!(TABLES as readonly string[]).includes(req.params.table)) {
      return res.status(404).json({ code: 'PGRST205', message: `Could not find the table ${req.params.table}` });
    }
    return next();
  });

  rest.get('/:table', (req, res) => {
    const { rows, error } = filtered(req, req.params.table);
    if (error) return res.status(400).json({ code: 'PGRST100', message: error });
    let result = [...rows];
    if (req.query.order) {
      const terms = String(req.query.order).split(',').map((term) => term.split('.'));
      result.sort((a, b) => {
        for (const [column, direction] of terms) {
          const [x, y] = [a[column], b[column]] as [string | number, string | number];
          if (x === y) continue;
          const order = x > y ? 1 : -1;
          return direction === 'desc' ? -order : order;
        }
        return 0;
      });
    }
    if (req.query.limit) result = result.slice(0, Number(req.query.limit));
    return send(req, res, 200, result);
  });

  rest.post('/:table', (req, res) => {
    const table = req.params.table;
    const now = new Date().toISOString();
    const incoming = (Array.isArray(req.body) ? req.body : [req.body]) as Row[];
    for (const row of incoming) {
      const problem = violation(table, row);
      if (problem) return res.status(400).json({ code: '23514', message: `violates check constraint ${problem}` });
    }
    const rows = incoming.map((row) => ({
      id: table === 'messages' ? nextMessageId++ : randomUUID(),
      created_at: now,
      ...(table === 'contractor_answers' || table === 'projects' ? { updated_at: now } : {}),
      ...row,
    }));
    db[table].push(...rows);
    save();
    return wantsRows(req) ? send(req, res, 201, rows) : res.status(201).end();
  });

  rest.patch('/:table', (req, res) => {
    const table = req.params.table;
    const problem = violation(table, req.body as Row);
    if (problem) return res.status(400).json({ code: '23514', message: `violates check constraint ${problem}` });
    const { rows, error } = filtered(req, table);
    if (error) return res.status(400).json({ code: 'PGRST100', message: error });
    for (const row of rows) Object.assign(row, req.body);
    save();
    return wantsRows(req) ? send(req, res, 200, rows) : res.status(204).end();
  });

  rest.delete('/:table', (req, res) => {
    const table = req.params.table;
    const { rows, error } = filtered(req, table);
    if (error) return res.status(400).json({ code: 'PGRST100', message: error });
    if (Object.keys(req.query).filter((key) => !RESERVED.has(key)).length === 0) {
      return res.status(400).json({ code: '21000', message: 'DELETE requires a WHERE clause' });
    }
    db[table] = db[table].filter((row) => !rows.includes(row));
    save();
    return wantsRows(req) ? send(req, res, 200, rows) : res.status(204).end();
  });

  app.use('/rest/v1', rest);
  return { app, flush };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.NODE_ENV === 'production') {
    console.error('The local Supabase stand-in has no access control and will not run in production.');
    process.exit(1);
  }
  const { app, flush } = createCompatApp();
  const server = app.listen(DEFAULT_PORT, '127.0.0.1', () => {
    console.log(`Local Supabase stand-in on http://127.0.0.1:${DEFAULT_PORT}. Sign in as ${DEMO_USER.email} / ${DEMO_USER.password}`);
  });
  // extract.ts blocks its event loop for up to two minutes while rendering pages. A short
  // keep-alive would close its idle socket meanwhile, and its next request would reset.
  server.keepAliveTimeout = 10 * 60 * 1000;
  server.headersTimeout = server.keepAliveTimeout + 1000;
  process.on('SIGINT', () => { flush(); process.exit(0); });
  process.on('SIGTERM', () => { flush(); process.exit(0); });
}
