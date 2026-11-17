/**
 * The 14 dp round-capped progress bar from the style guide (§3) and the Kotlin track's list screens.
 * Shared by the home hero and the list hero so a list's progress looks identical in both places.
 */
import React from 'react';
import {StyleSheet, View} from 'react-native';

type Props = {
  /** 0…1; clamped. */
  progress: number;
  color: string;
  trackColor: string;
};

export function ProgressBar({progress, color, trackColor}: Props) {
  const clamped = Math.min(Math.max(progress, 0), 1);
  return (
    <View style={[styles.track, {backgroundColor: trackColor}]}>
      <View
        style={[styles.fill, {backgroundColor: color, width: `${clamped * 100}%`}]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 14,
    borderRadius: 7,
    overflow: 'hidden',
    marginVertical: 10,
  },
  fill: {
    height: 14,
    borderRadius: 7,
  },
});
