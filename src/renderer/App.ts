import "./styles.css";
import type {
  DownloadTask,
  FolderRecord,
  LibraryManifest,
  LocalFileRecord,
  LocalState,
  Peer,
  RemoteFileRecord
} from "../shared/types";

type TabId = "mine" | "lan" | "transfers" | "settings";

interface UiState {
  tab: TabId;
  local: LocalState | null;
  peers: Peer[];
  manifests: Map<string, LibraryManifest>;
  manifestErrors: Map<string, string>;
  downloads: DownloadTask[];
  selectedPeer: string;
  currentFolderId: string | null;
  preview: PreviewTarget | null;
  dialog: DialogState | null;
  notice: string | null;
  error: string | null;
  autoLaunch: boolean;
  isRefreshing: boolean;
}

interface PreviewTarget {
  title: string;
  mimeType: string;
  url: string;
}

type DialogState =
  | {
      type: "rename-folder";
      folderId: string;
      folderName: string;
    }
  | {
      type: "delete-folder";
      folderId: string;
      folderName: string;
      parentId: string | null;
    }
  | {
      type: "delete-file";
      fileId: string;
      fileName: string;
    };

const state: UiState = {
  tab: "mine",
  local: null,
  peers: [],
  manifests: new Map(),
  manifestErrors: new Map(),
  downloads: [],
  selectedPeer: "all",
  currentFolderId: null,
  preview: null,
  dialog: null,
  notice: null,
  error: null,
  autoLaunch: false,
  isRefreshing: false
};

const appRootCandidate = document.querySelector<HTMLDivElement>("#app");
if (!appRootCandidate) {
  throw new Error("Missing app root.");
}
const appRoot: HTMLDivElement = appRootCandidate;

window.lanShare.onLocalUpdated(() => {
  void refreshLocal();
});

window.lanShare.onPeersUpdated((peers) => {
  state.peers = peers;
  normalizeSelectedPeer();
  void refreshRemoteManifests();
});

window.lanShare.onDownloadsUpdated((downloads) => {
  state.downloads = downloads;
  render();
});

void boot();

async function boot(): Promise<void> {
  await Promise.all([refreshLocal(false), refreshPeers(false), refreshDownloads(false), refreshAutoLaunch(false)]);
  await refreshRemoteManifests(false);
  render();

  setInterval(() => {
    void refreshPeersAndManifests();
  }, 5000);
}

async function refreshLocal(shouldRender = true): Promise<void> {
  state.local = await window.lanShare.getLocalState();
  normalizeCurrentFolder();
  if (shouldRender) {
    render();
  }
}

async function refreshPeers(shouldRender = true): Promise<void> {
  state.peers = await window.lanShare.getPeers();
  normalizeSelectedPeer();
  if (shouldRender) {
    render();
  }
}

async function refreshPeersAndManifests(): Promise<void> {
  await refreshPeers(false);
  await refreshRemoteManifests(true);
}

async function refreshDownloads(shouldRender = true): Promise<void> {
  state.downloads = await window.lanShare.getDownloads();
  if (shouldRender) {
    render();
  }
}

async function refreshAutoLaunch(shouldRender = true): Promise<void> {
  state.autoLaunch = await window.lanShare.getAutoLaunch();
  if (shouldRender) {
    render();
  }
}

async function refreshRemoteManifests(shouldRender = true): Promise<void> {
  const onlineIds = new Set(state.peers.map((peer) => peer.deviceId));
  for (const id of [...state.manifests.keys()]) {
    if (!onlineIds.has(id)) {
      state.manifests.delete(id);
    }
  }
  for (const id of [...state.manifestErrors.keys()]) {
    if (!onlineIds.has(id)) {
      state.manifestErrors.delete(id);
    }
  }

  await Promise.all(
    state.peers.map(async (peer) => {
      try {
        const manifest = await window.lanShare.getRemoteManifest(peer.deviceId);
        state.manifests.set(peer.deviceId, manifest);
        state.manifestErrors.delete(peer.deviceId);
      } catch (error) {
        state.manifests.delete(peer.deviceId);
        state.manifestErrors.set(peer.deviceId, getErrorMessage(error));
      }
    })
  );

  if (shouldRender) {
    render();
  }
}

async function refreshEverything(): Promise<void> {
  state.isRefreshing = true;
  render();
  try {
    state.peers = await window.lanShare.refreshNetwork();
    await delay(400);
    await refreshLocal(false);
    await refreshPeers(false);
    await refreshRemoteManifests(false);
    await refreshDownloads(false);
    state.notice = "已刷新局域网状态。";
  } finally {
    state.isRefreshing = false;
  }
}

