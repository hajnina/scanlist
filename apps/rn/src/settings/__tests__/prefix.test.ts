/**
 * Card A6 — the prefix set the engine actually reads (mirror of B6's PrefixInfoTest):
 * nothing hard-coded, trailing spaces named, empty sets reported honestly.
 */
import {
  describePrefix,
  docPrefixLine,
  imagePrefixLine,
  prefixInfoFromNative,
  prefixSummary,
  queryPrefixLine,
  type PrefixInfo,
} from '../prefix';

const NATIVE = {
  active: 'mnemothera',
  version: 1,
  model: 'embeddinggemma-2-740m',
  doc: 'task: search result | text: ',
  query: 'task: search query | text: ',
  image: '',
  dims: 256,
  nativeDims: 768,
};

const INFO: PrefixInfo = {
  active: 'mnemothera',
  version: 1,
  model: 'embeddinggemma-2-740m',
  docPrefix: 'task: search result | text: ',
  queryPrefix: 'task: search query | text: ',
  imagePrefix: '',
  dims: 256,
  nativeDims: 768,
};

describe('prefixInfoFromNative', () => {
  test('adapts the bridge map to the screen shape', () => {
    expect(prefixInfoFromNative(NATIVE)).toEqual(INFO);
  });

  test('null when there is no set (old binary / no native module)', () => {
    expect(prefixInfoFromNative(null)).toBeNull();
    expect(prefixInfoFromNative(undefined)).toBeNull();
    expect(prefixInfoFromNative({})).toBeNull();
    expect(prefixInfoFromNative({active: 'mnemothera'})).toBeNull();
  });

  test('tolerates missing optional fields (dims fall back to the status dims)', () => {
    expect(
      prefixInfoFromNative({active: 'modelcard', doc: 'title: none | text: '}, 512),
    ).toEqual({
      active: 'modelcard',
      version: 0,
      model: '',
      docPrefix: 'title: none | text: ',
      queryPrefix: '',
      imagePrefix: '',
      dims: 512,
      nativeDims: 768,
    });
  });
});

describe('prefix lines', () => {
  test('summary names the set, version and Matryoshka sizes', () => {
    expect(prefixSummary(INFO)).toBe('mnemothera · v1 · 768→256');
  });

  test('a trailing space is load-bearing and therefore named', () => {
    expect(describePrefix('task: text: ')).toBe(
      '"task: text: " · trailing space',
    );
    expect(docPrefixLine(INFO)).toBe(
      '"task: search result | text: " · trailing space',
    );
    expect(queryPrefixLine(INFO)).toBe(
      '"task: search query | text: " · trailing space',
    );
  });

  test('an empty prefix is called empty, not rendered as a blank row', () => {
    expect(describePrefix('')).toBe('empty');
    expect(imagePrefixLine(INFO)).toBe('none (raw image)');
  });

  test('a non-empty image prefix would be quoted like the others', () => {
    expect(imagePrefixLine({...INFO, imagePrefix: '<img>'})).toBe('"<img>"');
  });

  test('no shared prefix string is hard-coded in this module', () => {
    // The values above exist only in the fixtures: the module just formats what the engine reports.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'prefix.ts'),
      'utf8',
    ) as string;
    expect(source).not.toContain('task: search result');
    expect(source).not.toContain('title: none');
  });
});
