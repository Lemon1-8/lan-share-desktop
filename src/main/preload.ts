import { contextBridge, ipcRenderer } from "electron";
import type {
  CreateFolderInput,
  DownloadTask,
  LibraryManifest,
  LocalState,
  Peer,
  RenameFolderInput,
  UpdateSettingsInput,
  UploadFilesInput
} from "../shared/types";

const api = {
  getLocalState: () => ipcRenderer.invoke("local:get-state") as Promise<LocalState>,
  createFolder: (input: CreateFolderInput) => ipcRenderer.invoke("local:create-folder", input) as Promise<void>,
  renameFolder: (input: RenameFolderInput) => ipcRenderer.invoke("local:rename-folder", input) as Promise<void>,
  deleteFolder: (folderId: string) => ipcRenderer.invoke("local:delete-folder", folderId) as Promise<void>,
  chooseAndUploadFiles: (input: UploadFilesInput) =>
    ipcRenderer.invoke("local:choose-and-upload-files", input) as Promise<void>,
  unshareFile: (fileId: string) => ipcRenderer.invoke("local:unshare-file", fileId) as Promise<void>,
  reshareFile: (fileId: string) => ipcRenderer.invoke("local:reshare-file", fileId) as Promise<void>,
  deleteFile: (fileId: string) => ipcRenderer.invoke("local:delete-file", fileId) as Promise<void>,
  getLocalContentUrl: (fileId: string) => ipcRenderer.invoke("local:get-content-url", fileId) as Promise<string>,

  getPeers: () => ipcRenderer.invoke("network:get-peers") as Promise<Peer[]>,
  getRemoteManifest: (deviceId: string) =>
    ipcRenderer.invoke("network:get-remote-manifest", deviceId) as Promise<LibraryManifest>,
  getRemoteContentUrl: (deviceId: string, fileId: string) =>
    ipcRenderer.invoke("network:get-content-url", deviceId, fileId) as Promise<string>,
  refreshNetwork: () => ipcRenderer.invoke("network:refresh") as Promise<Peer[]>,

  startDownload: (deviceId: string, fileId: string) =>
    ipcRenderer.invoke("downloads:start", deviceId, fileId) as Promise<DownloadTask | null>,
  retryDownload: (downloadId: string) => ipcRenderer.invoke("downloads:retry", downloadId) as Promise<DownloadTask>,
  getDownloads: () => ipcRenderer.invoke("downloads:list") as Promise<DownloadTask[]>,

  updateSettings: (input: UpdateSettingsInput) => ipcRenderer.invoke("settings:update", input) as Promise<void>,
  getAutoLaunch: () => ipcRenderer.invoke("settings:get-auto-launch") as Promise<boolean>,
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke("settings:set-auto-launch", enabled) as Promise<boolean>,

  onLocalUpdated: (callback: () => void) => subscribe("local:updated", callback),
  onPeersUpdated: (callback: (peers: Peer[]) => void) => subscribe("network:peers-updated", callback),
  onDownloadsUpdated: (callback: (downloads: DownloadTask[]) => void) =>
    subscribe("downloads:updated", callback)
};

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld("lanShare", api);

export type LanShareApi = typeof api;
