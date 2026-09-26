// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLang } from '../src/i18n';
import { parseSeed } from '../src/input';
import { generateMap } from '../src/map';
import { parseSeedInput, SeedEntry } from '../src/seed-entry';

describe('parseSeedInput', () => {
  it('accepts the uint32 range, trimmed', () => {
    expect(parseSeedInput('0')).toBe(0);
    expect(parseSeedInput('1')).toBe(1);
    expect(parseSeedInput('721405')).toBe(721405);
    expect(parseSeedInput('4294967295')).toBe(4294967295);
    expect(parseSeedInput('  721405 \n')).toBe(721405);
    expect(parseSeedInput('007')).toBe(7);
  });

  it('rejects negatives, decimals, letters, hex, exponents, blanks and out-of-range numbers', () => {
    for (const bad of ['-1', '-0', '12.5', '1.0', 'abc', '12a', '0x10', '1e3', '', '   ', '4294967296', '99999999999', '1 2', '+5']) {
      expect(parseSeedInput(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('opens the same map as a ?seed= link with that number', () => {
    for (const raw of ['0', '1', '721405', '4294967295']) {
      const typed = parseSeedInput(raw);
      const linked = parseSeed(raw);
      expect(typed).toBe(linked);
      const a = generateMap(typed as number);
      const b = generateMap(linked as number);
      expect(a.seed).toBe(Number(raw));
      expect(a.spawn).toEqual(b.spawn);
      expect(a.summit).toEqual(b.summit);
      expect(a.caches).toEqual(b.caches);
      expect(Array.from(a.elevation.subarray(0, 400))).toEqual(Array.from(b.elevation.subarray(0, 400)));
    }
  });
});

describe('SeedEntry dialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    setLang('en', false);
  });

  const make = () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const entry = new SeedEntry({ onSubmit, onCancel }, document);
    entry.open();
    const input = entry.field as HTMLInputElement;
    return { entry, input, onSubmit, onCancel };
  };
  const key = (el: Element, k: string): void => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  };

  it('mounts a numeric-keypad input with the mobile attributes, focused', () => {
    const { input } = make();
    expect(input.type).toBe('text');
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect(input.getAttribute('pattern')).toBe('[0-9]*');
    expect(input.maxLength).toBe(10);
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.spellcheck).toBe(false);
    expect(document.activeElement).toBe(input);
    const backdrop = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(backdrop.style.position).toBe('fixed');
    expect(backdrop.style.pointerEvents).toBe('auto');
  });

  it('submits a valid seed with Enter and unmounts', () => {
    const { entry, input, onSubmit, onCancel } = make();
    input.value = ' 721405 ';
    key(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledWith(721405);
    expect(onCancel).not.toHaveBeenCalled();
    expect(entry.isOpen).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps an invalid seed open with a localised error and the field focused', () => {
    setLang('ko', false);
    const { entry, input, onSubmit } = make();
    input.value = 'abc';
    key(input, 'Enter');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(entry.isOpen).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('0 ~ 4294967295 범위의 숫자를 입력하세요');
    expect(document.activeElement).toBe(input);
    input.value = '4294967296';
    (Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '확인') as HTMLButtonElement).click();
    expect(onSubmit).not.toHaveBeenCalled();
    input.value = '4294967295';
    key(input, 'Enter');
    expect(onSubmit).toHaveBeenCalledWith(4294967295);
  });

  it('cancels with Escape, the Cancel button, or a press on the backdrop', () => {
    let m = make();
    key(m.input, 'Escape');
    expect(m.onCancel).toHaveBeenCalledTimes(1);
    expect(m.entry.isOpen).toBe(false);

    m = make();
    (Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'CANCEL') as HTMLButtonElement).click();
    expect(m.onCancel).toHaveBeenCalledTimes(1);
    expect(m.onSubmit).not.toHaveBeenCalled();

    m = make();
    const backdrop = document.querySelector('[role="dialog"]') as HTMLElement;
    // A stray click that did not start on the backdrop (the opening tap) is ignored...
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(m.entry.isOpen).toBe(true);
    // ...a real press on the backdrop cancels.
    backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(m.onCancel).toHaveBeenCalledTimes(1);
    expect(m.entry.isOpen).toBe(false);
  });

  it("ignores the opening tap's trailing synthetic click, even when it lands on a dialog button", () => {
    const { entry, onCancel, onSubmit } = make();
    const cancel = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'CANCEL') as HTMLButtonElement;
    cancel.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(entry.isOpen).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    cancel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    cancel.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps keystrokes away from the game while open', () => {
    const { input } = make();
    const gameKeys: string[] = [];
    const listener = (e: KeyboardEvent): void => {
      gameKeys.push(e.key);
    };
    window.addEventListener('keydown', listener);
    for (const k of ['w', 'a', 's', 'd', ' ', 'r', 'm', 'f', 'ArrowUp', '7']) key(input, k);
    window.removeEventListener('keydown', listener);
    expect(gameKeys).toEqual([]);
  });
});
