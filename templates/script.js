lucide.createIcons();

// Roles from the SRS: 1 Admin, 2 Executive, 3 Normal User. The server enforces them; this only shapes the page.
const ROLE = Number(document.body.dataset.role);
const IS_ADMIN = ROLE === 1;
const IS_EXEC = ROLE === 2;

// GSAP comes from a CDN. Without it (or with reduced motion) everything still works, just without motion.
const hasGsap = typeof window.gsap !== 'undefined';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const animate = hasGsap && !reduceMotion;
if (hasGsap) gsap.defaults({ ease: 'expo.out', duration: 0.5 });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentView = 'dashboard';
let selectedFile = null;
let job = null;            // { fileName } while an analysis is running
let currentReport = null;  // report shown on the Meeting Report page
let latestReportId = null; // newest finished report, for the "View report" toast

const pageTitles = {
    dashboard: 'Dashboard',
    analyze: 'New Analysis',
    loading: 'New Analysis',
    results: 'Meeting Report',
    history: 'History',
    admin: 'Admin',
    settings: 'Settings'
};

const mainEl = document.getElementById('main');
const toolbar = document.getElementById('toolbar');

// ---------------------------------------------------------------------------
// Saved reports live in the server database (per user). This is an in-memory copy for fast rendering.
// ---------------------------------------------------------------------------
let reportCache = [];

function loadReports() {
    return reportCache;
}

async function refreshReports() {
    if (IS_ADMIN) return; // admins never load meetings
    try {
        const res = await fetch('/api/reports');
        if (res.status === 401) { location.href = '/login'; return; }
        if (res.ok) reportCache = await res.json();
    } catch { /* offline: keep what we have */ }
    renderDashboard();
    if (currentView === 'history') renderHistory();
}

// The server already saved the meeting during /analyze; this just adds it to the local list.
function addReport(report, saved) {
    reportCache = [report, ...reportCache];
    if (!saved) showToast('This report could not be saved to your history.', true);
}

// The list holds metadata only; a meeting's transcript is fetched when it is opened.
async function getReport(id) {
    const cached = reportCache.find(r => r.id === id) || (currentReport && currentReport.id === id ? currentReport : null);
    if (cached && cached.lines) return cached;
    try {
        const res = await fetch(`/api/reports/${encodeURIComponent(id)}`);
        if (res.ok) {
            const full = await res.json();
            reportCache = reportCache.map(r => r.id === id ? full : r);
            return full;
        }
    } catch { /* fall through */ }
    return null;
}

async function clearHistory() {
    if (!confirm('Delete all of your own saved reports? This cannot be undone.')) return;
    try {
        const res = await fetch('/api/reports', { method: 'DELETE' });
        if (!res.ok) throw new Error();
    } catch { showToast('Could not clear history.', true); return; }
    reportCache = reportCache.filter(r => !r.mine);
    renderHistory();
    renderDashboard();
    showToast('History cleared');
}

async function deleteReportRow(r) {
    if (!confirm(`Delete "${r.title || r.fileName}"? This cannot be undone.`)) return;
    try { await api('DELETE', `/api/reports/${encodeURIComponent(r.id)}`); }
    catch (error) { showToast(error.message, true); return; }
    reportCache = reportCache.filter(x => x.id !== r.id);
    renderHistory();
    renderDashboard();
    showToast('Meeting deleted');
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function moveNavIndicator(btn, instant = false) {
    const indicator = document.getElementById('nav-indicator');
    if (!btn) { indicator.style.opacity = '0'; return; }
    const y = btn.offsetTop; // indicator and buttons share #side-nav as offset parent
    indicator.style.opacity = '1';
    if (animate && !instant) gsap.to(indicator, { y, duration: 0.5, ease: 'expo.out', overwrite: 'auto' });
    else if (hasGsap) gsap.set(indicator, { y });
    else indicator.style.transform = `translateY(${y}px)`;
}

function switchView(viewId) {
    // "New Analysis" shows the progress screen while a job is running, instead of a fresh upload form.
    if (viewId === 'analyze' && job) viewId = 'loading';
    if (viewId === 'dashboard') renderDashboard();
    if (viewId === 'history') renderHistory();
    if (viewId === 'admin') renderAdmin();

    const changed = viewId !== currentView;
    currentView = viewId;

    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(`view-${viewId}`);
    target.classList.add('active');
    document.getElementById('page-title').textContent = pageTitles[viewId] || 'Majlis';

    // Analyze, progress and new reports all live under "New Analysis"; opened past reports under History.
    const navId = { loading: 'analyze', results: currentReport && currentReport.fromHistory ? 'history' : 'analyze' }[viewId] || viewId;
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('is-active'));
    const activeBtn = document.getElementById(`nav-${navId}`);
    activeBtn.classList.add('is-active');
    moveNavIndicator(activeBtn);
    if (navId === 'analyze') setNavNews(false);

    if (changed) mainEl.scrollTop = 0;
    toolbar.classList.toggle('is-scrolled', false);
    updateWaves();

    if (animate && changed) {
        gsap.fromTo(target.querySelectorAll(':scope > *, .loading-wrap > *'),
            { autoAlpha: 0, y: 12 },
            { autoAlpha: 1, y: 0, duration: 0.55, stagger: 0.05, overwrite: true, clearProps: 'transform,visibility' });
    }
}

// Toolbar gets a frosted bar and the small title once the large title scrolls away.
mainEl.addEventListener('scroll', () => {
    toolbar.classList.toggle('is-scrolled', mainEl.scrollTop > 36);
}, { passive: true });

window.addEventListener('resize', () => moveNavIndicator(document.querySelector('.nav-btn.is-active'), true));

// Sidebar status next to "New Analysis": spinner while running, dot when a report is waiting.
function setNavBusy(busy) {
    const btn = document.getElementById('nav-analyze');
    const status = document.getElementById('nav-analyze-status');
    btn.classList.toggle('is-busy', busy);
    if (busy) {
        btn.classList.remove('has-news');
        status.innerHTML = '<i data-lucide="loader-circle" class="spin"></i>Working';
        lucide.createIcons();
    }
}
function setNavNews(news) {
    const btn = document.getElementById('nav-analyze');
    btn.classList.toggle('has-news', news);
    if (news) document.getElementById('nav-analyze-status').innerHTML = '<span class="nav-dot"></span>Ready';
}

