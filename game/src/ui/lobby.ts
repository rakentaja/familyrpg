// Lobby — one simple screen: table code + QR + share, who is here, who is the Guide, heroes, Start.
import type { GameState } from '../rules/types';
import type { Peer } from '../contracts';
import type { Ctx } from './ctx';
import { h, btn, replaceKids } from './dom';
import { icon } from './icons';
import { avatar, role, traitBadge, TRAITS, twoTap } from './common';
import { sfx, toast } from './feedback';
import { qrElement } from './qr';
import { openCreator } from './creator';

export function lobbyScreen(ctx: Ctx) {
  const store = ctx.store!;
  const { pack } = ctx;
  const online = store.role !== 'local';
  let peers: Peer[] = [];

  const playersBox = h('ul', { class: 'players' });
  const guideBox = h('div', { class: 'guide-pick' });
  const heroesBox = h('div', { class: 'heroes' });
  const startBox = h('div', { class: 'start-box' });

  // ---- invite (online only)
  let inviteCard: HTMLElement | null = null;
  const info = store.net.info;
  if (online && info) {
    const link = info.link;
    const code = link.includes('#join=') ? decodeURIComponent(link.split('#join=')[1]) : info.roomId;
    const copy = async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied — send it to the family!', 'good'); }
      catch { toast('Could not copy. Show the QR code instead.'); }
    };
    const share = async () => {
      sfx.tap();
      const data = { title: pack.theme.title, text: `Come and play ${pack.theme.title} with me!`, url: link };
      if (navigator.share) { try { await navigator.share(data); } catch { /* cancelled */ } return; }
      copy();
    };
    inviteCard = h('div', { class: 'paper card-block invite' },
      h('div', { class: 'invite-row' },
        qrElement(link, 132),
        h('div', { class: 'invite-text' },
          h('span', { class: 'lbl' }, 'Table code'),
          h('code', { class: 'code', 'aria-label': 'Table code' }, code),
          h('div', { class: 'row' },
            btn([icon('share'), ' Share'], share, 'primary small'),
            btn(icon('copy'), copy, 'ghost icon', { 'aria-label': 'Copy the link' })))));
  }

  const leave = twoTap(() => ctx.leave(), 'Tap ✕ again to leave the table', (m) => toast(m));
  const el = h('section', { class: 'screen lobby' },
    h('header', { class: 'screen-head' },
      h('h1', null, online ? 'Your table' : 'Pass-and-play'),
      btn(icon('close'), leave, 'icon', { 'aria-label': 'Leave table' })),
    h('div', { class: 'lobby-cols' },
      h('div', { class: 'col' },
        inviteCard,
        h('div', { class: 'paper card-block' },
          h('h2', null, online ? 'Who is here' : 'The Guide'),
          online ? playersBox : h('p', { class: 'hint' }, 'This device is the Guide and plays every hero. Pass it around the table!'),
          online ? guideBox : null)),
      h('div', { class: 'col' },
        h('div', { class: 'paper card-block' }, h('h2', null, pack.labels.heroes || 'Heroes'), heroesBox))),
    startBox);

  function isOnline(id: string) {
    if (id === store.me) return true;
    const peer = peers.find((x) => x.id === id);
    return !!peer && Date.now() - peer.lastSeen < 45000;
  }

  function update(s: GameState, prev?: GameState | null) {
    if (prev === s) return;                      // clock tick: nothing to repaint here
    const me = store.me;
    const host = store.isHost();
    const kid = s.settings.kidMode;
    const guide = s.players.find((p) => p.guide);

    // players
    playersBox.replaceChildren(...s.players.map((p) => h('li', { class: 'player' },
      h('span', { class: 'online' + (isOnline(p.id) ? ' on' : ''), title: isOnline(p.id) ? 'Online' : 'Away' }),
      h('span', { class: 'dot', style: `--c:${p.color}` }),
      h('span', { class: 'pname' }, p.name, p.id === me ? h('small', null, ' (you)') : null),
      p.guide ? h('span', { class: 'badge guide' }, icon('guide'), pack.labels.guide || 'Guide') : null,
      p.host ? h('span', { class: 'badge', title: 'Host' }, icon('crown')) : null)));

    // Guide picker
    if (online) {
      replaceKids(guideBox,
        h('p', { class: 'lbl' }, host ? 'Who is the Guide? (tells the story, moves the foes)' : `Guide: ${guide?.name ?? '—'}`),
        host ? h('div', { class: 'chips' }, s.players.map((p) => h('button', {
          type: 'button', class: 'chip' + (p.guide ? ' on' : ''), 'aria-pressed': String(!!p.guide), style: `--c:${p.color}`,
          onclick: () => { if (!p.guide) { sfx.tap(); store.dispatch({ t: 'setGuide', playerId: p.id }); } },
        }, icon('guide'), p.name))) : null);
    }

    // heroes
    const cards = s.heroes.map((x) => {
      const r = role(pack, x.roleId);
      const canEdit = host || x.owner === me;
      const owner = s.players.find((p) => p.id === x.owner);
      const ownerCtl = online && host && s.players.length > 1
        ? h('select', { class: 'owner-sel small', 'aria-label': `Who plays ${x.name}`, onchange: (e: Event) => store.dispatch({ t: 'assignHero', heroId: x.id, owner: (e.target as HTMLSelectElement).value }) },
          s.players.map((p) => h('option', { value: p.id, selected: p.id === x.owner }, p.name + (p.guide ? ' · Guide' : ''))))
        : online ? h('span', { class: 'owner' }, 'played by ', h('b', null, owner?.name ?? '?')) : null;
      return h('div', { class: 'hero-card', style: `--pc:${owner?.color ?? '#B4ABC6'}` },
        avatar(pack, x.roleId, owner?.color),
        h('div', { class: 'hc-text' },
          h('b', { class: 'hname' }, x.name), h('small', null, r?.name ?? x.roleId),
          h('div', { class: 'traits' }, TRAITS.map((t) => traitBadge(pack, t, x.traits[t], kid))),
          ownerCtl),
        canEdit ? btn(icon('close'), () => store.dispatch({ t: 'removeHero', heroId: x.id }), 'icon small', { 'aria-label': `Remove ${x.name}` }) : null);
    });
    const mine = s.heroes.filter((x) => x.owner === me).length;
    replaceKids(heroesBox,
      ...(cards.length ? cards : [h('p', { class: 'hint' }, online ? 'No heroes yet. Everyone makes one on their phone.' : 'No heroes yet. Make one for everyone at the table!')]),
      s.heroes.length < 8 ? btn([h('span', { class: 'plus' }, '+'), mine && online ? ' Make another hero' : online ? ' Make your hero' : ' Make a hero'], () => {
        sfx.tap();
        openCreator({ pack, state: s, me, canAssign: host && online, onDone: (hero) => store.dispatch({ t: 'addHero', ...hero }) });
      }, 'add-hero') : null);

    // start
    if (host) {
      const why = !s.heroes.length ? 'Make at least one hero first' : !guide ? 'Pick a Guide first' : '';
      replaceKids(startBox,
        why ? h('p', { class: 'hint' }, why) : null,
        btn('Start the adventure!', () => { sfx.fanfare(); store.dispatch({ t: 'start' }); }, 'primary big', { disabled: !!why }));
    } else {
      replaceKids(startBox, h('p', { class: 'waiting' }, 'Make your hero, then wait for the host to start ', h('span', { class: 'dots-anim' }, '…')));
    }
  }

  if (store.state) update(store.state, null);
  const offPeers = store.net.onPeers((p) => { peers = p; if (store.state) update(store.state, null); });
  return { el, update, destroy() { offPeers(); } };
}
