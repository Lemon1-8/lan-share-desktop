import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";

const requireForSql = createRequire(__filename);

function getSqlWasmPath(): string {
  const wasmPath = requireForSql.resolve("sql.js/dist/sql-wasm.wasm");
  return wasmPath.includes("app.asar")
    ? wasmPath.replace("app.asar", "app.asar.unpacked")
    : wasmPath;
}

export class AppDatabase {
  private db: Database | null = null;
  private sql: SqlJsStatic | null = null;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    const wasmPath = getSqlWasmPath();
    this.sql = await initSqlJs({
      locateFile: () => wasmPath
    });

    let existing: Buffer | null = null;
    try {
      existing = await readFile(this.dbPath);
    } catch {
      existing = null;
    }

    this.db = existing ? new this.sql.Database(new Uint8Array(existing)) : new this.sql.Database();
    this.migrate();
    await this.persist();
  }

  query<T extends object>(sql: string, params: unknown[] = []): T[] {
    const db = this.requireDb();
    const stmt = db.prepare(sql);
    const rows: T[] = [];
    try {
      stmt.bind(params as never[]);
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
    } finally {
      stmt.free();
    }
    return rows;
  }

  get<T extends object>(sql: string, params: unknown[] = []): T | null {
    return this.query<T>(sql, params)[0] ?? null;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.requireDb().run(sql, params as never[]);
    await this.persist();
  }

  async transaction(work: () => void): Promise<void> {
    const db = this.requireDb();
    db.run("BEGIN TRANSACTION");
    try {
      work();
      db.run("COMMIT");
      await this.persist();
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
  }

  exec(sql: string): void {
    this.requireDb().exec(sql);
  }

  async persist(): Promise<void> {
    const exported = this.requireDb().export();
    await writeFile(this.dbPath, Buffer.from(exported));
  }

  private migrate(): void {
    this.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parentId TEXT,
        ownerDeviceId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        deletedAt INTEGER
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        folderId TEXT,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        mimeType TEXT NOT NULL,
        ownerDeviceId TEXT NOT NULL,
        localPath TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        shared INTEGER NOT NULL DEFAULT 1,
        deletedAt INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parentId);
      CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folderId);
      CREATE INDEX IF NOT EXISTS idx_files_shared ON files(shared);
    `);
    this.ensureColumn("folders", "deletedAt", "INTEGER");
    this.ensureColumn("files", "deletedAt", "INTEGER");
    this.exec(`
      CREATE INDEX IF NOT EXISTS idx_folders_deleted ON folders(deletedAt);
      CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deletedAt);
    `);
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const rows = this.query<{ name: string }>(`PRAGMA table_info(${table})`);
    if (rows.some((row) => row.name === column)) {
      return;
    }
    this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  private requireDb(): Database {
    if (!this.db) {
      throw new Error("Database is not initialized.");
    }
    return this.db;
  }
}
