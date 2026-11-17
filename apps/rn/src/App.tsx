/**
 * App root (card A1). Providers + the screen state the app is small enough to keep here.
 *
 * Card A2 replaced the static `HomeSkeleton` with the real `ListsScreen` (import, nested list,
 * tick, persist, export).
 *
 * Card A6-followup wires the settings screen in, following the pattern A2 already uses inside
 * `ListsScreen` (a local screen flag, no navigation dependency): `App` owns `screen`, `ListsScreen`
 * gets one optional `onOpenSettings`, and `SettingsScreen` gets one `onBack`. The controller is
 * created here (`useMemo`) so leaving Settings and coming back shows the measurement it already
 * took instead of re-running a self-test that opens the 484 MB model.
 *
 * Start-up: the persisted backend choice + haptics switch are applied once, fire-and-forget, so a
 * restart honours them before the first scan or tap (`src/settings/startup.ts`). It is deliberately
 * not awaited — AsyncStorage settles after the first render and the defaults cover the gap.
 */
import React, {useEffect, useMemo, useState} from 'react';
import {StatusBar, useColorScheme} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {ListsScreen} from './list';
import {
  SettingsScreen,
  applyPersistedSettings,
  createNativeSettingsController,
} from './settings';
import {ScanListThemeProvider} from './theme';
import {DevEntry} from './dev';

/** The one screen flag (A2's in-screen pattern, lifted to the root for the second screen). */
type Screen = 'lists' | 'settings';

export default function App() {
  const scheme = useColorScheme();
  const [screen, setScreen] = useState<Screen>('lists');
  const settings = useMemo(() => createNativeSettingsController(), []);

  useEffect(() => {
    // Never rejects (corrupt store → defaults, refusing bridge → reported); the catch only keeps a
    // future refactor from surfacing an unhandled rejection at the root.
    applyPersistedSettings().catch(() => undefined);
  }, []);

  return (
    <SafeAreaProvider>
      <ScanListThemeProvider>
        <StatusBar
          barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
        />
        {screen === 'settings' ? (
          <SettingsScreen controller={settings} onBack={() => setScreen('lists')} />
        ) : (
          <ListsScreen onOpenSettings={() => setScreen('settings')} />
        )}
        {/* Card A3: renders nothing unless the dev menu opens the embed self-test. */}
        <DevEntry />
      </ScanListThemeProvider>
    </SafeAreaProvider>
  );
}
