/**
 * Scan button — the "big toggle surface" from the style guide (§3): a full-width surface whose
 * corner radius morphs 28.dp <-> 64.dp and whose scale dips on press (fast spatial spring),
 * with a Confirm haptic. In Bonsai Serve this surface is the kill switch; here it is the
 * magic-scan entry point, so the shape language is identical but the action is "scan".
 */
import React, {useRef, useState} from 'react';
import {Animated, Pressable, StyleSheet, View} from 'react-native';
import {Text, useTheme} from 'react-native-paper';
import {Motion, Shapes, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import {haptic} from '../haptics';
import {CapsLabel} from './Typography';

type Props = {
  title: string;
  description: string;
  onPress?: () => void;
};

export function ScanButton({title, description, onPress}: Props) {
  const theme = useTheme<ScanListTheme>();
  const [pressed, setPressed] = useState(false);
  const scale = useRef(new Animated.Value(1)).current;
  const radius = useRef(
    new Animated.Value(Shapes.scanIdle.borderRadius),
  ).current;

  const animate = (down: boolean) => {
    setPressed(down);
    Animated.spring(scale, {
      ...(down ? Motion.fastSpatial : Motion.spatial),
      toValue: down ? 0.96 : 1,
    }).start();
    // borderRadius cannot run on the native driver, so the shape morph uses the effects
    // spring on the JS driver (style guide §4: corner morph on big tappable surfaces).
    Animated.spring(radius, {
      ...(down ? Motion.fastEffects : Motion.slowEffects),
      toValue: down ? Shapes.scanActive.borderRadius : Shapes.scanIdle.borderRadius,
    }).start();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPressIn={() => animate(true)}
      onPressOut={() => animate(false)}
      onPress={() => {
        haptic('longPress');
        onPress?.();
      }}>
      <Animated.View
        style={[
          styles.surface,
          {
            transform: [{scale}],
            borderRadius: radius,
            backgroundColor: pressed
              ? theme.colors.tertiaryContainer
              : theme.colors.primaryContainer,
          },
        ]}>
        <View style={styles.copy}>
          <CapsLabel color={theme.colors.onPrimaryContainer}>{title}</CapsLabel>
          <Text
            variant="headlineMedium"
            style={[styles.headline, {color: theme.colors.onPrimaryContainer}]}>
            {description}
          </Text>
        </View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  surface: {
    paddingHorizontal: Spacing.heroPadding,
    paddingVertical: Spacing.leafPadding,
    overflow: 'hidden',
  },
  copy: {
    gap: 6,
  },
  headline: {
    marginTop: 4,
  },
});
