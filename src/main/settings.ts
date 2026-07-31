import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { v4 as uuidv4 } from "uuid";
import { AppDatabase } from "./database";
import { DEFAULT_HTTP_PORT, DISCOVERY_PORT } from "./constants";
import type { DeviceInfo } from "../shared/types";

interface SettingRow {
  key: string;
  value: string;
}

export class SettingsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly documentsPath: string
  ) {}

  async init(): Promise<void> {
    await this.ensureSetting("deviceId", uuidv4());
    await this.ensureSetting("displayName", `${os.userInfo().username}@${os.hostname()}`);
    await this.ensureSetting("libraryRoot", path.join(this.documentsPath, "LanShareLibrary"));
    await this.ensureSetting("preferredPort", String(DEFAULT_HTTP_PORT));
    await this.ensureSetting("indexVersion", String(Date.now()));
    await this.ensureSetting("minimizeOnClose", "true");
    await mkdir(this.getLibraryRoot(), { recursive: true });
  }

  getDevice(serverPort: number): DeviceInfo {
    return {
      deviceId: this.getSetting("deviceId"),
      displayName: this.getSetting("displayName"),
      libraryRoot: this.getLibraryRoot(),
      serverPort,
      discoveryPort: DISCOVERY_PORT,
      minimizeOnClose: this.getMinimizeOnClose()
    };
  }

  getDeviceId(): string {
    return this.getSetting("deviceId");
  }

  getDisplayName(): string {
    return this.getSetting("displayName");
  }

  getLibraryRoot(): string {
    return this.getSetting("libraryRoot");
  }

  getPreferredPort(): number {
    return Number(this.getSetting("preferredPort")) || DEFAULT_HTTP_PORT;
  }

  getIndexVersion(): number {
    return Number(this.getSetting("indexVersion")) || Date.now();
  }

  getMinimizeOnClose(): boolean {
    return this.getSetting("minimizeOnClose") !== "false";
  }

  async setServerPort(port: number): Promise<void> {
    await this.setSetting("preferredPort", String(port));
  }

  async updateDisplayName(displayName: string): Promise<void> {
    const clean = displayName.trim();
    if (!clean) {
      throw new Error("设备名称不能为空。");
    }
    await this.setSetting("displayName", clean);
    await this.bumpIndexVersion();
  }

  async updateMinimizeOnClose(enabled: boolean): Promise<void> {
    await this.setSetting("minimizeOnClose", enabled ? "true" : "false");
  }

  async bumpIndexVersion(): Promise<number> {
    const next = Date.now();
    await this.setSetting("indexVersion", String(next));
    return next;
  }

  private async ensureSetting(key: string, defaultValue: string): Promise<void> {
    if (this.db.get<SettingRow>("SELECT key, value FROM settings WHERE key = ?", [key])) {
      return;
    }
    await this.setSetting(key, defaultValue);
  }

  private getSetting(key: string): string {
    const row = this.db.get<SettingRow>("SELECT key, value FROM settings WHERE key = ?", [key]);
    if (!row) {
      throw new Error(`Missing setting: ${key}`);
    }
    return row.value;
  }

  private async setSetting(key: string, value: string): Promise<void> {
    await this.db.run(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [key, value]
    );
  }
}
