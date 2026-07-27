import { EventEmitter } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { dialog } from "electron";
import { v4 as uuidv4 } from "uuid";
import type { DownloadTask, FolderRecord, LibraryManifest, RemoteFileRecord } from "../shared/types";
import { DiscoveryService } from "./discovery";
import { sanitizeName, uniquePathParts } from "./path-utils";

interface StoredDownload {
  task: DownloadTask;
  peerId: string;
  fileId: string;
}

export class DownloadManager extends EventEmitter {
  private readonly downloads = new Map<string, StoredDownload>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly downloadsDir: string
  ) {
    super();
  }

  list(): DownloadTask[] {
    return [...this.downloads.values()]
      .map((entry) => ({ ...entry.task }))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async start(peerId: string, fileId: string): Promise<DownloadTask | null> {
    const peer = this.discovery.getPeer(peerId);
    if (!peer) {
      throw new Error("设备已离线。");
    }

    const meta = await fetchJson<RemoteFileRecord>(`http://${peer.host}:${peer.port}/files/${fileId}/meta`, 3500);
    const saveResult = await dialog.showSaveDialog({
      title: "保存文件",
      defaultPath: path.join(this.downloadsDir, meta.name),
      buttonLabel: "下载"
    });

    if (saveResult.canceled || !saveResult.filePath) {
      return null;
    }

    const now = Date.now();
    const task: DownloadTask = {
      id: uuidv4(),
      peerId,
      peerName: peer.displayName,
      fileId,
      fileName: meta.name,
      savePath: saveResult.filePath,
      receivedBytes: 0,
      totalBytes: meta.size,
      speedBytesPerSecond: 0,
      status: "queued",
      createdAt: now,
      updatedAt: now
    };

    this.downloads.set(task.id, { task, peerId, fileId });
    this.emitUpdated();
    void this.run(task.id);
    return { ...task };
  }

  async startFolder(peerId: string, folderId: string): Promise<DownloadTask[] | null> {
    const peer = this.discovery.getPeer(peerId);
    if (!peer) {
      throw new Error("设备已离线。");
    }

    const manifest = await this.discovery.fetchManifest(peerId);
    const folder = manifest.folders.find((item) => item.id === folderId);
    if (!folder) {
      throw new Error("文件夹不存在。");
    }

    const files = getFilesInFolder(manifest, folderId);
    if (files.length === 0) {
      throw new Error("文件夹中没有可下载的共享文件。");
    }

    const saveResult = await dialog.showOpenDialog({
      title: "选择保存位置",
      buttonLabel: "下载到这里",
      properties: ["openDirectory", "createDirectory"]
    });
    if (saveResult.canceled || saveResult.filePaths.length === 0) {
      return null;
    }

    const rootSavePath = getUniqueDirectoryPath(saveResult.filePaths[0], folder.name);
    await mkdir(rootSavePath, { recursive: true });

    const foldersById = new Map(manifest.folders.map((item) => [item.id, item]));
    const usedSavePaths = new Set<string>();
    const now = Date.now();
    const tasks = files.map((file, index) => {
      const relativeFolders = file.folderId ? getRelativeFolderParts(file.folderId, folderId, foldersById) : [];
      const saveFolder = path.join(rootSavePath, ...relativeFolders);
      const savePath = getUniqueSavePath(saveFolder, file.name, usedSavePaths);
      const task: DownloadTask = {
        id: uuidv4(),
        peerId,
        peerName: peer.displayName,
        fileId: file.id,
        fileName: file.name,
        savePath,
        receivedBytes: 0,
        totalBytes: file.size,
        speedBytesPerSecond: 0,
        status: "queued",
        createdAt: now + index,
        updatedAt: now
      };
      this.downloads.set(task.id, { task, peerId, fileId: file.id });
      return task;
    });

    this.emitUpdated();
    void this.runBatch(tasks.map((task) => task.id));
    return tasks.map((task) => ({ ...task }));
  }

  async retry(downloadId: string): Promise<DownloadTask> {
    const entry = this.downloads.get(downloadId);
    if (!entry) {
      throw new Error("下载任务不存在。");
    }
    entry.task.status = "queued";
    entry.task.error = undefined;
    entry.task.updatedAt = Date.now();
    this.emitUpdated();
    void this.run(downloadId);
    return { ...entry.task };
  }

  private async run(downloadId: string): Promise<void> {
    const entry = this.downloads.get(downloadId);
    if (!entry) {
      return;
    }

    const peer = this.discovery.getPeer(entry.peerId);
    if (!peer) {
      this.fail(entry.task, "设备已离线。");
      return;
    }

    const task = entry.task;
    task.status = "running";
    task.updatedAt = Date.now();
    this.emitUpdated();

    const partPath = `${task.savePath}.part`;
    await mkdir(path.dirname(task.savePath), { recursive: true });

    let resumeFrom = 0;
    try {
      resumeFrom = (await stat(partPath)).size;
    } catch {
      resumeFrom = 0;
    }

    if (resumeFrom > task.totalBytes) {
      await unlink(partPath).catch(() => undefined);
      resumeFrom = 0;
    }

    const startedAt = Date.now();
    let lastEmitAt = 0;
    let receivedThisRun = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined;
        const request = http.get(
          `http://${peer.host}:${peer.port}/files/${encodeURIComponent(entry.fileId)}/content`,
          { headers },
          (response) => {
            if (response.statusCode === 416 && resumeFrom === task.totalBytes) {
              response.resume();
              resolve();
              return;
            }

            if (response.statusCode !== 200 && response.statusCode !== 206) {
              response.resume();
              reject(new Error(`HTTP ${response.statusCode ?? "unknown"}`));
              return;
            }

            if (resumeFrom > 0 && response.statusCode !== 206) {
              resumeFrom = 0;
            }

            const output = createWriteStream(partPath, { flags: resumeFrom > 0 ? "a" : "w" });
            response.on("data", (chunk: Buffer) => {
              receivedThisRun += chunk.length;
              const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
              task.receivedBytes = resumeFrom + receivedThisRun;
              task.speedBytesPerSecond = receivedThisRun / elapsedSeconds;
              task.updatedAt = Date.now();
              if (Date.now() - lastEmitAt > 250) {
                lastEmitAt = Date.now();
                this.emitUpdated();
              }
            });
            response.pipe(output);
            output.on("finish", resolve);
            output.on("error", reject);
            response.on("error", reject);
          }
        );
        request.on("error", reject);
      });

      await rename(partPath, task.savePath);
      task.receivedBytes = task.totalBytes;
      task.speedBytesPerSecond = 0;
      task.status = "completed";
      task.updatedAt = Date.now();
      this.emitUpdated();
    } catch (error) {
      this.fail(task, error instanceof Error ? error.message : String(error));
    }
  }

  private async runBatch(downloadIds: string[]): Promise<void> {
    for (const downloadId of downloadIds) {
      await this.run(downloadId);
    }
  }

  private fail(task: DownloadTask, error: string): void {
    task.status = "failed";
    task.error = error;
    task.speedBytesPerSecond = 0;
    task.updatedAt = Date.now();
    this.emitUpdated();
  }

  private emitUpdated(): void {
    this.emit("updated", this.list());
  }
}

