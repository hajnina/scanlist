/**
 * One section (card A2): a collapsible header with this section's own items first and then its
 * sub-sections — the FLATTEN.md §2 order, i.e. exactly the imported JSON's nesting and order
 * (LIST.md §2: sibling sections may share a name, order is the display order).
 *
 * The header morphs its corner (18 dp closed <-> 28 dp open) and haptics ToggleOn/ToggleOff, like
 * B2's `SectionBlock`; the top level starts open, deeper levels start closed.
 */
import React, {useEffect, useRef, useState} from 'react';
import {Animated, Pressable, StyleSheet, View} from 'react-native';
import {Text, useTheme} from 'react-native-paper';
import {HEAVY, Motion, Spacing} from '../../theme/tokens';
import type {ScanListTheme} from '../../theme';
import {haptic} from '../../ui';
import {ItemRow} from './ItemRow';
import type {ItemNode, SectionNode} from '../view';

type Props = {
  section: SectionNode;
  depth: number;
  onToggle: (node: ItemNode) => void;
};

export function SectionBlock({section, depth, onToggle}: Props) {
  const theme = useTheme<ScanListTheme>();
  const [open, setOpen] = useState(depth === 0);
  const morph = useRef(new Animated.Value(depth === 0 ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(morph, {
      ...Motion.spatial,
      useNativeDriver: false,
      toValue: open ? 1 : 0,
    }).start();
  }, [open, morph]);

  const background = morph.interpolate({
    inputRange: [0, 1],
    outputRange: [
      theme.scanlist.surfaces.container,
      theme.scanlist.surfaces.high,
    ],
  });
  const radius = morph.interpolate({
    inputRange: [0, 1],
    outputRange: [18, 28],
  });

  return (
    <View style={[styles.section, {marginStart: depth * 10}]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{expanded: open}}
        accessibilityLabel={section.name}
        onPress={() => {
          haptic(open ? 'toggleOff' : 'toggleOn');
          setOpen(value => !value);
        }}>
        <Animated.View
          style={[styles.header, {backgroundColor: background, borderRadius: radius}]}>
          <View style={styles.headerCopy}>
            <Text
              variant="titleLarge"
              style={[styles.title, {color: theme.colors.onSurface}]}>
              {section.name}
            </Text>
            <Text
              variant="bodySmall"
              style={{color: theme.colors.onSurfaceVariant}}>
              {section.total === 0
                ? 'no items'
                : `${section.done} of ${section.total} ticked`}
            </Text>
          </View>
          <Text
            variant="titleLarge"
            style={[styles.chevron, {color: theme.colors.onSurfaceVariant}]}>
            {open ? '▾' : '▸'}
          </Text>
        </Animated.View>
      </Pressable>

      {open ? (
        <View style={styles.body}>
          {section.items.map(node => (
            <ItemRow
              key={node.flat.id}
              node={node}
              depth={depth}
              onToggle={onToggle}
            />
          ))}
          {section.sections.map((child, childIndex) => (
            <SectionBlock
              // LIST.md:38 allows sibling sections to share a name — path alone would
              // duplicate React keys. The sibling index disambiguates (A2 review nit).
              key={`${child.path.join('\u0000')}#${childIndex}`}
              section={child}
              depth={depth + 1}
              onToggle={onToggle}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.tilePaddingHorizontal,
    paddingVertical: Spacing.screenVertical,
    gap: Spacing.gap,
  },
  headerCopy: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontWeight: HEAVY,
  },
  chevron: {
    fontWeight: HEAVY,
  },
  body: {
    gap: 8,
  },
});
