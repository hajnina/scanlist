/**
 * React binding for {@linkcode SettingsController} (card A6): one subscription and the two effects
 * the screen owns.
 *
 * The run effect is keyed by `(choice, runToken)` — B6's `LaunchedEffect(state.choice, state.runToken)`.
 * A ref holds the last key so React 19 StrictMode's double mount cannot queue two identical
 * self-tests (they would serialise, doubling a 484 MB model load for nothing).
 */
import {useEffect, useRef, useState} from 'react';
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
  const lastRunKey = useRef<string | null>(null);

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
    if (!snapshot.ready) {
      return;
    }
    const key = `${snapshot.choice}:${snapshot.runToken}`;
    if (lastRunKey.current === key) {
      return;
    }
    lastRunKey.current = key;
    controller.run().catch(() => {
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