// ---------------------------------------------------------------------------
// Dashboard and History lists
// ---------------------------------------------------------------------------
function formatDuration(secs) {
    if (!secs) return '';
    const m = Math.round(secs / 60);
    return m < 1 ? `${Math.round(secs)} sec` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function formatDate(ts) {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function reportMeta(r) {
    const parts = [formatDate(r.createdAt)];
    if (r.duration) parts.push(formatDuration(r.duration));
    if (r.speakers) parts.push(`${r.speakers} speaker${r.speakers === 1 ? '' : 's'}`);
    return parts.join(', ');
}

function meetingRow(r, deletable) {
    const wrap = document.createElement('div');
    wrap.className = 'meeting-wrap';
    const row = document.createElement('button');
    row.className = 'meeting';
    row.onclick = () => openReport(r.id, true);
    row.innerHTML = `
        <span class="meeting-icon"><i data-lucide="file-audio-2"></i></span>
        <span class="meeting-main">
            <span class="meeting-name" style="display:block"></span>
            <span class="meeting-meta num" style="display:block"></span>
        </span>
        <i data-lucide="chevron-right"></i>`;
    row.querySelector('.meeting-name').textContent = r.title || r.fileName;
    const meta = row.querySelector('.meeting-meta');
    meta.textContent = reportMeta(r);
    if (r.mine === false) {
        const who = document.createElement('span');
        who.className = 'meeting-owner';
        who.textContent = `${r.owner}: `;
        meta.prepend(who);
    }
    wrap.appendChild(row);
    if (deletable && r.mine !== false) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'icon-btn btn-danger';
        del.setAttribute('aria-label', `Delete ${r.title || r.fileName}`);
        del.innerHTML = '<i data-lucide="trash-2"></i>';
        del.onclick = () => deleteReportRow(r);
        wrap.appendChild(del);
    }
    return wrap;
}

function emptyState(icon, title, text, withButton) {
    const el = document.createElement('div');
    el.className = 'empty';
    el.innerHTML = `<div class="empty-icon"><i data-lucide="${icon}"></i></div><h3></h3><p></p>`;
    el.querySelector('h3').textContent = title;
    el.querySelector('p').textContent = text;
    if (withButton) {
        const b = document.createElement('button');
        b.className = 'btn btn-primary';
        b.textContent = 'Analyze a recording';
        b.onclick = () => switchView('analyze');
        el.appendChild(b);
    }
    return el;
}

function renderDashboard() {
    const reports = loadReports().filter(r => r.mine !== false);
    const hours = reports.reduce((sum, r) => sum + (r.duration || 0), 0) / 3600;
    document.getElementById('stat-meetings').textContent = reports.length;
    document.getElementById('stat-hours').textContent = hours.toFixed(1) + 'h';
    document.getElementById('stat-speakers').textContent = reports.reduce((sum, r) => sum + (r.speakers || 0), 0);

    const list = document.getElementById('recent-list');
    list.replaceChildren();
    if (reports.length) reports.slice(0, 3).forEach(r => list.appendChild(meetingRow(r)));
    else list.appendChild(emptyState('mic', 'No meetings analyzed yet', 'Upload an audio recording of your first meeting to extract speakers, transcripts, and AI-generated executive summaries.', true));
    document.getElementById('see-all').hidden = reports.length <= 3;
    lucide.createIcons();
}

function renderHistory() {
    const all = loadReports();
    const query = (document.getElementById('history-search').value || '').toLowerCase().trim();
    const scope = (document.getElementById('history-scope') || {}).value || 'all';
    const days = Number(document.getElementById('history-range').value);
    const reports = all.filter(r => {
        if (scope === 'mine' && r.mine === false) return false;
        if (scope === 'team' && r.mine !== false) return false;
        if (days && Date.now() - r.createdAt > days * 86400000) return false;
        const haystack = `${r.title} ${r.fileName} ${r.summary} ${r.owner}`.toLowerCase();
        return query.split(/\s+/).every(term => haystack.includes(term));
    });
    const list = document.getElementById('history-list');
    list.replaceChildren();
    if (reports.length) reports.forEach(r => list.appendChild(meetingRow(r, true)));
    else if (all.length) list.appendChild(emptyState('search-x', 'No meetings match', 'Try a different search or date range.', false));
    else list.appendChild(emptyState('clock-3', 'No reports yet', 'Every analysis you run is saved here so you can open it again later.', true));
    document.getElementById('clear-history').hidden = !all.some(r => r.mine !== false);
    lucide.createIcons();
}

// ---------------------------------------------------------------------------
// Waveforms: idle on the upload screen, busy while analyzing
// ---------------------------------------------------------------------------
function buildWave(el, bars) {
    for (let i = 0; i < bars; i++) el.appendChild(document.createElement('span'));
    return Array.from(el.children);
}
const idleBars = buildWave(document.getElementById('idle-wave'), 21);
const busyBars = buildWave(document.getElementById('busy-wave'), 31);

function waveTween(bars, { min, max, speed }) {
    if (!animate) {
        bars.forEach((b, i) => { b.style.transform = `scaleY(${0.25 + 0.5 * Math.abs(Math.sin(i * 0.6))})`; });
        return null;
    }
    // Each bar breathes on its own random loop; a sine envelope keeps the middle taller.
    const tl = gsap.timeline({ paused: true });
    bars.forEach((bar, i) => {
        const envelope = 0.45 + 0.55 * Math.sin((i / (bars.length - 1)) * Math.PI);
        tl.to(bar, {
            scaleY: () => gsap.utils.random(min, max) * envelope,
            duration: () => gsap.utils.random(speed * 0.7, speed * 1.3),
            ease: 'sine.inOut', repeat: -1, yoyo: true, repeatRefresh: true
        }, i * 0.03);
    });
    return tl;
}
const idleWave = waveTween(idleBars, { min: 0.18, max: 0.75, speed: 0.9 });
const busyWave = waveTween(busyBars, { min: 0.2, max: 1, speed: 0.45 });

function updateWaves() {
    if (!idleWave) return;
    currentView === 'analyze' && !selectedFile ? idleWave.play() : idleWave.pause();
    currentView === 'loading' ? busyWave.play() : busyWave.pause();
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('audio');
const filePreview = document.getElementById('file-preview');
const uploadPrompt = document.getElementById('upload-prompt');
const btnAnalyze = document.getElementById('btn-analyze');

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
    dropZone.addEventListener(name, e => { e.preventDefault(); e.stopPropagation(); }, false);
});
['dragenter', 'dragover'].forEach(name => dropZone.addEventListener(name, () => dropZone.classList.add('is-dragging')));
['dragleave', 'drop'].forEach(name => dropZone.addEventListener(name, () => dropZone.classList.remove('is-dragging')));

dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        fileInput.files = files;
        handleFileSelect({ target: fileInput });
    }
});

function formatSize(bytes) {
    return bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    selectedFile = file;

    document.getElementById('file-name').textContent = file.name;
    document.getElementById('file-size').textContent = formatSize(file.size);

    uploadPrompt.style.display = 'none';
    filePreview.classList.add('flex');
    updateAnalyzeButton();
    updateWaves();

    if (animate) gsap.fromTo(filePreview, { autoAlpha: 0, y: 10, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.5, clearProps: 'transform,visibility' });
}

function resetUpload() {
    fileInput.value = '';
    selectedFile = null;
    filePreview.classList.remove('flex');
    uploadPrompt.style.display = '';
    updateAnalyzeButton();
    updateWaves();
}

function clearFile(event) {
    event.preventDefault();
    event.stopPropagation();
    resetUpload();
    if (animate) gsap.fromTo(uploadPrompt, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.4, clearProps: 'transform,visibility' });
}

// ---------------------------------------------------------------------------
// Speakers. EAGLE diarization recognises voices it has heard before, so every
// speaker reads aloud for about 20 seconds. Samples are recorded here, turned
// into 16 kHz mono WAV in the browser and sent along with the meeting.
// ---------------------------------------------------------------------------
const MAX_SPEAKERS = 20;
const ENROLL_SECONDS = 20;
const MIN_ENROLL_SECONDS = 5;
const ENROLL_RATE = 16000;

const speakerList = document.getElementById('speaker-list');
const analyzeHint = document.getElementById('analyze-hint');
let speakers = [];        // { id, name, sample: Blob|null, url, duration, busy, el }
let nextSpeakerId = 1;
let recorder = null;      // { speaker, mediaRecorder, stream, chunks, startedAt, timer }
const samplePlayer = new Audio();
let playingSpeaker = null;

function speakerInitial(name) {
    const first = [...(name || '').trim()][0];
    return first ? first.toUpperCase() : '?';
}

function addSpeaker(focus = true) {
    if (speakers.length >= MAX_SPEAKERS) return;
    const s = { id: nextSpeakerId++, name: `Speaker ${speakers.length + 1}`, sample: null, url: null, duration: 0, busy: false };

    const block = document.createElement('div');
    block.className = 'speaker-block';
    block.innerHTML = `
        <div class="speaker-row">
            <div class="avatar" aria-hidden="true"></div>
            <input class="speaker-name" type="text" maxlength="40" autocomplete="off" aria-label="Speaker name">
            <span class="sample-status num"></span>
            <div class="speaker-actions">
                <button type="button" class="btn btn-secondary btn-record"></button>
                <button type="button" class="btn icon-btn btn-play" aria-label="Play voice sample"><i data-lucide="play"></i></button>
                <button type="button" class="btn icon-btn btn-remove" aria-label="Remove speaker"><i data-lucide="trash-2"></i></button>
            </div>
        </div>
        <div class="rec-meter" aria-hidden="true"><span></span></div>`;

    s.el = {
        block,
        avatar: block.querySelector('.avatar'),
        input: block.querySelector('.speaker-name'),
        status: block.querySelector('.sample-status'),
        record: block.querySelector('.btn-record'),
        play: block.querySelector('.btn-play'),
        remove: block.querySelector('.btn-remove'),
        meter: block.querySelector('.rec-meter span')
    };
    s.el.input.value = s.name;
    s.el.input.addEventListener('input', () => { s.name = s.el.input.value; refreshSpeakers(); });
    s.el.record.addEventListener('click', () => toggleRecording(s));
    s.el.play.addEventListener('click', () => togglePlayback(s));
    s.el.remove.addEventListener('click', () => removeSpeaker(s));

    speakers.push(s);
    speakerList.appendChild(block);
    refreshSpeakers();
    lucide.createIcons();

    if (animate) gsap.fromTo(block, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.35, clearProps: 'transform,visibility' });
    if (focus) s.el.input.select();
}

function removeSpeaker(s) {
    if (recorder && recorder.speaker === s) cancelRecording();
    if (playingSpeaker === s) stopPlayback();
    if (s.url) URL.revokeObjectURL(s.url);
    speakers = speakers.filter(x => x !== s);
    s.el.block.remove();
    refreshSpeakers();
}

function speakerProblems() {
    const names = speakers.map(s => s.name.trim());
    const missing = speakers.filter(s => !s.sample).map(s => s.name.trim() || 'every speaker');
    if (!speakers.length) return 'Add at least one speaker.';
    if (names.some(n => !n)) return 'Give every speaker a name.';
    if (new Set(names.map(n => n.toLowerCase())).size !== names.length) return 'Two speakers have the same name.';
    if (recorder || speakers.some(s => s.busy)) return 'Finish the recording first.';
    if (missing.length) return `Record a voice sample for ${missing.slice(0, 2).join(' and ')}${missing.length > 2 ? ` and ${missing.length - 2} more` : ''}.`;
    return '';
}

function updateAnalyzeButton() {
    const problem = !selectedFile ? 'Choose the meeting recording.' : speakerProblems();
    btnAnalyze.disabled = Boolean(problem);
    analyzeHint.textContent = problem;
}

// Redraw every speaker row from its state.
function refreshSpeakers() {
    const names = speakers.map(s => s.name.trim().toLowerCase());
    speakers.forEach((s, i) => {
        const isRecording = recorder && recorder.speaker === s;
        const otherBusy = (recorder && !isRecording) || s.busy;
        const { avatar, input, status, record, play, remove, block } = s.el;

        avatar.style.background = speakerColors[i % speakerColors.length];
        avatar.textContent = speakerInitial(s.name);
        input.setAttribute('aria-invalid', String(!s.name.trim() || names.indexOf(s.name.trim().toLowerCase()) !== i));

        block.classList.toggle('is-recording', Boolean(isRecording));
        status.className = 'sample-status num' + (isRecording ? ' is-recording' : s.sample ? ' is-ready' : '');
        if (s.busy) status.textContent = 'Processing…';
        else if (isRecording) status.textContent = `${formatTime(recorderElapsed())} / ${formatTime(ENROLL_SECONDS)}`;
        else status.textContent = s.sample ? `${formatTime(s.duration)} recorded` : 'No voice sample';

        record.disabled = Boolean(otherBusy);
        record.classList.toggle('is-recording', Boolean(isRecording));
        record.innerHTML = isRecording ? '<span class="rec-dot"></span>Stop'
            : `<i data-lucide="mic"></i>${s.sample ? 'Re-record' : 'Record'}`;
        record.setAttribute('aria-label', isRecording ? `Stop recording ${s.name}` : `Record a voice sample for ${s.name || 'this speaker'}`);

        play.hidden = !s.sample || isRecording;
        play.innerHTML = `<i data-lucide="${playingSpeaker === s ? 'square' : 'play'}"></i>`;
        remove.disabled = Boolean(isRecording || s.busy);
    });
    document.getElementById('add-speaker').disabled = speakers.length >= MAX_SPEAKERS;
    lucide.createIcons();
    updateAnalyzeButton();
}

