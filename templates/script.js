lucide.createIcons();

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
    settings: 'Settings'
};

const mainEl = document.getElementById('main');
const toolbar = document.getElementById('toolbar');

// ---------------------------------------------------------------------------
// Saved reports (this browser only). Storage can be unavailable, so every call is guarded.
// ---------------------------------------------------------------------------
const STORE_KEY = 'majlis.reports.v1';
const MAX_REPORTS = 25;

function loadReports() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}

function saveReports(reports) {
    // Drop the oldest reports until it fits; transcripts can be large.
    for (let list = reports.slice(0, MAX_REPORTS); list.length; list = list.slice(0, -1)) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return; } catch { /* try smaller */ }
    }
}

function addReport(report) {
    saveReports([report, ...loadReports().filter(r => r.id !== report.id)]);
}

function getReport(id) {
    return loadReports().find(r => r.id === id) || (currentReport && currentReport.id === id ? currentReport : null);
}

function clearHistory() {
    if (!confirm('Delete all saved reports from this browser? This cannot be undone.')) return;
    try { localStorage.removeItem(STORE_KEY); } catch { /* nothing saved */ }
    renderHistory();
    renderDashboard();
    showToast('History cleared');
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

function meetingRow(r) {
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
    row.querySelector('.meeting-name').textContent = r.fileName;
    row.querySelector('.meeting-meta').textContent = reportMeta(r);
    return row;
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
    const reports = loadReports();
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
    const reports = loadReports();
    const list = document.getElementById('history-list');
    list.replaceChildren();
    if (reports.length) reports.forEach(r => list.appendChild(meetingRow(r)));
    else list.appendChild(emptyState('clock-3', 'No reports yet', 'Every analysis you run is saved here so you can open it again later.', true));
    document.getElementById('clear-history').hidden = !reports.length;
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
    const lines = (data.speaker_transcript?.length ? data.speaker_transcript : (data.transcript || []))
        .map(l => ({ speaker: l.speaker, start: l.start, end: l.end, text: l.text || '' }));
    const ends = lines.map(l => Number(l.end)).filter(Number.isFinite);
    return {
        id: String(Date.now()),
        fileName,
        createdAt: Date.now(),
        summary: data.summary || '',
        lines,
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
        if (!res.ok) throw new Error(data.error || 'Analysis failed.');

        const report = buildReport(data, file.name);
        addReport(report);
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

function openReport(id, fromHistory) {
    const report = getReport(id);
    if (!report) { showToast('That report is no longer saved in this browser.', true); return; }
    currentReport = { ...report, fromHistory };
    renderReport(currentReport);
    if (id === latestReportId) setNavNews(false);
    switchView('results');
}

function renderReport(report) {
    document.getElementById('report-meta').textContent = `${report.fileName}, ${reportMeta(report)}`;
    document.getElementById('summary').innerHTML = (report.summary || 'No summary returned.')
        .split('\n')
        .map(p => p.trim() ? `<p>${escapeHtml(p)}</p>` : '')
        .join('');

    const transcriptDiv = document.getElementById('transcript');
    transcriptDiv.replaceChildren();
    document.getElementById('transcript-search').value = '';
    document.getElementById('no-matches').style.display = 'none';

    report.lines.forEach(line => {
        const speaker = formatSpeakerName(line.speaker, report.speakerNames);
        const color = speakerColors[speaker.index % speakerColors.length];

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

        const badge = document.createElement('span');
        badge.className = 'speaker-badge';
        badge.style.color = color;
        badge.textContent = speaker.name;
        badge.setAttribute('data-original-text', speaker.name);

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
        body.append(meta, text);
        card.append(avatar, body);
        transcriptDiv.appendChild(card);
    });

    if (animate) {
        gsap.from(Array.from(transcriptDiv.children).slice(0, 10), {
            autoAlpha: 0, y: 8, filter: 'blur(3px)', duration: 0.5, stagger: 0.04, delay: 0.3, clearProps: 'transform,filter,visibility'
        });
    }
}

function exportReport() {
    const r = currentReport;
    if (!r) return;
    const out = [
        `Meeting report: ${r.fileName}`,
        reportMeta(r),
        '',
        'EXECUTIVE SUMMARY',
        r.summary || 'No summary returned.',
        '',
        'TRANSCRIPT',
        ...r.lines.map(l => {
            const time = Number.isFinite(Number(l.start)) ? `[${formatTime(l.start)}] ` : '';
            return `${time}${formatSpeakerName(l.speaker, r.speakerNames).name}: ${l.text}`;
        })
    ].join('\n');
    const url = URL.createObjectURL(new Blob(['﻿' + out], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = r.fileName.replace(/\.[^.]+$/, '') + ' - report.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Report exported');
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
// First paint: one orchestrated entrance
// ---------------------------------------------------------------------------
addSpeaker(false);
addSpeaker(false);
renderDashboard();
window.addEventListener('load', () => {
    moveNavIndicator(document.getElementById('nav-dashboard'), true);
    if (!animate) return;
    gsap.timeline()
        .from('.sidebar', { autoAlpha: 0, x: -16, duration: 0.8 })
        .from('.nav-btn, .nav-group-label', { autoAlpha: 0, x: -8, duration: 0.5, stagger: 0.04, clearProps: 'transform,visibility' }, '<0.15')
        .from('#nav-indicator', { scaleX: 0.6, autoAlpha: 0, duration: 0.6, transformOrigin: 'left center' }, '<0.15')
        .from('#view-dashboard > *', { autoAlpha: 0, y: 16, duration: 0.7, stagger: 0.07, clearProps: 'transform,visibility' }, '<0.05')
        .from('#view-dashboard .stat', { autoAlpha: 0, y: 8, duration: 0.5, stagger: 0.06, clearProps: 'transform,visibility' }, '<0.15');
});
