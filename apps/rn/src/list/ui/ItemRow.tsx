/**
 * One item row (card A2): name, amount + unit, note, and the tick.
 *
 * Ticking is the whole interaction of the unranked list (LIST.md §3 — `done` is the only mutable
 * per-item state): the row fires the toggle haptic, strikes the name through and morphs its corner
 * 44 dp -> 28 dp with the spatial spring, exactly like B2's `ListDetailScreen.kt` `ItemRow`
 * (style guide §4: press feedback + corner morph + haptics on every action).
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Pressable, StyleSheet, View} from 'react-native';
import {Text, useTheme} from 'react-native-paper';
import {HEAVY, Motion, Shapes, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import {haptic} from '../../ui';
import {displayText} from '../view';
import type {ItemNode} from '../view';

type Props = {
  node: ItemNode;
  depth: number;
  onToggle: (node: ItemNode) => void;
};

/** Corner radius of a row when ticked / unticked (B1's checked-item morph, 44 -> 28 dp). */
const DONE_RADIUS = 28;
const IDLE_RADIUS = Shapes.hero.borderRadius;

export function ItemRow({node, depth, onToggle}: Props) {
  const theme = useTheme<ScanListTheme>();
  const done = node.flat.done;
  const morph = useRef(new Animated.Value(done ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(morph, {
      ...Motion.spatial,
      // Shape and colour are not native-animatable, so both run on the JS driver.
      useNativeDriver: false,
      toValue: done ? 1 : 0,
    }).start();
  }, [done, morph]);

  const background = morph.interpolate({
    inputRange: [0, 1],
    outputRange: [
      theme.scanlist.surfaces.container,
      theme.scanlist.surfaces.high,
    ],
  });
  const radius = morph.interpolate({
    inputRange: [0, 1],
    outputRange: [IDLE_RADIUS, DONE_RADIUS],
  });
  const foreground = done ? theme.colors.onSurfaceVariant : theme.colors.onSurface;
  const amount = displayText(node.flat);

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{checked: done}}
      accessibilityLabel={
        amount === '' ? node.flat.name : `${node.flat.name}, ${amount}`
      }
      onPress={() => {
        haptic(done ? 'toggleOff' : 'confirm');
        onToggle(node);
      }}>
      <Animated.View
        style={[
          styles.row,
          {
            backgroundColor: background,
            borderRadius: radius,
            marginStart: depth * 10,
          },
        ]}>
        <View style={styles.copy}>
          <Text
            variant="headlineSmall"
            style={[
              styles.name,
              {color: foreground},
              done ? styles.done : null,
            ]}>
            {node.flat.name}
          </Text>
          {amount !== '' ? (
            <Text variant="bodyMedium" style={{color: foreground}}>
              {amount}
            </Text>
          ) : null}
          {node.flat.note !== null ? (
            <Text
              variant="bodySmall"
              style={{color: theme.colors.onSurfaceVariant}}>
              {node.flat.note}
            </Text>
          ) : null}
        </View>
        <Text
          variant="headlineSmall"
          style={[
            styles.tick,
            {color: done ? theme.colors.primary : theme.colors.onSurfaceVariant},
          ]}>
          {done ? '✓' : '○'}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.tilePaddingHorizontal,
    paddingVertical: Spacing.tilePaddingVertical,
    gap: Spacing.gap,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontWeight: HEAVY,
  },
  done: {
    textDecorationLine: 'line-through',
  },
  tick: {
    fontWeight: HEAVY,
  },
});