function recorderElapsed() {
    return recorder ? (performance.now() - recorder.startedAt) / 1000 : 0;
}

async function toggleRecording(s) {
    if (recorder) {
        if (recorder.speaker === s) stopRecording();
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        showToast('This browser cannot record audio. Try a current Chrome, Edge, Firefox or Safari.', true);
        return;
    }
    stopPlayback();

    let stream;
    try {
        // Keep the voice as natural as possible: the meeting recording will not be noise-suppressed either.
        stream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
        });
    } catch (err) {
        showToast(err && err.name === 'NotAllowedError'
            ? 'Microphone access is blocked. Allow it from the address bar and try again.'
            : 'No microphone was found.', true);
        return;
    }

    const mediaRecorder = new MediaRecorder(stream);
    const chunks = [];
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const rec = { speaker: s, mediaRecorder, stream, chunks, startedAt: performance.now(), timer: null, cancelled: false };
    recorder = rec;
    mediaRecorder.onstop = () => finishRecording(rec);
    mediaRecorder.start(250);

    recorder.timer = setInterval(() => {
        const elapsed = recorderElapsed();
        s.el.meter.style.width = `${Math.min(100, (elapsed / ENROLL_SECONDS) * 100)}%`;
        s.el.status.textContent = `${formatTime(elapsed)} / ${formatTime(ENROLL_SECONDS)}`;
        if (elapsed >= ENROLL_SECONDS) stopRecording();
    }, 200);
    s.el.meter.style.width = '0%';
    refreshSpeakers();
}

function stopRecording() {
    if (!recorder || recorder.mediaRecorder.state === 'inactive') return;
    recorder.duration = recorderElapsed();
    clearInterval(recorder.timer);
    recorder.mediaRecorder.stop(); // finishRecording runs from onstop
}

function cancelRecording() {
    if (!recorder) return;
    recorder.cancelled = true;
    stopRecording();
}

async function finishRecording(rec) {
    if (!rec) return;
    rec.stream.getTracks().forEach(t => t.stop());
    recorder = null;
    const s = rec.speaker;

    if (rec.cancelled) { refreshSpeakers(); return; }
    if (rec.duration < MIN_ENROLL_SECONDS) {
        refreshSpeakers();
        showToast(`Keep reading for at least ${MIN_ENROLL_SECONDS} seconds; 20 is best.`, true);
        return;
    }

    s.busy = true;
    refreshSpeakers();
    try {
        const wav = await toWav16k(new Blob(rec.chunks, { type: rec.mediaRecorder.mimeType || 'audio/webm' }));
        if (!speakers.includes(s)) return; // removed while processing
        // Check the audio that was actually captured, not the clock.
        if (wav.duration < MIN_ENROLL_SECONDS) {
            showToast(`Only ${wav.duration.toFixed(1)} s of audio was captured. Please record again; 20 seconds is best.`, true);
            return;
        }
        if (s.url) URL.revokeObjectURL(s.url);
        s.sample = wav.blob;
        s.duration = wav.duration;
        s.url = URL.createObjectURL(wav.blob);
    } catch (err) {
        console.error(err);
        showToast('Could not process the recording. Please record again.', true);
    } finally {
        s.busy = false;
        refreshSpeakers();
    }
}

// Decode whatever the browser recorded (WebM/Opus, MP4/AAC…) and resample to 16 kHz mono WAV.
async function toWav16k(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    let decoded;
    try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close(); }

    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * ENROLL_RATE)), ENROLL_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination); // channels are mixed down to mono
    source.start();
    const rendered = await offline.startRendering();
    return { blob: encodeWav(rendered.getChannelData(0), ENROLL_RATE), duration: rendered.duration };
}

function encodeWav(samples, rate) {
    const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const text = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([view], { type: 'audio/wav' });
}

function togglePlayback(s) {
    if (playingSpeaker === s) { stopPlayback(); return; }
    stopPlayback();
    if (!s.url) return;
    playingSpeaker = s;
    samplePlayer.src = s.url;
    samplePlayer.play().catch(() => stopPlayback());
    refreshSpeakers();
}

function stopPlayback() {
    if (!playingSpeaker) return;
    samplePlayer.pause();
    playingSpeaker = null;
    refreshSpeakers();
}
samplePlayer.addEventListener('ended', stopPlayback);

// ---------------------------------------------------------------------------
// Analysis. The request keeps running while the user moves between pages.
// ---------------------------------------------------------------------------
function setStep(id, state) {
    const step = document.getElementById(id);
    step.classList.remove('is-active', 'is-done');
    if (state) step.classList.add(`is-${state}`);
    const icon = { active: 'loader-circle', done: 'check-circle-2' }[state] || 'circle';
    step.querySelector('.step-icon').innerHTML = `<i data-lucide="${icon}"${state === 'active' ? ' class="spin"' : ''}></i>`;
    lucide.createIcons();
    if (animate && state === 'done' && currentView === 'loading') {
        gsap.fromTo(step.querySelector('.step-icon'), { scale: 0.5 }, { scale: 1, duration: 0.5, ease: 'back.out(2.5)' });
    }
}

let statusInterval;

function startProgress(fileName) {
    const statuses = ['Aligning audio…', 'Transcribing speech…', 'Matching voices to speakers…', 'Writing the summary…', 'Finishing the report…'];
    let i = 0;
    const statusEl = document.getElementById('loading-status');
    statusEl.textContent = statuses[0];
    document.getElementById('loading-file').textContent = fileName;
    setStep('step-transcribe', 'active');
    setStep('step-summary', null);

    // The backend does not report progress, so these messages are paced, not measured.
    statusInterval = setInterval(() => {
        i = Math.min(i + 1, statuses.length - 1);
        const text = statuses[i];
        if (animate && currentView === 'loading') {
            gsap.timeline()
                .to(statusEl, { autoAlpha: 0, y: -6, duration: 0.2, ease: 'power2.in' })
                .call(() => { statusEl.textContent = text; })
                .fromTo(statusEl, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.35, clearProps: 'transform,visibility' });
        } else {
            statusEl.textContent = text;
        }
        if (i === 3) {
            setStep('step-transcribe', 'done');
            setStep('step-summary', 'active');
        }
    }, 4000);
}