function render(): void {
  const local = state.local;
  appRoot.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">LAN</div>
          <div class="brand-copy">
            <div class="brand-title">局域网文件共享</div>
            <div class="brand-subtitle">${escapeHtml(local?.device.displayName ?? "正在启动")}</div>
          </div>
        </div>
        <nav class="nav">
          ${navButton("mine", "我的文件", "本机")}
          ${navButton("lan", "局域网", `${state.peers.length} 台`)}
          ${navButton("transfers", "传输", `${activeDownloads()} 项`)}
          ${navButton("settings", "设置", "端口")}
        </nav>
        <div class="sidebar-status">
          <span class="status-dot ${state.peers.length ? "online" : ""}"></span>
          <div>
            <div>${state.peers.length ? "局域网在线" : "等待设备"}</div>
            <small>HTTP ${local?.device.serverPort ?? "--"} / UDP ${local?.device.discoveryPort ?? "--"}</small>
          </div>
        </div>
      </aside>
      <main class="workspace">
        ${renderTopbar()}
        ${renderMessages()}
        ${renderMetrics()}
        ${renderCurrentTab()}
      </main>
      ${state.preview ? renderPreviewModal(state.preview) : ""}
      ${state.dialog ? renderDialogModal(state.dialog) : ""}
    </div>
  `;
  bindEvents();
}

function navButton(tab: TabId, label: string, meta: string): string {
  return `
    <button class="nav-button ${state.tab === tab ? "active" : ""}" data-tab="${tab}">
      <span>${label}</span>
      <small>${escapeHtml(meta)}</small>
    </button>
  `;
}

function renderTopbar(): string {
  const local = state.local;
  return `
    <header class="topbar">
      <div>
        <h1>${tabTitle(state.tab)}</h1>
        <div class="topbar-subtitle">
          ${local ? `${escapeHtml(local.device.deviceId.slice(0, 8))} · ${escapeHtml(local.device.libraryRoot)}` : "正在准备本机文件库"}
        </div>
      </div>
      <div class="topbar-actions">
        <button class="secondary" data-action="refresh" ${state.isRefreshing ? "disabled" : ""}>
          ${state.isRefreshing ? "刷新中" : "刷新"}
        </button>
      </div>
    </header>
  `;
}

function renderMessages(): string {
  return `
    ${state.notice ? `<div class="message success">${escapeHtml(state.notice)}</div>` : ""}
    ${state.error ? `<div class="message danger">${escapeHtml(state.error)}</div>` : ""}
  `;
}

function renderMetrics(): string {
  const localFiles = state.local?.files.length ?? 0;
  const sharedFiles = state.local?.files.filter((file) => file.shared).length ?? 0;
  const remoteFiles = [...state.manifests.values()].reduce((total, manifest) => total + manifest.files.length, 0);
  return `
    <section class="metrics">
      ${metric("本机文件", String(localFiles))}
      ${metric("已共享", String(sharedFiles))}
      ${metric("在线设备", String(state.peers.length))}
      ${metric("可下载文件", String(remoteFiles))}
    </section>
  `;
}

function metric(label: string, value: string): string {
  return `
    <div class="metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderCurrentTab(): string {
  if (!state.local) {
    return `<section class="panel"><div class="empty">正在启动本机服务</div></section>`;
  }
  if (state.tab === "mine") {
    return renderMine();
  }
  if (state.tab === "lan") {
    return renderLan();
  }
  if (state.tab === "transfers") {
    return renderTransfers();
  }
  return renderSettings();
}

