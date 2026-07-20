import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http, { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { DEFAULT_HTTP_PORT } from "./constants";
import { LocalLibrary } from "./library";

export class LanHttpServer {
  private server: http.Server | null = null;
  private currentPort = DEFAULT_HTTP_PORT;

  constructor(private readonly library: LocalLibrary) {}

  get port(): number {
    return this.currentPort;
  }

  async start(preferredPort: number): Promise<number> {
    let port = preferredPort;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await this.listen(port);
        this.currentPort = port;
        this.library.setServerPort(port);
        return port;
      } catch (error) {
        if (isPortInUse(error)) {
          port += 1;
          continue;
        }
        throw error;
      }
    }
    throw new Error("无法找到可用的局域网服务端口。");
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
  }

  private listen(port: number): Promise<void> {
    this.server = http.createServer((req, res) => {
      void this.route(req, res).catch((error) => {
        this.sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });

    return new Promise((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, "0.0.0.0", () => {
        this.server?.off("error", reject);
        resolve();
      });
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyCommonHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      this.sendJson(res, 405, { error: "Only read-only GET and HEAD requests are allowed." });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/health") {
      this.sendJson(res, 200, { ok: true, port: this.currentPort });
      return;
    }

    if (pathname === "/manifest") {
      this.sendJson(res, 200, this.library.getManifest());
      return;
    }

    const metaMatch = pathname.match(/^\/files\/([^/]+)\/meta$/);
    if (metaMatch) {
      const file = this.library.getSharedFile(metaMatch[1]);
      if (!file) {
        this.sendJson(res, 404, { error: "File is not shared or does not exist." });
        return;
      }
      const { localPath, shared, ...publicFile } = file;
      void localPath;
      void shared;
      this.sendJson(res, 200, publicFile);
      return;
    }

    const contentMatch = pathname.match(/^\/files\/([^/]+)\/content$/);
    if (contentMatch) {
      await this.streamFile(req, res, contentMatch[1]);
      return;
    }

    this.sendJson(res, 404, { error: "Not found." });
  }

  private async streamFile(req: IncomingMessage, res: ServerResponse, fileId: string): Promise<void> {
    const file = this.library.getSharedFile(fileId);
    if (!file) {
      this.sendJson(res, 404, { error: "File is not shared or does not exist." });
      return;
    }

    let fileStat;
    try {
      fileStat = await stat(file.localPath);
    } catch {
      this.sendJson(res, 404, { error: "File is missing on owner device." });
      return;
    }

    const total = fileStat.size;
    const range = req.headers.range;
    let start = 0;
    let end = total > 0 ? total - 1 : 0;
    let statusCode = 200;

    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Number(match[2]) : end;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }
      statusCode = 206;
    }

    const contentLength = total === 0 ? 0 : end - start + 1;
    const headers: Record<string, string | number> = {
      "Content-Type": file.mimeType || "application/octet-stream",
      "Content-Length": contentLength,
      "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control": "no-store"
    };
    if (statusCode === 206) {
      headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    }

    res.writeHead(statusCode, headers);
    if (req.method === "HEAD" || total === 0) {
      res.end();
      return;
    }
    createReadStream(file.localPath, { start, end }).pipe(res);
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    this.applyCommonHeaders(res);
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  private applyCommonHeaders(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  }
}

function isPortInUse(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE");
}