function stopProgress() {
    clearInterval(statusInterval);
    setStep('step-transcribe', null);
    setStep('step-summary', null);
}

function buildReport(data, fileName) {
    const base = {
        id: String(data.meeting_id || Date.now()),
        title: fileName.replace(/\.[^.]+$/, ''),
        fileName,
        createdAt: Date.now(),
        summary: data.summary || '',
        mine: true,
        owner: '',
        alignmentError: Boolean(data.alignment_error)
    };
    if (data.meeting_id) {
        // Saved on the server: the full report (with line ids for editing) loads when it is opened.
        const turns = data.speaker_transcript?.length ? data.speaker_transcript : [];
        const ends = turns.map(l => Number(l.end)).filter(Number.isFinite);
        return { ...base, duration: ends.length ? Math.max(...ends) : 0,
                 speakers: new Set(turns.map(l => l.speaker).filter(x => x && x !== 'UNKNOWN')).size };
    }
    const lines = (data.speaker_transcript?.length ? data.speaker_transcript : (data.transcript || []))
        .map(l => ({ speaker: l.speaker, start: l.start, end: l.end, text: l.text || '' }));
    const ends = lines.map(l => Number(l.end)).filter(Number.isFinite);
    return {
        ...base, lines, unsaved: true, speakerList: [],
        decisions: data.decisions || [],
        actionItems: (data.action_items || []).map(a => ({
            description: a.description, responsiblePerson: a.responsible_person, deadline: a.deadline })),
        duration: ends.length ? Math.max(...ends) : 0,
        speakers: new Set(lines.map(l => l.speaker).filter(s => s && s !== 'UNKNOWN')).size,
        speakerNames: Array.isArray(data.speakers) ? data.speakers : [],
        alignmentError: Boolean(data.alignment_error)
    };
}

async function analyze() {
    if (job) { switchView('loading'); return; }
    if (!selectedFile) {
        showToast('Choose an audio file first.', true);
        return;
    }
    const problem = speakerProblems();
    if (problem) { showToast(problem, true); return; }
    stopPlayback();

    const file = selectedFile;
    job = { fileName: file.name };
    setNavBusy(true);
    startProgress(file.name);
    switchView('loading');

    const formData = new FormData();
    formData.append('audio', file);
    speakers.forEach(s => {
        formData.append('speaker_name', s.name.trim());
        formData.append('speaker_sample', s.sample, `speaker-${s.id}.wav`);
    });

    try {
        const res = await fetch('/analyze', { method: 'POST', body: formData });
        let data;
        try { data = await res.json(); } catch { throw new Error(`The server returned an unexpected response (${res.status}).`); }
        if (res.status === 401) { location.href = '/login'; return; }
        if (!res.ok) throw new Error(data.error || 'Analysis failed.');

        const report = buildReport(data, file.name);
        addReport(report, Boolean(data.meeting_id));
        latestReportId = report.id;
        job = null;
        stopProgress();
        setNavBusy(false);
        resetUpload();

        if (currentView === 'loading') {
            openReport(report.id, false);
            showToast('Analysis complete');
        } else {
            // The user went elsewhere: leave them there and offer the report.
            currentReport = report;
            setNavNews(true);
            showToast(`Report ready: ${report.fileName}`, false, true);
            if (currentView === 'dashboard') renderDashboard();
            if (currentView === 'history') renderHistory();
        }
        if (report.alignmentError) setTimeout(() => showToast('Word alignment failed; showing the raw transcript.', true), 4200);
    } catch (error) {
        job = null;
        stopProgress();
        setNavBusy(false);
        if (currentView === 'loading') switchView('analyze');
        showToast(error.message || 'Analysis failed.', true);
        console.error(error);
    }
}

// ---------------------------------------------------------------------------
// Report page
// ---------------------------------------------------------------------------
const speakerColors = ['#0a7c76', '#5856d6', '#c2185b', '#b25000', '#0062cc', '#6e4fa3'];

// names: the enrolled speaker names, in the order they were added (EAGLE reports).
function formatSpeakerName(rawName, names = []) {
    if (!rawName || rawName === 'UNKNOWN') return { name: 'Unknown Speaker', index: 0, initial: '?' };
    const enrolled = names.indexOf(rawName);
    if (enrolled !== -1) return { name: rawName, index: enrolled, initial: speakerInitial(rawName) };
    // Older reports from pyannote use SPEAKER_00, SPEAKER_01…
    const match = rawName.match(/SPEAKER_(\d+)/i);
    if (match) {
        const num = parseInt(match[1], 10);
        return { name: `Speaker ${num + 1}`, index: num, initial: String(num + 1) };
    }
    return { name: rawName, index: 0, initial: speakerInitial(rawName) };
}

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

function openLatestReport() {
    if (latestReportId) openReport(latestReportId, false);
}

async function openReport(id, fromHistory) {
    const report = await getReport(id);
    if (!report) { showToast('That report is no longer saved.', true); return; }
    currentReport = { ...report, fromHistory };
    renderReport(currentReport);
    if (id === latestReportId) setNavNews(false);
    switchView('results');
}

function setParagraphs(el, text) {
    el.replaceChildren(...(text || 'No summary returned.').split('\n').filter(p => p.trim()).map(p => {
        const node = document.createElement('p');
        node.textContent = p.trim();
        return node;
    }));
}

