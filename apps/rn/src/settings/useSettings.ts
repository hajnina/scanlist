/**
 * React binding for {@linkcode SettingsController} (card A6): one subscription and the two effects
 * the screen owns.
 *
 * The run effect calls `controller.runIfNeeded()`; the `(choice, runToken)` guard lives on the
 * controller, so React 19 StrictMode's double mount cannot queue two identical self-tests AND a
 * screen remount (leave Settings → come back) does not re-open the model (A6-followup review).
 */
import {useEffect, useState} from 'react';
import type {BackendChoice, NativeBackend} from './backend';
import type {SettingsController, SettingsSnapshot} from './state';

export interface UseSettingsResult {
  snapshot: SettingsSnapshot;
  select: (choice: BackendChoice) => void;
  rerun: () => void;
  setHaptics: (enabled: boolean) => void;
  /** Runtime backend of the last successful run (`none` before the first one). */
  activeBackend: () => NativeBackend;
}

export function useSettings(controller: SettingsController): UseSettingsResult {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(() =>
    controller.getSnapshot(),
  );

  useEffect(() => {
    setSnapshot(controller.getSnapshot());
    return controller.subscribe(setSnapshot);
  }, [controller]);

  useEffect(() => {
    controller.init().catch(() => {
      // `init` never throws in practice (probe failures land in `snapshot.error`), but a hook must
      // not surface an unhandled rejection either way.
    });
  }, [controller]);

  useEffect(() => {
    // The `(choice, runToken)` guard is controller-owned (A6-followup review): a per-mount ref here
    // forgot the last run when the screen unmounted, so returning to Settings re-opened the model.
    controller.runIfNeeded().catch(() => {
      // A run never rejects (failures are outcomes); this is belt-and-braces for the effect.
    });
  }, [controller, snapshot.ready, snapshot.choice, snapshot.runToken]);

  return {
    snapshot,
    select: controller.select,
    rerun: controller.rerun,
    setHaptics: controller.setHaptics,
    activeBackend: controller.activeBackend,
  };
}