function renderMine(): string {
  const local = requireLocal();
  const currentFolderId = getCurrentFolderId(local);
  const currentFolder = currentFolderId ? local.folders.find((folder) => folder.id === currentFolderId) ?? null : null;
  const childFolders = getChildFolders(local.folders, currentFolderId);
  const visibleFiles = local.files.filter((file) => file.folderId === currentFolderId);
  const sharedVisibleFiles = visibleFiles.filter((file) => file.shared).length;

  return `
    <section class="command-bar folder-command-bar">
      <div class="current-target">
        <span>当前目录</span>
        <strong>${escapeHtml(currentFolder?.name ?? "根目录")}</strong>
      </div>
      <input id="folderName" type="text" placeholder="文件夹名称" maxlength="80" />
      <button data-action="create-folder">新建文件夹</button>
      <button class="primary" data-action="upload-files">共享文件</button>
    </section>
    <section class="content-grid local-grid">
      <div class="panel folder-panel">
        <div class="section-head">
          <h2>目录</h2>
          <span>${local.folders.length} 个</span>
        </div>
        ${renderFolderTree(local, currentFolderId)}
      </div>
      <div class="panel table-panel">
        <div class="section-head">
          <div>
            <h2>${escapeHtml(currentFolder?.name ?? "根目录")}</h2>
            <span>${childFolders.length} 个文件夹 · ${visibleFiles.length} 个文件 · ${sharedVisibleFiles} 个正在共享</span>
          </div>
          <div class="section-actions">
            <span>${formatFolderSize(visibleFiles)}</span>
            ${
              currentFolder
                ? `<button class="action-chip" data-action="rename-folder" data-folder-id="${escapeAttr(currentFolder.id)}">重命名</button>
                   <button class="action-chip danger" data-action="delete-folder" data-folder-id="${escapeAttr(currentFolder.id)}">删除文件夹</button>`
                : ""
            }
          </div>
        </div>
        ${renderBreadcrumbs(local.folders, currentFolderId)}
        ${renderSubfolders(childFolders, local)}
        ${
          visibleFiles.length
            ? `<table class="local-file-table">
                <thead>
                  <tr><th>名称</th><th>类型</th><th>大小</th><th>更新</th><th>状态</th><th>操作</th></tr>
                </thead>
                <tbody>${visibleFiles.map(renderLocalFileRow).join("")}</tbody>
              </table>`
            : `<div class="empty compact">当前目录没有文件</div>`
        }
      </div>
    </section>
  `;
}

function renderLan(): string {
  const peers = filteredPeers();
  return `
    <section class="command-bar split-bar">
      <div class="segmented">
        <button class="${state.selectedPeer === "all" ? "active" : ""}" data-peer-filter="all">全部设备</button>
        ${state.peers
          .map(
            (peer) =>
              `<button class="${state.selectedPeer === peer.deviceId ? "active" : ""}" data-peer-filter="${escapeAttr(peer.deviceId)}">${escapeHtml(peer.displayName)}</button>`
          )
          .join("")}
      </div>
      <button class="secondary" data-action="refresh" ${state.isRefreshing ? "disabled" : ""}>重新扫描</button>
    </section>
    ${
      state.peers.length
        ? `<section class="content-grid lan-grid">
            <div class="panel peer-list-panel">
              <div class="section-head">
                <h2>设备</h2>
                <span>${state.peers.length} 台在线</span>
              </div>
              ${state.peers.map(renderPeerListItem).join("")}
            </div>
            <div class="lan-results">${peers.map((peer) => renderPeerSection(peer)).join("")}</div>
          </section>`
        : `<section class="panel"><div class="empty tall">
            <strong>未发现其他设备</strong>
            <span>两台电脑需要运行同一个 exe，并允许 Windows 防火墙的专用网络访问。</span>
          </div></section>`
    }
  `;
}

function renderTransfers(): string {
  return `
    <section class="panel">
      <div class="section-head">
        <h2>下载任务</h2>
        <span>${state.downloads.length} 项</span>
      </div>
      ${
        state.downloads.length
          ? `<div class="transfer-list">${state.downloads.map(renderTransfer).join("")}</div>`
          : `<div class="empty">暂无下载任务</div>`
      }
    </section>
  `;
}

function renderSettings(): string {
  const local = requireLocal();
  return `
    <section class="panel settings-panel">
      <div class="section-head">
        <h2>本机设置</h2>
        <span>${escapeHtml(local.device.displayName)}</span>
      </div>
      <label class="setting-line">
        <span>设备名称</span>
        <input id="displayName" value="${escapeAttr(local.device.displayName)}" maxlength="80" />
      </label>
      <div class="setting-line readonly">
        <span>设备 ID</span>
        <code>${escapeHtml(local.device.deviceId)}</code>
      </div>
      <div class="setting-line readonly">
        <span>文件库路径</span>
        <code>${escapeHtml(local.device.libraryRoot)}</code>
      </div>
      <div class="setting-cards">
        <div><span>文件服务端口</span><strong>${local.device.serverPort}</strong></div>
        <div><span>设备发现端口</span><strong>${local.device.discoveryPort}</strong></div>
      </div>
      <label class="toggle-line">
        <input id="autoLaunch" type="checkbox" ${state.autoLaunch ? "checked" : ""} />
        <span>开机自动启动</span>
      </label>
      <div class="settings-actions">
        <button class="primary" data-action="save-settings">保存设置</button>
      </div>
    </section>
  `;
}