function renderReport(report) {
    const mine = report.mine !== false;
    document.getElementById('report-title').textContent = report.title || report.fileName;
    document.getElementById('report-meta').textContent =
        `${report.fileName}, ${reportMeta(report)}${mine ? '' : `, uploaded by ${report.owner}`}`;
    // Only the owner can correct, regenerate or delete; an Executive reading a team member's meeting is read-only.
    document.querySelectorAll('#view-results [data-owner]').forEach(b => { b.hidden = !mine || report.unsaved; });
    document.getElementById('summary-editor').hidden = true;
    document.getElementById('summary').hidden = false;
    setParagraphs(document.getElementById('summary'), report.summary);

    const decisions = document.getElementById('decisions');
    decisions.replaceChildren(...(report.decisions?.length
        ? report.decisions.map(d => el('li', '', d))
        : [el('li', 'insight-empty', 'No decisions were found in this meeting.')]));

    const items = document.getElementById('action-items');
    items.replaceChildren(...(report.actionItems?.length
        ? report.actionItems.map(a => {
            const row = el('div', 'action-row');
            const meta = el('div', 'action-meta');
            meta.append(el('span', '', `Responsible: ${a.responsiblePerson || 'Not specified'}`),
                        el('span', '', `Deadline: ${a.deadline || 'Not specified'}`));
            row.append(el('div', '', a.description), meta);
            return row;
        })
        : [el('div', 'insight-empty', 'No action items were found in this meeting.')]));

    const transcriptDiv = document.getElementById('transcript');
    transcriptDiv.replaceChildren();
    document.getElementById('transcript-search').value = '';
    document.getElementById('no-matches').style.display = 'none';
    const editable = mine && !report.unsaved;

    report.lines.forEach(line => {
        const speaker = formatSpeakerName(line.speaker, report.speakerNames);
        const position = (report.speakerList || []).findIndex(s => s.id === line.speakerId);
        const colorIndex = position >= 0 ? position : speaker.index;
        const color = speakerColors[colorIndex % speakerColors.length];

        const card = document.createElement('div');
        card.className = 'transcript-card';

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.style.background = color;
        avatar.textContent = speaker.initial;

        const body = document.createElement('div');
        body.className = 'transcript-body';
        const meta = document.createElement('div');
        meta.className = 'transcript-meta';

        const badge = document.createElement(editable ? 'button' : 'span');
        badge.className = 'speaker-badge';
        badge.style.color = color;
        badge.textContent = speaker.name;
        badge.setAttribute('data-original-text', speaker.name);
        if (editable) {
            badge.type = 'button';
            badge.title = 'Rename this speaker';
            badge.setAttribute('aria-label', `Rename speaker ${speaker.name}`);
            badge.onclick = () => renameSpeaker(line);
        }

        const timing = document.createElement('span');
        timing.className = 'transcript-time num';
        timing.dir = 'ltr'; // keep "start – end" in reading order inside the RTL transcript
        if (Number.isFinite(Number(line.start)) && Number.isFinite(Number(line.end))) {
            timing.textContent = `${formatTime(line.start)} – ${formatTime(line.end)}`;
        }

        const text = document.createElement('p');
        text.className = 'transcript-text';
        text.textContent = line.text;
        text.setAttribute('data-original-text', line.text);

        meta.append(badge, timing);
        if (editable) {
            const edit = el('button', 'btn btn-quiet card-edit', 'Edit');
            edit.type = 'button';
            edit.setAttribute('aria-label', `Edit text of ${speaker.name} at ${timing.textContent || 'this line'}`);
            edit.onclick = () => editLine(line, body, text, edit);
            meta.appendChild(edit);
        }
        body.append(meta, text);
        card.append(avatar, body);
        transcriptDiv.appendChild(card);
    });

    if (animate) {
        gsap.from(Array.from(transcriptDiv.children).slice(0, 10), {
            autoAlpha: 0, y: 8, filter: 'blur(3px)', duration: 0.5, stagger: 0.04, delay: 0.3, clearProps: 'transform,filter,visibility'
        });
    }
    lucide.createIcons();
}

// Re-read the saved report after a change so the page shows exactly what the server stored.
function adoptReport(full) {
    reportCache = reportCache.map(r => r.id === full.id ? full : r);
    currentReport = { ...full, fromHistory: currentReport?.fromHistory };
    renderReport(currentReport);
}

async function renameMeeting() {
    const title = prompt('Meeting title', currentReport.title || currentReport.fileName);
    if (title === null || !title.trim()) return;
    try { adoptReport(await api('PATCH', `/api/reports/${currentReport.id}`, { title })); showToast('Title saved'); }
    catch (error) { showToast(error.message, true); }
}

async function renameSpeaker(line) {
    const current = formatSpeakerName(line.speaker).name;
    const label = prompt(`New name for ${current} (applies to every line they speak)`, current);
    if (label === null || !label.trim()) return;
    try {
        await api('PATCH', `/api/reports/${currentReport.id}/speakers/${line.speakerId}`, { label });
        adoptReport(await api('GET', `/api/reports/${currentReport.id}`));
        showToast('Speaker renamed');
    } catch (error) { showToast(error.message, true); }
}

function editLine(line, body, textEl, editBtn) {
    const editor = el('div', 'line-editor');
    const area = el('textarea', 'field area arabic');
    area.value = line.text;
    area.dir = 'auto';
    area.setAttribute('aria-label', 'Edit transcript text');
    const actions = el('div', 'editor-actions');
    const cancel = el('button', 'btn btn-secondary', 'Cancel');
    const save = el('button', 'btn btn-primary', 'Save');
    cancel.type = save.type = 'button';
    cancel.onclick = () => { editor.remove(); textEl.hidden = false; editBtn.hidden = false; };
    save.onclick = async () => {
        try {
            await api('PATCH', `/api/reports/${currentReport.id}/segments/${line.id}`, { text: area.value });
            adoptReport(await api('GET', `/api/reports/${currentReport.id}`));
            showToast('Line saved');
        } catch (error) { showToast(error.message, true); }
    };
    actions.append(cancel, save);
    editor.append(area, actions);
    textEl.hidden = true;
    editBtn.hidden = true;
    body.appendChild(editor);
    area.focus();
}

function editSummary() {
    document.getElementById('summary-text').value = currentReport.summary || '';
    document.getElementById('summary').hidden = true;
    document.getElementById('summary-editor').hidden = false;
    document.getElementById('summary-text').focus();
}
function cancelSummary() {
    document.getElementById('summary-editor').hidden = true;
    document.getElementById('summary').hidden = false;
}
async function saveSummary() {
    try {
        adoptReport(await api('PATCH', `/api/reports/${currentReport.id}`, { summary: document.getElementById('summary-text').value }));
        showToast('Summary saved');
    } catch (error) { showToast(error.message, true); }
}

async function regenerateReport() {
    if (!confirm('Re-run the AI over the current transcript? This replaces the summary, decisions and action items (including any edits to them).')) return;
    const btn = document.getElementById('btn-regenerate');
    btn.disabled = true;
    showToast('Regenerating with the local AI model. This can take a minute.');
    try { adoptReport(await api('POST', `/api/reports/${currentReport.id}/regenerate`)); showToast('Results regenerated'); }
    catch (error) { showToast(error.message, true); }
    finally { btn.disabled = false; }
}

