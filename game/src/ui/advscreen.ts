// My adventures: the built-in ones and the Guide's own — edit (scene editor), copy, share by code/link, import,
// reset an edited built-in, delete. Everything is kept on this device; sharing goes through Nostr (net/share.ts).
import type { Adventure } from '../rules/types';
import { blankAdventure } from '../rules/layout';
import type { Ctx } from './ctx';
import { h, btn, replaceKids } from './dom';
import { icon } from './icons';
import { twoTap } from './common';
import { sfx, toast } from './feedback';
import { allAdventures, deleteAdventure, importAdventure, newAdventureId, saveAdventure, type AdventureEntry } from './adventures';
import { fetchAdventure, parseShareInput, shareAdventure, shareLink } from '../net/share';
import { qrElement } from './qr';

export function adventuresScreen(ctx: Ctx, opts: { importCode?: string; back(): void }) {
  const { pack } = ctx;
  const list = h('div', { class: 'adv-list' });
  const shareBox = h('div', { class: 'paper card-block adv-share', hidden: true });
  let busy = false;

  const copyText = async (text: string, msg: string) => {
    try { await navigator.clipboard.writeText(text); toast(msg, 'good'); } catch { toast('Could not copy — select the code instead.'); }
  };

  async function share(e: AdventureEntry) {
    if (busy) return;
    busy = true; sfx.tap();
    replaceKids(shareBox, h('p', null, h('span', { class: 'spinner small' }), ` Sharing “${e.adv.name}”…`));
    shareBox.hidden = false;
    shareBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    try {
      const code = await shareAdventure(e.adv);
      const link = shareLink(code);
      const send = async () => {
        const data = { title: e.adv.name, text: `Here’s my ${pack.theme.title} adventure “${e.adv.name}”. Open the link to add it:`, url: link };
        if (navigator.share) { try { await navigator.share(data); } catch { /* cancelled */ } return; }
        void copyText(link, 'Link copied');
      };
      replaceKids(shareBox,
        h('div', { class: 'invite-row' }, qrElement(link, 120),
          h('div', { class: 'invite-text' },
            h('span', { class: 'lbl' }, `Share code for “${e.adv.name}”`),
            h('code', { class: 'code' }, code),
            h('div', { class: 'row' }, btn([icon('share'), ' Send'], send, 'primary small'), btn(icon('copy'), () => copyText(link, 'Link copied'), 'ghost icon', { 'aria-label': 'Copy the link' })),
            h('small', { class: 'hint' }, 'Anyone with the code or link can add this adventure. Changes you make later need a new code.'))),
        btn('Close', () => { shareBox.hidden = true; }, 'ghost small'));
    } catch (err) {
      replaceKids(shareBox, h('p', null, String((err as Error)?.message || 'Could not share')), btn('Close', () => { shareBox.hidden = true; }, 'ghost small'));
    } finally { busy = false; }
  }

  function exportFile(adv: Adventure) {
    const blob = new Blob([JSON.stringify({ app: 'sleighbound-adventure', adv }, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${adv.id}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function paint() {
    const all = allAdventures(pack);
    replaceKids(list, all.map((e) => {
      const tag = e.builtIn ? (e.edited ? 'Built-in · changed' : 'Built-in') : 'Mine';
      return h('div', { class: 'paper card-block adv-card' },
        h('div', { class: 'adv-head' },
          h('span', { class: 'grow' }, h('b', null, e.adv.name), h('small', null, `${e.adv.scenes.length} scene${e.adv.scenes.length === 1 ? '' : 's'} · ${tag}`)),
          btn([icon('edit'), ' Edit'], () => { sfx.tap(); ctx.editAdventure(e.adv); }, 'primary small')),
        e.adv.blurb ? h('p', { class: 'adv-blurb' }, e.adv.blurb) : null,
        h('div', { class: 'row wrap adv-actions' },
          btn([icon('share'), ' Share'], () => share(e), 'small'),
          btn([icon('copy'), ' Copy'], () => {
            const cp = structuredClone(e.adv);
            cp.id = newAdventureId(pack, e.adv.id.replace(/-\d+$/, ''));
            cp.name = `${e.adv.name} (copy)`.slice(0, 60);
            if (saveAdventure(cp)) { toast('Copied', 'good'); paint(); }
          }, 'small ghost'),
          btn([icon('down'), ' File'], () => exportFile(e.adv), 'small ghost'),
          e.builtIn && e.edited ? btn('Reset', twoTap(() => { deleteAdventure(e.adv.id); toast('Back to the original', 'good'); paint(); }, 'Tap Reset again to undo all your changes', (m) => toast(m)), 'small ghost danger') : null,
          !e.builtIn ? btn(icon('trash'), twoTap(() => { deleteAdventure(e.adv.id); paint(); }, `Tap again to delete “${e.adv.name}”`, (m) => toast(m)), 'small icon ghost danger', { 'aria-label': 'Delete' }) : null));
    }));
  }

  // import by code / link / file
  const codeIn = h('input', { class: 'code-in', placeholder: 'Share code or link', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', value: opts.importCode ?? '', 'aria-label': 'Share code' });
  const doImport = async () => {
    if (busy) return;
    const v = codeIn.value.trim();
    if (!v || !parseShareInput(v)) { codeIn.focus(); toast('Type or paste the share code'); return; }
    busy = true; el.classList.add('busy');
    try {
      const raw = await fetchAdventure(v);
      const adv = importAdventure(pack, raw);
      if (!adv) throw new Error('That adventure could not be read.');
      toast(`Added “${adv.name}”`, 'good'); sfx.chime();
      codeIn.value = ''; paint();
    } catch (err) { toast(String((err as Error)?.message || 'Could not find it'), 'error'); }
    finally { busy = false; el.classList.remove('busy'); }
  };
  codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doImport(); });
  const fileIn = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: async () => {
    const f = fileIn.files?.[0]; if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      const adv = importAdventure(pack, raw?.adv ?? raw);
      if (!adv) throw new Error('That file is not an adventure.');
      toast(`Added “${adv.name}”`, 'good'); paint();
    } catch (err) { toast(String((err as Error)?.message || 'Could not read the file'), 'error'); }
    fileIn.value = '';
  } }) as HTMLInputElement;

  const el = h('section', { class: 'screen adventures' },
    h('header', { class: 'screen-head' },
      h('h1', null, 'My adventures'),
      btn(icon('close'), () => opts.back(), 'icon', { 'aria-label': 'Back' })),
    h('div', { class: 'adv-cols' },
      h('div', { class: 'col' },
        h('div', { class: 'paper card-block' },
          h('p', { class: 'hint' }, 'Build scenes from the library of creatures, props and tokens. As the host you can also change the table during a game.'),
          h('div', { class: 'row wrap' },
            btn([icon('plus'), ' New adventure'], () => {
              const adv = blankAdventure(newAdventureId(pack));
              if (saveAdventure(adv)) ctx.editAdventure(adv);
            }, 'primary'),
            btn([icon('book'), ' Add from a file'], () => fileIn.click(), 'ghost'), fileIn)),
        h('div', { class: 'paper card-block' },
          h('label', { class: 'lbl' }, 'Got a share code? Add that adventure here'),
          h('div', { class: 'row' }, codeIn, btn('Add', () => void doImport(), 'primary'))),
        shareBox),
      h('div', { class: 'col' }, list)));

  paint();
  if (opts.importCode) setTimeout(() => void doImport(), 50);
  return { el };
}