function renderFolderTree(local: LocalState, currentFolderId: string | null): string {
  const rootStats = getFolderStats(local, null);
  const rows = [
    `<button class="folder-tree-button ${currentFolderId === null ? "active" : ""}" data-action="select-folder" data-folder-id="">
      <span class="folder-depth-marker"></span>
      <div>
        <strong>根目录</strong>
        <small>${rootStats.childFolderCount} 个文件夹 · ${rootStats.fileCount} 个文件</small>
      </div>
    </button>`
  ];

  rows.push(
    ...flattenFolderTree(local.folders).map((folder) => {
      const stats = getFolderStats(local, folder.id);
      const depth = folderDepth(folder.id, local.folders);
      return `
        <button class="folder-tree-button ${currentFolderId === folder.id ? "active" : ""}" data-action="select-folder" data-folder-id="${escapeAttr(folder.id)}" style="--folder-depth:${depth}">
          <span class="folder-depth-marker"></span>
          <div>
            <strong>${escapeHtml(folder.name)}</strong>
            <small>${stats.childFolderCount} 个文件夹 · ${stats.fileCount} 个文件</small>
          </div>
        </button>
      `;
    })
  );

  return `<div class="folder-list">${rows.join("")}</div>`;
}

function renderSubfolders(childFolders: FolderRecord[], local: LocalState): string {
  if (!childFolders.length) {
    return "";
  }
  return `
    <div class="subfolder-section">
      <div class="subfolder-title">子文件夹</div>
      <div class="subfolder-grid">
        ${childFolders
          .map((folder) => {
            const stats = getFolderStats(local, folder.id);
            return `
              <button class="subfolder-card" data-action="select-folder" data-folder-id="${escapeAttr(folder.id)}">
                <span class="subfolder-icon"></span>
                <div>
                  <strong>${escapeHtml(folder.name)}</strong>
                  <small>${stats.childFolderCount} 个文件夹 · ${stats.fileCount} 个文件 · ${stats.sharedFileCount} 个共享</small>
                </div>
              </button>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderLocalFileRow(file: LocalFileRecord): string {
  const canPreview = isPreviewable(file.mimeType);
  return `
    <tr>
      <td data-label="名称">
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="file-meta">ID ${escapeHtml(file.id.slice(0, 8))}</div>
      </td>
      <td data-label="类型">${escapeHtml(file.mimeType)}</td>
      <td data-label="大小">${formatBytes(file.size)}</td>
      <td data-label="更新">${formatDate(file.updatedAt)}</td>
      <td data-label="状态"><span class="badge ${file.shared ? "ok" : "muted"}">${file.shared ? "共享中" : "已停用"}</span></td>
      <td class="row-actions" data-label="操作">
        <button class="action-chip" ${canPreview ? "" : "disabled"} data-action="preview-local" data-file-id="${escapeAttr(file.id)}">预览</button>
        ${
          file.shared
            ? `<button class="action-chip warning" data-action="unshare-file" data-file-id="${escapeAttr(file.id)}">取消共享</button>`
            : `<button class="action-chip" data-action="reshare-file" data-file-id="${escapeAttr(file.id)}">重新共享</button>`
        }
        <button class="action-chip danger" data-action="delete-file" data-file-id="${escapeAttr(file.id)}">删除</button>
      </td>
    </tr>
  `;
}

function renderPeerListItem(peer: Peer): string {
  const manifest = state.manifests.get(peer.deviceId);
  const error = state.manifestErrors.get(peer.deviceId);
  const statusClass = manifest ? "ok" : error ? "warning" : "muted";
  const statusText = manifest ? `${manifest.files.length} 个文件` : error ? "清单失败" : "同步中";
  return `
    <button class="peer-list-item ${state.selectedPeer === peer.deviceId ? "active" : ""}" data-peer-filter="${escapeAttr(peer.deviceId)}">
      <span class="peer-dot ${statusClass}"></span>
      <div>
        <strong>${escapeHtml(peer.displayName)}</strong>
        <small>${escapeHtml(peer.host)}:${peer.port}</small>
      </div>
      <em>${escapeHtml(statusText)}</em>
    </button>
  `;
}

function renderPeerSection(peer: Peer): string {
  const manifest = state.manifests.get(peer.deviceId);
  const error = state.manifestErrors.get(peer.deviceId);

  if (!manifest) {
    return `
      <section class="panel table-panel">
        <div class="section-head">
          <div>
            <h2>${escapeHtml(peer.displayName)}</h2>
            <span>${escapeHtml(peer.host)}:${peer.port} · ${formatAge(peer.lastSeen)}</span>
          </div>
          <span class="badge warning">清单不可用</span>
        </div>
        <div class="empty">
          ${error ? `连接失败：${escapeHtml(error)}` : "正在读取共享清单"}
        </div>
      </section>
    `;
  }

  return `
    <section class="panel table-panel">
      <div class="section-head">
        <div>
          <h2>${escapeHtml(peer.displayName)}</h2>
          <span>${escapeHtml(peer.host)}:${peer.port} · ${manifest.files.length} 个共享文件</span>
        </div>
        <span class="badge ok">在线</span>
      </div>
      ${
        manifest.files.length
          ? `<table class="remote-file-table">
              <thead>
                <tr><th>名称</th><th>位置</th><th>大小</th><th>更新</th><th>操作</th></tr>
              </thead>
              <tbody>${manifest.files.map((file) => renderRemoteFileRow(peer, file, manifest.folders)).join("")}</tbody>
            </table>`
          : `<div class="empty">这台设备当前没有共享文件</div>`
      }
    </section>
  `;
}

function renderRemoteFileRow(peer: Peer, file: RemoteFileRecord, folders: FolderRecord[]): string {
  const canPreview = isPreviewable(file.mimeType);
  return `
    <tr>
      <td data-label="名称">
        <div class="file-name">${escapeHtml(file.name)}</div>
        <div class="file-meta">${escapeHtml(file.mimeType)}</div>
      </td>
      <td data-label="位置">${escapeHtml(file.folderId ? folderPath(file.folderId, folders) : "根目录")}</td>
      <td data-label="大小">${formatBytes(file.size)}</td>
      <td data-label="更新">${formatDate(file.updatedAt)}</td>
      <td class="row-actions" data-label="操作">
        <button class="action-chip" ${canPreview ? "" : "disabled"} data-action="preview-remote" data-peer-id="${escapeAttr(peer.deviceId)}" data-file-id="${escapeAttr(file.id)}">预览</button>
        <button class="action-chip primary" data-action="download-file" data-peer-id="${escapeAttr(peer.deviceId)}" data-file-id="${escapeAttr(file.id)}">下载</button>
      </td>
    </tr>
  `;
}

function renderTransfer(task: DownloadTask): string {
  const progress = task.totalBytes > 0 ? Math.min(100, (task.receivedBytes / task.totalBytes) * 100) : 0;
  return `
    <div class="transfer-item">
      <div class="transfer-main">
        <div>
          <div class="file-name">${escapeHtml(task.fileName)}</div>
          <div class="file-meta">${escapeHtml(task.peerName)} · ${escapeHtml(task.savePath)}</div>
        </div>
        <span class="badge ${task.status === "completed" ? "ok" : task.status === "failed" ? "warning" : "running"}">${statusLabel(task.status)}</span>
      </div>
      <div class="progress"><div style="width:${progress}%"></div></div>
      <div class="transfer-meta">
        <span>${formatBytes(task.receivedBytes)} / ${formatBytes(task.totalBytes)}</span>
        <span>${task.status === "running" ? `${formatBytes(task.speedBytesPerSecond)}/s` : task.error ? escapeHtml(task.error) : ""}</span>
        ${task.status === "failed" ? `<button data-action="retry-download" data-download-id="${escapeAttr(task.id)}">重试</button>` : ""}
      </div>
    </div>
  `;
}

function renderPreviewModal(preview: PreviewTarget): string {
  return `
    <div class="modal-backdrop preview-backdrop">
      <div class="preview-modal">
        <div class="preview-head">
          <div>
            <h2>${escapeHtml(preview.title)}</h2>
            <span>${escapeHtml(preview.mimeType)}</span>
          </div>
          <button class="icon-button" data-action="close-preview" title="关闭">x</button>
        </div>
        <div class="preview-body">${renderPreviewBody(preview)}</div>
      </div>
    </div>
  `;
}

function renderDialogModal(dialog: DialogState): string {
  if (dialog.type === "rename-folder") {
    return `
      <div class="modal-backdrop dialog-backdrop">
        <div class="dialog-modal">
          <div class="dialog-head">
            <h2>重命名文件夹</h2>
            <span>${escapeHtml(dialog.folderName)}</span>
          </div>
          <label class="dialog-field">
            <span>文件夹名称</span>
            <input id="dialogFolderName" value="${escapeAttr(dialog.folderName)}" maxlength="80" />
          </label>
          <div class="dialog-actions">
            <button data-action="dialog-cancel">取消</button>
            <button class="primary" data-action="dialog-confirm">保存</button>
          </div>
        </div>
      </div>
    `;
  }

  const isFolder = dialog.type === "delete-folder";
  return `
    <div class="modal-backdrop dialog-backdrop">
      <div class="dialog-modal">
        <div class="dialog-head">
          <h2>${isFolder ? "删除文件夹" : "删除文件"}</h2>
          <span>${escapeHtml(isFolder ? dialog.folderName : dialog.fileName)}</span>
        </div>
        <div class="dialog-copy">
          ${
            isFolder
              ? "该文件夹、所有子文件夹和文件都会从软件中隐藏。磁盘上的文件副本不会被物理删除。"
              : "该文件会从软件中隐藏，不再出现在本机列表和局域网共享清单中。磁盘上的文件副本不会被物理删除。"
          }
        </div>
        <div class="dialog-actions">
          <button data-action="dialog-cancel">取消</button>
          <button class="danger-button" data-action="dialog-confirm">删除</button>
        </div>
      </div>
    </div>
  `;
}

function renderPreviewBody(preview: PreviewTarget): string {
  const url = escapeAttr(preview.url);
  if (preview.mimeType.startsWith("image/")) {
    return `<img class="preview-image" src="${url}" alt="${escapeAttr(preview.title)}" />`;
  }
  if (preview.mimeType === "application/pdf") {
    return `<iframe class="preview-frame" src="${url}" title="${escapeAttr(preview.title)}"></iframe>`;
  }
  if (preview.mimeType.startsWith("video/")) {
    return `<video class="preview-media" src="${url}" controls></video>`;
  }
  if (preview.mimeType.startsWith("audio/")) {
    return `<audio class="preview-audio" src="${url}" controls></audio>`;
  }
  if (preview.mimeType.startsWith("text/") || preview.mimeType.includes("json") || preview.mimeType.includes("xml")) {
    return `<iframe class="preview-frame" src="${url}" title="${escapeAttr(preview.title)}"></iframe>`;
  }
  return `<div class="empty">此格式不支持预览</div>`;
}

function bindEvents(): void {
  appRoot.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tab = button.dataset.tab as TabId;
      render();
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="refresh"]').forEach((button) => {
    button.addEventListener("click", () => {
      void action(refreshEverything);
    });
  });

  appRoot.querySelector<HTMLButtonElement>('[data-action="create-folder"]')?.addEventListener("click", () => {
    void action(async () => {
      const input = appRoot.querySelector<HTMLInputElement>("#folderName");
      await window.lanShare.createFolder({ name: input?.value ?? "", parentId: getCurrentFolderId(requireLocal()) });
      if (input) {
        input.value = "";
      }
      await refreshLocal(false);
      state.notice = "文件夹已创建。";
    });
  });

  appRoot.querySelector<HTMLButtonElement>('[data-action="upload-files"]')?.addEventListener("click", () => {
    void action(async () => {
      await window.lanShare.chooseAndUploadFiles({ folderId: getCurrentFolderId(requireLocal()) });
      await refreshLocal(false);
      state.notice = "文件已加入共享。";
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="select-folder"]').forEach((button) => {
    button.addEventListener("click", () => {
      state.currentFolderId = button.dataset.folderId || null;
      render();
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="rename-folder"]').forEach((button) => {
    button.addEventListener("click", () => {
      const folderId = requireDataset(button, "folderId");
      const folder = requireLocal().folders.find((item) => item.id === folderId);
      if (!folder) {
        state.error = "文件夹不存在。";
        render();
        return;
      }
      openDialog({ type: "rename-folder", folderId, folderName: folder.name });
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="delete-folder"]').forEach((button) => {
    button.addEventListener("click", () => {
      const folderId = requireDataset(button, "folderId");
      const folder = requireLocal().folders.find((item) => item.id === folderId);
      if (!folder) {
        state.error = "文件夹不存在。";
        render();
        return;
      }
      openDialog({ type: "delete-folder", folderId, folderName: folder.name, parentId: folder.parentId });
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="unshare-file"]').forEach((button) => {
    button.addEventListener("click", () => {
      void action(async () => {
        await window.lanShare.unshareFile(requireDataset(button, "fileId"));
        await refreshLocal(false);
        state.notice = "文件已取消共享，并移动到“未共享”。";
      });
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="reshare-file"]').forEach((button) => {
    button.addEventListener("click", () => {
      void action(async () => {
        await window.lanShare.reshareFile(requireDataset(button, "fileId"));
        await refreshLocal(false);
        state.notice = "文件已重新共享。";
      });
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="delete-file"]').forEach((button) => {
    button.addEventListener("click", () => {
      const fileId = requireDataset(button, "fileId");
      const file = requireLocal().files.find((item) => item.id === fileId);
      if (!file) {
        state.error = "文件不存在。";
        render();
        return;
      }
      openDialog({ type: "delete-file", fileId, fileName: file.name });
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>("[data-peer-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedPeer = button.dataset.peerFilter ?? "all";
      render();
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="preview-local"]').forEach((button) => {
    button.addEventListener("click", () => {
      void action(async () => {
        const file = requireLocal().files.find((item) => item.id === requireDataset(button, "fileId"));
        if (!file) {
          throw new Error("文件不存在。");
        }
        const url = await window.lanShare.getLocalContentUrl(file.id);
        state.preview = { title: file.name, mimeType: file.mimeType, url };
      });
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="preview-remote"]').forEach((button) => {
    button.addEventListener("click", () => {
      void action(async () => {
        const peerId = requireDataset(button, "peerId");
        const fileId = requireDataset(button, "fileId");
        const manifest = state.manifests.get(peerId);
        const file = manifest?.files.find((item) => item.id === fileId);
        if (!file) {
          throw new Error("文件不存在。");
        }
        const url = await window.lanShare.getRemoteContentUrl(peerId, fileId);
        state.preview = { title: file.name, mimeType: file.mimeType, url };
      });
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="download-file"]').forEach((button) => {
    button.addEventListener("click", () => {
      void action(async () => {
        const task = await window.lanShare.startDownload(requireDataset(button, "peerId"), requireDataset(button, "fileId"));
        if (task) {
          state.tab = "transfers";
          await refreshDownloads(false);
        }
      });
    });
  });

  appRoot.querySelectorAll<HTMLButtonElement>('[data-action="retry-download"]').forEach((button) => {
    button.addEventListener("click", () => {
      void action(async () => {
        await window.lanShare.retryDownload(requireDataset(button, "downloadId"));
        await refreshDownloads(false);
      });
    });
  });

  appRoot.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.addEventListener("click", () => {
    void action(async () => {
      const displayName = appRoot.querySelector<HTMLInputElement>("#displayName")?.value ?? "";
      await window.lanShare.updateSettings({ displayName });
      await refreshLocal(false);
      state.notice = "设置已保存。";
    });
  });

  appRoot.querySelector<HTMLInputElement>("#autoLaunch")?.addEventListener("change", (event) => {
    void action(async () => {
      state.autoLaunch = await window.lanShare.setAutoLaunch((event.currentTarget as HTMLInputElement).checked);
    });
  });

  appRoot.querySelector<HTMLButtonElement>('[data-action="dialog-cancel"]')?.addEventListener("click", closeDialog);
  appRoot.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]')?.addEventListener("click", () => {
    void action(confirmDialog);
  });

  appRoot.querySelector<HTMLInputElement>("#dialogFolderName")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void action(confirmDialog);
    }
    if (event.key === "Escape") {
      closeDialog();
    }
  });

  appRoot.querySelector<HTMLDivElement>(".dialog-backdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closeDialog();
    }
  });

  appRoot.querySelector<HTMLDivElement>(".preview-backdrop")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      closePreview();
    }
  });
  appRoot.querySelector<HTMLButtonElement>('[data-action="close-preview"]')?.addEventListener("click", closePreview);
}

