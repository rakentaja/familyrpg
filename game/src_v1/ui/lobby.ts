// Lobby: players, invite (code, QR, share), mode + Guide, kid mode, heroes, Start.
import type { GameState } from '../engine/types';
import type { Peer } from '../contracts';
import type { Ctx } from './ctx';
import { h, btn, replaceKids } from './dom';
import { icon } from './icons';
import { avatar, isHostPlayer, role, traitBadge, TRAITS, canRunTable } from './common';
import { sfx, toast } from './feedback';
import { qrElement } from './qr';
import { openCreator } from './creator';

export function lobbyScreen(ctx: Ctx) {
  const store = ctx.store!;
  const { pack } = ctx;
  const online = store.role !== 'local';
  let peers: Peer[] = [];

  const playersBox = h('ul', { class: 'players' });
  const heroesBox = h('div', { class: 'heroes' });
  const modeBox = h('div', { class: 'mode-box' });
  const startBox = h('div', { class: 'start-box' });

  // ---- invite card (online only)
  let inviteCard: HTMLElement | null = null;
  const info = store.net.info;
  if (online && info) {
    const link = info.link;
    const code = link.includes('#join=') ? link.split('#join=')[1] : info.roomId;
    const share = async () => {
      sfx.tap();
      const data = { title: pack.theme.title, text: `Come and play ${pack.theme.title} with me!`, url: link };
      if (navigator.share) { try { await navigator.share(data); return; } catch { /* cancelled */ return; } }
      copy();
    };
    const copy = async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied — send it to the family!', 'good'); }
      catch { toast('Could not copy. Show the QR code instead.'); }
    };
    inviteCard = h('div', { class: 'paper card-block invite' },
      h('h2', null, 'Invite the family'),
      h('div', { class: 'invite-row' },
        qrElement(link, 168),
        h('div', { class: 'invite-text' },
          h('p', null, 'Scan with a phone camera, or type this code in “Join a table”:'),
          h('code', { class: 'code', 'aria-label': 'Table code' }, code),
          h('div', { class: 'row' },
            btn([icon('share'), ' Share'], share, 'primary'),
            btn([icon('copy'), ' Copy'], copy, 'ghost')))));
  }

  const leaveBtn = btn(icon('close'), () => { if (confirmLeave()) ctx.leave(); }, 'icon', { 'aria-label': 'Leave table' });
  const el = h('section', { class: 'screen lobby' },
    h('header', { class: 'screen-head' }, h('h1', null, online ? 'Your table' : 'Pass-and-play'), leaveBtn),
    h('div', { class: 'lobby-cols' },
      h('div', { class: 'col' },
        inviteCard,
        online ? h('div', { class: 'paper card-block' }, h('h2', null, 'Who is here'), playersBox) : null),
      h('div', { class: 'col' },
        h('div', { class: 'paper card-block' }, h('h2', null, pack.labels.heroes || 'Heroes'), heroesBox),
        h('div', { class: 'paper card-block' }, h('h2', null, 'How do we play?'), modeBox))),
    startBox);

  let leaveArmed = 0;
  function confirmLeave() {
    if (Date.now() - leaveArmed < 3000) return true;
    leaveArmed = Date.now();
    toast('Tap ✕ again to leave the table');
    return false;
  }

  function isOnline(id: string, s: GameState) {
    if (id === store.me) return true;
    const p = s.players.find((x) => x.id === id);
    if (p?.online !== undefined) return p.online;
    const peer = peers.find((x) => x.id === id);
    return !!peer && Date.now() - peer.lastSeen < 45000;
  }

  function update(s: GameState) {
    const me = store.me;
    const host = store.isHost() || isHostPlayer(s, me);
    const kid = s.kidMode;

    // players
    playersBox.replaceChildren(...s.players.map((p) => h('li', { class: 'player' },
      h('span', { class: 'dot', style: `--c:${p.color}` }),
      h('span', { class: 'pname' }, p.name, p.id === me ? h('small', null, ' (you)') : null),
      p.host ? h('span', { class: 'badge', title: 'Host' }, icon('crown'), 'Host') : null,
      p.guide && s.mode === 'guide' ? h('span', { class: 'badge guide' }, icon('guide'), 'Guide') : null,
      h('span', { class: 'online' + (isOnline(p.id, s) ? ' on' : ''), title: isOnline(p.id, s) ? 'Online' : 'Away' }))));

    // mode
    const seg = (label: string, sub: string, on: boolean, fn: () => void) =>
      h('button', { type: 'button', class: 'seg-btn' + (on ? ' on' : ''), 'aria-pressed': String(on), disabled: !host, onclick: fn }, h('b', null, label), h('small', null, sub));
    replaceKids(modeBox,
      h('div', { class: 'seg' },
        seg('Story cards', 'No grown-up needed — the cards run the game', s.mode === 'guideless', () => store.dispatch({ t: 'setMode', mode: 'guideless' })),
        seg('With a Guide', 'One player tells the story and plays the foes', s.mode === 'guide', () => store.dispatch({ t: 'setMode', mode: 'guide' }))),
      s.mode === 'guide' ? h('div', { class: 'guide-pick' },
        h('p', { class: 'lbl' }, 'Who is the Guide?'),
        h('div', { class: 'chips' }, s.players.map((p) => h('button', {
          type: 'button', class: 'chip' + (p.guide ? ' on' : ''), disabled: !host, 'aria-pressed': String(!!p.guide), style: `--c:${p.color}`,
          onclick: () => { for (const o of s.players) if (o.guide && o.id !== p.id) store.dispatch({ t: 'setGuide', playerId: o.id, on: false }); store.dispatch({ t: 'setGuide', playerId: p.id, on: !p.guide }); },
        }, icon('guide'), p.name)))) : null,
      h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', checked: s.kidMode, disabled: !host, onchange: (e: Event) => store.dispatch({ t: 'setKidMode', on: (e.target as HTMLInputElement).checked }) }),
        h('span', { class: 'switch' }),
        h('span', null, h('b', null, 'Kid mode'), h('small', null, 'Pictures instead of numbers, cards read aloud'))));

    // heroes
    const cards = s.heroes.map((x) => {
      const r = role(pack, x.roleId);
      const canEdit = host || x.owner === me;
      const owner = s.players.find((p) => p.id === x.owner);
      const ownerCtl = online && host && s.players.length > 1
        ? h('select', { class: 'owner-sel small', 'aria-label': `Who plays ${x.name}`, onchange: (e: Event) => store.dispatch({ t: 'assignHero', heroId: x.id, owner: (e.target as HTMLSelectElement).value }) },
          s.players.map((p) => h('option', { value: p.id, selected: p.id === x.owner }, p.name)))
        : online ? h('span', { class: 'owner' }, 'played by ', h('b', null, owner?.name ?? '?')) : null;
      return h('div', { class: 'hero-card', style: `--pc:${owner?.color ?? '#B4ABC6'}` },
        avatar(pack, x.roleId, owner?.color),
        h('div', { class: 'hc-text' },
          h('b', { class: 'hname' }, x.name), h('small', null, r?.name ?? x.roleId),
          h('div', { class: 'traits' }, TRAITS.map((t) => traitBadge(pack, t, x.traits[t], kid))),
          ownerCtl),
        canEdit ? btn(icon('close'), () => { store.dispatch({ t: 'removeHero', heroId: x.id }); }, 'icon small', { 'aria-label': `Remove ${x.name}` }) : null);
    });
    const myHeroes = s.heroes.filter((x) => x.owner === me).length;
    replaceKids(heroesBox,
      ...(cards.length ? cards : [h('p', { class: 'hint' }, 'No heroes yet. Everyone makes one — or make a few and pass the phone!')]),
      s.heroes.length < 8 ? btn([h('span', { class: 'plus' }, '+'), myHeroes ? ' Make another hero' : ' Make your hero'], () => {
        sfx.tap();
        openCreator({ pack, state: s, me, canAssign: host && online, onDone: (hero) => store.dispatch({ t: 'addHero', ...hero }) });
      }, 'add-hero') : null);

    // start
    const guideMissing = s.mode === 'guide' && !s.players.some((p) => p.guide);
    const canStart = canRunTable(s, me, store.isHost()) && host;
    if (canStart) {
      const why = !s.heroes.length ? 'Make at least one hero first' : guideMissing ? 'Pick a Guide first' : '';
      replaceKids(startBox,
        why ? h('p', { class: 'hint' }, why) : null,
        btn(`Start the adventure!`, () => { sfx.fanfare(); store.dispatch({ t: 'start' }); }, 'primary big', { disabled: !!why }));
    } else {
      replaceKids(startBox,h('p', { class: 'waiting' }, 'Make your hero, then wait for the host to start ', h('span', { class: 'dots-anim' }, '…')));
    }
  }

  if (store.state) update(store.state);
  const offPeers = store.net.onPeers((p) => { peers = p; if (store.state) update(store.state); });
  return { el, update, destroy() { offPeers(); } };
}
