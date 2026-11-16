/**
 * Staggered entrance — React Native port of `Modifier.springIn(index)` from
 * references/bonsai-ui/src/bonsai-serve (style guide §4): scale 0.8 → 1.0, alpha 0 → 1,
 * translationY 90 px → 0, spatial spring, `index * 80 ms` delay.
 */
import React, {type PropsWithChildren, useEffect, useRef} from 'react';
import {Animated, type StyleProp, type ViewStyle} from 'react-native';
import {Motion, SPRING_IN} from '../../theme/tokens';

type Props = PropsWithChildren<{
  /** 0, 1, 2… — each step adds 80 ms of delay. */
  index?: number;
  style?: StyleProp<ViewStyle>;
}>;

export function SpringIn({index = 0, style, children}: Props) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.spring(progress, {
      ...Motion.spatial,
      toValue: 1,
      delay: index * SPRING_IN.staggerMs,
    });
    animation.start();
    return () => animation.stop();
  }, [index, progress]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              scale: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [SPRING_IN.fromScale, 1],
              }),
            },
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [SPRING_IN.fromTranslationY, 0],
              }),
            },
          ],
        },
      ]}>
      {children}
    </Animated.View>
  );
}