async function action(work: () => Promise<void>): Promise<void> {
  try {
    state.error = null;
    state.notice = null;
    await work();
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    render();
  }
}

function closePreview(): void {
  state.preview = null;
  render();
}

function openDialog(dialog: DialogState): void {
  state.dialog = dialog;
  state.error = null;
  state.notice = null;
  render();
  window.setTimeout(() => {
    const input = appRoot.querySelector<HTMLInputElement>("#dialogFolderName");
    input?.focus();
    input?.select();
  }, 0);
}

function closeDialog(): void {
  state.dialog = null;
  render();
}

async function confirmDialog(): Promise<void> {
  const dialog = state.dialog;
  if (!dialog) {
    return;
  }

  if (dialog.type === "rename-folder") {
    const name = appRoot.querySelector<HTMLInputElement>("#dialogFolderName")?.value ?? "";
    await window.lanShare.renameFolder({ folderId: dialog.folderId, name });
    state.dialog = null;
    await refreshLocal(false);
    state.notice = "文件夹已重命名。";
    return;
  }

  if (dialog.type === "delete-folder") {
    state.currentFolderId = dialog.parentId;
    await window.lanShare.deleteFolder(dialog.folderId);
    state.dialog = null;
    await refreshLocal(false);
    state.notice = "文件夹已删除。";
    return;
  }

  await window.lanShare.deleteFile(dialog.fileId);
  state.dialog = null;
  await refreshLocal(false);
  state.notice = "文件已删除。";
}

