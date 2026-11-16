/**
 * Expressive card — tonal container with the style guide's asymmetric shapes (§3) and the
 * press feedback from §4: scale 1 → 0.94 with the fast spatial spring, Confirm haptic on tap.
 */
import React, {useRef, type PropsWithChildren} from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import {Surface, useTheme} from 'react-native-paper';
import {Shapes, Motion, type CardVariant} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import {haptic} from '../haptics';

type Props = PropsWithChildren<{
  variant: CardVariant;
  /** Container role colour; defaults to the neutral tonal surface container. */
  containerColor?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}>;

const PRESSED_SCALE = 0.94;

export function ExpressiveCard({
  variant,
  containerColor,
  onPress,
  accessibilityLabel,
  style,
  children,
}: Props) {
  const theme = useTheme<ScanListTheme>();
  const scale = useRef(new Animated.Value(1)).current;
  const background = containerColor ?? theme.scanlist.surfaces.container;

  const toScale = (value: number, spring: typeof Motion.spatial) =>
    Animated.spring(scale, {...spring, toValue: value}).start();

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      disabled={!onPress}
      onPressIn={() => toScale(PRESSED_SCALE, Motion.fastSpatial)}
      onPressOut={() => toScale(1, Motion.spatial)}
      onPress={
        onPress
          ? () => {
              haptic('confirm');
              onPress();
            }
          : undefined
      }>
      <Animated.View style={{transform: [{scale}]}}>
        <Surface
          elevation={0}
          style={[styles.card, Shapes[variant], {backgroundColor: background}, style]}>
          {children}
        </Surface>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    overflow: 'hidden',
  },
});
