import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import type { CreateFolderInput, RenameFolderInput, UpdateSettingsInput, UploadFilesInput } from "../shared/types";
import { APP_NAME } from "./constants";
import { AppDatabase } from "./database";
import { DiscoveryService } from "./discovery";
import { DownloadManager } from "./downloads";
import { LanHttpServer } from "./lan-server";
import { LocalLibrary } from "./library";
import { SettingsService } from "./settings";

app.setName(APP_NAME);

let mainWindow: BrowserWindow | null = null;
let library: LocalLibrary;
let settings: SettingsService;
let discovery: DiscoveryService;
let downloads: DownloadManager;
let lanServer: LanHttpServer;

async function bootstrap(): Promise<void> {
  const db = new AppDatabase(path.join(app.getPath("userData"), "lan-share.sqlite"));
  await db.init();

  settings = new SettingsService(db, app.getPath("documents"));
  await settings.init();

  library = new LocalLibrary(db, settings);
  lanServer = new LanHttpServer(library);
  const serverPort = await lanServer.start(settings.getPreferredPort());
  await settings.setServerPort(serverPort);
  library.setServerPort(serverPort);

  discovery = new DiscoveryService(
    () => ({
      deviceId: settings.getDeviceId(),
      displayName: settings.getDisplayName(),
      serverPort: lanServer.port
    }),
    () => settings.getIndexVersion()
  );
  downloads = new DownloadManager(discovery, app.getPath("downloads"));

  registerIpc();
  wireEvents();
  discovery.start();
  createWindow();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 560,
    minHeight: 520,
    title: "局域网文件共享",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("local:get-state", () => library.getLocalState());
  ipcMain.handle("local:create-folder", async (_event, input: CreateFolderInput) => {
    await library.createFolder(input.name, input.parentId);
  });
  ipcMain.handle("local:rename-folder", async (_event, input: RenameFolderInput) => {
    await library.renameFolder(input.folderId, input.name);
  });
  ipcMain.handle("local:delete-folder", async (_event, folderId: string) => {
    await library.deleteFolder(folderId);
  });
  ipcMain.handle("local:choose-and-upload-files", async (_event, input: UploadFilesInput) => {
    const result = await dialog.showOpenDialog({
      title: "选择要上传的文件",
      properties: ["openFile", "multiSelections"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return;
    }
    await library.importFiles(result.filePaths, input.folderId);
  });
  ipcMain.handle("local:unshare-file", async (_event, fileId: string) => {
    await library.unshareFile(fileId);
  });
  ipcMain.handle("local:reshare-file", async (_event, fileId: string) => {
    await library.reshareFile(fileId);
  });
  ipcMain.handle("local:delete-file", async (_event, fileId: string) => {
    await library.deleteFile(fileId);
  });
  ipcMain.handle("local:get-content-url", (_event, fileId: string) => {
    const file = library.getFile(fileId);
    if (!file) {
      throw new Error("文件不存在。");
    }
    return pathToFileURL(file.localPath).toString();
  });

  ipcMain.handle("network:get-peers", () => discovery.getPeers());
  ipcMain.handle("network:refresh", () => {
    discovery.broadcastNow();
    return discovery.getPeers();
  });
  ipcMain.handle("network:get-remote-manifest", (_event, deviceId: string) => discovery.fetchManifest(deviceId));
  ipcMain.handle("network:get-content-url", (_event, deviceId: string, fileId: string) =>
    discovery.getContentUrl(deviceId, fileId)
  );

  ipcMain.handle("downloads:start", (_event, deviceId: string, fileId: string) => downloads.start(deviceId, fileId));
  ipcMain.handle("downloads:retry", (_event, downloadId: string) => downloads.retry(downloadId));
  ipcMain.handle("downloads:list", () => downloads.list());

  ipcMain.handle("settings:update", async (_event, input: UpdateSettingsInput) => {
    await settings.updateDisplayName(input.displayName);
  });
  ipcMain.handle("settings:get-auto-launch", () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle("settings:set-auto-launch", (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });
}

function wireEvents(): void {
  library.on("updated", () => {
    discovery.broadcastNow();
    mainWindow?.webContents.send("local:updated");
  });

  discovery.on("updated", (peers) => {
    mainWindow?.webContents.send("network:peers-updated", peers);
  });

  downloads.on("updated", (tasks) => {
    mainWindow?.webContents.send("downloads:updated", tasks);
  });
}

app.whenReady().then(() => {
  void bootstrap().catch((error) => {
    dialog.showErrorBox("启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  discovery?.stop();
  void lanServer?.stop();
});
