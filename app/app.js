(() => {
  'use strict';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const $ = (id) => document.getElementById(id);

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const prefs = Object.assign(
    // Android cannot reliably share the microphone between the recorder and speech recognition, so audio is off there by default.
    { lang: 'en', arDialect: 'ar-IL', fillers: true, punct: true, audio: !isAndroid, source: 'default' },
    store.get('prefs', {})
  );
  prefs.export = Object.assign({ corrected: true, original: false, fixes: false }, prefs.export);
  delete prefs.export.audio;

  // ------------------------------------------------------------ device storage
  // memories:   { id, title, created, updated, count, last }       one per title
  // recordings: { id, memoryId, start, end, duration, segments, edited, audioSize, audioType }
  // audio:      { recordingId, blob }
  const DB = (() => {
    let opening = null;
    const done = (req) => new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    function open() {
      if (!opening) {
        opening = new Promise((resolve, reject) => {
          const req = indexedDB.open('transcriber', 1);
          req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore('memories', { keyPath: 'id' });
            db.createObjectStore('recordings', { keyPath: 'id' }).createIndex('memoryId', 'memoryId');
            db.createObjectStore('audio', { keyPath: 'recordingId' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return opening;
    }
    const os = async (name, mode) => (await open()).transaction(name, mode || 'readonly').objectStore(name);
    return {
      all: async (name) => done((await os(name)).getAll()),
      get: async (name, key) => done((await os(name)).get(key)),
      put: async (name, value) => done((await os(name, 'readwrite')).put(value)),
      del: async (name, key) => done((await os(name, 'readwrite')).delete(key)),
      recordingsOf: async (memoryId) => done((await os('recordings')).index('memoryId').getAll(memoryId)),
    };
  })();

  // ------------------------------------------------------------ helpers
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fmtDate = (t) => new Date(t).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  function fmtDuration(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    const m = Math.floor(s / 60);
    return m ? `${m} min ${s % 60} s` : `${s} s`;
  }
  const fmtSize = (b) => { const mb = b / 1048576; return mb < 0.1 ? '<0.1 MB' : mb.toFixed(1) + ' MB'; };
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`; };
  const safeName = (s) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'transcript';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // ------------------------------------------------------------ state
  let memory = null; // the open title
  let recordings = []; // its recordings, oldest first
  let current = null; // the recording in progress
  let corrected = null; // { byRec: Map(id -> segments), changesByRec: Map(id -> changes), total }
  let view = 'corrected';
  let active = false; // a recording is in progress (running or paused)
  let paused = false;
  let sessionDone = true;
  let rec = null;
  let recAlive = false;
  let interim = '';
  let interimStart = 0;
  let fatal = false;
  let session = 0; // counts recordings, so timers left over from an earlier one do nothing
  let finishing = false; // Stop was pressed and the last words are still arriving
  let lastError = null; // a speech-service error that the next restart should report
  let retryDelay = 0;
  let retryTimer = null;
  let launchedAt = 0;
  let elapsed = 0;
  let tick = null;
  let wakeLock = null;
  let audio = null; // { recorder, chunks } while recording
  let audioFailed = false;
  let input = null; // the open audio source: { stream, track, useTrack, kind, name }
  let starting = false; // waiting for the audio source to open
  let sourceStopped = ''; // why the source went away mid-recording, shown after saving
  const audioCache = new Map(); // recording id -> blob recorded in this app session
  let saveTimer = null;
  let editTimer = null;

  const el = {
    home: $('home'), newBtn: $('newBtn'), loadBtn: $('loadBtn'), newForm: $('newForm'), newTitle: $('newTitle'),
    newError: $('newError'), newCancel: $('newCancel'), loadPanel: $('loadPanel'), memoryList: $('memoryList'),
    memoryEmpty: $('memoryEmpty'), homeStatus: $('homeStatus'),
    memoryView: $('memoryView'), back: $('back'), memTitle: $('memTitle'), rename: $('rename'), memMeta: $('memMeta'),
    record: $('record'), recordLabel: $('recordLabel'), pause: $('pause'), timer: $('timer'), status: $('status'),
    transcript: $('transcript'), views: $('views'), count: $('count'),
    fixes: $('fixes'), fixesSummary: $('fixesSummary'), fixesList: $('fixesList'),
    copy: $('copy'), exportBtn: $('export'),
    optFillers: $('optFillers'), optPunct: $('optPunct'), optDialect: $('optDialect'), optAudio: $('optAudio'),
    source: $('source'), sourceHint: $('sourceHint'),
    dialog: $('exportDialog'), exportNote: $('exportNote'), exportSave: $('exportSave'), exportClose: $('exportClose'),
    out: { corrected: $('outCorrected'), original: $('outOriginal'), fixes: $('outFixes') },
    audioList: $('audioList'), audioNone: $('audioNone'),
  };

  const langCode = () => (prefs.lang === 'en' ? 'en-US' : prefs.lang === 'he' ? 'he-IL' : prefs.arDialect);

  function setStatus(text, warn, target) {
    target = target || el.status;
    target.textContent = text || '';
    target.classList.toggle('warn', !!warn && !!text);
  }

  function dbError(err) {
    const msg = 'Could not save to this device: ' + ((err && err.message) || err);
    setStatus(msg, true, memory ? el.status : el.homeStatus);
  }

  // ------------------------------------------------------------ start screen
  function showHome() {
    memory = null;
    recordings = [];
    corrected = null;
    el.memoryView.hidden = true;
    el.home.hidden = false;
    el.newForm.hidden = true;
    el.loadPanel.hidden = true;
    document.title = 'Transcriber';
    window.scrollTo(0, 0);
  }

  function showNewForm() {
    el.loadPanel.hidden = true;
    el.newForm.hidden = false;
    el.newError.hidden = true;
    el.newTitle.value = '';
    el.newTitle.focus();
  }

  async function showLoadList() {
    el.newForm.hidden = true;
    el.loadPanel.hidden = false;
    let mems;
    try { mems = await DB.all('memories'); } catch (err) { dbError(err); return; }
    mems.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    el.memoryList.textContent = '';
    el.memoryEmpty.hidden = mems.length > 0;
    for (const m of mems) {
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'memOpen';
      const title = document.createElement('span');
      title.className = 'memTitle';
      title.dir = 'auto';
      title.textContent = m.title;
      const meta = document.createElement('span');
      meta.className = 'memMeta';
      meta.textContent = m.count
        ? `${plural(m.count, 'recording')} · last recorded ${fmtDate(m.last)}`
        : `No recordings yet · created ${fmtDate(m.created)}`;
      open.append(title, meta);
      open.addEventListener('click', () => openMemory(m.id));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'quiet';
      del.textContent = 'Delete';
      del.setAttribute('aria-label', 'Delete ' + m.title);
      del.addEventListener('click', () => deleteMemory(m));
      li.append(open, del);
      el.memoryList.appendChild(li);
    }
    el.loadPanel.scrollIntoView({ block: 'nearest' });
  }

  async function createMemory(title) {
    const now = Date.now();
    const m = { id: uid(), title, created: now, updated: now, count: 0, last: null };
    try { await DB.put('memories', m); } catch (err) { dbError(err); return; }
    try { await navigator.storage?.persist?.(); } catch { /* best effort: ask the browser not to clear saved recordings */ }
    await openMemory(m.id);
  }

  async function openMemory(id) {
    let m, recs;
    try {
      m = await DB.get('memories', id);
      recs = m ? await DB.recordingsOf(id) : [];
    } catch (err) { dbError(err); return; }
    if (!m) { setStatus('That recording could not be found.', true, el.homeStatus); return; }
    recs.sort((a, b) => a.start - b.start);
    // A recording cut off by closing the app mid-way still has its text: close it properly.
    for (const r of recs) {
      if (!r.end) {
        const last = r.segments[r.segments.length - 1];
        r.end = last ? last.end : r.start;
        r.duration = r.duration || r.end - r.start;
        DB.put('recordings', r).catch(dbError);
      }
    }
    if (m.count !== recs.length) {
      m.count = recs.length;
      m.last = recs.length ? recs[recs.length - 1].start : null;
      DB.put('memories', m).catch(dbError);
    }
    memory = m;
    recordings = recs;
    view = 'corrected';
    elapsed = 0;
    showTimer();
    runCorrection();
    el.home.hidden = true;
    el.memoryView.hidden = false;
    setStatus(recs.length
      ? `${plural(recs.length, 'recording')} loaded. Press Start recording to add a new one.`
      : 'Press Start recording when you are ready.');
    setStatus('', false, el.homeStatus);
    render();
    window.scrollTo(0, 0);
  }

  async function deleteMemory(m) {
    if (!confirm(`Delete "${m.title}" with all its recordings and audio? This cannot be undone.`)) return;
    try {
      const recs = await DB.recordingsOf(m.id);
      for (const r of recs) {
        await DB.del('audio', r.id);
        await DB.del('recordings', r.id);
        audioCache.delete(r.id);
      }
      await DB.del('memories', m.id);
      setStatus(`Deleted "${m.title}".`, false, el.homeStatus);
    } catch (err) { dbError(err); }
    showLoadList();
  }

  function saveMemory() {
    if (!memory) return;
    memory.count = recordings.length;
    memory.last = recordings.length ? recordings[recordings.length - 1].start : null;
    memory.updated = Date.now();
    DB.put('memories', memory).catch(dbError);
  }

  // Transcripts from the earlier version (kept in browser storage) become a saved recording.
  async function migrateOldTranscript() {
    const old = store.get('segments', null);
    if (!Array.isArray(old) || !old.length) { store.remove('segments'); return; }
    const start = old[0].start || Date.now();
    const end = old[old.length - 1].end || start;
    const m = { id: uid(), title: 'Earlier transcript', created: start, updated: Date.now(), count: 1, last: start };
    const r = {
      id: uid(), memoryId: m.id, start, end, duration: Math.max(0, end - start),
      segments: old, edited: null, audioSize: 0, audioType: '',
    };
    await DB.put('memories', m);
    await DB.put('recordings', r);
    store.remove('segments');
  }

  // ------------------------------------------------------------ recognition
  // Only these errors mean recognition cannot work at all; anything else
  // (dropped connection, busy microphone, the service ending early) is retried.
  const FATAL = {
    'not-allowed': 'Microphone access was blocked. Allow the microphone for this app in the browser, then start again.',
    'service-not-allowed': 'Speech recognition is not allowed in this browser. Open the app in Google Chrome.',
    'language-not-supported': 'This language is not supported by the speech service on this device.',
  };

  function reconnectMessage(err) {
    const still = audio ? ' The audio is still being recorded.' : '';
    if (err === 'network') return 'Lost the connection to the speech service. Reconnecting…' + still;
    if (err === 'audio-capture') {
      return 'The microphone is busy. Retrying…' + still +
        (prefs.audio ? ' If this keeps happening, turn off "Also record the audio" in Settings.' : '');
    }
    return 'The speech service stopped. Reconnecting…' + still;
  }

  function launch() {
    const lang = prefs.lang;
    const target = current;
    const me = new SR();
    rec = me;
    me.lang = langCode();
    // Android Chrome repeats earlier text in continuous mode, so use one phrase per session there.
    me.continuous = !isAndroid;
    me.interimResults = true;
    me.maxAlternatives = 3;
    launchedAt = Date.now();

    me.onresult = (e) => {
      if (rec !== me) return;
      if (retryDelay || lastError) {
        retryDelay = 0;
        lastError = null;
        if (active && !paused) setStatus('Listening… speak now.');
      }
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const alternatives = [];
          for (let j = 0; j < r.length; j++) {
            const text = r[j].transcript.trim();
            if (text) alternatives.push({ text, confidence: r[j].confidence || 0 });
          }
          if (alternatives.length && target) {
            target.segments.push({
              text: alternatives[0].text, lang, confidence: alternatives[0].confidence, alternatives,
              start: interimStart || Date.now(), end: Date.now(),
            });
            scheduleSave(target);
          }
          interimStart = 0;
        } else {
          if (!interimStart) interimStart = Date.now();
          interim += r[0].transcript;
        }
      }
      render();
    };

    me.onerror = (e) => {
      if (rec !== me || e.error === 'no-speech' || e.error === 'aborted') return;
      if (FATAL[e.error]) {
        fatal = true;
        setStatus(FATAL[e.error], true);
      } else {
        lastError = e.error;
      }
    };

    me.onend = () => {
      if (rec !== me) return;
      recAlive = false;
      interim = '';
      interimStart = 0;
      if (!active || fatal) { finish(); return; }
      if (paused) { render(); return; }
      // The browser ends sessions on silence and on hiccups; keep going until the user presses Stop.
      if (lastError || Date.now() - launchedAt < 1000) {
        retryDelay = Math.min(retryDelay ? retryDelay * 2 : 500, 5000);
        setStatus(reconnectMessage(lastError), true);
      } else {
        retryDelay = 0;
      }
      lastError = null;
      relaunch(retryDelay || 150);
      render();
    };

    if (input && input.useTrack) me.start(input.track);
    else me.start();
    recAlive = true;
  }

  function relaunch(delay) {
    clearTimeout(retryTimer);
    const s = session;
    retryTimer = setTimeout(() => {
      if (s === session && active && !paused && !recAlive && !document.hidden) tryLaunch();
    }, delay);
  }

  function tryLaunch() {
    try {
      launch();
    } catch {
      // e.g. the previous session has not let go of the microphone yet
      recAlive = false;
      retryDelay = Math.min(retryDelay ? retryDelay * 2 : 500, 5000);
      setStatus(reconnectMessage(null), true);
      relaunch(retryDelay);
    }
  }

  // Chrome stops listening while the window is minimized or hidden; pick up again when it is back.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !active) return;
    if (!paused && !recAlive) relaunch(0);
    try { if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  });

  function scheduleSave(r) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DB.put('recordings', r).catch(dbError), 800);
  }

  // ------------------------------------------------------------ audio source
  // Desktop Chrome 133+ and Edge 135+ can transcribe a chosen audio track. Elsewhere
  // (Android, other browsers) speech recognition always uses the default microphone.
  const trackSupported = (() => {
    if (isAndroid || !navigator.mediaDevices?.getUserMedia) return false;
    const ua = navigator.userAgent;
    const edge = ua.match(/Edg\/(\d+)/);
    if (edge) return +edge[1] >= 135;
    const chrome = ua.match(/Chrome\/(\d+)/);
    return !!chrome && +chrome[1] >= 133;
  })();
  const displaySupported = trackSupported && !!navigator.mediaDevices?.getDisplayMedia;

  const sourceName = (src) => {
    if (src === 'default') return 'the default microphone';
    if (src === 'display') return 'computer audio';
    const o = [...el.source.options].find((x) => x.value === src);
    return o ? o.textContent : 'the selected microphone';
  };

  async function refreshSources() {
    if (!trackSupported) {
      el.source.textContent = '';
      el.source.add(new Option('Default microphone', 'default'));
      el.source.disabled = true;
      el.sourceHint.hidden = false;
      el.sourceHint.textContent = isAndroid
        ? 'On a phone the app always uses the default microphone.'
        : 'This browser always uses the default microphone. Use Google Chrome to choose another source.';
      return;
    }
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* keep the list empty */ }
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const def = mics.find((d) => d.deviceId === 'default');
    const real = mics.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    el.source.textContent = '';
    const defName = def && def.label ? def.label.replace(/^Default\s*-\s*/i, '') : '';
    el.source.add(new Option(defName ? `Default microphone (${defName})` : 'Default microphone', 'default'));
    real.forEach((d, i) => el.source.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
    if (displaySupported) el.source.add(new Option('Computer audio (a meeting, video or call)', 'display'));
    if (![...el.source.options].some((o) => o.value === prefs.source)) {
      // Without microphone permission the device list is hidden, so keep the saved choice.
      if (prefs.source !== 'default' && prefs.source !== 'display' && !real.length) {
        el.source.add(new Option('Saved microphone', prefs.source));
      } else {
        prefs.source = 'default';
      }
    }
    el.source.value = prefs.source;
    showSourceHint();
  }

  function showSourceHint() {
    if (!trackSupported) return;
    const hint = prefs.source === 'display'
      ? 'After pressing Start, pick the screen, window or tab that plays the sound and turn on "Share system audio" (or "Share tab audio").'
      : '';
    el.sourceHint.textContent = hint;
    el.sourceHint.hidden = !hint;
  }

  // Opens the chosen source. It is called straight from the Start click, with no await
  // before it, because sharing computer audio needs that click.
  async function openInput() {
    const src = trackSupported ? prefs.source : 'default';
    if (src === 'display') {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      });
      const track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach((t) => t.stop());
        throw Object.assign(new Error('No audio was shared'), { name: 'NoAudioShared' });
      }
      return { stream, track, useTrack: true, kind: 'display', name: 'computer audio' };
    }
    if (src !== 'default') {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: src } } });
      return { stream, track: stream.getAudioTracks()[0], useTrack: true, kind: 'mic', name: sourceName(src) };
    }
    // Default microphone: recognition opens it itself; only the audio recorder needs a stream.
    if (!prefs.audio || !navigator.mediaDevices?.getUserMedia) return null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return { stream, track: stream.getAudioTracks()[0], useTrack: false, kind: 'mic', name: 'the default microphone' };
    } catch {
      return null; // still transcribe; the audio just is not kept
    }
  }

  function inputError(err) {
    const name = err && err.name;
    if (name === 'NoAudioShared') {
      return 'No sound was shared. Press Start again, pick the screen or tab, and turn on "Share system audio" (or "Share tab audio").';
    }
    if (name === 'NotAllowedError') {
      return prefs.source === 'display'
        ? 'Sharing was cancelled, so nothing was recorded.'
        : 'Microphone access was blocked. Allow the microphone for this app in the browser, then start again.';
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return 'The selected microphone was not found. Plug it in or choose another audio source.';
    }
    if (name === 'NotReadableError') {
      return 'The selected microphone is being used by another program. Close it there or choose another audio source.';
    }
    return 'Could not open the audio source: ' + ((err && err.message) || err);
  }

  function closeInput() {
    if (input) input.stream.getTracks().forEach((t) => t.stop());
    input = null;
  }

  // ------------------------------------------------------------ audio recording
  function startRecorder(track) {
    audioFailed = false;
    if (!window.MediaRecorder || !track) { audioFailed = true; return; }
    try {
      const recorder = new MediaRecorder(new MediaStream([track]));
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.start(1000);
      audio = { recorder, chunks };
    } catch {
      audioFailed = true;
    }
  }

  // Resolves with the finished recording as one blob (or null).
  function stopAudio() {
    return new Promise((resolve) => {
      const a = audio;
      audio = null;
      if (!a) return resolve(null);
      const done = () => resolve(a.chunks.length ? new Blob(a.chunks, { type: a.recorder.mimeType || 'audio/webm' }) : null);
      if (a.recorder.state === 'inactive') return done();
      a.recorder.onstop = done;
      try { a.recorder.stop(); } catch { done(); }
    });
  }

  // ------------------------------------------------------------ recording control
  function startTimer() {
    const began = Date.now() - elapsed;
    clearInterval(tick);
    tick = setInterval(() => { elapsed = Date.now() - began; showTimer(); }, 500);
  }

  async function start() {
    if (!memory || active || starting || finishing) return;
    starting = true;
    setStatus('Starting…');
    let inp;
    try {
      const opening = openInput(); // before any await, so the click still counts
      render();
      inp = await opening;
    } catch (err) {
      starting = false;
      setStatus(inputError(err), true);
      render();
      return;
    }
    starting = false;
    input = inp;
    sourceStopped = '';
    current = {
      id: uid(), memoryId: memory.id, start: Date.now(), end: null, duration: 0,
      segments: [], edited: null, audioSize: 0, audioType: '',
      source: input && input.useTrack ? input.name : 'the default microphone',
    };
    recordings.push(current);
    active = true;
    paused = false;
    session++;
    sessionDone = false;
    finishing = false;
    fatal = false;
    lastError = null;
    retryDelay = 0;
    elapsed = 0;
    showTimer();
    DB.put('recordings', current).catch(dbError);
    if (prefs.audio) startRecorder(input && input.track);
    if (input && input.useTrack) {
      // Unplugging the microphone or pressing "Stop sharing" ends the recording and saves it.
      const kind = input.kind;
      input.track.addEventListener('ended', () => {
        if (!active) return;
        sourceStopped = kind === 'display' ? 'Sharing was stopped' : 'The microphone was disconnected';
        stop();
      });
    }
    setStatus(prefs.audio && audioFailed
      ? `Listening to ${current.source}… (the audio itself could not be recorded, only the text)`
      : `Listening to ${current.source}…`);
    render();
    startTimer();
    tryLaunch();
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  }

  function pause() {
    if (!active || paused) return;
    paused = true;
    clearInterval(tick);
    clearTimeout(retryTimer);
    try { rec?.stop(); } catch { /* already stopped */ }
    try { if (audio?.recorder.state === 'recording') audio.recorder.pause(); } catch { /* ignore */ }
    setStatus('Paused. Press Resume to keep going, or Stop to finish.');
    render();
  }

  function resume() {
    if (!active || !paused) return;
    paused = false;
    retryDelay = 0;
    lastError = null;
    try { if (audio?.recorder.state === 'paused') audio.recorder.resume(); } catch { /* ignore */ }
    startTimer();
    setStatus('Listening… speak now.');
    render();
    if (!recAlive) tryLaunch(); // otherwise onend restarts it
  }

  function stop() {
    if (!active) return;
    active = false;
    paused = false;
    finishing = true;
    clearInterval(tick);
    clearTimeout(retryTimer);
    setStatus('Finishing…');
    render();
    if (!recAlive) { finish(); return; }
    try { rec.stop(); } catch { /* already stopped */ }
    // In case the browser never reports the end; ignored if this recording already finished.
    const s = session;
    setTimeout(() => { if (s === session) finish(); }, 2000);
  }

  async function finish() {
    if (sessionDone) return;
    sessionDone = true;
    active = false;
    paused = false;
    clearInterval(tick);
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    if (recAlive) { try { rec.abort(); } catch { /* ignore */ } }
    rec = null;
    recAlive = false;
    const r = current;
    const blob = await stopAudio();
    closeInput();
    try { wakeLock?.release(); } catch { /* ignore */ }
    wakeLock = null;
    let kept = false;
    if (r) {
      r.end = Date.now();
      r.duration = elapsed;
      if (blob) {
        r.audioSize = blob.size;
        r.audioType = blob.type;
        audioCache.set(r.id, blob);
      }
      if (!r.segments.length && !blob) {
        recordings = recordings.filter((x) => x !== r);
        DB.del('recordings', r.id).catch(() => {});
      } else {
        kept = true;
        try {
          if (blob) await DB.put('audio', { recordingId: r.id, blob });
          await DB.put('recordings', r);
        } catch (err) { dbError(err); }
        saveMemory();
      }
    }
    current = null;
    finishing = false;
    runCorrection();
    if (!fatal) {
      const why = sourceStopped ? sourceStopped + ', so the recording ended. ' : '';
      setStatus(why + (kept
        ? `Recording ${recordings.indexOf(r) + 1} saved. The text was checked and corrected; you can edit it directly.`
        : 'Nothing was heard, so nothing was saved.'), !!why);
    }
    sourceStopped = '';
    render();
    refreshSources(); // device names become readable once the microphone has been allowed
    if (!fatal && kept) openExport(true, r.id);
  }

  // ------------------------------------------------------------ correction
  // All recordings of a title are corrected together, so names and words used
  // in one recording help fix the others.
  function runCorrection() {
    const input = [];
    for (const r of recordings) {
      if (r === current) continue;
      for (const s of r.segments) input.push(Object.assign({}, s, { recId: r.id }));
    }
    if (!input.length) { corrected = null; return; }
    const res = Corrector.correct(input, { fillers: prefs.fillers, punctuation: prefs.punct });
    const byRec = new Map();
    const changesByRec = new Map();
    for (const s of res.segments) {
      if (!byRec.has(s.recId)) byRec.set(s.recId, []);
      byRec.get(s.recId).push(s);
    }
    for (const c of res.changes) {
      const id = input[c.index] && input[c.index].recId;
      if (!id) continue;
      if (!changesByRec.has(id)) changesByRec.set(id, []);
      changesByRec.get(id).push(c);
    }
    corrected = { byRec, changesByRec, total: res.changes.length };
  }

  // ------------------------------------------------------------ text
  function paragraphs(segs) {
    const out = [];
    for (const s of segs) {
      const last = out[out.length - 1];
      if (last && last.lang === s.lang && s.start - last.end < 2500) {
        last.text += ' ' + s.text;
        last.end = s.end;
      } else out.push({ lang: s.lang, text: s.text, end: s.end });
    }
    return out;
  }

  const textOf = (segs) => paragraphs(segs).map((p) => p.text).join('\n\n');
  const rawText = (r) => textOf(r.segments);
  const fixedText = (r) => (r.edited != null ? r.edited : textOf((corrected && corrected.byRec.get(r.id)) || []));
  const recNumber = (r) => recordings.indexOf(r) + 1;

  const FILE_LABEL = {
    corrected: 'Corrected transcript',
    original: 'Raw transcript (exactly as heard)',
    fixes: 'List of automatic fixes',
  };

  // One text file for all recordings of the open title.
  function buildTxt(kind) {
    const done = recordings.filter((r) => r !== current);
    const rule = '='.repeat(48);
    const out = [
      `Title: ${memory.title}`,
      `File: ${FILE_LABEL[kind]}`,
      `Recordings: ${done.length}`,
      `Exported: ${fmtDate(Date.now())}`,
      '',
    ];
    for (const r of done) {
      const from = r.source && r.source !== 'the default microphone' ? `, ${r.source}` : '';
      out.push(rule, `Recording ${recNumber(r)}: ${fmtDate(r.start)} (${fmtDuration(r.duration)}${from})`, rule, '');
      let body;
      if (kind === 'corrected') body = fixedText(r);
      else if (kind === 'original') body = rawText(r);
      else {
        const changes = (corrected && corrected.changesByRec.get(r.id)) || [];
        body = changes.map((c) => `${c.before}  ->  ${c.after}   [${c.rule}]`).join('\r\n') || '(no fixes)';
      }
      out.push(body || '(nothing was heard)', '');
    }
    return out.join('\r\n');
  }

  // ------------------------------------------------------------ rendering
  function addParagraphs(container, segs) {
    for (const p of paragraphs(segs)) {
      const node = document.createElement('p');
      node.lang = p.lang;
      node.dir = p.lang === 'en' ? 'ltr' : 'rtl';
      node.textContent = p.text;
      container.appendChild(node);
    }
  }

  function render() {
    if (!memory) return;
    el.memTitle.textContent = memory.title;
    document.title = memory.title + ' · Transcriber';
    const doneCount = recordings.filter((r) => r !== current).length;
    el.memMeta.textContent = doneCount
      ? `${plural(doneCount, 'recording')} · created ${fmtDate(memory.created)}`
      : `Created ${fmtDate(memory.created)}`;

    const showCorrected = !!corrected && view === 'corrected';
    const t = el.transcript;
    t.textContent = '';
    for (const r of recordings) {
      const live = r === current;
      const block = document.createElement('article');
      block.className = 'rec';
      const head = document.createElement('div');
      head.className = 'recHead';
      const name = document.createElement('strong');
      name.textContent = 'Recording ' + recNumber(r);
      const when = document.createElement('time');
      when.dateTime = new Date(r.start).toISOString();
      when.textContent = fmtDate(r.start);
      const info = document.createElement('span');
      if (live) {
        info.className = 'live';
        info.textContent = paused ? 'paused' : 'recording now';
      } else {
        info.textContent = fmtDuration(r.duration) + (r.audioSize ? ' · audio' : '') +
          (r.source && r.source !== 'the default microphone' ? ' · ' + r.source : '') +
          (showCorrected && r.edited != null ? ' · edited by hand' : '');
      }
      head.append(name, when, info);

      const body = document.createElement('div');
      body.className = 'recText';
      if (live) {
        addParagraphs(body, r.segments);
        if (interim) {
          const node = document.createElement('p');
          node.className = 'interim';
          node.dir = prefs.lang === 'en' ? 'ltr' : 'rtl';
          node.textContent = interim;
          body.appendChild(node);
        }
      } else if (showCorrected) {
        if (r.edited != null) {
          for (const para of r.edited.split(/\n{2,}/)) {
            const node = document.createElement('p');
            node.dir = 'auto';
            node.textContent = para;
            body.appendChild(node);
          }
        } else addParagraphs(body, corrected.byRec.get(r.id) || []);
        if (r.segments.length) {
          body.contentEditable = active ? 'false' : 'true';
          body.dataset.rec = r.id;
        }
      } else addParagraphs(body, r.segments);
      if (!body.childNodes.length && !live) {
        const node = document.createElement('p');
        node.className = 'empty';
        node.textContent = r.audioSize ? '(no speech recognized; audio only)' : '(nothing was heard)';
        body.appendChild(node);
        body.removeAttribute('contenteditable');
      }
      block.append(head, body);
      t.appendChild(block);
    }
    if (active) t.scrollTop = t.scrollHeight;

    el.record.dataset.state = !active ? 'idle' : paused ? 'paused' : 'recording';
    el.record.setAttribute('aria-pressed', String(active));
    el.recordLabel.textContent = finishing ? 'Saving…' : starting ? 'Starting…' : active ? 'Stop' : doneCount ? 'Start new recording' : 'Start recording';
    el.pause.hidden = !active;
    el.pause.textContent = paused ? 'Resume' : 'Pause';
    el.record.disabled = finishing || starting || !SR;
    el.source.disabled = active || starting || finishing || !trackSupported;
    el.back.disabled = el.rename.disabled = active || finishing;

    el.views.hidden = !corrected;
    for (const b of el.views.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === view));

    const shownText = [...t.querySelectorAll('.recText')].map((b) => b.innerText).join(' ');
    const words = shownText.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    el.count.textContent = words ? plural(words, 'word') : '';

    renderFixes();

    const hasText = recordings.some((r) => r !== current && r.segments.length);
    const hasAudio = recordings.some((r) => r !== current && r.audioSize);
    el.copy.disabled = !hasText || active;
    el.exportBtn.disabled = !(hasText || hasAudio) || active;
    for (const b of document.querySelectorAll('.langs button')) b.setAttribute('aria-pressed', String(b.dataset.lang === prefs.lang));
  }

  function renderFixes() {
    const total = corrected ? corrected.total : 0;
    el.fixes.hidden = !total;
    if (!total) return;
    el.fixesSummary.textContent = plural(total, 'automatic fix').replace('fixs', 'fixes');
    el.fixesList.textContent = '';
    let shown = 0;
    for (const r of recordings) {
      const changes = corrected.changesByRec.get(r.id);
      if (!changes || !changes.length || shown >= 300) continue;
      const group = document.createElement('li');
      group.className = 'group';
      group.textContent = `Recording ${recNumber(r)}`;
      el.fixesList.appendChild(group);
      for (const c of changes) {
        if (shown++ >= 300) break;
        const li = document.createElement('li');
        li.dir = 'auto';
        const del = document.createElement('del'); del.textContent = c.before;
        const ins = document.createElement('ins'); ins.textContent = c.after;
        const rule = document.createElement('span'); rule.className = 'rule'; rule.textContent = c.rule;
        li.append(del, '→', ins, rule);
        el.fixesList.appendChild(li);
      }
    }
  }

  function showTimer() {
    const s = Math.floor(elapsed / 1000);
    el.timer.textContent = pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }

  // ------------------------------------------------------------ export window
  function openExport(justStopped, latestId) {
    const done = recordings.filter((r) => r !== current);
    const hasText = done.some((r) => r.segments.length);
    for (const k of ['corrected', 'original', 'fixes']) {
      const c = el.out[k];
      c.disabled = !hasText || (k === 'fixes' && !(corrected && corrected.total));
      c.checked = !c.disabled && prefs.export[k];
    }
    el.audioList.textContent = '';
    const withAudio = done.filter((r) => r.audioSize);
    el.audioNone.hidden = withAudio.length > 0;
    for (const r of withAudio) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.rec = r.id;
      box.checked = justStopped ? r.id === latestId : withAudio.length === 1;
      const text = document.createElement('span');
      text.textContent = `Recording ${recNumber(r)}: ${fmtDate(r.start)}`;
      const small = document.createElement('small');
      small.textContent = fmtSize(r.audioSize);
      text.appendChild(small);
      label.append(box, text);
      el.audioList.appendChild(label);
    }
    const latest = recordings.find((r) => r.id === latestId);
    el.exportNote.textContent = justStopped && latest
      ? `Recording ${recNumber(latest)} was added to "${memory.title}". Choose what to save.`
      : `"${memory.title}": choose what to save.`;
    updateExportButton();
    if (!el.dialog.open) el.dialog.showModal();
  }

  const exportBoxes = () => [...Object.values(el.out), ...el.audioList.querySelectorAll('input')];

  function updateExportButton() {
    el.exportSave.disabled = !exportBoxes().some((c) => c.checked && !c.disabled);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const textBlob = (text) => new Blob(['﻿' + text + '\r\n'], { type: 'text/plain;charset=utf-8' });
  const NAMES = { corrected: 'corrected transcript', original: 'raw transcript', fixes: 'fixes' };

  async function saveSelected() {
    el.exportSave.disabled = true;
    const base = safeName(memory.title);
    const files = [];
    for (const k of ['corrected', 'original', 'fixes']) {
      const c = el.out[k];
      if (c.disabled) continue;
      prefs.export[k] = c.checked;
      if (c.checked) files.push([textBlob(buildTxt(k)), `${base} - ${NAMES[k]}.txt`]);
    }
    store.set('prefs', prefs);
    let missing = 0;
    for (const box of el.audioList.querySelectorAll('input:checked')) {
      const r = recordings.find((x) => x.id === box.dataset.rec);
      if (!r) continue;
      let blob = audioCache.get(r.id);
      if (!blob) { try { blob = (await DB.get('audio', r.id))?.blob; } catch { blob = null; } }
      if (!blob) { missing++; continue; }
      const type = blob.type || r.audioType;
      const ext = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
      files.push([blob, `${base} - recording ${recNumber(r)} - ${stamp(r.start)}.${ext}`]);
    }
    for (const [blob, name] of files) {
      download(blob, name);
      await new Promise((res) => setTimeout(res, 300)); // browsers drop downloads fired in the same instant
    }
    el.dialog.close();
    const msg = `Saved ${plural(files.length, 'file')} to your Downloads folder.` +
      (missing ? ` ${plural(missing, 'audio recording')} could not be found on this device.` : '');
    setStatus(msg, missing > 0);
  }

  // ------------------------------------------------------------ events
  el.newBtn.addEventListener('click', showNewForm);
  el.loadBtn.addEventListener('click', showLoadList);
  el.newCancel.addEventListener('click', () => { el.newForm.hidden = true; });
  el.newForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = el.newTitle.value.replace(/\s+/g, ' ').trim();
    if (!title) { el.newError.hidden = false; el.newTitle.focus(); return; }
    createMemory(title);
  });
  el.newTitle.addEventListener('input', () => { el.newError.hidden = true; });

  el.back.addEventListener('click', () => { if (!active) showHome(); });
  el.rename.addEventListener('click', () => {
    if (active || !memory) return;
    const title = (prompt('New title', memory.title) || '').replace(/\s+/g, ' ').trim();
    if (!title || title === memory.title) return;
    memory.title = title;
    saveMemory();
    render();
  });

  el.record.addEventListener('click', () => {
    if (finishing) return;
    if (active) stop();
    else start();
  });
  el.pause.addEventListener('click', () => (paused ? resume() : pause()));

  document.querySelector('.langs').addEventListener('click', (e) => {
    const lang = e.target.closest('button')?.dataset.lang;
    if (!lang || lang === prefs.lang) return;
    prefs.lang = lang;
    store.set('prefs', prefs);
    render();
    if (active && !paused && recAlive) {
      launchedAt = 0; // a deliberate restart, not a hiccup
      try { rec.stop(); } catch { /* restarts in onend with the new language */ }
    }
  });

  el.views.addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.view;
    if (!v) return;
    view = v;
    render();
  });

  // Hand edits of the corrected text are saved per recording.
  el.transcript.addEventListener('input', (e) => {
    const body = e.target.closest && e.target.closest('.recText[data-rec]');
    if (!body) return;
    const r = recordings.find((x) => x.id === body.dataset.rec);
    if (!r) return;
    r.edited = body.innerText.replace(/\n{3,}/g, '\n\n').trim();
    clearTimeout(editTimer);
    editTimer = setTimeout(() => DB.put('recordings', r).catch(dbError), 600);
  });

  el.copy.addEventListener('click', async () => {
    const text = buildTxt(corrected && view === 'corrected' ? 'corrected' : 'original');
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied all recordings to the clipboard.');
    } catch {
      setStatus('Could not copy to the clipboard. Use Export instead.', true);
    }
  });

  el.exportBtn.addEventListener('click', () => openExport(false));
  el.exportSave.addEventListener('click', saveSelected);
  el.exportClose.addEventListener('click', () => el.dialog.close());
  el.dialog.addEventListener('change', updateExportButton);

  function bindOption(input, name, prop) {
    input[prop] = prefs[name];
    input.addEventListener('change', () => {
      prefs[name] = input[prop];
      store.set('prefs', prefs);
      if (!active && memory && name !== 'audio') { runCorrection(); render(); }
    });
  }
  bindOption(el.optFillers, 'fillers', 'checked');
  bindOption(el.optPunct, 'punct', 'checked');
  bindOption(el.optDialect, 'arDialect', 'value');
  bindOption(el.optAudio, 'audio', 'checked');

  el.source.addEventListener('change', () => {
    prefs.source = el.source.value;
    store.set('prefs', prefs);
    showSourceHint();
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (!active) refreshSources(); });

  window.addEventListener('beforeunload', (e) => {
    if (active) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------ startup
  showHome();
  refreshSources();
  if (!SR) {
    el.record.disabled = true;
    setStatus('This browser has no speech recognition. Open the app in Google Chrome (Windows or Android).', true, el.homeStatus);
    setStatus('This browser has no speech recognition. Open the app in Google Chrome.', true);
  }
  if (!window.indexedDB) {
    el.newBtn.disabled = el.loadBtn.disabled = true;
    setStatus('This browser cannot save recordings. Open the app in Google Chrome.', true, el.homeStatus);
  } else {
    migrateOldTranscript().catch(dbError);
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
  }
})();
