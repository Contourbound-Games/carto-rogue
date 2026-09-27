import { afterEach, describe, expect, it } from 'vitest';
import { hasBitmapGlyphs } from '../src/font';
import { getLang, langVersion, messageTables, onLangChange, setLang, t, toggleLang } from '../src/i18n';
import type { MessageKey } from '../src/i18n';

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n', () => {
  afterEach(() => setLang('en', false));

  it('defaults to English', () => {
    expect(getLang()).toBe('en');
    expect(t('flat')).toBe('FLAT');
  });

  it('has a non-empty Korean entry for every English key, with the same placeholders', () => {
    const { en, ko } = messageTables();
    const keys = Object.keys(en) as MessageKey[];
    expect(Object.keys(ko).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(ko[key].length, key).toBeGreaterThan(0);
      expect(placeholders(ko[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('draws every string from bitmap glyphs (5x7 Latin or extracted Galmuri9), never the web-font fallback', () => {
    for (const lang of ['en', 'ko'] as const) {
      for (const [key, text] of Object.entries(messageTables()[lang])) {
        expect(hasBitmapGlyphs(text.replace(/\{\w+\}/g, '')), `${lang}.${key}: run npm run gen:glyphs`).toBe(true);
      }
    }
  });

  it('translates the HUD labels named in the brief', () => {
    setLang('ko', false);
    expect(t('steepAlarm')).toBe('급경사!');
    expect(t('moderate')).toBe('완만');
    expect(t('flat')).toBe('평탄');
    expect(t('floatCache')).toBe('보급캠프');
    expect(t('altimeter')).toBe('고도계');
    expect(t('stamina')).toBe('스태미나');
    expect(t('compass')).toBe('나침반');
    expect(t('sightRadius')).toContain('시야');
  });

  it('substitutes placeholders and leaves unknown ones intact', () => {
    expect(t('logBegin', { seed: 721405 })).toBe('Expedition #721405 begins.');
    expect(t('tilesN', { n: 10 }, 'ko')).toBe('10칸');
    expect(t('logBegin')).toBe('Expedition #{seed} begins.');
  });

  it('toggles, notifies listeners and bumps the version once per change', () => {
    const seen: string[] = [];
    const off = onLangChange((l) => seen.push(l));
    const v0 = langVersion();
    expect(toggleLang()).toBe('ko');
    setLang('ko', false); // no-op: same language
    expect(toggleLang()).toBe('en');
    off();
    expect(seen).toEqual(['ko', 'en']);
    expect(langVersion()).toBe(v0 + 2);
  });

  it('keeps English log lines within the 30-character field log', () => {
    const samples = [
      t('logBegin', { seed: 4294967295 }),
      t('logTooSpent'),
      t('logEdge'),
      t('logCliff'),
      t('logPanoramaPeaks', { tiles: 4800, peaks: t('manyPeaks', { n: 12 }) }),
      t('logPeaks', { n: 12, m: 1200 }),
      t('logCachesSpotted', { n: 6 }),
      t('logLowStamina'),
      t('logCacheGain', { n: 40 }),
    ];
    for (const line of samples) expect(line.length, line).toBeLessThanOrEqual(30);
  });
});
