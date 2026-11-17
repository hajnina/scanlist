/**
 * Web scan sources (card C4) — public surface.
 *
 * The scan screen (card C5) imports from here; everything below the `session` factory is pure and
 * unit-tested in happy-dom (`__tests__/`). `README.md` documents the constants, the signal shapes
 * and the manual browser check.
 */

export * from './types';
export * from './clock';
export * from './geometry';
export * from './sampler';
export * from './camera';
export * from './barcode';
export * from './detector';
export * from './dedupe';
export * from './ocr';
export * from './ocrEngine';
export * from './embedder';
export * from './uploader';
export * from './jpeg';
export * from './barcodeSource';
export * from './ocrSource';
export * from './capture';
export * from './session';
