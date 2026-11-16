/**
 * Settings (backend choice: NPU → GPU → CPU, precedence, smoothing α, hysteresis).
 *
 * Card A1: the defaults from docs/ARCHITECTURE.md as a typed shape; no persistence yet.
 */
export type EmbedBackend = 'auto' | 'npu' | 'gpu' | 'cpu';

export interface Settings {
  /** Preferred embedding backend; `auto` = NPU → GPU → CPU ladder. */
  backend: EmbedBackend;
  /** Matryoshka truncation (768 / 512 / 256 / 128). */
  dims: 768 | 512 | 256 | 128;
  /** EMA smoothing for scan scores. */
  smoothingAlpha: number;
  /** The top item only changes when its smoothed score beats the current top by this margin. */
  hysteresis: number;
  /** Theme follows the system (style guide §2) unless this is switched off in a later card. */
  followSystemDarkMode: boolean;
}

export const defaultSettings: Settings = {
  backend: 'auto',
  dims: 256,
  smoothingAlpha: 0.5,
  hysteresis: 0.02,
  followSystemDarkMode: true,
};

export const settingsPlaceholder = 'settings screen lands in a later card';