function requireLocal(): LocalState {
  if (!state.local) {
    throw new Error("本机状态尚未加载。");
  }
  return state.local;
}

function requireDataset(element: HTMLElement, key: string): string {
  const value = element.dataset[key];
  if (!value) {
    throw new Error(`Missing dataset value: ${key}`);
  }
  return value;
}

function filteredPeers(): Peer[] {
  if (state.selectedPeer === "all") {
    return state.peers;
  }
  return state.peers.filter((peer) => peer.deviceId === state.selectedPeer);
}

function normalizeSelectedPeer(): void {
  if (state.selectedPeer !== "all" && !state.peers.some((peer) => peer.deviceId === state.selectedPeer)) {
    state.selectedPeer = "all";
  }
}

function normalizeCurrentFolder(): void {
  if (!state.local) {
    return;
  }
  if (state.currentFolderId && !state.local.folders.some((folder) => folder.id === state.currentFolderId)) {
    state.currentFolderId = null;
  }
}

function getCurrentFolderId(local: LocalState): string | null {
  if (!state.currentFolderId) {
    return null;
  }
  return local.folders.some((folder) => folder.id === state.currentFolderId) ? state.currentFolderId : null;
}

function flattenFolderTree(folders: FolderRecord[], parentId: string | null = null, seen = new Set<string>()): FolderRecord[] {
  const result: FolderRecord[] = [];
  for (const folder of getChildFolders(folders, parentId)) {
    if (seen.has(folder.id)) {
      continue;
    }
    seen.add(folder.id);
    result.push(folder, ...flattenFolderTree(folders, folder.id, seen));
  }
  return result;
}

