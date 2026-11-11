// The Guide's "Ask" card in the build drawer: type a request, see what it will do, tap Do it.
// The helper is opt-in: nothing is downloaded until the Guide turns it on (helper.ts).
import type { Cmd } from '../../../ai/src/dsl';
import type { GameState, GuideOp, Pack } from '../rules/types';
import { describe, run, type Piece } from '../ai/solve';
import { ai, loadTagger, MODEL_MB, setWanted, understand, wanted } from '../ai/helper';
import { h, btn, replaceKids } from './dom';
import { icon } from './icons';
import { sfx, toast } from './feedback';

export interface AskDeps {
  pack: Pack;
  state(): GameState;
  dispatch(op: GuideOp): void;
  selected(): Piece | null;
  placeHidden(): boolean;
  done(touched: Piece[]): void;      // select what was made / changed
}

const EXAMPLES = ['two coal imps hiding behind the crates', 'make the tree bigger', 'a snowman in each corner', 'new snowy scene called Frosty Hollow', 'make a frozen pond'];
const SURE = 0.6;

export function askCard(d: AskDeps) {
  const el = h('div', { class: 'ask-card paper', hidden: true });
  let state: 'off' | 'loading' | 'ready' | 'thinking' | 'preview' = wanted() ? 'loading' : 'off';
  let pct = 0, err = '';
  let text = '';
  let plan: { cmds: Cmd[]; sure: boolean; unknown: string[] } | null = null;
  let input: HTMLInputElement | null = null;

  function start() {
    state = 'loading'; err = ''; paint();
    loadTagger((f) => { pct = f; if (state === 'loading') paintProgress(); })
      .then(() => { setWanted(true); if (state === 'loading') { state = 'ready'; paint(); } })
      .catch((e) => { console.warn('helper', e); state = 'off'; err = `Could not start the helper on this device. Check the connection and try again. (${String((e as Error)?.message ?? e).slice(0, 200)})`; paint(); });
  }
  let bar: HTMLElement | null = null;
  function paintProgress() { if (bar) bar.style.width = `${Math.round(pct * 100)}%`; }

  async function ask() {
    text = (input?.value ?? text).trim();
    if (!text) return;
    state = 'thinking'; paint();
    try {
      const r = await understand(text, d.pack, d.state());
      plan = { cmds: r.cmds, sure: r.minConf >= SURE, unknown: r.unknown };
      state = 'preview';
    } catch (e) { console.warn('helper', e); err = 'Something went wrong. Try again.'; state = 'ready'; }
    paint();
  }
  function apply() {
    if (!plan) return;
    const out = run({ pack: d.pack, ai, state: d.state, dispatch: d.dispatch, selected: d.selected, placeHidden: d.placeHidden() }, plan.cmds);
    sfx.tap();
    if (out.done) toast(out.notes.length ? `Done. ${out.notes.join(' ')}` : 'Done');
    else toast(out.notes.join(' ') || 'Nothing to do.', 'error');
    plan = null; text = ''; state = 'ready'; paint();
    if (out.touched.length) d.done(out.touched);
  }

  function paint() {
    const head = h('div', { class: 'pc-head' }, icon('sparkle'), h('b', null, 'Ask the helper'), h('span', { style: 'flex:1' }),
      btn(icon('close'), () => close(), 'icon small ghost', { 'aria-label': 'Close' }));
    const note = err ? h('p', { class: 'ask-err' }, err) : null;
    if (state === 'off') {
      replaceKids(el, head,
        h('p', { class: 'ask-note' }, 'Type what you want on the table, like “', h('i', null, EXAMPLES[0]), '”, and the helper sets it up. It runs on this device and downloads once (', String(MODEL_MB), ' MB).'),
        note, h('div', { class: 'pc-row' }, btn([icon('down'), err ? ' Try again' : ' Turn on the helper'], start, 'small primary')));
      return;
    }
    if (state === 'loading') {
      bar = h('span', { class: 'ask-fill' });
      replaceKids(el, head, h('p', { class: 'ask-note' }, 'Getting the helper ready…'), h('div', { class: 'ask-bar' }, bar));
      paintProgress();
      return;
    }
    input = h('input', { class: 'ask-in', type: 'text', enterkeyhint: 'go', autocomplete: 'off', placeholder: `e.g. ${EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]}`, maxlength: '200' }) as HTMLInputElement;
    input.value = text;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void ask(); } });
    const row = h('div', { class: 'ask-row' }, input, btn(state === 'thinking' ? '…' : 'Go', () => void ask(), 'small primary', { disabled: state === 'thinking' }));
    if (state !== 'preview' || !plan) {
      replaceKids(el, head, row, note,
        h('p', { class: 'ask-note' }, 'Tip: tap a piece first to change it (“make it bigger”, “turn it around”).'),
        h('div', { class: 'pc-row' }, btn('Turn off', () => { setWanted(false); state = 'off'; paint(); }, 'small ghost')));
      if (state === 'ready') setTimeout(() => input?.focus(), 30);
      return;
    }
    const p = plan;
    const items = p.cmds.map((c) => h('li', null, describe(d.pack, c)));
    const msg = !p.cmds.length
      ? h('p', { class: 'ask-err' }, p.unknown.length ? `I don’t have “${p.unknown.join('”, “')}”. Try another word.` : 'Sorry, I didn’t catch that. Try saying it another way.')
      : h('p', { class: 'ask-note' }, p.sure ? 'I will:' : 'Not quite sure — is this right?');
    const doIt = btn([icon('check'), ' Do it'], apply, 'small primary');
    replaceKids(el, head, row, msg, p.cmds.length ? h('ul', { class: 'ask-plan' }, items) : null,
      p.cmds.length ? h('div', { class: 'pc-row' }, doIt, btn('Cancel', () => { plan = null; state = 'ready'; paint(); }, 'small ghost')) : null);
    // Enter again runs it; with nothing to do, keep typing
    setTimeout(() => (p.cmds.length ? doIt : input)?.focus(), 0);
  }

  function open() { el.hidden = false; if (state === 'loading' && !bar) start(); else paint(); }
  function close() { el.hidden = true; }
  return { el, open, close, toggle: () => (el.hidden ? open() : close()), get isOpen() { return !el.hidden; } };
}
