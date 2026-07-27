import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, copyFile, lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { lookup as lookupMime } from "mime-types";
import { v4 as uuidv4 } from "uuid";
import type {
  FolderRecord,
  LibraryManifest,
  LocalFileRecord,
  LocalState,
  RemoteFileRecord
} from "../shared/types";
import { AppDatabase } from "./database";
import { SettingsService } from "./settings";
import { sanitizeName, uniquePathParts } from "./path-utils";

const UNSHARED_FOLDER_NAME = "未共享";

interface FolderRow {
  id: string;
  name: string;
  parentId: string | null;
  ownerDeviceId: string;
  createdAt: number;
  deletedAt: number | null;
}

interface FileRow {
  id: string;
  folderId: string | null;
  name: string;
  size: number;
  mimeType: string;
  ownerDeviceId: string;
  localPath: string;
  updatedAt: number;
  shared: number;
  deletedAt: number | null;
}

export class LocalLibrary extends EventEmitter {
  private serverPort = 0;

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: SettingsService
  ) {
    super();
  }

  setServerPort(port: number): void {
    this.serverPort = port;
  }

  async createFolder(name: string, parentId: string | null): Promise<FolderRecord> {
    const record = await this.createFolderRecord(name, parentId);
    await this.markUpdated();
    return record;
  }

  async renameFolder(folderId: string, name: string): Promise<FolderRecord> {
    const folder = this.requireFolder(folderId);
    const cleanName = sanitizeName(name, "文件夹");
    const uniqueName = this.getUniqueFolderName(cleanName, folder.parentId, folder.id);
    await this.db.run("UPDATE folders SET name = ? WHERE id = ? AND deletedAt IS NULL", [uniqueName, folder.id]);
    await this.markUpdated();
    return { ...folder, name: uniqueName };
  }

  async deleteFolder(folderId: string): Promise<void> {
    this.requireFolder(folderId);
    const deletedAt = Date.now();
    const folderIds = this.getDescendantFolderIds(folderId);
    for (const id of folderIds) {
      await this.db.run("UPDATE files SET shared = 0, deletedAt = ?, updatedAt = ? WHERE folderId = ? AND deletedAt IS NULL", [
        deletedAt,
        deletedAt,
        id
      ]);
    }
    for (const id of [...folderIds].reverse()) {
      await this.db.run("UPDATE folders SET deletedAt = ? WHERE id = ? AND deletedAt IS NULL", [deletedAt, id]);
    }
    await this.markUpdated();
  }

  async importFiles(sourcePaths: string[], folderId: string | null): Promise<LocalFileRecord[]> {
    if (folderId) {
      this.requireFolder(folderId);
    }
    const targetFolder = folderId ? this.resolveFolderPath(folderId) : this.settings.getLibraryRoot();
    await mkdir(targetFolder, { recursive: true });

    const created: LocalFileRecord[] = [];
    for (const sourcePath of sourcePaths) {
      created.push(await this.importFile(sourcePath, folderId, targetFolder));
    }

    await this.markUpdated();
    return created;
  }

  async importFolders(sourcePaths: string[], parentFolderId: string | null): Promise<LocalFileRecord[]> {
    if (parentFolderId) {
      this.requireFolder(parentFolderId);
    }

    const created: LocalFileRecord[] = [];
    for (const sourcePath of sourcePaths) {
      const sourceStat = await lstat(sourcePath);
      if (!sourceStat.isDirectory()) {
        throw new Error(`${path.basename(sourcePath)} 不是文件夹。`);
      }

      const rootFolder = await this.createFolderRecord(path.basename(sourcePath), parentFolderId);
      await this.importFolderContents(sourcePath, rootFolder.id, created);
    }

    await this.markUpdated();
    return created;
  }

  async unshareFile(fileId: string): Promise<void> {
    this.requireFile(fileId);
    const unsharedFolder = await this.ensureUnsharedFolder();
    await this.db.run("UPDATE files SET folderId = ?, shared = 0, updatedAt = ? WHERE id = ? AND deletedAt IS NULL", [
      unsharedFolder.id,
      Date.now(),
      fileId
    ]);
    await this.markUpdated();
  }

  async reshareFile(fileId: string): Promise<void> {
    this.requireFile(fileId);
    await this.db.run("UPDATE files SET shared = 1, updatedAt = ? WHERE id = ? AND deletedAt IS NULL", [Date.now(), fileId]);
    await this.markUpdated();
  }

  async deleteFile(fileId: string): Promise<void> {
    this.requireFile(fileId);
    const deletedAt = Date.now();
    await this.db.run("UPDATE files SET shared = 0, deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL", [
      deletedAt,
      deletedAt,
      fileId
    ]);
    await this.markUpdated();
  }

  getLocalState(): LocalState {
    return {
      device: this.settings.getDevice(this.serverPort),
      folders: this.getFolders(),
      files: this.getFiles(),
      indexVersion: this.settings.getIndexVersion()
    };
  }

  getManifest(): LibraryManifest {
    const device = this.settings.getDevice(this.serverPort);
    const sharedFiles = this.getFiles().filter((file) => file.shared);
    const visibleFolderIds = this.getFolderIdsForFiles(sharedFiles);
    return {
      device: {
        deviceId: device.deviceId,
        displayName: device.displayName,
        serverPort: device.serverPort
      },
      folders: this.getFolders().filter((folder) => visibleFolderIds.has(folder.id)),
      files: sharedFiles.map<RemoteFileRecord>((file) => ({
          id: file.id,
          folderId: file.folderId,
          name: file.name,
          size: file.size,
          mimeType: file.mimeType,
          ownerDeviceId: file.ownerDeviceId,
          updatedAt: file.updatedAt
        })),
      indexVersion: this.settings.getIndexVersion()
    };
  }

  getSharedFile(fileId: string): LocalFileRecord | null {
    const file = this.getFile(fileId);
    return file?.shared ? file : null;
  }

  getFile(fileId: string): LocalFileRecord | null {
    const row = this.db.get<FileRow>("SELECT * FROM files WHERE id = ? AND deletedAt IS NULL", [fileId]);
    return row ? mapFile(row) : null;
  }

  getFolderPath(folderId: string | null): string {
    return folderId ? this.resolveFolderPath(folderId) : this.settings.getLibraryRoot();
  }

  private getFolders(): FolderRecord[] {
    return this.db
      .query<FolderRow>("SELECT * FROM folders WHERE deletedAt IS NULL ORDER BY createdAt ASC")
      .map((row) => ({
        id: row.id,
        name: row.name,
        parentId: row.parentId,
        ownerDeviceId: row.ownerDeviceId,
        createdAt: Number(row.createdAt)
      }));
  }

  private getFiles(): LocalFileRecord[] {
    return this.db
      .query<FileRow>("SELECT * FROM files WHERE deletedAt IS NULL ORDER BY updatedAt DESC")
      .map(mapFile);
  }

  private requireFolder(folderId: string): FolderRecord {
    const row = this.db.get<FolderRow>("SELECT * FROM folders WHERE id = ? AND deletedAt IS NULL", [folderId]);
    if (!row) {
      throw new Error("文件夹不存在。");
    }
    return {
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      ownerDeviceId: row.ownerDeviceId,
      createdAt: Number(row.createdAt)
    };
  }

  private requireFile(fileId: string): LocalFileRecord {
    const file = this.getFile(fileId);
    if (!file) {
      throw new Error("文件不存在。");
    }
    return file;
  }

  private resolveFolderPath(folderId: string): string {
    const parts: string[] = [];
    let current: FolderRecord | null = this.requireFolder(folderId);
    while (current) {
      parts.unshift(sanitizeName(current.name, "文件夹"));
      current = current.parentId ? this.requireFolder(current.parentId) : null;
    }
    return path.join(this.settings.getLibraryRoot(), ...parts);
  }

  private async createFolderRecord(name: string, parentId: string | null): Promise<FolderRecord> {
    const cleanName = sanitizeName(name, "新建文件夹");
    if (parentId) {
      this.requireFolder(parentId);
    }
    const uniqueName = this.getUniqueFolderName(cleanName, parentId);
    const record: FolderRecord = {
      id: uuidv4(),
      name: uniqueName,
      parentId,
      ownerDeviceId: this.settings.getDeviceId(),
      createdAt: Date.now()
    };

    await this.db.run(
      "INSERT INTO folders(id, name, parentId, ownerDeviceId, createdAt) VALUES(?, ?, ?, ?, ?)",
      [record.id, record.name, record.parentId, record.ownerDeviceId, record.createdAt]
    );
    await mkdir(this.resolveFolderPath(record.id), { recursive: true });
    return record;
  }

  private async importFolderContents(
    sourceFolder: string,
    targetFolderId: string,
    created: LocalFileRecord[]
  ): Promise<void> {
    const targetFolderPath = this.resolveFolderPath(targetFolderId);
    const entries = await readdir(sourceFolder, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const sourcePath = path.join(sourceFolder, entry.name);
      if (entry.isDirectory()) {
        const childFolder = await this.createFolderRecord(entry.name, targetFolderId);
        await this.importFolderContents(sourcePath, childFolder.id, created);
        continue;
      }

      if (entry.isFile()) {
        created.push(await this.importFile(sourcePath, targetFolderId, targetFolderPath));
      }
    }
  }

  private async importFile(
    sourcePath: string,
    folderId: string | null,
    targetFolder?: string
  ): Promise<LocalFileRecord> {
    const resolvedTargetFolder = targetFolder ?? this.getFolderPath(folderId);
    await mkdir(resolvedTargetFolder, { recursive: true });
    const fileName = path.basename(sourcePath);
    const targetPath = this.getUniqueFilePath(resolvedTargetFolder, fileName);
    await copyFile(sourcePath, targetPath);
    const fileStat = await stat(targetPath);
    const record: LocalFileRecord = {
      id: uuidv4(),
      folderId,
      name: path.basename(targetPath),
      size: fileStat.size,
      mimeType: lookupMime(targetPath) || "application/octet-stream",
      ownerDeviceId: this.settings.getDeviceId(),
      localPath: targetPath,
      updatedAt: fileStat.mtimeMs,
      shared: true
    };
    await this.db.run(
      `INSERT INTO files(id, folderId, name, size, mimeType, ownerDeviceId, localPath, updatedAt, shared)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        record.id,
        record.folderId,
        record.name,
        record.size,
        record.mimeType,
        record.ownerDeviceId,
        record.localPath,
        record.updatedAt
      ]
    );
    return record;
  }

  private getUniqueFolderName(name: string, parentId: string | null, exceptFolderId?: string): string {
    const siblings = new Set(
      this.db
        .query<FolderRow>(
          parentId
            ? "SELECT id, name FROM folders WHERE parentId = ? AND deletedAt IS NULL"
            : "SELECT id, name FROM folders WHERE parentId IS NULL AND deletedAt IS NULL",
          parentId ? [parentId] : []
        )
        .filter((row) => row.id !== exceptFolderId)
        .map((row) => row.name.toLowerCase())
    );

    let candidate = name;
    let index = 2;
    while (siblings.has(candidate.toLowerCase())) {
      candidate = `${name} (${index})`;
      index += 1;
    }
    return candidate;
  }

  private getUniqueFilePath(folderPath: string, fileName: string): string {
    const { base, ext } = uniquePathParts(fileName);
    let candidate = path.join(folderPath, `${base}${ext}`);
    let index = 2;
    while (this.pathAlreadyTracked(candidate) || existsSync(candidate)) {
      candidate = path.join(folderPath, `${base} (${index})${ext}`);
      index += 1;
    }
    return candidate;
  }

  private pathAlreadyTracked(candidate: string): boolean {
    return Boolean(this.db.get<FileRow>("SELECT id FROM files WHERE lower(localPath) = lower(?) AND deletedAt IS NULL", [candidate]));
  }

  private async ensureUnsharedFolder(): Promise<FolderRecord> {
    const existing = this.db.get<FolderRow>(
      "SELECT * FROM folders WHERE parentId IS NULL AND name = ? AND deletedAt IS NULL",
      [UNSHARED_FOLDER_NAME]
    );
    if (existing) {
      return mapFolder(existing);
    }
    return this.createFolder(UNSHARED_FOLDER_NAME, null);
  }

  private getDescendantFolderIds(folderId: string): string[] {
    const folders = this.getFolders();
    const childrenByParent = new Map<string | null, FolderRecord[]>();
    for (const folder of folders) {
      const children = childrenByParent.get(folder.parentId) ?? [];
      children.push(folder);
      childrenByParent.set(folder.parentId, children);
    }

    const result: string[] = [];
    const visit = (id: string): void => {
      result.push(id);
      for (const child of childrenByParent.get(id) ?? []) {
        visit(child.id);
      }
    };
    visit(folderId);
    return result;
  }

  private getFolderIdsForFiles(files: LocalFileRecord[]): Set<string> {
    const folders = new Map(this.getFolders().map((folder) => [folder.id, folder]));
    const ids = new Set<string>();
    for (const file of files) {
      let current = file.folderId ? folders.get(file.folderId) : undefined;
      while (current) {
        ids.add(current.id);
        current = current.parentId ? folders.get(current.parentId) : undefined;
      }
    }
    return ids;
  }

  private async markUpdated(): Promise<void> {
    await this.settings.bumpIndexVersion();
    this.emit("updated", this.getLocalState());
  }
}

function mapFolder(row: FolderRow): FolderRecord {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    ownerDeviceId: row.ownerDeviceId,
    createdAt: Number(row.createdAt)
  };
}

function mapFile(row: FileRow): LocalFileRecord {
  return {
    id: row.id,
    folderId: row.folderId,
    name: row.name,
    size: Number(row.size),
    mimeType: row.mimeType,
    ownerDeviceId: row.ownerDeviceId,
    localPath: row.localPath,
    updatedAt: Number(row.updatedAt),
    shared: Boolean(row.shared)
  };
}
