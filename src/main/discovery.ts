import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import os from "node:os";
import type { LibraryManifest, Peer, PublicDevice } from "../shared/types";
import { DISCOVERY_INTERVAL_MS, DISCOVERY_PORT, PEER_TTL_MS, PROTOCOL_VERSION } from "./constants";

interface Announcement {
  type: "lan-share:announce";
  protocolVersion: number;
  deviceId: string;
  displayName: string;
  port: number;
  indexVersion: number;
  sentAt: number;
}

export class DiscoveryService extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly peers = new Map<string, Peer>();

  constructor(
    private readonly getLocalDevice: () => PublicDevice,
    private readonly getIndexVersion: () => number
  ) {
    super();
  }

  start(): void {
    if (this.socket) {
      return;
    }

    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket.on("message", (message, rinfo) => this.handleMessage(message, rinfo.address));
    this.socket.bind(DISCOVERY_PORT, "0.0.0.0", () => {
      this.socket?.setBroadcast(true);
      this.broadcastNow();
      setTimeout(() => this.broadcastNow(), 600);
      setTimeout(() => this.broadcastNow(), 1600);
    });

    this.broadcastTimer = setInterval(() => this.broadcastNow(), DISCOVERY_INTERVAL_MS);
    this.pruneTimer = setInterval(() => this.prunePeers(), 1000);
  }

  stop(): void {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
    }
    this.socket?.close();
    this.socket = null;
    this.broadcastTimer = null;
    this.pruneTimer = null;
  }

  broadcastNow(): void {
    if (!this.socket) {
      return;
    }
    const local = this.getLocalDevice();
    const announcement: Announcement = {
      type: "lan-share:announce",
      protocolVersion: PROTOCOL_VERSION,
      deviceId: local.deviceId,
      displayName: local.displayName,
      port: local.serverPort,
      indexVersion: this.getIndexVersion(),
      sentAt: Date.now()
    };
    const payload = Buffer.from(JSON.stringify(announcement));
    for (const target of getBroadcastTargets()) {
      this.socket.send(payload, DISCOVERY_PORT, target, () => undefined);
    }
  }

  getPeers(): Peer[] {
    return [...this.peers.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  getPeer(deviceId: string): Peer | null {
    return this.peers.get(deviceId) ?? null;
  }

  async fetchManifest(deviceId: string): Promise<LibraryManifest> {
    const peer = this.getPeer(deviceId);
    if (!peer) {
      throw new Error("设备已离线。");
    }
    return fetchJson<LibraryManifest>(`http://${peer.host}:${peer.port}/manifest`, 3500);
  }

  getContentUrl(deviceId: string, fileId: string): string {
    const peer = this.getPeer(deviceId);
    if (!peer) {
      throw new Error("设备已离线。");
    }
    return `http://${peer.host}:${peer.port}/files/${encodeURIComponent(fileId)}/content`;
  }

  private handleMessage(message: Buffer, host: string): void {
    let announcement: Announcement;
    try {
      announcement = JSON.parse(message.toString("utf8")) as Announcement;
    } catch {
      return;
    }

    const local = this.getLocalDevice();
    if (
      announcement.type !== "lan-share:announce" ||
      announcement.protocolVersion !== PROTOCOL_VERSION ||
      announcement.deviceId === local.deviceId ||
      !announcement.deviceId ||
      !announcement.port
    ) {
      return;
    }

    const previous = this.peers.get(announcement.deviceId);
    const next: Peer = {
      deviceId: announcement.deviceId,
      displayName: announcement.displayName,
      host,
      port: announcement.port,
      lastSeen: Date.now(),
      indexVersion: announcement.indexVersion
    };
    this.peers.set(announcement.deviceId, next);

    if (
      !previous ||
      previous.host !== next.host ||
      previous.port !== next.port ||
      previous.displayName !== next.displayName ||
      previous.indexVersion !== next.indexVersion
    ) {
      this.emit("updated", this.getPeers());
    }
  }

  private prunePeers(): void {
    const now = Date.now();
    let changed = false;
    for (const [deviceId, peer] of this.peers) {
      if (now - peer.lastSeen > PEER_TTL_MS) {
        this.peers.delete(deviceId);
        changed = true;
      }
    }
    if (changed) {
      this.emit("updated", this.getPeers());
    }
  }
}

function getBroadcastTargets(): string[] {
  const targets = new Set<string>(["255.255.255.255"]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) {
        continue;
      }
      const broadcast = getSubnetBroadcast(entry.address, entry.netmask);
      if (broadcast) {
        targets.add(broadcast);
      }
    }
  }
  return [...targets];
}

function getSubnetBroadcast(address: string, netmask: string): string | null {
  const addressNumber = ipv4ToNumber(address);
  const maskNumber = ipv4ToNumber(netmask);
  if (addressNumber === null || maskNumber === null) {
    return null;
  }
  const broadcast = (addressNumber | (~maskNumber >>> 0)) >>> 0;
  return numberToIpv4(broadcast);
}

function ipv4ToNumber(value: string): number | null {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function numberToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ].join(".");
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
