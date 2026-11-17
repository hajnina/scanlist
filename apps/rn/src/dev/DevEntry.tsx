/**
 * Hidden dev affordance for card A3: RN's own dev menu (shake / Ctrl+M / ⌘M in a debug build) gets one
 * extra item, "Embed self-test". Everything else is null — the skeleton home screen (A2's file) and the
 * app root stay untouched apart from rendering this component.
 *
 * `DevSettings.addMenuItem` only exists in debug builds, so release APKs carry no way in. The import is
 * lazy and skipped under Jest: loading `DevSettings` there instantiates a `NativeEventEmitter` around a
 * mocked native module and prints a warning into every test that renders `<App />`.
 */
import React, {useEffect, useState} from 'react';
import {EmbedSelfTestScreen} from './EmbedSelfTestScreen';

const MENU_LABEL = 'Embed self-test (A3)';

export function DevEntry() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!__DEV__ || typeof jest !== 'undefined') {
      return;
    }
    let alive = true;
    import('react-native')
      .then(reactNative => {
        const devSettings = reactNative.DevSettings;
        if (!alive || typeof devSettings?.addMenuItem !== 'function') {
          return;
        }
        devSettings.addMenuItem(MENU_LABEL, () => setOpen(true));
        // There is no removeMenuItem: a second mount would add a second item, harmless in dev.
      })
      .catch(() => {
        // No dev menu in this runtime; the screen is simply unreachable.
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!open) {
    return null;
  }
  return <EmbedSelfTestScreen onClose={() => setOpen(false)} />;
}
