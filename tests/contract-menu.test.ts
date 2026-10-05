// The Survey Contract card (Steam edition): its state machine (src/contract-menu.ts), how its keys and rows
// reach Game.startContract, the title card's second button row and the card's text in both languages.
// Explorer is refused (the card stays and nothing changes) until the player picks Standard themselves.
import { afterEach, describe, expect, it } from 'vitest';
import { CONTRACT_ROWS, ContractMenu } from '../src/contract-menu';
import { SURVEY_CONTRACTS } from '../src/contracts';
import type { ContractId } from '../src/contracts';
import { measureText } from '../src/font';
import { Game } from '../src/game';
import {
  BTN_H,
  CONTRACT_TEXT_W,
  CONTRACTS_W,
  TITLE_W,
  buttonRowWidth,
  contractLines,
  contractsEntrySpec,
  titleButtonSpecs,
  titleLayout,
} from '../src/hud';
import { contractText, setLang } from '../src/i18n';
import type { ContractTextKey } from '../src/i18n';
import { keyToUiKey } from '../src/input';
import type { UiKey } from '../src/input';
import { generateMap } from '../src/map';
import type { Action, AudioEngine } from '../src/types';
import { mapDigest } from './support/fingerprint';

const silent: AudioEngine = {
  muted: false,
  unlock: () => undefined,
  toggleMute: () => false,
  footstep: () => undefined,
  bump: () => undefined,
  cacheCollected: () => undefined,
  discovery: () => undefined,
  lowStamina: () => undefined,
  victory: () => undefined,
  defeat: () => undefined,
  expeditionStart: () => undefined,
  stopAll: () => undefined,
};

const titleGame = (mode: 'standard' | 'explorer' = 'standard'): Game => new Game(silent, generateMap, { seed: 205, now: 0, mode });
const definition = (id: ContractId) => SURVEY_CONTRACTS.find((c) => c.id === id)!;

afterEach(() => setLang('en', false));

describe('the Survey Contract card', () => {
  it('lists exactly the approved Contracts, opens on the first and wraps round', () => {
    expect(CONTRACT_ROWS).toEqual(['gentle-ascent', 'hold-the-high-ground', 'master-surveyor']);
    const menu = new ContractMenu();
    expect(menu.isOpen).toBe(false);
    menu.open(100);
    expect([menu.isOpen, menu.since, menu.selected]).toEqual([true, 100, 'gentle-ascent']);
    menu.step(-1);
    expect(menu.selected).toBe('master-surveyor');
    menu.step(1);
    menu.step(1);
    expect(menu.selected).toBe('hold-the-high-ground');
    menu.focus('master-surveyor');
    expect(menu.selected).toBe('master-surveyor');
    menu.close();
    menu.open(200);
    expect(menu.selected).toBe('gentle-ascent');
  });

  it('shows the completions it is given against their own rows', () => {
    const menu = new ContractMenu();
    expect(CONTRACT_ROWS.map((id) => menu.isCompleted(id))).toEqual([false, false, false]);
    menu.completed = ['master-surveyor', 'gentle-ascent'];
    expect(CONTRACT_ROWS.map((id) => menu.isCompleted(id))).toEqual([true, false, true]);
  });

  it('takes the keys while open: select, begin, close; R closes and passes on, M passes, the rest stops here', () => {
    const menu = new ContractMenu();
    expect(menu.key(null, 'confirm')).toBe('pass'); // closed: nothing to do with the card
    menu.open(0);
    expect(menu.key(null, 'down')).toBe('handled');
    expect(menu.selected).toBe('hold-the-high-ground');
    expect(menu.key(null, 'up')).toBe('handled');
    expect(menu.key(null, 'up')).toBe('handled');
    expect(menu.selected).toBe('master-surveyor');
    expect(menu.key(null, 'confirm')).toEqual({ start: 'master-surveyor' });
    const swallowed: [UiKey | null, Action | null][] = [
      [null, 'left'],
      [null, 'right'],
      ['archives', null],
      ['card', null],
      ['pause', null],
      [null, null],
    ];
    for (const [uiKey, action] of swallowed) expect(menu.key(uiKey, action), `${uiKey} ${action}`).toBe('handled');
    expect(menu.key(null, 'mute')).toBe('pass');
    expect(menu.isOpen).toBe(true);
    expect(menu.key('close', null)).toBe('handled');
    expect(menu.isOpen).toBe(false);
    menu.open(0);
    expect(menu.key('contracts', null)).toBe('handled');
    expect(menu.isOpen).toBe(false);
    menu.open(0);
    expect(menu.key(null, 'restart')).toBe('pass');
    expect(menu.isOpen).toBe(false);
  });

  it('is opened with C (and the Korean-layout key)', () => {
    expect(keyToUiKey('KeyC', 'c')).toBe('contracts');
    expect(keyToUiKey('', 'C')).toBe('contracts');
    expect(keyToUiKey('', 'ㅊ')).toBe('contracts');
  });
});

