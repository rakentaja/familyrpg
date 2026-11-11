// The Guide's "Ask" card in the build drawer: type a request, see what it will do line by line, tap Do it.
// The helper is opt-in: nothing is downloaded until the Guide turns it on (helper.ts).
//
// Request log (for retraining; it stays on this device, nothing is ever sent anywhere):
//   localStorage "sb2.ai.log" = JSON array, newest last, at most 500 entries. One entry per Do it or Cancel:
//     { t: ISO time, text: what was typed, dsl: printProgram(cmds) (one command per line),
//       kept: indices of the lines that were ticked and run ([] on Cancel),
//       issues: one array of messages per line (same order as the dsl lines), conf: one confidence per line }
//   "Copy requests (N)" copies it as JSONL (one entry per line) to the clipboard.
import type { Cmd } from '../../../ai/src/dsl';
import { printProgram } from '../../../ai/src/dsl';
import type { GameState, GuideOp, Pack } from '../rules/types';
import { check, describe, run, type Issue, type Piece, type World } from '../ai/solve';
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

// ---------------------------------------------------------------- request log
const LOG_KEY = 'sb2.ai.log';
const LOG_MAX = 500;
interface LogEntry { t: string; text: string; dsl: string; kept: number[]; issues: string[][]; conf: number[] }
function readLog(): LogEntry[] {
  try { const v = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeLog(e: LogEntry) {
  try { const all = readLog(); all.push(e); localStorage.setItem(LOG_KEY, JSON.stringify(all.slice(-LOG_MAX))); } catch { /* private mode / full */ }
}
function clearLog() { try { localStorage.removeItem(LOG_KEY); } catch { /* private mode */ } }

interface Plan {
  text: string; cmds: Cmd[]; conf: number[]; sure: boolean; unknown: string[]; seed: number;
  full: Issue[][];                   // issues with every line run (decides the default ticks)
  ticked: boolean[];
}

export function askCard(d: AskDeps) {
  const el = h('div', { class: 'ask-card paper', hidden: true });
  let state: 'off' | 'loading' | 'ready' | 'thinking' | 'preview' = wanted() ? 'loading' : 'off';
  let pct = 0, err = '';
  let text = '';
  let plan: Plan | null = null;
  let input: HTMLInputElement | null = null;
  let planBox: HTMLElement | null = null;

  const world = (): World => ({ pack: d.pack, ai, state: d.state, dispatch: d.dispatch, selected: d.selected, placeHidden: d.placeHidden() });
  const skipOf = (p: Plan) => new Set(p.ticked.flatMap((on, i) => (on ? [] : [i])));
  /** Issues as the plan stands now: ticked lines checked together; unticked lines keep their full-plan issues. */
  function issuesNow(p: Plan): Issue[][] {
    const now = check(world(), p.cmds, { seed: p.seed, skip: skipOf(p) });
    return p.cmds.map((_, i) => (p.ticked[i] ? now[i]! : p.full[i]!));
  }
  function log(p: Plan, kept: number[], issues: Issue[][]) {
    writeLog({ t: new Date().toISOString(), text: p.text, dsl: printProgram(p.cmds), kept, issues: issues.map((l) => l.map((x) => x.msg)), conf: p.conf.map((c) => Math.round(c * 1000) / 1000) });
  }

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
      const cc = (r as { clauseConf?: number[] }).clauseConf;
      const conf = cc && cc.length === r.cmds.length ? cc : r.cmds.map(() => r.minConf);
      const seed = Date.now();
      const full = check(world(), r.cmds, { seed });
      plan = { text, cmds: r.cmds, conf, sure: r.minConf >= SURE, unknown: r.unknown, seed, full, ticked: full.map((l) => !l.some((x) => x.block)) };
      state = 'preview';
    } catch (e) { console.warn('helper', e); err = 'Something went wrong. Try again.'; state = 'ready'; }
    paint();
  }
  function apply() {
    const p = plan;
    if (!p) return;
    const issues = issuesNow(p);
    const kept = p.ticked.flatMap((on, i) => (on ? [i] : []));
    if (!kept.length) return;
    log(p, kept, issues);
    const out = run(world(), p.cmds, p.seed, { skip: skipOf(p) });
    sfx.tap();
    if (out.done) toast(out.notes.length ? `Done. ${out.notes.join(' ')}` : 'Done');
    else toast(out.notes.join(' ') || 'Nothing to do.', 'error');
    plan = null; text = ''; state = 'ready'; paint();
    if (out.touched.length) d.done(out.touched);
  }
  function cancel() {
    if (plan?.cmds.length) log(plan, [], issuesNow(plan));
    plan = null; state = 'ready'; paint();
  }
  async function copyLog() {
    const all = readLog();
    try { await navigator.clipboard.writeText(all.map((e) => JSON.stringify(e)).join('\n') + '\n'); toast(`Copied ${all.length} requests`, 'good'); }
    catch { toast('Could not copy on this device.', 'error'); }
  }

  function paint() {
    const head = h('div', { class: 'pc-head' }, icon('sparkle'), h('b', null, 'Ask the helper'), h('span', { style: 'flex:1' }),
      btn(icon('close'), () => close(), 'icon small ghost', { 'aria-label': 'Close' }));
    const note = err ? h('p', { class: 'ask-err' }, err) : null;
    planBox = null;
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
      const n = readLog().length;
      replaceKids(el, head, row, note,
        h('p', { class: 'ask-note' }, 'Tip: tap a piece first to change it (“make it bigger”, “turn it around”).'),
        h('div', { class: 'pc-row' },
          btn('Turn off', () => { setWanted(false); state = 'off'; paint(); }, 'small ghost'),
          n ? btn(`Copy requests (${n})`, () => void copyLog(), 'small ghost') : null,
          n ? btn('Clear', () => { clearLog(); toast(`Cleared ${n} requests`); paint(); }, 'small ghost') : null));
      if (state === 'ready') setTimeout(() => input?.focus(), 30);
      return;
    }
    planBox = h('div', { class: 'ask-planbox' });
    replaceKids(el, head, row, planBox);
    paintPlan();
  }

  /** The plan part of the card (repainted on its own when a line is ticked, so the input keeps what was typed). */
  function paintPlan(focusLine = -1) {
    const p = plan, box = planBox;
    if (!p || !box) return;
    if (!p.cmds.length) {
      replaceKids(box, h('p', { class: 'ask-err' }, p.unknown.length ? `I don’t have “${p.unknown.join('”, “')}”. Try another word.` : 'Sorry, I didn’t catch that. Try saying it another way.'));
      setTimeout(() => input?.focus(), 0);
      return;
    }
    const issues = issuesNow(p);
    const allBlocked = p.full.every((l) => l.some((x) => x.block));
    const boxes: HTMLInputElement[] = [];
    const items = p.cmds.map((c, i) => {
      const on = p.ticked[i]!, iss = issues[i]!, block = iss.some((x) => x.block);
      const cb = h('input', { type: 'checkbox', checked: on, disabled: allBlocked, 'aria-label': `Line ${i + 1}` }) as HTMLInputElement;
      cb.addEventListener('change', () => { p.ticked[i] = cb.checked; paintPlan(i); });
      boxes.push(cb);
      return h('li', { class: `ask-line${on ? '' : ' off'}${block ? ' blocked' : ''}` },
        h('label', null, cb, h('span', { class: 'ask-num' }, `${i + 1}.`), h('span', { class: 'ask-what' }, describe(d.pack, c)),
          p.conf[i]! < SURE ? h('span', { class: 'ask-unsure' }, 'not sure') : null),
        ...iss.map((x) => h('p', { class: `ask-issue${x.block ? ' block' : ''}` }, x.msg)));
    });
    const runnable = p.ticked.some((on, i) => on && !issues[i]!.some((x) => x.block));
    const msg = allBlocked
      ? h('p', { class: 'ask-err' }, p.cmds.length === 1 ? 'This can’t be done here:' : 'None of this can be done here:')
      : h('p', { class: 'ask-note' }, p.sure ? 'I will:' : 'Not quite sure — is this right?');
    const doIt = allBlocked ? null : btn([icon('check'), ' Do it'], apply, 'small primary', { disabled: !runnable });
    replaceKids(box, msg, h('ol', { class: 'ask-plan' }, items),
      h('div', { class: 'pc-row' }, doIt, btn(allBlocked ? 'Back' : 'Cancel', cancel, 'small ghost')));
    // Enter again runs it; with nothing to run, keep typing
    setTimeout(() => (focusLine >= 0 ? boxes[focusLine] : doIt && runnable ? doIt : input)?.focus(), 0);
  }

  function open() { el.hidden = false; if (state === 'loading' && !bar) start(); else paint(); }
  function close() { el.hidden = true; }
  return { el, open, close, toggle: () => (el.hidden ? open() : close()), get isOpen() { return !el.hidden; } };
}
