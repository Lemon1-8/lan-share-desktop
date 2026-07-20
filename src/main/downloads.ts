import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { dialog } from "electron";
import { v4 as uuidv4 } from "uuid";
import type { DownloadTask, RemoteFileRecord } from "../shared/types";
import { DiscoveryService } from "./discovery";

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
