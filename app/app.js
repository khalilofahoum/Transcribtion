(() => {
  'use strict';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const isAndroid = /Android/i.test(navigator.userAgent);
  const $ = (id) => document.getElementById(id);

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  const prefs = Object.assign(
    // Android cannot reliably share the microphone between the recorder and speech recognition, so audio is off there by default.
    { lang: 'en', arDialect: 'ar-IL', fillers: true, punct: true, audio: !isAndroid },
    store.get('prefs', {})
  );
  prefs.export = Object.assign({ audio: true, corrected: true, original: false, fixes: false }, prefs.export);

  let segments = store.get('segments', []); // raw recognizer output: {text, lang, confidence, alternatives, start, end}
  let corrected = null; // { segments, changes } after the correction pass
  let view = 'corrected';
  let active = false; // a recording session is in progress (running or paused)
  let paused = false;
  let sessionDone = true;
  let rec = null;
  let recAlive = false;
  let interim = '';
  let interimStart = 0;
  let fatal = false;
  let quickEnds = 0;
  let launchedAt = 0;
  let elapsed = 0;
  let tick = null;
  let wakeLock = null;
  let audio = null; // { stream, recorder, chunks } while a session is in progress
  let audioParts = []; // finished audio recordings (one per session), kept in memory only
  let audioFailed = false;

  const el = {
    record: $('record'), recordLabel: $('recordLabel'), pause: $('pause'), timer: $('timer'), status: $('status'),
    transcript: $('transcript'), views: $('views'), count: $('count'),
    fixes: $('fixes'), fixesSummary: $('fixesSummary'), fixesList: $('fixesList'),
    copy: $('copy'), exportBtn: $('export'), clear: $('clear'),
    optFillers: $('optFillers'), optPunct: $('optPunct'), optDialect: $('optDialect'), optAudio: $('optAudio'),
    dialog: $('exportDialog'), exportNote: $('exportNote'), exportSave: $('exportSave'), exportClose: $('exportClose'),
    out: { audio: $('outAudio'), corrected: $('outCorrected'), original: $('outOriginal'), fixes: $('outFixes') },
    audioInfo: $('audioInfo'),
  };

  const langCode = () => (prefs.lang === 'en' ? 'en-US' : prefs.lang === 'he' ? 'he-IL' : prefs.arDialect);

  function setStatus(text, warn) {
    el.status.textContent = text || '';
    el.status.classList.toggle('warn', !!warn && !!text);
  }

  // ------------------------------------------------------------ recognition
  function launch() {
    const lang = prefs.lang;
    rec = new SR();
    rec.lang = langCode();
    // Android Chrome repeats earlier text in continuous mode, so use one phrase per session there.
    rec.continuous = !isAndroid;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    launchedAt = Date.now();

    rec.onresult = (e) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const alternatives = [];
          for (let j = 0; j < r.length; j++) {
            const text = r[j].transcript.trim();
            if (text) alternatives.push({ text, confidence: r[j].confidence || 0 });
          }
          if (alternatives.length) {
            segments.push({
              text: alternatives[0].text, lang, confidence: alternatives[0].confidence, alternatives,
              start: interimStart || Date.now(), end: Date.now(),
            });
          }
          interimStart = 0;
        } else {
          if (!interimStart) interimStart = Date.now();
          interim += r[0].transcript;
        }
      }
      store.set('segments', segments);
      if (!active) runCorrection(); // last words that arrived after Stop
      render();
    };

    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      fatal = true;
      const messages = {
        'not-allowed': 'Microphone access was blocked. Allow the microphone for this app in the browser, then try again.',
        'service-not-allowed': 'Speech recognition is not allowed in this browser. Open the app in Google Chrome.',
        'audio-capture': prefs.audio
          ? 'The microphone could not be used for transcription. Turn off "Also record the audio" in Settings and try again.'
          : 'No microphone was found. Connect one and try again.',
        'network': 'The speech service could not be reached. Check your internet connection and try again.',
        'language-not-supported': 'This language is not supported by the speech service on this device.',
      };
      setStatus(messages[e.error] || 'Recording stopped: ' + e.error, true);
    };

    rec.onend = () => {
      recAlive = false;
      interim = '';
      interimStart = 0;
      if (active && !fatal) {
        if (paused) { render(); return; }
        // The browser ends sessions on silence; keep going until the user presses Stop.
        quickEnds = Date.now() - launchedAt < 800 ? quickEnds + 1 : 0;
        if (quickEnds >= 6) {
          fatal = true;
          setStatus('The speech service keeps stopping. Check the microphone and internet connection.', true);
        } else {
          setTimeout(() => { if (active && !paused && !recAlive) tryLaunch(); }, 200);
          return;
        }
      }
      finish();
    };

    rec.start();
    recAlive = true;
  }

  function tryLaunch() {
    try { launch(); } catch (err) {
      fatal = true;
      setStatus('Could not start recording: ' + err.message, true);
      finish();
    }
  }

  // ------------------------------------------------------------ audio recording
  async function startAudio() {
    audioFailed = false;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { audioFailed = true; return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.start(1000);
      audio = { stream, recorder, chunks };
    } catch {
      audioFailed = true;
    }
  }

  function stopAudio() {
    return new Promise((resolve) => {
      const a = audio;
      audio = null;
      if (!a) return resolve();
      const done = () => {
        a.stream.getTracks().forEach((t) => t.stop());
        if (a.chunks.length) audioParts.push(new Blob(a.chunks, { type: a.recorder.mimeType || 'audio/webm' }));
        resolve();
      };
      if (a.recorder.state === 'inactive') return done();
      a.recorder.onstop = done;
      try { a.recorder.stop(); } catch { done(); }
    });
  }

  // ------------------------------------------------------------ session control
  function startTimer() {
    const began = Date.now() - elapsed;
    clearInterval(tick);
    tick = setInterval(() => { elapsed = Date.now() - began; showTimer(); }, 500);
  }

  async function start() {
    active = true;
    paused = false;
    sessionDone = false;
    fatal = false;
    quickEnds = 0;
    corrected = null;
    setStatus('Starting…');
    render();
    if (prefs.audio) await startAudio();
    if (!active) { stopAudio(); return; }
    setStatus(prefs.audio && audioFailed
      ? 'Listening… (the audio itself could not be recorded on this device, only the text)'
      : 'Listening… speak now.');
    startTimer();
    tryLaunch();
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  }

  function pause() {
    if (!active || paused) return;
    paused = true;
    clearInterval(tick);
    try { rec?.stop(); } catch { /* already stopped */ }
    try { if (audio?.recorder.state === 'recording') audio.recorder.pause(); } catch { /* ignore */ }
    setStatus('Paused. Press Resume to keep going, or Stop to finish.');
    render();
  }

  function resume() {
    if (!active || !paused) return;
    paused = false;
    quickEnds = 0;
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
    clearInterval(tick);
    setStatus('Finishing…');
    if (!recAlive) { finish(); return; }
    try { rec.stop(); } catch { /* already stopped */ }
    setTimeout(finish, 2000); // in case the browser never reports the end
  }

  async function finish() {
    if (sessionDone) return;
    sessionDone = true;
    active = false;
    paused = false;
    clearInterval(tick);
    await stopAudio();
    try { wakeLock?.release(); } catch { /* ignore */ }
    wakeLock = null;
    runCorrection();
    if (!fatal) setStatus(segments.length ? 'Done. The text below was checked and corrected — you can edit it directly.' : 'Nothing was heard.');
    render();
    if (!fatal && (segments.length || audioParts.length)) openExport(true);
  }

  // ------------------------------------------------------------ correction
  function runCorrection() {
    corrected = segments.length
      ? Corrector.correct(segments, { fillers: prefs.fillers, punctuation: prefs.punct })
      : null;
    view = 'corrected';
  }

  // ------------------------------------------------------------ rendering
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

  function render() {
    const showCorrected = !active && corrected && view === 'corrected';
    const segs = showCorrected ? corrected.segments : segments;
    const t = el.transcript;
    t.textContent = '';
    for (const p of paragraphs(segs)) {
      const node = document.createElement('p');
      node.lang = p.lang;
      node.dir = p.lang === 'en' ? 'ltr' : 'rtl';
      node.textContent = p.text;
      t.appendChild(node);
    }
    if (active && interim) {
      const node = document.createElement('p');
      node.className = 'interim';
      node.dir = prefs.lang === 'en' ? 'ltr' : 'rtl';
      node.textContent = interim;
      t.appendChild(node);
    }
    if (active) t.scrollTop = t.scrollHeight;
    t.contentEditable = active || !segments.length ? 'false' : 'true';

    el.record.dataset.state = !active ? 'idle' : paused ? 'paused' : 'recording';
    el.record.setAttribute('aria-pressed', String(active));
    el.recordLabel.textContent = active ? 'Stop' : segments.length ? 'Continue recording' : 'Start recording';
    el.pause.hidden = !active;
    el.pause.textContent = paused ? 'Resume' : 'Pause';

    el.views.hidden = active || !corrected;
    for (const b of el.views.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.view === view));

    const words = segs.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    el.count.textContent = words ? words + (words === 1 ? ' word' : ' words') : '';

    const changes = !active && corrected ? corrected.changes : [];
    el.fixes.hidden = !changes.length;
    if (changes.length) {
      el.fixesSummary.textContent = changes.length + (changes.length === 1 ? ' automatic fix' : ' automatic fixes');
      el.fixesList.textContent = '';
      for (const c of changes.slice(0, 300)) {
        const li = document.createElement('li');
        li.dir = 'auto';
        const del = document.createElement('del'); del.textContent = c.before;
        const ins = document.createElement('ins'); ins.textContent = c.after;
        const rule = document.createElement('span'); rule.className = 'rule'; rule.textContent = c.rule;
        li.append(del, '→', ins, rule);
        el.fixesList.appendChild(li);
      }
    }

    const empty = !segments.length && !audioParts.length;
    el.copy.disabled = !segments.length || active;
    el.exportBtn.disabled = el.clear.disabled = empty || active;
    for (const b of document.querySelectorAll('.langs button')) b.setAttribute('aria-pressed', String(b.dataset.lang === prefs.lang));
  }

  function showTimer() {
    const s = Math.floor(elapsed / 1000);
    el.timer.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  const currentText = () => el.transcript.innerText.replace(/\n{3,}/g, '\n\n').trim();

  // ------------------------------------------------------------ export window
  function openExport(justStopped) {
    const hasAudio = audioParts.length > 0;
    const hasText = segments.length > 0;
    const mb = audioParts.reduce((n, b) => n + b.size, 0) / 1048576;
    el.audioInfo.textContent = hasAudio
      ? `${audioParts.length > 1 ? audioParts.length + ' files, ' : ''}${mb < 0.1 ? '<0.1' : mb.toFixed(1)} MB`
      : 'not recorded';
    el.out.audio.disabled = !hasAudio;
    el.out.audio.checked = hasAudio && prefs.export.audio;
    for (const k of ['corrected', 'original', 'fixes']) {
      el.out[k].disabled = !hasText || (k === 'fixes' && !(corrected && corrected.changes.length));
      el.out[k].checked = !el.out[k].disabled && prefs.export[k];
    }
    el.exportNote.textContent = justStopped ? 'Recording finished. Choose what to save.' : 'Choose what to save.';
    updateExportButton();
    if (!el.dialog.open) el.dialog.showModal();
  }

  function updateExportButton() {
    el.exportSave.disabled = !Object.values(el.out).some((c) => c.checked);
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  const textBlob = (text) => new Blob(['﻿' + text + '\n'], { type: 'text/plain;charset=utf-8' });

  async function saveSelected() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const base = `transcript-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const files = [];
    if (el.out.corrected.checked && corrected) {
      // include any hand edits when the corrected text is what is on screen
      files.push([textBlob(view === 'corrected' ? currentText() : textOf(corrected.segments)), base + '-corrected.txt']);
    }
    if (el.out.original.checked) files.push([textBlob(textOf(segments)), base + '-original.txt']);
    if (el.out.fixes.checked && corrected) {
      const lines = corrected.changes.map((c) => `${c.before}  →  ${c.after}   [${c.rule}]`);
      files.push([textBlob(lines.join('\n')), base + '-fixes.txt']);
    }
    if (el.out.audio.checked) {
      audioParts.forEach((blob, i) => {
        const ext = /mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
        files.push([blob, `${base}-audio${audioParts.length > 1 ? '-' + (i + 1) : ''}.${ext}`]);
      });
    }
    for (const k of Object.keys(el.out)) if (!el.out[k].disabled) prefs.export[k] = el.out[k].checked;
    store.set('prefs', prefs);
    for (const [blob, name] of files) {
      download(blob, name);
      await new Promise((r) => setTimeout(r, 300)); // browsers drop downloads fired in the same instant
    }
    el.dialog.close();
    setStatus(`Saved ${files.length} file${files.length === 1 ? '' : 's'} to your Downloads folder.`);
  }

  // ------------------------------------------------------------ events
  el.record.addEventListener('click', () => (active ? stop() : start()));
  el.pause.addEventListener('click', () => (paused ? resume() : pause()));

  document.querySelector('.langs').addEventListener('click', (e) => {
    const lang = e.target.closest('button')?.dataset.lang;
    if (!lang || lang === prefs.lang) return;
    prefs.lang = lang;
    store.set('prefs', prefs);
    render();
    if (active && !paused && recAlive) { try { rec.stop(); } catch { /* restarts in onend with the new language */ } }
  });

  el.views.addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.view;
    if (!v) return;
    view = v;
    render();
  });

  el.copy.addEventListener('click', async () => {
    const text = currentText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(el.transcript);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('copy');
      sel.removeAllRanges();
    }
    setStatus('Copied to the clipboard.');
  });

  el.exportBtn.addEventListener('click', () => openExport(false));
  el.exportSave.addEventListener('click', saveSelected);
  el.exportClose.addEventListener('click', () => el.dialog.close());
  for (const c of Object.values(el.out)) c.addEventListener('change', updateExportButton);

  el.clear.addEventListener('click', () => {
    if (!confirm('Delete this transcript and its audio recording?')) return;
    segments = [];
    corrected = null;
    audioParts = [];
    elapsed = 0;
    store.set('segments', segments);
    showTimer();
    setStatus('');
    render();
  });

  function bindOption(input, name, prop) {
    input[prop] = prefs[name];
    input.addEventListener('change', () => {
      prefs[name] = input[prop];
      store.set('prefs', prefs);
      if (!active && name !== 'audio') { runCorrection(); render(); }
    });
  }
  bindOption(el.optFillers, 'fillers', 'checked');
  bindOption(el.optPunct, 'punct', 'checked');
  bindOption(el.optDialect, 'arDialect', 'value');
  bindOption(el.optAudio, 'audio', 'checked');

  // ------------------------------------------------------------ startup
  if (!SR) {
    el.record.disabled = true;
    setStatus('This browser has no speech recognition. Open the app in Google Chrome (Windows or Android).', true);
  }
  if (segments.length) {
    runCorrection();
    if (SR) setStatus('Your last transcript was restored.');
  }
  render();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
  }
})();
