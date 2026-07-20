export interface PublicDevice {
  deviceId: string;
  displayName: string;
  serverPort: number;
}

export interface DeviceInfo extends PublicDevice {
  libraryRoot: string;
  discoveryPort: number;
}

export interface FolderRecord {
  id: string;
  name: string;
  parentId: string | null;
  ownerDeviceId: string;
  createdAt: number;
}

export interface LocalFileRecord {
  id: string;
  folderId: string | null;
  name: string;
  size: number;
  mimeType: string;
  ownerDeviceId: string;
  localPath: string;
  updatedAt: number;
  shared: boolean;
}

export interface RemoteFileRecord {
  id: string;
  folderId: string | null;
  name: string;
  size: number;
  mimeType: string;
  ownerDeviceId: string;
  updatedAt: number;
}

export interface LocalState {
  device: DeviceInfo;
  folders: FolderRecord[];
  files: LocalFileRecord[];
  indexVersion: number;
}

export interface LibraryManifest {
  device: PublicDevice;
  folders: FolderRecord[];
  files: RemoteFileRecord[];
  indexVersion: number;
}

export interface Peer {
  deviceId: string;
  displayName: string;
  host: string;
  port: number;
  lastSeen: number;
  indexVersion: number;
}

export type DownloadStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export interface DownloadTask {
  id: string;
  peerId: string;
  peerName: string;
  fileId: string;
  fileName: string;
  savePath: string;
  receivedBytes: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  status: DownloadStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateFolderInput {
  name: string;
  parentId: string | null;
}

export interface RenameFolderInput {
  folderId: string;
  name: string;
}

export interface UploadFilesInput {
  folderId: string | null;
}

export interface UpdateSettingsInput {
  displayName: string;
}
