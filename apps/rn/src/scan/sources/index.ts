/**
 * Scan sources barrel. Card A1: contract only (see ./types).
 */
export type {ScanSignal, ScanSource, ScanSourceName} from './types';

/** Registered sources; filled in by the camera/barcode/OCR cards. */
export const scanSources: never[] = [];
