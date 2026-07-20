import type { LanShareApi } from "../main/preload";

declare global {
  interface Window {
    lanShare: LanShareApi;
  }
}

export {};