async function deleteMeeting() {
    if (!confirm('Delete this meeting and its transcript? This cannot be undone.')) return;
    try { await api('DELETE', `/api/reports/${currentReport.id}`); }
    catch (error) { showToast(error.message, true); return; }
    reportCache = reportCache.filter(r => r.id !== currentReport.id);
    currentReport = null;
    showToast('Meeting deleted');
    switchView('history');
}

// PDF uses the browser's print dialog (save as PDF), which shapes Arabic correctly; DOCX and JSON come from the server.
function exportReport(format) {
    const r = currentReport;
    if (!r) return;
    if (format === 'pdf') {
        const previous = document.title;
        document.title = r.title || r.fileName;
        window.print();
        document.title = previous;
        return;
    }
    if (r.unsaved) { showToast('This report was not saved, so only PDF export is available.', true); return; }
    location.href = `/api/reports/${encodeURIComponent(r.id)}/export?format=${format}`;
}

function copyText(elementId) {
    const text = document.getElementById(elementId).innerText;
    navigator.clipboard.writeText(text)
        .then(() => showToast('Summary copied'))
        .catch(() => showToast('Copy failed. Select the text and copy it manually.', true));
}

// Transcript search: every typed word must appear in the line.
function filterTranscript() {
    const rawQuery = document.getElementById('transcript-search').value.toLowerCase().trim();
    const searchTerms = rawQuery.split(/\s+/).filter(t => t.length > 0);
    const cards = document.querySelectorAll('#transcript .transcript-card');
    let shown = 0;

    cards.forEach(card => {
        const badge = card.querySelector('.speaker-badge');
        const textEl = card.querySelector('.transcript-text');
        const originalSpeaker = badge.getAttribute('data-original-text');
        const originalText = textEl.getAttribute('data-original-text');
        const haystack = (originalSpeaker + ' ' + originalText).toLowerCase();
        const matches = searchTerms.every(term => haystack.includes(term));

        if (matches || searchTerms.length === 0) {
            card.style.display = '';
            shown++;
            if (searchTerms.length > 0) {
                badge.innerHTML = highlightText(originalSpeaker, searchTerms);
                textEl.innerHTML = highlightText(originalText, searchTerms);
            } else {
                badge.textContent = originalSpeaker;
                textEl.textContent = originalText;
            }
        } else {
            card.style.display = 'none';
        }
    });

    document.getElementById('no-matches').style.display = cards.length && shown === 0 ? 'block' : 'none';
}

function highlightText(text, terms) {
    if (!text) return '';
    // Escape HTML first so transcript text can never inject markup, then escape regex characters.
    const safe = escapeHtml(text);
    const escapedTerms = terms.map(t => escapeHtml(t).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));
    const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
    return safe.replace(regex, '<mark>$1</mark>');
}

// ---------------------------------------------------------------------------
// Toast (HUD)
// ---------------------------------------------------------------------------
let toastTimer;
function showToast(message, isError = false, withAction = false) {
    const toast = document.getElementById('toast');
    const old = toast.querySelector(':scope > svg, :scope > i');
    if (old) old.remove();
    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', isError ? 'alert-circle' : 'check-circle-2');
    icon.className = isError ? 'err' : 'ok';
    toast.prepend(icon);
    document.getElementById('toast-msg').textContent = message;
    toast.classList.toggle('has-action', withAction);
    lucide.createIcons();

    clearTimeout(toastTimer);
    setToast(true);
    toastTimer = setTimeout(() => setToast(false), withAction ? 8000 : 3800);
}

function setToast(visible) {
    const toast = document.getElementById('toast');
    if (!hasGsap) { toast.style.transform = `translate(-50%, ${visible ? '0' : '-160%'})`; return; }
    gsap.to(toast, {
        xPercent: -50, x: 0, yPercent: visible ? 0 : -160, scale: visible ? 1 : 0.95,
        duration: animate ? (visible ? 0.55 : 0.35) : 0,
        ease: visible ? 'back.out(1.5)' : 'power2.in', overwrite: true
    });
}
if (hasGsap) gsap.set('#toast', { xPercent: -50, x: 0, y: 0, yPercent: -160 });