function getChildFolders(folders: FolderRecord[], parentId: string | null): FolderRecord[] {
  return folders
    .filter((folder) => folder.parentId === parentId)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function getFolderStats(local: LocalState, folderId: string | null): {
  childFolderCount: number;
  fileCount: number;
  sharedFileCount: number;
} {
  const files = local.files.filter((file) => file.folderId === folderId);
  return {
    childFolderCount: local.folders.filter((folder) => folder.parentId === folderId).length,
    fileCount: files.length,
    sharedFileCount: files.filter((file) => file.shared).length
  };
}

function folderDepth(folderId: string, folders: FolderRecord[]): number {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let depth = 1;
  let current = byId.get(folderId);
  while (current?.parentId) {
    depth += 1;
    current = byId.get(current.parentId);
    if (depth > 24) {
      break;
    }
  }
  return depth;
}

function renderBreadcrumbs(folders: FolderRecord[], currentFolderId: string | null): string {
  const trail: Array<{ id: string | null; name: string }> = [{ id: null, name: "根目录" }];
  if (currentFolderId) {
    for (const folder of folderAncestors(currentFolderId, folders)) {
      trail.push({ id: folder.id, name: folder.name });
    }
  }

  return `
    <div class="breadcrumbs">
      ${trail
        .map(
          (item, index) => `
            ${index > 0 ? `<span class="breadcrumb-separator">/</span>` : ""}
            <button class="${item.id === currentFolderId ? "active" : ""}" data-action="select-folder" data-folder-id="${escapeAttr(item.id ?? "")}">
              ${escapeHtml(item.name)}
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function folderAncestors(folderId: string, folders: FolderRecord[]): FolderRecord[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: FolderRecord[] = [];
  let current = byId.get(folderId);
  while (current) {
    trail.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    if (trail.length > 24) {
      break;
    }
  }
  return trail;
}

function formatFolderSize(files: LocalFileRecord[]): string {
  return `${formatBytes(files.reduce((total, file) => total + file.size, 0))}`;
}

function activeDownloads(): number {
  return state.downloads.filter((task) => task.status === "queued" || task.status === "running").length;
}

function tabTitle(tab: TabId): string {
  if (tab === "mine") return "我的文件";
  if (tab === "lan") return "局域网";
  if (tab === "transfers") return "传输";
  return "设置";
}

function folderPath(folderId: string, folders: FolderRecord[]): string {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const parts: string[] = [];
  let current = byId.get(folderId);
  while (current) {
    parts.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return parts.join(" / ") || "根目录";
}

function isPreviewable(mimeType: string): boolean {
  return (
    mimeType.startsWith("image/") ||
    mimeType.startsWith("text/") ||
    mimeType.startsWith("audio/") ||
    mimeType.startsWith("video/") ||
    mimeType === "application/pdf" ||
    mimeType.includes("json") ||
    mimeType.includes("xml")
  );
}

function statusLabel(status: DownloadTask["status"]): string {
  if (status === "queued") return "等待";
  if (status === "running") return "下载中";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  return "已取消";
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatAge(lastSeen: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
  if (seconds < 2) {
    return "刚刚在线";
  }
  return `${seconds} 秒前在线`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
