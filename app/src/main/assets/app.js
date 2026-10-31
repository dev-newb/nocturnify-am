// Nocturnify (Apple Music) — minimal D-pad front end over MusicKit JS v3 + the Apple Music API.
(function () {
  const $ = s => document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const strip = s => String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();   // editorial notes carry HTML
  const status = m => { $('#now-status').textContent = m; console.log('[status]', m); };
  let toastTimer = null;
  function toast(m) {
    const t = $('#toast'); t.textContent = m; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
    console.log('[toast]', m);
  }
  let screen = 'login';   // 'login' | 'app' | 'viz' — decides how the remote OK key is routed
  let music = null;       // the MusicKit instance
  let storefront = 'us';
  let lastSearch = null;  // {q, sections} — so returning to Search keeps results
  let ctxName = '';       // the view being browsed
  // What was started from this TV, captured at play time: the queue's own items, so the
  // context line drops out once autoplay moves past them.
  let playCtx = { ids: null, station: false, name: '' };
  let loved = null;       // rating of the current song: 1, -1, 0, or null (unknown)
  let idleTimer = null;
  let logoutArmed = false;

  // ---------- Apple Music API ----------
  const API = 'https://api.music.apple.com';
  async function api(path, opts = {}) {
    const r = await fetch(API + path.replace('{sf}', storefront), {
      ...opts,
      headers: {
        Authorization: 'Bearer ' + CONFIG.developerToken,
        'Music-User-Token': music?.musicUserToken || '',
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) {
      const body = await r.text();
      let msg = body.slice(0, 200);
      try { const e = JSON.parse(body).errors?.[0]; if (e) msg = e.detail || e.title || msg; } catch {}
      const err = new Error(`${r.status} ${path.split('?')[0]}: ${msg}`);
      err.status = r.status;
      if (r.status === 403 && path.startsWith('/v1/me')) signedOut('Apple Music sign-in expired — please sign in again');
      throw err;
    }
    const txt = await r.text();
    if (!txt) return null;
    try { return JSON.parse(txt); } catch { return null; }
  }
  const art = (a, px) => a?.url ? a.url.replace('{w}', px).replace('{h}', px).replace('{f}', 'jpg').replace('{c}', 'bb') : '';
  // A song's catalog id, whether it came from the catalog or the user's library.
  const catId = it => {
    const p = it?.playParams || it?.attributes?.playParams || {};
    if (p.catalogId) return String(p.catalogId);
    const id = String(it?.id ?? '');
    return /^\d+$/.test(id) ? id : null;
  };

  // ---------- Player (MusicKit) ----------
  const now = () => music?.nowPlayingItem || null;
  const playing = () => !!music?.isPlaying;
  async function setPlaying(want) {
    if (!music) return;
    try { if (want) await music.play(); else music.pause(); } catch (e) { status('play: ' + (e.message || e)); }
  }
  const togglePlay = () => setPlaying(!playing());
  const next = () => music && Promise.resolve(music.skipToNextItem()).catch(e => status('next: ' + (e.message || e)));
  // Like every player: restart the song unless we're right at its start.
  const prev = () => {
    if (!music) return;
    if (music.currentPlaybackTime > 3) music.seekToTime(0);
    else Promise.resolve(music.skipToPreviousItem()).catch(e => status('prev: ' + (e.message || e)));
  };
  window.tvSetPlaying = setPlaying;   // MediaSession (notification / remote) hooks
  window.tvNext = next;
  window.tvPrev = prev;

  async function playQueue(desc, name, { station = false } = {}) {
    if (!music) return;
    try {
      await music.setQueue({ ...desc, startPlaying: true });
      playCtx = { ids: station ? null : new Set((music.queue?.items || []).map(i => String(i.id))), station, name: name ?? ctxName };
    } catch (e) { status('play: ' + (e.message || e)); toast('Couldn’t play that: ' + (e.message || e)); }
  }
  async function stationFrom(it) {
    const id = catId(it);
    if (!id) { toast('No catalog version of this song to build a station from'); return; }
    try {
      await music.setStationQueue({ song: id });
      await music.play();
      playCtx = { ids: null, station: true, name: `Station · ${it.title}` };
      toast(`Station from “${it.title}”`);
    } catch (e) { toast('Station: ' + (e.message || e)); }
  }

  // ---------- Now playing ----------
  function renderNow() {
    const it = now(); if (!it) return;
    $('#now-title').textContent = it.title || '';
    const alb = it.albumName || '';
    $('#now-artist').textContent = alb && alb.trim().toLowerCase() !== (it.title || '').trim().toLowerCase()
      ? `${it.artistName || ''}  ·  ${alb}` : (it.artistName || '');
    $('#now-art').src = art(it.artwork, 160);
    $('#now-state').textContent = playing() ? '▶' : '❚❚';
    $('#now-love').textContent = loved === 1 ? '♥' : '';
  }
  setInterval(() => {
    if (!music) return;
    const d = music.currentPlaybackDuration;
    $('#now-fill').style.width = d ? (100 * music.currentPlaybackTime / d).toFixed(2) + '%' : '0';
  }, 500);
  let lastPush = '';
  function pushNative() {
    try {
      const it = now();
      const payload = JSON.stringify({ playing: playing(), title: it?.title || '', artist: it?.artistName || '' });
      if (payload === lastPush) return;   // identical state: don't churn the notification
      lastPush = payload;
      window.AndroidBridge?.postMessage(payload);
    } catch (e) { /* bridge absent — background audio just won't engage */ }
  }
  async function refreshLove() {
    loved = null; renderNow();
    const id = catId(now());
    if (!id) return;
    try { const r = await api(`/v1/me/ratings/songs/${id}`); loved = r?.data?.[0]?.attributes?.value ?? 0; }
    catch (e) { loved = e.status === 404 ? 0 : null; }
    if (catId(now()) === id) renderNow();
  }
  async function toggleLove() {
    const it = now(), id = catId(it);
    if (!id) { toast('Can’t rate this item'); return; }
    const want = loved !== 1;
    try {
      if (want) await api(`/v1/me/ratings/songs/${id}`, { method: 'PUT', body: JSON.stringify({ type: 'rating', attributes: { value: 1 } }) });
      else await api(`/v1/me/ratings/songs/${id}`, { method: 'DELETE' });
      loved = want ? 1 : 0; renderNow();
      toast(want ? `♥ Loved “${it.title}”` : `Removed love from “${it.title}”`);
      VIZ.flash?.(want ? '♥' : '♡');
    } catch (e) { toast('Love: ' + e.message); }
  }
  async function addToLibrary() {
    const it = now(), id = catId(it);
    if (!id) { toast('Already in your library'); return; }
    try { await api(`/v1/me/library?ids[songs]=${id}`, { method: 'POST' }); toast(`Added “${it.title}” to your library`); }
    catch (e) { toast('Library: ' + e.message); }
  }

  // The line under the track names says where it's playing FROM, and drops out once playback
  // has moved past what was started here (autoplay after the queue ends).
  function contextLabel(it) {
    if (playCtx.station) return playCtx.name;
    return playCtx.ids && it && playCtx.ids.has(String(it.id)) ? playCtx.name : '';
  }
  let liveMeta = null;    // live radio: the station is the item; the song comes as timed metadata
  const vizState = () => {
    const it = now(); if (!it) return {};
    const live = !!it.isLiveRadioStation;
    return {
      uri: String(it.id), title: (live && liveMeta?.title) || it.title || '',
      artist: (live && liveMeta?.artist) || it.artistName || '',
      album: live ? it.title : (it.albumName || ''),
      context: contextLabel(it),
      artUrl: art(it.artwork, 600),
      position: (music.currentPlaybackTime || 0) * 1000,
      duration: live ? 0 : (music.currentPlaybackDuration || 0) * 1000,
      paused: !playing(),
    };
  };

  function syncToggles() {
    const sh = document.querySelector('[data-nav="shuffle"]');
    if (sh) sh.textContent = `Shuffle: ${music?.shuffleMode ? 'On' : 'Off'}`;
    const ap = document.querySelector('[data-nav="autoplay"]');
    if (ap) ap.textContent = `Autoplay: ${music?.autoplayEnabled ? 'On' : 'Off'}`;
  }
  function toggleShuffle() {
    music.shuffleMode = music.shuffleMode ? 0 : 1;      // MusicKit.PlayerShuffleMode: off / songs
    syncToggles(); status('Shuffle ' + (music.shuffleMode ? 'on' : 'off'));
  }
  function toggleAutoplay() {
    music.autoplayEnabled = !music.autoplayEnabled;
    try { localStorage.autoplay = music.autoplayEnabled ? '1' : '0'; } catch (e) {}
    syncToggles(); status('Autoplay ' + (music.autoplayEnabled ? 'on — similar music continues after the queue' : 'off'));
  }

  function openViz() { screen = 'viz'; VIZ.start({ state: vizState }); }
  function resetIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (screen === 'app' && playing()) openViz(); }, 60000);   // screensaver-style
  }
  function closeViz() { VIZ.stop(); screen = 'app'; resetIdle(); }

  // Seeking from the visualiser: presses accumulate and fire one seek once you stop.
  let seekTarget = null, seekTimer = null;
  function seekBy(deltaMs) {
    const st = vizState();
    if (!st.duration) return;
    const base = seekTarget != null ? seekTarget : st.position;
    seekTarget = Math.max(0, Math.min(Math.max(0, st.duration - 5000), base + deltaMs));
    VIZ.setSeekPreview(seekTarget);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => {
      const t = seekTarget; seekTarget = null;
      Promise.resolve(music?.seekToTime(t / 1000)).catch(() => {});
      setTimeout(() => VIZ.setSeekPreview(null), 700);
    }, 400);
  }
  // Remote FF/RW: a single press skips a track, holding scrubs within it.
  let ffDir = 0, ffCount = 0, ffTimer = null;
  const FF_TAP_MS = 500;
  window.tvScrub = dir => {
    if (ffDir !== dir) { clearTimeout(ffTimer); ffDir = dir; ffCount = 0; }
    ffCount++;
    if (ffCount === 1) {
      ffTimer = setTimeout(() => {
        if (ffCount === 1) { if (dir > 0) next(); else prev(); }
        ffDir = 0; ffCount = 0;
      }, FF_TAP_MS);
    } else {
      clearTimeout(ffTimer);
      seekBy(dir * 5000);
      ffTimer = setTimeout(() => { ffDir = 0; ffCount = 0; }, 600);
    }
  };
  window.tvSeekTo = ms => { Promise.resolve(music?.seekToTime(ms / 1000)).catch(() => {}); };

  function markPlaying() {
    const it = now();
    const ids = it ? [String(it.id), catId(it)].filter(Boolean) : [];
    document.querySelectorAll('#main .item').forEach(i => i.classList.toggle('playing', !!i.dataset.id && ids.includes(i.dataset.id)));
  }

  // ---------- Views ----------
  const main = $('#main');
  let view = { name: 'home' };
  const setMain = (title, node, note) => {
    main.innerHTML = '';
    main.append(el('div', 'title', esc(title)));
    if (note) main.append(el('div', 'note', esc(note)));
    main.append(node);
    focus.enter('main', 0);
  };
  const sect = (list, label) => list.append(el('div', 'sect', esc(label)));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  function songRow(t, i, onPlay, numbered = true) {
    const a = t.attributes || {};
    const row = el('div', 'item');
    row.dataset.id = String(t.id);
    if (numbered) row.append(el('span', 'n', String(i + 1)));
    else { const img = el('img'); img.src = art(a.artwork, 112); row.append(img); }
    row.append(el('div', '', `<div class="t">${esc(a.name)}</div><div class="s">${esc(a.artistName)}</div>`));
    row.onactivate = onPlay;
    return row;
  }
  // Any album / playlist / station, catalog or library.
  function resRow(x) {
    const a = x.attributes || {};
    const row = el('div', 'item');
    const img = el('img'); img.src = art(a.artwork, 112); row.append(img);
    let sub = '';
    if (/albums$/.test(x.type)) sub = [a.artistName, a.trackCount ? plural(a.trackCount, 'track') : null].filter(Boolean).join(' · ');
    else if (/playlists$/.test(x.type)) sub = a.curatorName || (x.type.startsWith('library') ? 'Your playlist' : 'Playlist');
    else if (x.type === 'stations') sub = a.isLive ? 'Live radio' : 'Station';
    else if (/songs$/.test(x.type)) sub = a.artistName || '';
    row.append(el('div', '', `<div class="t">${esc(a.name)}</div><div class="s">${esc(sub)}</div>`));
    row.onactivate = () => openRes(x);
    return row;
  }
  function openRes(x) {
    const a = x.attributes || {};
    const lib = x.type.startsWith('library');
    if (/albums$/.test(x.type)) { ctxName = a.name; go({ name: 'album', id: x.id, lib, title: a.name }); }
    else if (/playlists$/.test(x.type)) { ctxName = a.name; go({ name: 'playlist', id: x.id, lib, title: a.name, note: strip(a.description?.short || a.description?.standard) }); }
    else if (x.type === 'stations') { playQueue({ station: x.id }, a.name, { station: true }); status('Playing ' + a.name); }
    else if (/songs$/.test(x.type)) playQueue({ song: x.id }, a.name);
  }
  // Fetch an endpoint, tolerating failure: For You / Radio stitch several together and one
  // missing section shouldn't blank the page.
  const soft = p => api(p).catch(e => { console.log('[soft]', e.message); return null; });
  // Library lists by date added where the API allows it, plain order where it doesn't.
  async function sorted(path) {
    try { return await api(path + '&sort=-dateAdded'); }
    catch (e) { if (e.status === 400) return api(path); throw e; }
  }

  const views = {
    async home() {
      const list = el('div', 'list');
      const [recent, recs, heavy] = await Promise.all([
        soft('/v1/me/recent/played?limit=10'),
        soft('/v1/me/recommendations?limit=8'),
        soft('/v1/me/history/heavy-rotation?limit=10'),
      ]);
      if (recent?.data?.length) { sect(list, 'Recently played'); recent.data.forEach(x => list.append(resRow(x))); }
      for (const g of recs?.data || []) {
        const items = (g.relationships?.contents?.data || []).filter(x => x.attributes).slice(0, 8);
        if (!items.length) continue;
        sect(list, g.attributes?.title?.stringForDisplay || 'For you');
        items.forEach(x => list.append(resRow(x)));
      }
      if (heavy?.data?.length) { sect(list, 'Heavy rotation'); heavy.data.forEach(x => list.append(resRow(x))); }
      if (!list.children.length) list.append(el('div', 'empty', 'Nothing here yet — play something and Apple Music will fill this in'));
      setMain('For You', list); markPlaying();
    },
    async playlists() {
      const list = el('div', 'list');
      const r = await api('/v1/me/library/playlists?limit=100');
      (r?.data || []).forEach(x => list.append(resRow(x)));
      if (!list.children.length) list.append(el('div', 'empty', 'No playlists in your library'));
      setMain('Playlists', list);
    },
    async playlist({ id, lib, title, note }) {
      const list = el('div', 'list');
      let tracks = [];
      if (lib) tracks = (await api(`/v1/me/library/playlists/${id}/tracks?limit=100`))?.data || [];
      else {
        const p = (await api(`/v1/catalog/{sf}/playlists/${id}?include=tracks`))?.data?.[0];
        tracks = p?.relationships?.tracks?.data || [];
        note = note || strip(p?.attributes?.description?.short || p?.attributes?.description?.standard);
      }
      tracks = tracks.filter(t => t.attributes?.playParams);
      tracks.forEach((t, i) => list.append(songRow(t, i, () => playQueue({ playlist: id, startWith: i }, title))));
      if (!list.children.length) list.append(el('div', 'empty', 'No playable tracks'));
      setMain(title, list, note); markPlaying();
    },
    async albums() {
      ctxName = 'Albums';
      const list = el('div', 'list');
      const r = await sorted('/v1/me/library/albums?limit=100');
      const items = r?.data || [];
      items.forEach(x => list.append(resRow(x)));
      if (!items.length) list.append(el('div', 'empty', 'No albums in your library'));
      setMain(r?.meta?.total > items.length ? `Albums (${items.length} of ${r.meta.total})` : 'Albums', list);
    },
    async album({ id, lib, title }) {
      const list = el('div', 'list');
      const a = lib ? (await api(`/v1/me/library/albums/${id}?include=tracks`))?.data?.[0]
                    : (await api(`/v1/catalog/{sf}/albums/${id}`))?.data?.[0];
      const tracks = (a?.relationships?.tracks?.data || []).filter(t => t.attributes?.playParams);
      tracks.forEach((t, i) => list.append(songRow(t, i, () => playQueue({ album: id, startWith: i }, title))));
      if (!list.children.length) list.append(el('div', 'empty', 'No playable tracks'));
      const note = strip(a?.attributes?.editorialNotes?.short || '');
      setMain(title, list, note); markPlaying();
    },
    async songs() {
      ctxName = 'Songs';
      const list = el('div', 'list');
      const r = await sorted('/v1/me/library/songs?limit=100');
      const songs = (r?.data || []).filter(t => t.attributes?.playParams);
      const ids = songs.map(t => t.id);
      songs.forEach((t, i) => list.append(songRow(t, i, () => playQueue({ songs: ids, startWith: i }, 'Songs'), false)));
      if (!songs.length) list.append(el('div', 'empty', 'No songs in your library'));
      setMain('Songs', list); markPlaying();
    },
    async radio() {
      ctxName = 'Radio';
      const list = el('div', 'list');
      const it = now();
      if (it && catId(it)) {
        const row = el('div', 'item action', `<div><div class="t">Start a station from “${esc(it.title)}”</div><div class="s">${esc(it.artistName)} — endless music like this song</div></div>`);
        row.onactivate = () => stationFrom(it);
        list.append(row);
      }
      const [mine, live, recent] = await Promise.all([
        soft('/v1/catalog/{sf}/stations?filter[identity]=personal'),
        soft('/v1/catalog/{sf}/stations?filter[featured]=apple-music-live-radio'),
        soft('/v1/me/recent/radio-stations?limit=10'),
      ]);
      if (mine?.data?.length) { sect(list, 'Your station'); mine.data.forEach(x => list.append(resRow(x))); }
      if (live?.data?.length) { sect(list, 'Live'); live.data.forEach(x => list.append(resRow(x))); }
      if (recent?.data?.length) { sect(list, 'Recently played'); recent.data.forEach(x => list.append(resRow(x))); }
      setMain('Radio', list);
    },
    async charts() {
      ctxName = 'Charts';
      const list = el('div', 'list');
      const r = await api('/v1/catalog/{sf}/charts?types=songs,albums,playlists&limit=20');
      const songs = r?.results?.songs?.[0], albums = r?.results?.albums?.[0], pls = r?.results?.playlists?.[0];
      if (songs?.data?.length) {
        sect(list, songs.name || 'Top songs');
        const ids = songs.data.map(t => t.id);
        songs.data.forEach((t, i) => list.append(songRow(t, i, () => playQueue({ songs: ids, startWith: i }, songs.name || 'Top songs'))));
      }
      if (albums?.data?.length) { sect(list, albums.name || 'Top albums'); albums.data.forEach(x => list.append(resRow(x))); }
      if (pls?.data?.length) { sect(list, pls.name || 'Top playlists'); pls.data.forEach(x => list.append(resRow(x))); }
      setMain('Charts', list); markPlaying();
    },
    async queue() {
      const list = el('div', 'list');
      const it = now();
      if (it) {
        const act = (t, s, fn) => { const row = el('div', 'item action', `<div><div class="t">${t}</div><div class="s">${s}</div></div>`); row.onactivate = fn; list.append(row); };
        sect(list, 'Now playing');
        act(loved === 1 ? '♥ Loved — press to undo' : '♡ Love this song', esc(`${it.title} · ${it.artistName || ''}`), async () => { await toggleLove(); go({ name: 'queue' }); });
        act('＋ Add to library', 'Keep it in your Apple Music library', addToLibrary);
        act('◎ Start a station from this song', 'Endless music like it', () => stationFrom(it));
      }
      const items = music?.queue?.items || [];
      const pos = music?.queue?.position ?? -1;
      const upcoming = items.map((m, i) => ({ m, i })).filter(x => x.i > pos).slice(0, 60);
      if (upcoming.length) {
        sect(list, 'Up next');
        upcoming.forEach(({ m, i }) => {
          const row = el('div', 'item');
          row.dataset.id = String(m.id);
          const img = el('img'); img.src = art(m.artwork, 112);
          row.append(img, el('div', '', `<div class="t">${esc(m.title)}</div><div class="s">${esc(m.artistName)}</div>`));
          row.onactivate = () => Promise.resolve(music.changeToMediaAtIndex(i)).catch(e => status('jump: ' + (e.message || e)));
          list.append(row);
        });
      } else if (it) list.append(el('div', 'empty', music?.autoplayEnabled ? 'End of the queue — autoplay will keep going with similar music' : 'End of the queue'));
      if (!list.children.length) list.append(el('div', 'empty', 'Nothing playing'));
      setMain('Up Next', list); markPlaying();
    },
    async search() {
      ctxName = 'Search';
      const wrap = el('div');
      const input = el('input'); input.placeholder = 'Search Apple Music…'; input.className = 'item';
      const results = el('div', 'list');
      input.onactivate = () => input.focus();          // OK enters the field; IME opens
      const render = () => {
        results.innerHTML = '';
        for (const s of lastSearch?.sections || []) {
          sect(results, s.label);
          if (s.songs) {
            const ids = s.items.map(t => t.id);
            s.items.forEach((t, i) => results.append(songRow(t, i, () => playQueue({ songs: ids, startWith: i }, 'Search'), false)));
          } else s.items.forEach(x => results.append(resRow(x)));
        }
        if (!results.children.length) results.append(el('div', 'empty', lastSearch ? 'No results' : 'Press OK to type a search'));
        markPlaying();
      };
      const run = async () => {
        const q = input.value.trim(); if (!q) return;
        results.innerHTML = '<div class="empty">Searching…</div>';
        try {
          const term = encodeURIComponent(q);
          const [cat, lib] = await Promise.all([
            api(`/v1/catalog/{sf}/search?term=${term}&types=songs,albums,playlists,stations&limit=10`),
            soft(`/v1/me/library/search?term=${term}&types=library-playlists,library-albums&limit=5`),
          ]);
          const R = cat?.results || {}, L = lib?.results || {};
          const mine = [...(L['library-playlists']?.data || []), ...(L['library-albums']?.data || [])];
          lastSearch = {
            q,
            sections: [
              mine.length && { label: 'In your library', items: mine },
              R.songs?.data?.length && { label: 'Songs', items: R.songs.data, songs: true },
              R.albums?.data?.length && { label: 'Albums', items: R.albums.data },
              R.playlists?.data?.length && { label: 'Playlists', items: R.playlists.data },
              R.stations?.data?.length && { label: 'Stations', items: R.stations.data },
            ].filter(Boolean),
          };
          render();
          focus.enter('main', 1);
        } catch (err) {
          results.innerHTML = '';
          results.append(el('div', 'empty', 'Search failed: ' + err.message));
          status(err.message);
        }
      };
      input.addEventListener('keydown', async e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); await run(); }
        else if (e.key === 'Escape') { e.preventDefault(); input.blur(); }
        // D-pad must be able to leave the field, otherwise results are unreachable
        else if (e.key === 'ArrowDown') { e.preventDefault(); input.blur(); focus.enter('main', 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); input.blur(); focus.enter('main', 0); }
      });
      if (lastSearch) input.value = lastSearch.q;
      wrap.append(input, results);
      setMain('Search', wrap);
      render();                                        // restore previous results immediately
    },
    async logout() {
      const item = document.querySelector('[data-nav="logout"]');
      if (logoutArmed) { try { await music.unauthorize(); } catch (e) {} location.reload(); return; }
      logoutArmed = true;
      if (item) item.textContent = 'Press OK again to sign out';
      setTimeout(() => { logoutArmed = false; if (item) item.textContent = 'Sign out'; }, 5000);
    },
  };

  async function go(v) {
    if (v.name === 'viz') { openViz(); return; }     // overlay: leave the current view intact underneath
    if (v.name === 'shuffle') { toggleShuffle(); return; }   // toggles, not destinations
    if (v.name === 'autoplay') { toggleAutoplay(); return; }
    if (v.name === 'logout') { views.logout(); return; }
    view = v; if (!views[v.name]) return;
    main.innerHTML = '<div class="title">Loading…</div>';
    try { await views[v.name](v); } catch (e) { main.innerHTML = `<div class="title">Error</div><div class="empty">${esc(e.message)}</div>`; status(e.message); }
  }

  // ---------- Focus / D-pad ----------
  const focus = {
    zone: 'main', idx: { side: 0, main: 0 },
    items(z) { return [...document.querySelectorAll(z === 'side' ? '#side .item' : '#main .item')]; },
    enter(z, i) { this.zone = z; if (i != null) this.idx[z] = i; this.apply(); },
    move(d) { const n = this.items(this.zone).length; if (!n) return; this.idx[this.zone] = Math.max(0, Math.min(n - 1, this.idx[this.zone] + d)); this.apply(); },
    apply() {
      for (const z of ['side', 'main']) this.items(z).forEach((it, i) => it.classList.toggle('focused', z === this.zone && i === this.idx[z]));
      const cur = this.current();
      if (cur) {
        // never pull DOM focus into the search field — that traps the D-pad. OK enters it.
        if (cur.tagName !== 'INPUT') { cur.tabIndex = -1; cur.focus({ preventScroll: true }); }
        else document.activeElement?.blur?.();
        // the first row also reveals the title / note above it
        if (this.zone === 'main' && this.idx.main === 0) main.scrollTop = 0;
        else cur.scrollIntoView({ block: 'nearest' });
      }
    },
    current() { return this.items(this.zone)[this.idx[this.zone]]; },
  };

  function activateFocused() {
    const a = document.activeElement;
    const t = focus.current() || ((a && (a.dataset?.nav || a.onactivate)) ? a : null);
    if (!t) return;
    if (t.dataset?.nav) go({ name: t.dataset.nav }); else t.onactivate?.();
  }

  const isOk = e => e.key === 'Enter' || e.key === 'Spacebar' || e.keyCode === 13 || e.keyCode === 23;
  document.addEventListener('keydown', e => {
    resetIdle();
    const k = e.key;
    if (screen === 'viz') {
      if (isOk(e) || k === 'MediaPlayPause') togglePlay();
      else if (k === 'ArrowRight' || k === 'MediaTrackNext') next();
      else if (k === 'ArrowLeft' || k === 'MediaTrackPrevious') prev();
      else if (k === 'ArrowUp') VIZ.cycle(1);        // D-pad up/down: the one control every
      else if (k === 'ArrowDown') VIZ.cycle(-1);     // Android TV remote has and we don't use
      else return;
      e.preventDefault(); return;
    }
    if (screen === 'login') {
      if (isOk(e)) { signIn(); e.preventDefault(); }
      return;
    }
    if (document.activeElement?.tagName === 'INPUT') return;     // the TV keyboard owns the keys
    if (k === 'ArrowUp') focus.move(-1); else if (k === 'ArrowDown') focus.move(1);
    else if (k === 'ArrowLeft') focus.enter('side'); else if (k === 'ArrowRight') focus.enter('main');
    else if (isOk(e)) activateFocused();
    else if (k === 'MediaPlayPause') togglePlay();
    else if (k === 'MediaTrackNext') next(); else if (k === 'MediaTrackPrevious') prev();
    else return;
    e.preventDefault();
  });

  // Called from MainActivity for remote transport keys (Android keycodes) and Back.
  window.onTvKey = (code, down = true) => {
    if (!down) return;
    if (code === 90) return seekBy(5000);
    if (code === 89) return seekBy(-5000);
    ({ 85: togglePlay, 126: () => setPlaying(true), 127: () => setPlaying(false), 87: next, 88: prev, 86: () => setPlaying(false),
       183: toggleLove,                                  // red:    ♥ love / unlove
       184: addToLibrary,                                // green:  add to library
       185: () => now() && stationFrom(now()),           // yellow: station from this song
       186: () => VIZ.cycle(1),                          // blue:   next visualiser mode
    })[code]?.();
  };
  window.onTvBack = () => {
    if (screen === 'viz') { closeViz(); return true; }
    if (document.activeElement?.tagName === 'INPUT') { document.activeElement.blur(); return true; }
    if (view.name !== 'home') { go({ name: 'home' }); return true; }
    if (focus.zone === 'main') { focus.enter('side'); return true; }
    return false;                                               // at the root: let Android close the app
  };

  // ---------- Boot ----------
  function showSetup(why) {
    for (const id of ['#login', '#app']) $(id).hidden = true;
    $('#setup-why').textContent = why;
    $('#setup').hidden = false;
    screen = 'setup';
  }
  function signedOut(why) {
    if (screen === 'login') return;
    $('#app').hidden = true; VIZ.stop();
    $('#login').hidden = false; screen = 'login';
    if (why) $('#login .hint').textContent = why;
  }
  async function signIn() {
    try {
      $('#login .hint').textContent = 'Opening Apple sign-in…';
      await music.authorize();
      location.reload();
    } catch (e) {
      $('#login .hint').textContent = 'Sign-in didn’t finish: ' + (e?.message || e || 'cancelled') + '. Press OK to try again.';
      console.log('[auth] failed', e?.message || e);
    }
  }

  // The sidebar must fit on one screen. If its spacing ever pushes it past the bottom, shrink the
  // text just enough to bring everything back, rather than letting Sign out fall off.
  function fitSide() {
    const side = $('#side');
    let px = 26;
    side.style.fontSize = '';
    while (side.scrollHeight > side.clientHeight + 1 && px > 12) side.style.fontSize = (px -= 0.5) + 'px';
    console.log('[side] font', px, side.scrollHeight, '/', side.clientHeight);
  }
  window.addEventListener('resize', fitSide);

  function startApp() {
    screen = 'app';
    $('#login').hidden = true;
    $('#app').hidden = false;
    fitSide();
    storefront = music.storefrontId || 'us';
    try { music.autoplayEnabled = localStorage.autoplay !== '0'; } catch (e) { music.autoplayEnabled = true; }
    syncToggles();
    status(`Ready · Apple Music (${storefront.toUpperCase()})`);
    resetIdle();
    go({ name: 'home' });
  }

  document.addEventListener('musickitloaded', async () => {
    const exp = CONFIG.tokenExpires && new Date(CONFIG.tokenExpires + 'T00:00:00Z');
    if (!CONFIG.developerToken) return showSetup('This build has no MusicKit developer token.');
    if (exp && exp < new Date()) return showSetup(`The MusicKit developer token expired on ${CONFIG.tokenExpires}.`);
    try {
      music = await MusicKit.configure({ developerToken: CONFIG.developerToken, app: { name: CONFIG.appName || 'Nocturnify', build: '0.1' } });
    } catch (e) { return showSetup('MusicKit wouldn’t start: ' + (e?.message || e)); }
    window.music = music;   // handy from the remote debugger
    music.addEventListener('nowPlayingItemDidChange', () => { liveMeta = null; renderNow(); markPlaying(); pushNative(); refreshLove(); });
    music.addEventListener('playbackStateDidChange', () => { renderNow(); pushNative(); });
    music.addEventListener('mediaPlaybackError', e => { const m = e?.message || e?.reason || String(e); status('playback: ' + m); console.log('[mk] playback error', JSON.stringify(e)); });
    music.addEventListener('timedMetadataDidChange', e => {
      // Live radio songs arrive as ID3 / HLS metadata; log the shape until it's pinned down.
      console.log('[mk] timed metadata', JSON.stringify(e).slice(0, 300));
      const t = e?.title || e?.metadata?.title, a = e?.performer || e?.artist || e?.metadata?.artist;
      if (t) liveMeta = { title: t, artist: a || '' };
    });
    music.addEventListener('authorizationStatusDidChange', () => { if (!music.isAuthorized && screen !== 'login') signedOut('Signed out of Apple Music.'); });

    if (!music.isAuthorized) {
      $('#login').hidden = false;
      screen = 'login';
      $('#login-btn').onclick = signIn;
      return;
    }
    startApp();
  });
})();