// Leaving the page would cancel a running analysis, so warn first.
// Recorded voice samples are lost on reload too.
window.addEventListener('beforeunload', (e) => {
    if (job || recorder || speakers.some(s => s.sample)) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------------------
// Admin (only exists in the page for administrators; the server enforces it too)
// ---------------------------------------------------------------------------
async function api(method, path, body) {
    const res = await fetch(path, {
        method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401) { location.href = '/login'; throw new Error('Signed out.'); }
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
}

function formatWhen(iso) {
    return iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function userRow(u, meId, executives) {
    const row = el('div', 'row admin-row');
    const main = el('div', 'user-main');
    const name = el('p', 'user-name', u.username);
    name.appendChild(el('span', 'pill', u.role));
    if (!u.isActive) name.appendChild(el('span', 'pill pill-off', 'Disabled'));
    if (u.locked) name.appendChild(el('span', 'pill pill-warn', 'Locked'));
    if (u.id === meId) name.appendChild(el('span', 'pill pill-off', 'You'));
    const team = u.roleId === 2 ? ` · team of ${u.teamSize}` : u.roleId === 3 ? ` · team: ${u.executive || 'none'}` : '';
    main.append(name, el('p', 'user-meta num',
        `${u.email || 'no email'}${team} · ${u.meetings} meeting${u.meetings === 1 ? '' : 's'} · last sign-in ${formatWhen(u.lastLogin)}`));

    const actions = el('div', 'user-actions');
    const act = (label, handler, danger) => {
        const b = el('button', `btn btn-quiet${danger ? ' btn-danger' : ''}`, label);
        b.type = 'button';
        b.setAttribute('aria-label', `${label} for ${u.username}`);
        b.onclick = handler;
        actions.appendChild(b);
    };
    if (u.roleId === 3) {
        const pick = el('select', 'field assign');
        pick.setAttribute('aria-label', `Team for ${u.username}`);
        pick.append(new Option('No team', ''), ...executives.map(x => new Option(`Team of ${x.username}`, x.id)));
        pick.value = u.executiveId || '';
        pick.onchange = () => adminAction(() => api('PATCH', `/api/admin/users/${u.id}`, { executiveId: pick.value ? Number(pick.value) : null }), 'Team updated');
        actions.appendChild(pick);
    }
    act('Reset password', () => openPasswordDialog(u));
    if (u.locked) act('Unlock', () => adminAction(() => api('PATCH', `/api/admin/users/${u.id}`, { unlock: true }), 'Account unlocked'));
    if (u.id !== meId && u.roleId !== 1) {
        act(u.roleId === 2 ? 'Make Normal User' : 'Make Executive',
            () => adminAction(() => api('PATCH', `/api/admin/users/${u.id}`, { roleId: u.roleId === 2 ? 3 : 2 }), 'Role updated'));
        act(u.isActive ? 'Disable' : 'Enable', () => adminAction(() => api('PATCH', `/api/admin/users/${u.id}`, { isActive: !u.isActive }), u.isActive ? 'User disabled' : 'User enabled'));
        act('Delete', () => {
            if (confirm(`Delete ${u.username} and all of their meetings? This cannot be undone.`)) {
                adminAction(() => api('DELETE', `/api/admin/users/${u.id}`), 'User deleted');
            }
        }, true);
    }
    row.append(main, actions);
    return row;
}

async function adminAction(fn, doneMessage) {
    try { await fn(); showToast(doneMessage); } catch (error) { showToast(error.message, true); }
    renderAdmin();
}

function teamBlock(title, members) {
    const block = el('div', 'team-block');
    block.appendChild(el('h4', '', title));
    block.appendChild(el('p', 'team-members', members.length ? members.map(m => m.username).join(', ') : 'No members yet.'));
    return block;
}

function syncNewTeam() {
    const isExec = document.getElementById('new-role').value === '2';
    const pick = document.getElementById('new-team');
    pick.disabled = isExec;
    if (isExec) pick.value = '';
}

async function renderAdmin() {
    if (!document.getElementById('view-admin')) return;
    let data;
    try { data = await api('GET', '/api/admin/overview'); } catch (error) { showToast(error.message, true); return; }

    document.getElementById('adm-users').textContent = data.stats.users;
    document.getElementById('adm-executives').textContent = data.stats.executives;
    document.getElementById('adm-meetings').textContent = data.stats.meetings;
    document.getElementById('adm-hours').textContent = data.stats.hours.toFixed(1) + 'h';
    document.getElementById('adm-utterances').textContent = data.stats.utterances;
    document.getElementById('adm-db-version').textContent = data.database.version;
    document.getElementById('adm-db-size').textContent = data.database.size;

    const executives = data.users.filter(u => u.roleId === 2 && u.isActive);
    const teamPick = document.getElementById('new-team');
    const chosen = teamPick.value;
    teamPick.replaceChildren(new Option('No team', ''), ...executives.map(x => new Option(`Team of ${x.username}`, x.id)));
    teamPick.value = chosen;
    syncNewTeam();

    const normals = data.users.filter(u => u.roleId === 3);
    const teams = document.getElementById('admin-teams');
    teams.replaceChildren(
        ...executives.map(x => teamBlock(`Team of ${x.username}`, normals.filter(u => u.executiveId === x.id))),
        teamBlock('Not on a team', normals.filter(u => !u.executiveId)));
    if (!executives.length) teams.prepend(el('div', 'insight-empty', 'Create an Executive account to start a team, then assign Normal Users to it below.'));

    document.getElementById('admin-users').replaceChildren(...data.users.map(u => userRow(u, data.me, executives)));

    const audit = document.getElementById('admin-audit');
    audit.replaceChildren(...(data.audit.length ? data.audit.map(a => {
        const row = el('div', 'audit-row');
        row.append(el('span', 'when num', formatWhen(a.at)), el('span', 'what', `${a.actor || 'System'}: ${a.action.replaceAll('_', ' ')}`), el('span', 'detail', a.detail));
        return row;
    }) : [el('div', 'empty', 'No activity yet.')]));
    lucide.createIcons();
}

const pwDialog = document.getElementById('pw-dialog');
let pwUser = null;
function openPasswordDialog(u) {
    pwUser = u;
    document.getElementById('pw-for').textContent = `Choose a new password for ${u.username}. Share it with them privately.`;
    document.getElementById('pw-input').value = '';
    pwDialog.showModal();
    document.getElementById('pw-input').focus();
}
if (pwDialog) {
    document.getElementById('pw-cancel').onclick = () => pwDialog.close();
    document.getElementById('pw-form').addEventListener('submit', () => {
        const password = document.getElementById('pw-input').value;
        adminAction(() => api('PATCH', `/api/admin/users/${pwUser.id}`, { password }), 'Password reset');
    });
}

const addUserForm = document.getElementById('add-user-form');
if (addUserForm) {
    addUserForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('add-user-error');
        errorEl.textContent = '';
        try {
            await api('POST', '/api/admin/users', {
                username: document.getElementById('new-username').value,
                email: document.getElementById('new-email').value,
                password: document.getElementById('new-password').value,
                roleId: Number(document.getElementById('new-role').value),
                executiveId: Number(document.getElementById('new-team').value) || null
            });
            addUserForm.reset();
            showToast('Account created');
            renderAdmin();
        } catch (error) { errorEl.textContent = error.message; }
    });
}

// ---------------------------------------------------------------------------
// First paint: one orchestrated entrance
// ---------------------------------------------------------------------------
addSpeaker(false);
addSpeaker(false);
renderDashboard();
refreshReports();
if (IS_ADMIN) switchView('admin'); // Admins land on account management, not on meetings
window.addEventListener('load', () => {
    moveNavIndicator(document.querySelector('.nav-btn.is-active'), true);
    if (!animate || IS_ADMIN) return;
    gsap.timeline()
        .from('.sidebar', { autoAlpha: 0, x: -16, duration: 0.8 })
        .from('.nav-btn, .nav-group-label', { autoAlpha: 0, x: -8, duration: 0.5, stagger: 0.04, clearProps: 'transform,visibility' }, '<0.15')
        .from('#nav-indicator', { scaleX: 0.6, autoAlpha: 0, duration: 0.6, transformOrigin: 'left center' }, '<0.15')
        .from('#view-dashboard > *', { autoAlpha: 0, y: 16, duration: 0.7, stagger: 0.07, clearProps: 'transform,visibility' }, '<0.05')
        .from('#view-dashboard .stat', { autoAlpha: 0, y: 8, duration: 0.5, stagger: 0.06, clearProps: 'transform,visibility' }, '<0.15');
});