describe('beginning a Contract from the card', () => {
  it.each(SURVEY_CONTRACTS)('$id: the selected row starts that Contract on its own mountain and closes the card', (c) => {
    const game = titleGame();
    const menu = new ContractMenu();
    menu.open(0);
    menu.focus(c.id);
    const command = menu.key(null, 'confirm');
    expect(command).toEqual({ start: c.id });
    expect(menu.begin(game, 100, c.id)).toBe(true);
    expect(menu.isOpen).toBe(false);
    const s = game.state;
    expect([s.phase, s.mode, s.contract, s.seed, s.map.generator]).toEqual(['playing', 'standard', c.id, c.seed, c.generator]);
    expect(mapDigest(s.map)).toBe(definition(c.id).mapDigest);
  });

  it('starts a completed Contract again', () => {
    const game = titleGame();
    const menu = new ContractMenu();
    menu.completed = ['gentle-ascent'];
    menu.open(0);
    expect(menu.begin(game, 100, 'gentle-ascent')).toBe(true);
    expect(game.state.contract).toBe('gentle-ascent');
  });

  it('in Explorer starts nothing and changes nothing, until the player picks Standard on the title card', () => {
    const game = titleGame('explorer');
    const before = game.state;
    const menu = new ContractMenu();
    menu.open(0);
    menu.focus('hold-the-high-ground');
    expect(menu.begin(game, 100)).toBe(false);
    expect(menu.isOpen).toBe(true);
    expect(game.state).toBe(before);
    expect([game.state.phase, game.state.mode, game.state.contract]).toEqual(['title', 'explorer', null]);
    // The player closes the card and switches the mode button to Standard, then opens it again.
    menu.key('close', null);
    expect(game.setMode('standard')).toBe(true);
    menu.open(200);
    menu.focus('hold-the-high-ground');
    expect(menu.begin(game, 300)).toBe(true);
    expect([game.state.mode, game.state.contract]).toEqual(['standard', 'hold-the-high-ground']);
  });

  it('closing the card leaves the title card exactly as it was', () => {
    const game = titleGame();
    const before = game.state;
    const menu = new ContractMenu();
    menu.open(0);
    menu.key(null, 'down');
    menu.key('close', null);
    expect(game.state).toBe(before);
    expect([game.state.phase, game.state.turns, game.state.contract]).toEqual(['title', 0, null]);
  });
});

describe('title card layout', () => {
  it('keeps the itch title exactly as it was: the same five buttons and positions', () => {
    const state = titleGame().state;
    expect(titleButtonSpecs(state).map((s) => s.id)).toEqual(['lang', 'mode', 'copySeed', 'seedEntry', 'archives']);
    expect(titleLayout(false)).toEqual({ prompt: 538, buttons: 576, contracts: null, footer: 618 });
  });

  it('fits both Steam rows on the title card in both languages, between the begin prompt and the footer', () => {
    const state = titleGame().state;
    for (const lang of ['en', 'ko'] as const) {
      setLang(lang, false);
      expect(buttonRowWidth(titleButtonSpecs(state)), lang).toBeLessThanOrEqual(TITLE_W - 40);
      expect(buttonRowWidth([contractsEntrySpec()]), lang).toBeLessThanOrEqual(TITLE_W - 40);
      expect(contractsEntrySpec().id).toBe('contracts');
    }
    const steam = titleLayout(true);
    const PROMPT_H = 21; // the begin prompt is 7 px glyphs at 3x
    const SHADOW = 2; // a paper button's drop shadow
    expect(steam.contracts).not.toBeNull();
    expect(steam.prompt).toBeGreaterThan(517); // below the title footnote (painted at 510, 7 px)
    expect(steam.prompt + PROMPT_H).toBeLessThan(steam.buttons);
    expect(steam.buttons + BTN_H + SHADOW).toBeLessThan(steam.contracts!);
    expect(steam.contracts! + BTN_H + SHADOW).toBeLessThan(steam.footer);
    expect(steam.footer + 7).toBeLessThanOrEqual(660 - 19); // inside the neatline
  });

  it('fits every line of the Contract card in both languages', () => {
    const keys = Object.keys({
      contractsSub: 0,
      contractsRule: 0,
      contractsHint: 0,
      contractsStandardOnly: 0,
      contractsSwitch: 0,
    }) as ContractTextKey[];
    for (const lang of ['en', 'ko'] as const) {
      setLang(lang, false);
      expect(measureText(contractText('contractsTitle'), 3), lang).toBeLessThanOrEqual(CONTRACTS_W - 120);
      for (const key of keys) expect(measureText(contractText(key), 1), `${lang}.${key}`).toBeLessThanOrEqual(CONTRACTS_W - 80);
      for (const id of CONTRACT_ROWS) {
        const [name, goal] = contractLines(id);
        expect(measureText(name, 2), `${lang} ${id} name`).toBeLessThanOrEqual(CONTRACT_TEXT_W);
        expect(measureText(goal, 1), `${lang} ${id} goal`).toBeLessThanOrEqual(CONTRACT_TEXT_W);
        // No seed, generator or digest is ever shown.
        expect(`${name} ${goal}`).not.toMatch(/\d{4,}/);
      }
    }
  });
});
