// How many tokens each login has spent, by the hour, for the Usage panel's
// charts (docs/protocol/settings.md, "Usage history"). Read from the CLIs' own
// transcripts, so turns run outside Threadbear count too: Claude's
// <configDir>/projects/**/*.jsonl, Codex's <configDir>/sessions and
// archived_sessions, and OpenCode's $XDG_DATA_HOME/opencode/opencode.db
// (read-only, assistant steps' tokens, model and estimated USD cost only).
// Only what's new since the last look is read, and the hourly totals and
// where it got to in each file are kept in <data dir>/token-tally.json, so a
// restart doesn't read everything again. The Claude and Codex parsing follows
// Token Stats' (mikerosoft-tools/token-stats, UsageParsers.swift) so the two
// agree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Account, Provider } from './protocol.ts';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import crypto from 'node:crypto';
import { readJsonSync } from './fsutil.ts';

export const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// How far back a file nobody has read yet is worth reading.
export const FIRST_READ_DAYS = 14;
// Hours older than this are dropped.
export const KEEP_DAYS = 15;
export const PASS_INTERVAL_MS = 60_000;
const CHUNK = 4 * 1024 * 1024;
const OPENCODE_BATCH = 200;
const OPENCODE_PENDING_TTL_MS = 2 * HOUR_MS;
const OPENCODE_PENDING_MAX = 64;
// While a long pass (the first) is under way, what it has done so far is
// saved this often, so a restart part way through doesn't start again.
const SAVE_EVERY_MS = 10_000;
// Claude Code writes a streamed message several times as it grows, a few
// lines apart: the last few message ids per file are enough to count each
// once.
const KEEP_IDS = 24;
// A file quiet for this long has finished streaming its messages: its ids
// aren't kept.
const IDS_QUIET_MS = HOUR_MS;

// [input, output, cacheRead, cacheWrite]
export type Counts = [number, number, number, number];
// [startMs, input, output, cacheRead, cacheWrite]
export type HourRow = [number, number, number, number, number];
// [startMs, provider, model, costUsd, totalTokens]
export type SpendRow = [number, string, string, number, number];

type SpendBucket = { hour: number; provider: string; model: string; cost: number; tokens: number };

type PendingOpencodeMsg = {
  id: string;
  hour: number;
  provider: string;
  model: string;
  cost: number;
  counts: Counts;
  created: number;
};

type OpencodeCursor = {
  account: string;
  table: 'session_message' | 'message';
  ino: number;
  dbMtimeMs: number;
  dbSize: number;
  walMtimeMs: number;
  walSize: number;
  lastRowid: number;
  lastId: string;
  pending: PendingOpencodeMsg[];
};

type Cursor = {
  account: string;
  size: number;
  mtimeMs: number;
  offset: number; // the end of the last whole line read
  // Claude: the newest message ids, with what each has counted so far and
  // the hour it went into.
  ids?: [string, number, ...Counts][];
  // Codex: the last total_token_usage seen [input, cached, cacheWrite, output].
  prev?: Counts;
};

type TallyFile = {
  version: 1;
  ready: boolean;
  // accountId -> [startMs, ...Counts][]
  hours: Record<string, HourRow[]>;
  // accountId -> [startMs, provider, model, costUsd, totalTokens][]
  spend?: Record<string, SpendRow[]>;
  files: Record<string, Cursor>;
  opencode?: OpencodeCursor;
};

// Searching a whole transcript for a marker is slow (JSON is full of the
// quotes it starts and ends with; 184 MB took 2.5 s), so only the ends of
// each line are looked at. Claude Code writes `"type":"assistant"` after the
// message, near the end of the line; Codex writes the payload's type near
// the start. Both ends are checked, in case the order changes.
const CLAUDE_MARKER = Buffer.from('"type":"assistant"');
const CODEX_MARKER = Buffer.from('"token_count"');
const LINE_END_BYTES = 1024;

export type TallyAccount = Pick<Account, 'id' | 'provider' | 'configDir'>;

