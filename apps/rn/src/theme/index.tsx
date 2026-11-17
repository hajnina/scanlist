/**
 * Theme entry point: system light/dark, MD3 Paper theme from ./theme, plus Paper's Provider.
 *
 * Local (in-app) dark-mode toggle is deliberately absent — style guide §2: "follows the system".
 */
import React, {type PropsWithChildren} from 'react';
import {PaperProvider} from 'react-native-paper';
import {useColorScheme} from 'react-native';
import {darkTheme, lightTheme} from './scanlistTheme';

export function ScanListThemeProvider({children}: PropsWithChildren) {
  const scheme = useColorScheme();
  return (
    <PaperProvider theme={scheme === 'dark' ? darkTheme : lightTheme}>
      {children}
    </PaperProvider>
  );
}

export {darkTheme, lightTheme};
export type {ScanListTheme, ScanListSurfaces} from './scanlistTheme';
export * from './tokens';
