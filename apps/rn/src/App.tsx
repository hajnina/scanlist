/**
 * App root (card A1). Providers only — the screens live in src/list, src/scan, src/settings.
 */
import React from 'react';
import {StatusBar, useColorScheme} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {HomeSkeleton} from './list';
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
        <HomeSkeleton />
        {/* Card A3: renders nothing unless the dev menu opens the embed self-test. */}
        <DevEntry />
      </ScanListThemeProvider>
    </SafeAreaProvider>
  );
}
