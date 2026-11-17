/**
 * scanlist UI kit — the handful of primitives every screen shares.
 * Style guide: references/bonsai-ui/STYLE_GUIDE.md (§3 tokens, §4 components).
 */
export {ExpressiveCard} from './components/ExpressiveCard';
export {SpringIn} from './components/SpringIn';
export {ScanButton} from './components/ScanButton';
export {ChoiceChips, type ChoiceOption} from './components/ChoiceChips';
export {FactRow} from './components/FactRow';
export {GuidanceNote, type GuidanceTone} from './components/GuidanceNote';
export {BigState, CapsLabel, HeroNumeral, MachineText} from './components/Typography';
export {
  haptic,
  hapticsEnabled,
  setHapticsEnabled,
  type HapticIntent,
} from './haptics';
