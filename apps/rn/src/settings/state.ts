/**
 * The settings controller (card A6) — the RN twin of B6's `SettingsState.kt`.
 *
 * Plain TypeScript, no React: the screen subscribes and calls one method per action, so every rule
 * here (persistence, stale-number clearing, run serialisation) is a Jest unit test. The UI half is
 * `SettingsScreen.tsx` / `useSettings.ts`.
 *
 * Two B6 review lessons are structural here:
 *
 *  - **Serialised runs.** The self-test opens a 484 MB model; a backend switch mid-run cancels the
 *    screen's effect but cannot cancel the in-flight probe. A promise chain makes the next run wait
 *    for the current one, then measure the CURRENT choice — switching never strands the RUNNING
 *    phase and never overlaps two engines (~0.5 GB each).
 *  - **Stale numbers are dropped.** `select()`/`rerun()` bump a generation counter; a run that
 *    finishes after a switch returns its result to nobody, so the latency card can never show a
 *    measurement taken on a backend the picker no longer displays.
 */
import {
  DEFAULT_BACKEND,
  parseBackendChoice,
  parseNativeBackend,
  type BackendChoice,
  type NativeBackend,
} from './backend';
import {E_EMBEDDER, type SelfTestOutcome, type SelfTestRunner} from './latency';
import {
  modelStatusFromFacts,
  type ModelFileFacts,
  type ModelStatus,
} from './modelStatus';
import type {PrefixInfo} from './prefix';
import type {SettingsRepository} from './store';
import {setHapticsEnabled} from '../ui/haptics';

/** Lifecycle of the self-test: idle before the first run, running, done with a result. */
export type SettingsPhase = 'idle' | 'running' | 'done';

/** Everything the screen renders, in one immutable snapshot. */
export interface SettingsSnapshot {
  /** True once the stored settings + probes have been loaded (the screen can render). */
  ready: boolean;
  /** The picker selection (`auto` by default). */
  choice: BackendChoice;
  haptics: boolean;
  phase: SettingsPhase;
  /** The last run's outcome; `null` after a switch/rerun (the numbers were for another choice). */
  result: SelfTestOutcome | null;
  /** The bundle the embedding pipeline opens, or null while probing / after a probe failure. */
  model: ModelStatus | null;
  /** The active prefix set from the bundled prompts.json; null when unavailable. */
  prefixes: PrefixInfo | null;
  /** The package-specific push command when the native module reported one. */
  modelHint: string | null;
  /** The first probe error, shown as a hint next to the affected card. Never a crash. */
  error: string | null;
  /** Bumped by {@linkcode SettingsController.rerun} so the screen re-embeds the same choice. */
  runToken: number;
}

/** Everything device-specific is injected (tests use fakes; `device.ts` wires the app). */
export interface SettingsDeps {
  repository: SettingsRepository;
  runner: SelfTestRunner;
  /** File facts of the bundle the pipeline opens (native `status()` in the app). */
  probeModel: () => Promise<ModelFileFacts>;
  /** The prefix set the engine reads; `null` when the asset/bridge is unavailable. */
  probePrefixes: () => Promise<PrefixInfo | null>;
  /** Optional native push command for the missing-model hint. */
  probeModelHint?: () => Promise<string | null>;
  /** Defaults to the UI kit's global switch (`ui/haptics`). */
  applyHaptics?: (enabled: boolean) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const INITIAL: SettingsSnapshot = {
  ready: false,
  choice: DEFAULT_BACKEND,
  haptics: true,
  phase: 'idle',
  result: null,
  model: null,
  prefixes: null,
  modelHint: null,
  error: null,
  runToken: 0,
};

export class SettingsController {
  private snapshot: SettingsSnapshot = {...INITIAL};
  private readonly listeners = new Set<(snapshot: SettingsSnapshot) => void>();
  private initPromise: Promise<void> | null = null;

  /** The promise chain that serialises self-test runs (B6's mutex). */
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * The `(choice, runToken)` pair a run was last started for. Controller-owned on purpose: the
   * screen unmounts when the user leaves Settings, and a per-mount ref would forget this and pay a
   * second 484 MB model open on the next visit (A6-followup review).
   */
  private lastRunKey: string | null = null;

  /** Increments on every switch/rerun: an older run's result is stale and must be dropped. */
  private generation = 0;

  constructor(private readonly deps: SettingsDeps) {
    // Methods are passed straight to `onPress`/`useEffect` by the screen, so keep their `this`.
    this.init = this.init.bind(this);
    this.select = this.select.bind(this);
    this.run = this.run.bind(this);
    this.runIfNeeded = this.runIfNeeded.bind(this);
    this.rerun = this.rerun.bind(this);
    this.setHaptics = this.setHaptics.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.getSnapshot = this.getSnapshot.bind(this);
    this.activeBackend = this.activeBackend.bind(this);
  }

  getSnapshot(): SettingsSnapshot {
    return this.snapshot;
  }

  /** Subscribe to real changes only; returns the unsubscribe function. */
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Load the stored settings and probe the model + prefix set. Idempotent (StrictMode double effect). */
  init(): Promise<void> {
    if (this.initPromise === null) {
      this.initPromise = this.load();
    }
    return this.initPromise;
  }

