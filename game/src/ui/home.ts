// Home: title art, your name + colour, Host / Join / Play on this device, install hint.
import type { Ctx } from './ctx';
import { h, btn } from './dom';
import { icon } from './icons';
import { prefs, savePrefs, toast, sfx, readAloud } from './feedback';
import { PLAYER_COLORS } from './common';
import { canScan, scanQr } from './qr';
import { installState, onInstallChange, promptInstall } from './pwa';

const NAMES = ['Holly', 'Juniper', 'Pip', 'Comet', 'Ivy', 'Bramble', 'Clove', 'Maple', 'Robin', 'Nutmeg'];

export function myName() { return (prefs.name || '').trim() || 'Player'; }
export function myColor() { return prefs.color || PLAYER_COLORS[0]; }

export function homeScreen(ctx: Ctx, opts: { joinCode?: string } = {}) {
  const { pack } = ctx;
  if (!prefs.name) { prefs.name = NAMES[Math.floor(Math.random() * NAMES.length)]; savePrefs(); }

  let busy = false;
  const run = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    if (!nameIn.value.trim()) { nameIn.focus(); toast('What should we call you?'); return; }
    busy = true; el.classList.add('busy'); sfx.tap();
    try { await fn(); } catch (err) { console.error(err); toast(String((err as Error)?.message || err || 'Could not connect'), 'error'); }
    finally { busy = false; el.classList.remove('busy'); }
  };

  const nameIn = h('input', { class: 'name-in', id: 'myName', value: prefs.name, maxlength: '16', autocomplete: 'nickname', enterkeyhint: 'done', 'aria-label': 'Your name' });
  nameIn.addEventListener('input', () => { prefs.name = nameIn.value.trim(); savePrefs(); });
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Your colour' });
  const paintSwatches = () => {
    swatches.replaceChildren(...PLAYER_COLORS.map((c) => h('button', {
      type: 'button', class: 'swatch' + (c === myColor() ? ' on' : ''), style: `--c:${c}`, role: 'radio', 'aria-checked': String(c === myColor()), 'aria-label': 'Colour',
      onclick: () => { prefs.color = c; savePrefs(); paintSwatches(); sfx.tap(); },
    })));
  };
  paintSwatches();

  // join panel
  const codeIn = h('input', { class: 'code-in', placeholder: 'Table code or link', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go', value: opts.joinCode ?? '', 'aria-label': 'Table code' });
  const doJoin = run(async () => {
    const code = codeIn.value.trim();
    if (!code) { codeIn.focus(); toast('Type the code from the host’s screen'); return; }
    await ctx.join(code);
  });
  codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  const scanBtn = btn([icon('camera'), ' Scan'], async () => {
    const v = await scanQr();
    if (v) { codeIn.value = v; doJoin(); }
  }, 'ghost');
  scanBtn.hidden = true;
  canScan().then((ok) => { scanBtn.hidden = !ok; });
  const joinPanel = h('div', { class: 'join-panel', hidden: !opts.joinCode },
    h('label', { class: 'lbl' }, 'Ask the host for their table code, or scan it'),
    h('div', { class: 'row' }, codeIn), h('div', { class: 'row' }, btn('Join!', doJoin, 'primary grow'), scanBtn));

  // model loading bar
  const loadBar = h('i');
  const loadRow = h('div', { class: 'load-row' }, h('span', null, 'Packing the sleigh…'), h('div', { class: 'bar small' }, loadBar));
  const setLoad = (p: number) => { loadBar.style.width = Math.round(p * 100) + '%'; if (p >= 1) loadRow.hidden = true; };
  setLoad(ctx.sceneProgress);
  const offLoad = ctx.onSceneProgress(setLoad);

  // install
  const installBox = h('div', { class: 'install' });
  const paintInstall = () => {
    const st = installState();
    installBox.replaceChildren();
    if (st === 'prompt') installBox.append(btn([icon('install'), ' Add Sleighbound to your home screen'], () => promptInstall(), 'ghost small'));
    else if (st === 'ios') installBox.append(h('p', { class: 'hint' }, 'Tip: tap ', h('b', null, 'Share'), ' ⎙ then ', h('b', null, '“Add to Home Screen”'), ' to play full-screen.'));
  };
  paintInstall();
  const offInstall = onInstallChange(paintInstall);

  const el = h('section', { class: 'screen home' },
    h('div', { class: 'hero-art', role: 'img', 'aria-label': 'Heroes on a snowy rooftop at night' },
      h('h1', null, pack.theme.title || pack.meta.name),
      h('p', { class: 'subtitle' }, pack.theme.subtitle || '')),
    h('div', { class: 'paper sheet-card' },
      h('div', { class: 'me-row' },
        h('label', { for: 'myName', class: 'lbl' }, 'Your name'), nameIn, swatches),
      h('div', { class: 'choices' },
        btn([icon('star'), h('span', null, h('b', null, 'Host a table'), h('small', null, 'Everyone plays on their own phone'))], run(() => ctx.hostOnline()), 'choice primary'),
        btn([icon('qr'), h('span', null, h('b', null, 'Join a table'), h('small', null, 'Type the code or scan the QR'))], () => { joinPanel.hidden = !joinPanel.hidden; if (!joinPanel.hidden) codeIn.focus(); sfx.tap(); }, 'choice'),
        joinPanel,
        btn([icon('dice'), h('span', null, h('b', null, 'Play on this device'), h('small', null, 'You are the Guide — pass the phone around, no internet needed'))], run(() => ctx.playLocal()), 'choice'),
        btn([icon('book'), h('span', null, h('b', null, 'My adventures'), h('small', null, 'Build and change scenes, share them with other families'))], () => { sfx.tap(); ctx.openAdventures(); }, 'choice')),
      h('p', { class: 'premise' }, pack.theme.premise, ' ', readAloud(() => pack.theme.premise)),
      loadRow, installBox));

  return { el, destroy() { offInstall(); offLoad(); }, focusJoin() { joinPanel.hidden = false; } };
}