export class TokenTally {
  private file: string;
  private opencodeDb?: string;
  private clock: Clock;
  private log: Logger;
  private accounts: () => TallyAccount[];
  private hours = new Map<string, Map<number, Counts>>();
  private spend = new Map<string, Map<string, SpendBucket>>();
  private cursors = new Map<string, Cursor>();
  private opencodeCursor?: OpencodeCursor;
  private ready = false;
  private timer?: TimerHandle;
  private running = false;
  // Set by stop(): a pass under way gives up at the next file.
  private stopped = false;
  private writes = true;
  private passing?: Promise<void>;
  private savedAt = 0;
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(o: { dataDir: string; clock: Clock; log: Logger; accounts: () => TallyAccount[]; opencodeDb?: string }) {
    this.file = path.join(o.dataDir, 'token-tally.json');
    this.opencodeDb = o.opencodeDb;
    this.clock = o.clock;
    this.log = o.log;
    this.accounts = o.accounts;
    const saved = readJsonSync<TallyFile>(this.file);
    if (saved?.version === 1) {
      this.ready = saved.ready === true;
      for (const [id, rows] of Object.entries(saved.hours ?? {})) {
        if (!Array.isArray(rows)) continue;
        const m = new Map<number, Counts>();
        for (const r of rows) if (Array.isArray(r) && r.length === 5) m.set(r[0], [r[1], r[2], r[3], r[4]]);
        this.hours.set(id, m);
      }
      for (const [id, rows] of Object.entries(saved.spend ?? {})) {
        if (!Array.isArray(rows)) continue;
        const m = new Map<string, SpendBucket>();
        for (const r of rows) {
          if (Array.isArray(r) && r.length === 5 && typeof r[0] === 'number' && typeof r[1] === 'string' && typeof r[2] === 'string' && typeof r[3] === 'number' && typeof r[4] === 'number') {
            m.set(spendKey(r[0], r[1], r[2]), { hour: r[0], provider: r[1], model: r[2], cost: r[3], tokens: r[4] });
          }
        }
        if (m.size) this.spend.set(id, m);
      }
      for (const [key, c] of Object.entries(saved.files ?? {})) {
        if (c && typeof c.offset === 'number' && typeof c.account === 'string') this.cursors.set(key, c);
      }
      if (saved.opencode && typeof saved.opencode.account === 'string' && typeof saved.opencode.lastRowid === 'number' && Array.isArray(saved.opencode.pending)) {
        this.opencodeCursor = saved.opencode;
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.schedule(0);
  }

  // Stops reading; with `writes` false (a draining runner), never writes
  // token-tally.json again either: it's the new runner's.
  stop(): void {
    this.running = false;
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
  }

  stopWriting(): void {
    this.writes = false;
    this.stop();
  }

  isReady(): boolean {
    return this.ready;
  }

  // The hours since `since`, per account, oldest first.
  rows(since: number): { accountId: string; hours: HourRow[] }[] {
    const out: { accountId: string; hours: HourRow[] }[] = [];
    for (const [accountId, m] of this.hours) {
      const hours = [...m.entries()]
        .filter(([start]) => start + HOUR_MS > since)
        .sort((a, b) => a[0] - b[0])
        .map(([start, c]) => [start, ...c] as HourRow);
      out.push({ accountId, hours });
    }
    return out;
  }

  // Hourly API spend by upstream provider and model since `since`, oldest first.
  spendRows(since: number): { accountId: string; hours: SpendRow[] }[] {
    const out: { accountId: string; hours: SpendRow[] }[] = [];
    for (const [accountId, m] of this.spend) {
      const hours = [...m.values()]
        .filter((b) => b.hour + HOUR_MS > since && (b.cost > 0 || b.tokens > 0))
        .sort((a, b) => a.hour - b.hour || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
        .map((b) => [b.hour, b.provider, b.model, round6(b.cost), b.tokens] as SpendRow);
      if (hours.length) out.push({ accountId, hours });
    }
    return out;
  }

  // One look now, for tests and `tb`; resolves when it's done.
  async pass(): Promise<void> {
    if (this.passing) return this.passing;
    this.passing = this.doPass().finally(() => (this.passing = undefined));
    return this.passing;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer?.cancel();
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.pass()
        .catch((err) => this.log.warn('token tally: pass failed', { error: String(err) }))
        .finally(() => this.schedule(PASS_INTERVAL_MS));
    }, ms);
  }

  private async doPass(): Promise<void> {
    const now = this.clock.now();
    const firstCutoff = now - FIRST_READ_DAYS * DAY_MS;
    const keepFrom = now - KEEP_DAYS * DAY_MS;
    const seenRoots = new Set<string>();
    const seenFiles = new Set<string>();
    for (const account of this.accounts()) {
      if (account.provider === 'opencode') {
        const dbPath = this.opencodeDb ?? defaultOpencodeDb();
        let realDb: string;
        try {
          realDb = await fs.promises.realpath(dbPath);
        } catch {
          continue; // not there
        }
        if (seenRoots.has(realDb)) continue;
        seenRoots.add(realDb);
        await this.readOpencode(account, realDb, now, keepFrom);
        if (this.stopped) return;
        continue;
      }
      // The other ACP agents keep no transcripts in a form this can read.
      if (account.provider !== 'claude' && account.provider !== 'codex') continue;
      const roots =
        account.provider === 'codex'
          ? [path.join(account.configDir, 'sessions'), path.join(account.configDir, 'archived_sessions')]
          : [path.join(account.configDir, 'projects')];
      for (const root of roots) {
        let real: string;
        try {
          real = await fs.promises.realpath(root);
        } catch {
          continue; // not there
        }
        // Two logins pointing at the same folder count it once.
        if (seenRoots.has(real)) continue;
        seenRoots.add(real);
        for await (const file of walkJsonl(real)) {
          if (this.stopped) return;
          const key = fileKey(account.provider, file.path);
          if (seenFiles.has(key)) continue;
          seenFiles.add(key);
          await this.readFile(account, key, file, firstCutoff, keepFrom);
          if (this.dirty && this.clock.now() - this.savedAt >= SAVE_EVERY_MS) this.save();
          await new Promise((r) => setImmediate(r));
        }
      }
    }
    // Forget files that have been quiet longer than anything kept.
    for (const [key, c] of this.cursors) {
      if (c.mtimeMs < keepFrom) {
        this.cursors.delete(key);
        this.dirty = true;
      }
    }
    this.prune(keepFrom);
    if (!this.ready) {
      this.ready = true;
      this.dirty = true;
    }
    if (this.dirty) this.save();
  }

  private async readFile(account: TallyAccount, key: string, file: { path: string; size: number; mtimeMs: number }, firstCutoff: number, keepFrom: number): Promise<void> {
    let c = this.cursors.get(key);
    if (c && c.size === file.size && c.mtimeMs === file.mtimeMs) return;
    if (!c && file.mtimeMs < firstCutoff) return;
    // Replaced or cut short: start it again.
    if (!c || file.size < c.offset || c.account !== account.id) {
      c = { account: account.id, size: 0, mtimeMs: 0, offset: 0 };
    }
    const cursor = c;
    const add = (at: number, counts: Counts): number | undefined => {
      if (!Number.isFinite(at) || at < keepFrom) return undefined;
      const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
      this.addTo(account.id, hour, counts);
      return hour;
    };
    const onLine =
      account.provider === 'codex'
        ? (line: Buffer) => codexLine(line, cursor, add)
        : (line: Buffer) => claudeLine(line, cursor, add, (hour, counts) => this.addTo(account.id, hour, counts));
    const marker = account.provider === 'codex' ? CODEX_MARKER : CLAUDE_MARKER;
    try {
      cursor.offset = await readLines(file.path, cursor.offset, file.size, marker, onLine);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.log.warn('token tally: could not read a transcript', { file: file.path, error: String(err) });
      return;
    }
    cursor.size = file.size;
    cursor.mtimeMs = file.mtimeMs;
    this.cursors.set(key, cursor);
    this.dirty = true;
  }

  private async readOpencode(account: TallyAccount, dbPath: string, now: number, keepFrom: number): Promise<void> {
    let dbStat: fs.Stats;
    try {
      dbStat = fs.statSync(dbPath);
      if (!dbStat.isFile()) return;
    } catch {
      return;
    }
    let walMtimeMs = 0;
    let walSize = 0;
    try {
      const ws = fs.statSync(`${dbPath}-wal`);
      walMtimeMs = ws.mtimeMs;
      walSize = ws.size;
    } catch {
      // No WAL file right now.
    }
    const have = this.opencodeCursor;
    if (
      have &&
      have.account === account.id &&
      have.ino === dbStat.ino &&
      have.dbMtimeMs === dbStat.mtimeMs &&
      have.dbSize === dbStat.size &&
      have.walMtimeMs === walMtimeMs &&
      have.walSize === walSize &&
      have.pending.length === 0
    ) {
      return;
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
    } catch (err) {
      this.log.warn('token tally: could not open OpenCode db', { file: dbPath, error: String(err) });
      return;
    }
    try {
      const table = opencodeTable(db);
      if (!table) return;
      const maxRow = db.prepare(`SELECT max(rowid) AS maxRowid FROM ${table}`).get() as { maxRowid?: unknown } | undefined;
      const maxRowid = typeof maxRow?.maxRowid === 'number' ? maxRow.maxRowid : 0;
      let anchorOk = false;
      if (have && have.account === account.id && have.ino === dbStat.ino && have.table === table && have.lastRowid <= maxRowid) {
        if (!have.lastId) {
          anchorOk = true;
        } else {
          const anchor = db.prepare(`SELECT id FROM ${table} WHERE rowid = ?`).get(have.lastRowid) as { id?: unknown } | undefined;
          anchorOk = anchor?.id === have.lastId;
        }
      }
      let cursor: OpencodeCursor;
      if (!anchorOk) {
        this.hours.delete(account.id);
        this.spend.delete(account.id);
        const minRow = db.prepare(`SELECT min(rowid) AS minRowid FROM ${table} WHERE time_created >= ?`).get(keepFrom) as { minRowid?: unknown } | undefined;
        const startRowid = typeof minRow?.minRowid === 'number' ? minRow.minRowid - 1 : maxRowid;
        cursor = {
          account: account.id,
          table,
          ino: dbStat.ino,
          dbMtimeMs: dbStat.mtimeMs,
          dbSize: dbStat.size,
          walMtimeMs,
          walSize,
          lastRowid: Math.max(0, startRowid),
          lastId: '',
          pending: [],
        };
      } else {
        cursor = { ...have!, pending: [...have!.pending] };
      }

      const nextPending: PendingOpencodeMsg[] = [];
      if (cursor.pending.length > 0) {
        const byId = db.prepare(`SELECT id, time_created, data FROM ${table} WHERE id = ?`);
        for (const prev of cursor.pending) {
          if (this.stopped) return;
          const row = byId.get(prev.id) as { id?: unknown; time_created?: unknown; data?: unknown } | undefined;
          if (!row || typeof row.data !== 'string') continue;
          const parsed = parseOpencodeMessage(table, row.data);
          if (!parsed) continue;
          const provider = parsed.provider || prev.provider;
          const model = parsed.model || prev.model;
          const dCost = Math.max(0, parsed.cost - prev.cost);
          const dCounts: Counts = [
            Math.max(0, parsed.counts[0] - prev.counts[0]),
            Math.max(0, parsed.counts[1] - prev.counts[1]),
            Math.max(0, parsed.counts[2] - prev.counts[2]),
            Math.max(0, parsed.counts[3] - prev.counts[3]),
          ];
          const dTokens = sumCounts(dCounts);
          if (prev.hour + HOUR_MS > keepFrom) {
            if (dTokens > 0) this.addTo(account.id, prev.hour, dCounts);
            if (dCost > 0 || dTokens > 0) this.addSpend(account.id, prev.hour, provider, model, dCost, dTokens);
          }
          const updated: PendingOpencodeMsg = {
            id: prev.id,
            hour: prev.hour,
            provider,
            model,
            cost: Math.max(prev.cost, parsed.cost),
            counts: [
              Math.max(prev.counts[0], parsed.counts[0]),
              Math.max(prev.counts[1], parsed.counts[1]),
              Math.max(prev.counts[2], parsed.counts[2]),
              Math.max(prev.counts[3], parsed.counts[3]),
            ],
            created: prev.created,
          };
          if (!parsed.done && now - prev.created < OPENCODE_PENDING_TTL_MS) nextPending.push(updated);
        }
      }

      const where = table === 'session_message' ? `type = 'assistant' AND ` : '';
      const batchStmt = db.prepare(`SELECT rowid, id, time_created, data FROM ${table} WHERE ${where}rowid > ? ORDER BY rowid ASC LIMIT ${OPENCODE_BATCH}`);
      while (!this.stopped) {
        const rows = batchStmt.all(cursor.lastRowid) as { rowid?: unknown; id?: unknown; time_created?: unknown; data?: unknown }[];
        if (rows.length === 0) break;
        for (const row of rows) {
          if (typeof row.rowid !== 'number' || typeof row.id !== 'string' || typeof row.time_created !== 'number' || typeof row.data !== 'string') continue;
          cursor.lastRowid = row.rowid;
          cursor.lastId = row.id;
          const parsed = parseOpencodeMessage(table, row.data);
          if (!parsed) continue;
          const hour = Math.floor(row.time_created / HOUR_MS) * HOUR_MS;
          const totalTokens = sumCounts(parsed.counts);
          if (hour + HOUR_MS > keepFrom) {
            if (totalTokens > 0) this.addTo(account.id, hour, parsed.counts);
            if (parsed.cost > 0 || totalTokens > 0) this.addSpend(account.id, hour, parsed.provider, parsed.model, parsed.cost, totalTokens);
            if (!parsed.done && now - row.time_created < OPENCODE_PENDING_TTL_MS) {
              nextPending.push({
                id: row.id,
                hour,
                provider: parsed.provider,
                model: parsed.model,
                cost: parsed.cost,
                counts: parsed.counts,
                created: row.time_created,
              });
            }
          }
        }
        if (rows.length < OPENCODE_BATCH) break;
        await new Promise((r) => setImmediate(r));
      }
      if (this.stopped) return;
      if (nextPending.length > OPENCODE_PENDING_MAX) nextPending.splice(0, nextPending.length - OPENCODE_PENDING_MAX);
      cursor.pending = nextPending;
      cursor.dbMtimeMs = dbStat.mtimeMs;
      cursor.dbSize = dbStat.size;
      cursor.walMtimeMs = walMtimeMs;
      cursor.walSize = walSize;
      this.opencodeCursor = cursor;
      this.dirty = true;
    } catch (err) {
      this.log.warn('token tally: could not read OpenCode db', { file: dbPath, error: String(err) });
    } finally {
      db.close();
    }
  }

  private addTo(accountId: string, hour: number, counts: Counts): void {
    let m = this.hours.get(accountId);
    if (!m) this.hours.set(accountId, (m = new Map()));
    const have = m.get(hour) ?? [0, 0, 0, 0];
    m.set(hour, [have[0] + counts[0], have[1] + counts[1], have[2] + counts[2], have[3] + counts[3]]);
  }

  private addSpend(accountId: string, hour: number, provider: string, model: string, cost: number, tokens: number): void {
    let m = this.spend.get(accountId);
    if (!m) this.spend.set(accountId, (m = new Map()));
    const key = spendKey(hour, provider, model);
    const have = m.get(key);
    if (have) {
      have.cost += cost;
      have.tokens += tokens;
    } else {
      m.set(key, { hour, provider, model, cost, tokens });
    }
  }

  private prune(keepFrom: number): void {
    for (const [id, m] of this.hours) {
      for (const hour of m.keys()) {
        if (hour + HOUR_MS <= keepFrom) {
          m.delete(hour);
          this.dirty = true;
        }
      }
      if (m.size === 0) this.hours.delete(id);
    }
    for (const [id, m] of this.spend) {
      for (const [key, b] of m) {
        if (b.hour + HOUR_MS <= keepFrom) {
          m.delete(key);
          this.dirty = true;
        }
      }
      if (m.size === 0) this.spend.delete(id);
    }
  }

  // Resolves once what's been read so far is on disk (tests wait on it).
  flushed(): Promise<void> {
    return this.saving;
  }

  private save(): void {
    this.savedAt = this.clock.now();
    this.dirty = false;
    if (!this.writes) return;
    // Against the wall clock, as mtimes are.
    const wall = Date.now();
    for (const c of this.cursors.values()) if (c.ids && wall - c.mtimeMs > IDS_QUIET_MS) delete c.ids;
    const spendObj = Object.fromEntries(
      [...this.spend]
        .map(([id, m]) => [
          id,
          [...m.values()]
            .sort((a, b) => a.hour - b.hour || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
            .map((b) => [b.hour, b.provider, b.model, round6(b.cost), b.tokens] as SpendRow),
        ])
        .filter(([, rows]) => (rows as SpendRow[]).length > 0),
    );
    const doc: TallyFile = {
      version: 1,
      ready: this.ready,
      hours: Object.fromEntries([...this.hours].map(([id, m]) => [id, [...m].sort((a, b) => a[0] - b[0]).map(([h, c]) => [h, ...c] as HourRow)])),
      ...(Object.keys(spendObj).length > 0 ? { spend: spendObj } : {}),
      files: Object.fromEntries(this.cursors),
      ...(this.opencodeCursor ? { opencode: this.opencodeCursor } : {}),
    };
    const data = JSON.stringify(doc) + '\n';
    // Written off the event loop and without an fsync (about 2 MB, once a
    // minute; an fsync took a second under load). It's a cache: if a crash
    // loses it, the transcripts are read again. The rename still means
    // it's never half written.
    // Named like atomicWriteFileSync's, so removeTempFiles clears one a crash left.
    const tmp = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    this.saving = this.saving
      .then(async () => {
        if (!this.writes) return;
        await fs.promises.writeFile(tmp, data);
        await fs.promises.rename(tmp, this.file);
      })
      .catch((err) => {
        this.log.warn('token tally: could not write token-tally.json', { error: String(err) });
        void fs.promises.rm(tmp, { force: true });
      });
  }
}

// Codex moves a finished session from sessions/ to archived_sessions/, so
// its file is known by name (each has the session's id in it), not path.
function fileKey(provider: Provider, file: string): string {
  return provider === 'codex' ? `codex:${path.basename(file)}` : file;
}

// Every .jsonl file under `dir`, following symlinked folders once each.
// Sync calls, a folder at a time: some 3,400 files are looked at every
// minute, and an await per stat made that take seconds.
async function* walkJsonl(dir: string, seen = new Set<string>()): AsyncGenerator<{ path: string; size: number; mtimeMs: number }> {
  let real: string;
  let entries: fs.Dirent[];
  try {
    real = fs.realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    entries = fs.readdirSync(real, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs: string[] = [];
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  for (const [i, e] of entries.entries()) {
    // A folder of hundreds of sessions shouldn't hold everything else up.
    if (i > 0 && i % 64 === 0) await new Promise((r) => setImmediate(r));
    const p = path.join(real, e.name);
    const jsonl = e.name.endsWith('.jsonl');
    if (!e.isDirectory() && !e.isSymbolicLink() && !(e.isFile() && jsonl)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue; // gone since the listing, or a broken link
    }
    if (st.isDirectory()) dirs.push(p);
    else if (st.isFile() && jsonl) files.push({ path: p, size: st.size, mtimeMs: st.mtimeMs });
  }
  yield* files;
  for (const d of dirs) {
    await new Promise((r) => setImmediate(r));
    yield* walkJsonl(d, seen);
  }
}

// Reads `file` from `offset` to `size`, calling `onLine` for each whole line
// with `marker` in it. Returns the offset after the last whole line, so a
// line still being written is read next time.
export async function readLines(file: string, offset: number, size: number, marker: Buffer, onLine: (line: Buffer) => void): Promise<number> {
  if (offset >= size) return offset;
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = offset; // where the next read starts
    let start = offset; // the file offset of carry's first byte
    let carry: Buffer | undefined;
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const lastNl = data.lastIndexOf(10);
      if (lastNl < 0) {
        carry = Buffer.from(data);
        continue;
      }
      scan(data, lastNl + 1, marker, onLine);
      start += lastNl + 1;
      carry = lastNl + 1 < data.length ? Buffer.from(data.subarray(lastNl + 1)) : undefined;
      await new Promise((r) => setImmediate(r));
    }
    return start;
  } finally {
    await fh.close();
  }
}

// Hands over each line with the marker near either end, so lines without
// it (most of a transcript: tool results, user turns) are never parsed.
function scan(data: Buffer, end: number, marker: Buffer, onLine: (line: Buffer) => void): void {
  let start = 0;
  while (start < end) {
    let lineEnd = data.indexOf(10, start);
    if (lineEnd < 0 || lineEnd > end) lineEnd = end;
    const len = lineEnd - start;
    if (len >= marker.length) {
      const head = data.subarray(start, start + Math.min(len, LINE_END_BYTES));
      const tail = len > LINE_END_BYTES ? data.subarray(lineEnd - LINE_END_BYTES, lineEnd) : undefined;
      if (head.indexOf(marker) >= 0 || (tail && tail.indexOf(marker) >= 0)) onLine(data.subarray(start, lineEnd));
    }
    start = lineEnd + 1;
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parse(line: Buffer): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(line.toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// An assistant line: counts its usage, or only its growth if the same
// message was counted from an earlier line.
function claudeLine(line: Buffer, c: Cursor, add: (at: number, counts: Counts) => number | undefined, addAt: (hour: number, counts: Counts) => void): void {
  const entry = parse(line);
  if (!entry || entry.type !== 'assistant') return;
  const message = entry.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof entry.timestamp !== 'string') return;
  const counts: Counts = [num(usage.input_tokens), num(usage.output_tokens), num(usage.cache_read_input_tokens), num(usage.cache_creation_input_tokens)];
  const id = typeof message?.id === 'string' ? message.id : undefined;
  const ids = (c.ids ??= []);
  const i = id ? ids.findIndex((x) => x[0] === id) : -1;
  if (i >= 0) {
    const [, hour, ...had] = ids[i];
    const growth: Counts = [Math.max(0, counts[0] - had[0]), Math.max(0, counts[1] - had[1]), Math.max(0, counts[2] - had[2]), Math.max(0, counts[3] - had[3])];
    if (growth.some((g) => g > 0)) {
      addAt(hour, growth);
      ids[i] = [id!, hour, Math.max(counts[0], had[0]), Math.max(counts[1], had[1]), Math.max(counts[2], had[2]), Math.max(counts[3], had[3])];
    }
    return;
  }
  const hour = add(Date.parse(entry.timestamp), counts);
  if (hour === undefined || !id) return;
  ids.push([id, hour, ...counts]);
  if (ids.length > KEEP_IDS) ids.splice(0, ids.length - KEEP_IDS);
}

// A token_count event: its total less the last one. Codex's input_tokens
// includes the cached input, which is counted as cacheRead instead.
function codexLine(line: Buffer, c: Cursor, add: (at: number, counts: Counts) => number | undefined): void {
  const root = parse(line);
  if (!root || root.type !== 'event_msg') return;
  const payload = root.payload as Record<string, unknown> | undefined;
  if (payload?.type !== 'token_count') return;
  const total = (payload.info as Record<string, unknown> | null | undefined)?.total_token_usage as Record<string, unknown> | undefined;
  if (!total || typeof root.timestamp !== 'string') return;
  const now: Counts = [num(total.input_tokens), num(total.cached_input_tokens), num(total.cache_write_input_tokens), num(total.output_tokens)];
  const prev = c.prev ?? [0, 0, 0, 0];
  const d = now.map((v, i) => Math.max(0, v - prev[i])) as Counts;
  c.prev = now;
  if (d.every((v) => v === 0)) return;
  add(Date.parse(root.timestamp), [Math.max(0, d[0] - d[1]), d[3], d[1], d[2]]);
}

function defaultOpencodeDb(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'opencode', 'opencode.db');
}

function opencodeTable(db: DatabaseSync): 'session_message' | 'message' | undefined {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_message', 'message')").all() as { name?: unknown }[];
  const names = new Set(rows.map((r) => r.name));
  if (names.has('session_message')) return 'session_message';
  if (names.has('message')) return 'message';
  return undefined;
}

type ParsedOpencode = { provider: string; model: string; cost: number; counts: Counts; done: boolean };

function parseOpencodeMessage(table: 'session_message' | 'message', raw: string): ParsedOpencode | undefined {
  let d: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    d = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (table === 'message' && d.role !== 'assistant') return undefined;
  const modelObj = d.model && typeof d.model === 'object' ? (d.model as Record<string, unknown>) : undefined;
  const provider = typeof (table === 'session_message' ? modelObj?.providerID : d.providerID) === 'string' ? String(table === 'session_message' ? modelObj?.providerID : d.providerID) : '';
  const model = typeof (table === 'session_message' ? modelObj?.id : d.modelID) === 'string' ? String(table === 'session_message' ? modelObj?.id : d.modelID) : '';
  const cost = Math.max(0, num(d.cost));
  const t = d.tokens && typeof d.tokens === 'object' ? (d.tokens as Record<string, unknown>) : undefined;
  const cache = t?.cache && typeof t.cache === 'object' ? (t.cache as Record<string, unknown>) : undefined;
  const counts: Counts = [
    Math.max(0, num(t?.input)),
    Math.max(0, num(t?.output)) + Math.max(0, num(t?.reasoning)),
    Math.max(0, num(cache?.read)),
    Math.max(0, num(cache?.write)),
  ];
  const time = d.time && typeof d.time === 'object' ? (d.time as Record<string, unknown>) : undefined;
  const done = Boolean(d.finish || time?.completed);
  return { provider, model, cost, counts, done };
}

function spendKey(hour: number, provider: string, model: string): string {
  return `${hour}\0${provider}\0${model}`;
}

function sumCounts(c: Counts): number {
  return c[0] + c[1] + c[2] + c[3];
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