  /**
   * Pick a backend: persist it, drop the old measurement and invalidate an in-flight run. The
   * screen's effect then calls {@linkcode run} (B6's `LaunchedEffect(choice)`).
   */
  select(next: BackendChoice): void {
    const choice = parseBackendChoice(next);
    if (choice === this.snapshot.choice) {
      return;
    }
    this.generation += 1;
    this.update({choice, phase: 'idle', result: null});
    this.persist(this.deps.repository.setBackend(choice));
  }

  /**
   * Run the self-test on the current choice. Runs are serialised: a call made while another run is
   * in flight waits, then measures the choice current *at that moment*. Never throws (a runner
   * failure becomes an `E_EMBEDDER` outcome).
   */
  run(): Promise<void> {
    const generation = this.generation;
    const task = this.chain.then(async () => {
      if (generation !== this.generation) {
        // Superseded while queued: the newer run (or the switch) owns the screen state.
        return;
      }
      const choice = this.snapshot.choice;
      this.update({phase: 'running', result: null});

      let outcome: SelfTestOutcome;
      try {
        outcome = await this.deps.runner.selfTest(choice);
      } catch (error) {
        outcome = {
          ok: false,
          choice,
          code: E_EMBEDDER,
          message: messageOf(error),
        };
      }

      if (generation !== this.generation) {
        // The user switched while we measured: drop numbers that belong to the old backend.
        return;
      }
      this.update({phase: 'done', result: outcome});
      await this.refreshModel();
    });
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** "Test again": same choice, fresh numbers (the engine may have been unloaded since). */
  rerun(): void {
    this.generation += 1;
    this.update({
      phase: 'idle',
      result: null,
      runToken: this.snapshot.runToken + 1,
    });
  }

  /**
   * Run only if the current `(choice, runToken)` has not been measured yet — the screen's effect
   * path. The key lives on the controller, so leaving Settings and returning (a remount with the
   * same controller) reuses the measurement instead of opening the 484 MB model again; a switch or
   * "test again" still changes the key and runs. A not-yet-loaded controller does nothing (the
   * effect fires again once `ready` flips).
   */
  runIfNeeded(): Promise<void> {
    if (!this.snapshot.ready) {
      return Promise.resolve();
    }
    const key = `${this.snapshot.choice}:${this.snapshot.runToken}`;
    if (this.lastRunKey === key) {
      return Promise.resolve();
    }
    this.lastRunKey = key;
    return this.run();
  }

  /** Flip haptics: apply immediately (the switch must feel instant) and persist in the background. */
  setHaptics(enabled: boolean): void {
    if (enabled === this.snapshot.haptics) {
      return;
    }
    this.update({haptics: enabled});
    (this.deps.applyHaptics ?? setHapticsEnabled)(enabled);
    this.persist(this.deps.repository.setHaptics(enabled));
  }

  /** The runtime backend of the last successful run, `none` before the first one. */
  activeBackend(): NativeBackend {
    const result = this.snapshot.result;
    return result !== null && result.ok
      ? parseNativeBackend(result.report.backend)
      : 'none';
  }

  // ------------------------------------------------------------------ internals

  private async load(): Promise<void> {
    const stored = await this.deps.repository.load();
    this.update({choice: stored.backend, haptics: stored.haptics});
    (this.deps.applyHaptics ?? setHapticsEnabled)(stored.haptics);

    const [model, prefixes, hint] = await Promise.allSettled([
      this.deps.probeModel(),
      this.deps.probePrefixes(),
      this.deps.probeModelHint === undefined
        ? Promise.resolve(null)
        : this.deps.probeModelHint(),
    ]);

    const failures: string[] = [];
    if (model.status === 'rejected') {
      failures.push(messageOf(model.reason));
    }
    if (prefixes.status === 'rejected') {
      failures.push(messageOf(prefixes.reason));
    }

    this.update({
      ready: true,
      model: model.status === 'fulfilled'
        ? modelStatusFromFacts(model.value)
        : null,
      prefixes: prefixes.status === 'fulfilled' ? prefixes.value : null,
      modelHint: hint.status === 'fulfilled' ? hint.value : null,
      error: failures.length > 0 ? failures[0] : null,
    });
  }

  /** Re-read the bundle after a run: the probe may have just opened (or failed to open) the model. */
  private async refreshModel(): Promise<void> {
    try {
      const facts = await this.deps.probeModel();
      this.update({model: modelStatusFromFacts(facts)});
    } catch (error) {
      this.update({error: messageOf(error)});
    }
  }

  private persist(write: Promise<unknown>): void {
    write.catch(() => {
      // A settings write failure must not take the screen down; the next change retries.
    });
  }

  /** Shallow merge; notifies subscribers only when a field actually changed. */
  private update(patch: Partial<SettingsSnapshot>): void {
    const keys = Object.keys(patch) as Array<keyof SettingsSnapshot>;
    const changed = keys.some(key => this.snapshot[key] !== patch[key]);
    if (!changed) {
      return;
    }
    this.snapshot = {...this.snapshot, ...patch};
    for (const listener of [...this.listeners]) {
      listener(this.snapshot);
    }
  }
}
