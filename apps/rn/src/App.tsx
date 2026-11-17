/**
 * App root (card A1). Providers only — the screens live in src/list, src/scan, src/settings.
 *
 * Card A2 replaced the static `HomeSkeleton` with the real `ListsScreen` (import, nested list,
 * tick, persist, export); this is the only line outside `apps/rn/src/list/` the card touched.
 */
import React from 'react';
import {StatusBar, useColorScheme} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {ListsScreen} from './list';
import {ScanListThemeProvider} from './theme';
import {DevEntry} from './dev';

export default function App() {
  const scheme = useColorScheme();
  return (
    <SafeAreaProvider>
      <ScanListThemeProvider>
        <StatusBar
          barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'}
        />
        <ListsScreen />
        {/* Card A3: renders nothing unless the dev menu opens the embed self-test. */}
        <DevEntry />
      </ScanListThemeProvider>
    </SafeAreaProvider>
  );
}