function getFilesInFolder(manifest: LibraryManifest, folderId: string): RemoteFileRecord[] {
  const folderIds = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of manifest.folders) {
      if (folder.parentId && folderIds.has(folder.parentId) && !folderIds.has(folder.id)) {
        folderIds.add(folder.id);
        changed = true;
      }
    }
  }
  return manifest.files.filter((file) => file.folderId !== null && folderIds.has(file.folderId));
}

function getRelativeFolderParts(
  folderId: string,
  rootFolderId: string,
  foldersById: Map<string, FolderRecord>
): string[] {
  const parts: string[] = [];
  let current = foldersById.get(folderId);
  while (current && current.id !== rootFolderId) {
    parts.unshift(sanitizeName(current.name, "文件夹"));
    current = current.parentId ? foldersById.get(current.parentId) : undefined;
  }
  return parts;
}

function getUniqueDirectoryPath(parentPath: string, folderName: string): string {
  const cleanName = sanitizeName(folderName, "下载文件夹");
  let candidate = path.join(parentPath, cleanName);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = path.join(parentPath, `${cleanName} (${index})`);
    index += 1;
  }
  return candidate;
}

function getUniqueSavePath(folderPath: string, fileName: string, usedSavePaths: Set<string>): string {
  const { base, ext } = uniquePathParts(fileName);
  let candidate = path.join(folderPath, `${base}${ext}`);
  let index = 2;
  while (usedSavePaths.has(candidate.toLowerCase()) || existsSync(candidate)) {
    candidate = path.join(folderPath, `${base} (${index})${ext}`);
    index += 1;
  }
  usedSavePaths.add(candidate.toLowerCase());
  return candidate;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
