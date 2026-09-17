const TARGET_SAMPLE_RATE = 16000;
const MIN_CHUNK_SECONDS = 1;
const MAX_CHUNK_SECONDS = 10;
const MAX_STREAM_SECONDS = 25;
const PROVISIONAL_INTERVAL_SECONDS = 2;
const SPEECH_RMS_THRESHOLD = 0.012;
const LIVE_RMS_BASE = { microphone: 0.012, system: 0.006, mixed: 0.008 };
const NOISE_FLOOR_ATTACK = 0.05;
const NOISE_FLOOR_MARGIN = 2.5;
const SILENCE_HANGOVER_SECONDS = 0.35;
const PRE_ROLL_FRAMES = 2;
const STATE_POLL_MS = 2000;

const ids = ["finalizeButton","uploadButton","fileInput","youtubeForm","youtubeUrl","youtubeSubmit","mediaColumn","videoCard","video","demoAudio","videoBadge","playButton","playIcon","currentTime","duration","timeline","soundButton","fastTranscribeButton","restartButton","mediaTitle","mediaMeta","statusPill","statusText","progressText","lineCount","progressBar","transcriptStream","copyButton","toast","runtimeLabel","onlineSummaryToggle","summaryButton","summaryContent","summaryMeta","summaryRuntime","copySummaryButton","contextCount","contextList","captureMode","audioDevice","audioDeviceRow","liveMeter","liveHint"];
const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
let activeMedia = el.demoAudio;
let mediaUnavailable = !el.demoAudio.getAttribute("src");
let uploadUrl = null;
let segments = [];
let serverStatus = "loading";
let serverError = null;
let streamingEnabled = false;
let summaryStatus = "loading";
let summaryError = null;
let meetingId = null;
let meetingState = null;
let finalDocument = null;
let rolloutPending = false;
let autoRolloutEnabled = true;
let statePollTimer = null;
let nextSegmentId = 1;
let sessionGeneration = 0;
let pendingRequests = 0;
let healthTimer = null;
let inferenceRange = null;
let inferenceEvents = [];
let liveHypothesis = null;
let hypothesisAnimationId = 0;
let renderedHypothesis = null;
let finalAnimationId = 0;
let captureMode = "media";
let liveActive = false;
let liveStreams = [];
let liveStartedAt = 0;
let liveOffset = 0;
let fastTranscription = null;

class RealtimeCapture {
  constructor() {
    this.context = null;
    this.nodes = new Map();
    this.liveNodes = null;
    this.samples = [];
    this.sampleCount = 0;
    this.captureStart = null;
    this.hasSpeech = false;
    this.silenceSeconds = 0;
    this.preRoll = [];
    this.noiseFloor = 0;
    this.requestChain = Promise.resolve();
    this.lastProvisionalSampleCount = 0;
    this.provisionalRequestQueued = false;
    this.utteranceId = 0;
    this.stream = null;
  }

  async ensureContext() {
    if (!this.context) this.context = new AudioContext({ latencyHint: "interactive" });
    await this.context.resume();
    return this.context;
  }

  async attach(media) {
    await this.ensureContext();
    if (this.nodes.has(media)) return;
    const source = this.context.createMediaElementSource(media);
    const processor = this.context.createScriptProcessor(4096, 2, 1);
    const silent = this.context.createGain();
    silent.gain.value = 0;
    source.connect(this.context.destination);
    source.connect(processor);
    processor.connect(silent);
    silent.connect(this.context.destination);
    processor.onaudioprocess = event => {
      if (captureMode !== "media" || media !== activeMedia || media.paused || media.ended) return;
      this.ingest(event.inputBuffer);
    };
    this.nodes.set(media, { source, processor, silent });
  }

  // A live device is never routed back to the speakers: monitoring a microphone
  // would feed the room into itself, and monitoring system audio would double it.
  async attachStreams(streams) {
    await this.ensureContext();
    this.detachStreams();
    const mixer = this.context.createGain();
    const processor = this.context.createScriptProcessor(4096, 2, 1);
    const silent = this.context.createGain();
    silent.gain.value = 0;
    const sources = streams.map(stream => {
      const source = this.context.createMediaStreamSource(stream);
      source.connect(mixer);
      return source;
    });
    mixer.connect(processor);
    processor.connect(silent);
    silent.connect(this.context.destination);
    processor.onaudioprocess = event => { if (liveActive) this.ingest(event.inputBuffer); };
    this.liveNodes = { sources, mixer, processor, silent };
  }

  detachStreams() {
    if (!this.liveNodes) return;
    const { sources, mixer, processor, silent } = this.liveNodes;
    processor.onaudioprocess = null;
    sources.forEach(source => source.disconnect());
    mixer.disconnect();
    processor.disconnect();
    silent.disconnect();
    this.liveNodes = null;
  }

  ingest(input) {
    if (serverStatus === "error" || serverStatus === "offline") return;
    const mono = new Float32Array(input.length);
    for (let channel = 0; channel < input.numberOfChannels; channel++) {
      const data = input.getChannelData(channel);
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / input.numberOfChannels;
    }
    const resampled = downsample(mono, this.context.sampleRate, TARGET_SAMPLE_RATE);
    const frameSeconds = resampled.length / TARGET_SAMPLE_RATE;
    const rms = computeRMS(resampled);
    renderLevel(rms);
    // Meeting and system audio swing far more than a close microphone, so the gate
    // rides a slowly tracked noise floor instead of one absolute threshold.
    const threshold = captureMode === "media"
      ? SPEECH_RMS_THRESHOLD
      : Math.max(speechThreshold(), this.noiseFloor * NOISE_FLOOR_MARGIN);
    const speaking = rms >= threshold;
    if (!speaking && captureMode !== "media") {
      this.noiseFloor = this.noiseFloor * (1 - NOISE_FLOOR_ATTACK) + rms * NOISE_FLOOR_ATTACK;
    }

    if (!speaking && !this.hasSpeech) {
      this.preRoll.push(resampled);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      renderDraft(0);
      return;
    }

    if (speaking) {
      this.silenceSeconds = 0;
      if (!this.hasSpeech) {
        const preRollSeconds = this.preRoll.reduce((sum, chunk) => sum + chunk.length, 0) / TARGET_SAMPLE_RATE;
        this.captureStart = Math.max(0, captureClock() - frameSeconds - preRollSeconds);
        for (const chunk of this.preRoll) { this.samples.push(chunk); this.sampleCount += chunk.length; }
        this.preRoll = [];
        this.hasSpeech = true;
        if (streamingEnabled) this.openStream();
      }
    } else {
      this.silenceSeconds += frameSeconds;
    }

    this.samples.push(resampled);
    this.sampleCount += resampled.length;
    renderDraft(this.sampleCount / TARGET_SAMPLE_RATE);
    if (streamingEnabled) this.queueStream();
    else this.queueProvisional();

    const bufferedSeconds = this.sampleCount / TARGET_SAMPLE_RATE;
    const maximumSegmentSeconds = streamingEnabled ? MAX_STREAM_SECONDS : MAX_CHUNK_SECONDS;
    if (this.silenceSeconds >= SILENCE_HANGOVER_SECONDS || bufferedSeconds >= maximumSegmentSeconds) {
      this.flush();
    }
  }

  flush() {
    if (!this.sampleCount) return;
    if (this.sampleCount < MIN_CHUNK_SECONDS * TARGET_SAMPLE_RATE) {
      this.discard();
      return;
    }
    const pcm = concatSamples(this.samples, this.sampleCount);
    const start = this.captureStart ?? Math.max(0, captureClock() - this.sampleCount / TARGET_SAMPLE_RATE);
    const end = start + this.sampleCount / TARGET_SAMPLE_RATE;
    const generation = sessionGeneration;
    const utteranceId = ++this.utteranceId;
    this.samples = [];
    this.sampleCount = 0;
    this.captureStart = null;
    this.hasSpeech = false;
    this.silenceSeconds = 0;
    this.lastProvisionalSampleCount = 0;
    this.provisionalRequestQueued = false;
    const stream = this.stream;
    this.stream = null;
    if (streamingEnabled && stream) {
      const tail = pcm.slice(stream.sentSamples);
      this.requestChain = this.requestChain.then(() => finishStream(stream, tail, start, end, generation));
    } else {
      this.requestChain = this.requestChain.then(() => transcribeChunk(pcm, start, end, generation, { utteranceId }));
    }
  }

  openStream() {
    const stream = { id: null, startPromise: null, sentSamples: 0 };
    stream.startPromise = startStream().then(id => { stream.id = id; return id; });
    this.stream = stream;
  }

  queueStream() {
    const stream = this.stream;
    if (!stream || !this.hasSpeech || this.sampleCount - stream.sentSamples < TARGET_SAMPLE_RATE) return;
    const pcm = concatSamples(this.samples, this.sampleCount).slice(stream.sentSamples);
    const start = (this.captureStart ?? captureClock()) + stream.sentSamples / TARGET_SAMPLE_RATE;
    const end = start + pcm.length / TARGET_SAMPLE_RATE;
    const generation = sessionGeneration;
    stream.sentSamples = this.sampleCount;
    this.requestChain = this.requestChain.then(async () => {
      const streamId = stream.id || await stream.startPromise;
      return pushStream(streamId, pcm, start, end, generation);
    });
  }

  queueProvisional() {
    if (this.provisionalRequestQueued || !this.hasSpeech || this.sampleCount < MIN_CHUNK_SECONDS * TARGET_SAMPLE_RATE || this.sampleCount - this.lastProvisionalSampleCount < PROVISIONAL_INTERVAL_SECONDS * TARGET_SAMPLE_RATE) return;
    const pcm = concatSamples(this.samples, this.sampleCount);
    const start = this.captureStart ?? Math.max(0, captureClock() - pcm.length / TARGET_SAMPLE_RATE);
    const end = start + pcm.length / TARGET_SAMPLE_RATE;
    const generation = sessionGeneration;
    const utteranceId = this.utteranceId;
    this.lastProvisionalSampleCount = this.sampleCount;
    this.provisionalRequestQueued = true;
    this.requestChain = this.requestChain
      .then(() => {
        if (utteranceId !== this.utteranceId) return;
        return transcribeChunk(pcm, start, end, generation, { provisional: true, utteranceId });
      })
      .finally(() => {
        this.provisionalRequestQueued = false;
        if (this.hasSpeech && utteranceId === this.utteranceId) this.queueProvisional();
      });
  }

  discard() {
    const stream = this.stream;
    if (stream) stream.startPromise.then(streamId => abortStream(streamId)).catch(() => {});
    this.samples = [];
    this.sampleCount = 0;
    this.captureStart = null;
    this.hasSpeech = false;
    this.silenceSeconds = 0;
    this.preRoll = [];
    this.lastProvisionalSampleCount = 0;
    this.provisionalRequestQueued = false;
    this.stream = null;
    this.utteranceId++;
    liveHypothesis = null;
    hypothesisAnimationId++;
    renderDraft(0);
  }
}

const capturer = new RealtimeCapture();

// Playback has a seekable clock of its own; a live device only has elapsed time,
// carried across device switches by liveOffset so the transcript stays ordered.
function liveSeconds() {
  if (!liveActive || !capturer.context) return liveOffset;
  return liveOffset + Math.max(0, capturer.context.currentTime - liveStartedAt);
}

function captureClock() {
  return captureMode === "media" ? activeMedia.currentTime || 0 : liveSeconds();
}

function isCapturing() {
  return captureMode === "media" ? !activeMedia.paused : liveActive;
}

function speechThreshold() {
  return captureMode === "media" ? SPEECH_RMS_THRESHOLD : LIVE_RMS_BASE[captureMode] || SPEECH_RMS_THRESHOLD;
}

function renderLevel(rms) {
  el.liveMeter.style.setProperty("--level", `${Math.min(100, rms * 1400).toFixed(0)}%`);
}

function downsample(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) return input.slice();
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

function computeRMS(samples) {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / samples.length);
}

function concatSamples(chunks, length) {
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

// This adapter turns an already-loaded media file into the same PCM contract used by
// both ASR backends. It deliberately owns no model details: vLLM consumes one
// stateful stream, while the regular Transformers backend consumes fixed batches.
class FastTranscriber {
  async decode(media, signal) {
    const source = media.currentSrc || media.src;
    if (!source) throw new Error("找不到目前的音訊來源");
    const response = await fetch(source, { signal });
    if (!response.ok) throw new Error("無法讀取這個檔案");
    const context = new AudioContext();
    try {
      return await context.decodeAudioData(await response.arrayBuffer());
    } finally {
      await context.close();
    }
  }

  toPCM(audio, startSeconds, endSeconds) {
    const start = Math.floor(startSeconds * audio.sampleRate);
    const end = Math.min(audio.length, Math.ceil(endSeconds * audio.sampleRate));
    const mono = new Float32Array(Math.max(0, end - start));
    for (let channel = 0; channel < audio.numberOfChannels; channel++) {
      const input = audio.getChannelData(channel);
      for (let index = start; index < end; index++) mono[index - start] += input[index] / audio.numberOfChannels;
    }
    return downsample(mono, audio.sampleRate, TARGET_SAMPLE_RATE);
  }

  async run(run) {
    const audio = await this.decode(activeMedia, run.controller.signal);
    run.totalSeconds = audio.duration;
    const segmentSeconds = streamingEnabled ? MAX_STREAM_SECONDS : MAX_CHUNK_SECONDS;
    for (let start = 0; start < audio.duration; start += segmentSeconds) {
      this.assertActive(run);
      const end = Math.min(audio.duration, start + segmentSeconds);
      if (streamingEnabled) await this.runStreamingSegment(run, audio, start, end);
      else await this.runBatchSegment(run, audio, start, end);
      run.completedSeconds = end;
      syncUI();
    }
  }

  async runStreamingSegment(run, audio, start, end) {
    // Do not abort the session-creation request. If Stop lands while the server is
    // creating a session, we still need its id so the finally block can release it.
    const streamId = await startStream();
    run.streamId = streamId;
    let finished = false;
    try {
      this.assertActive(run);
      let cursor = start;
      while (cursor + MIN_CHUNK_SECONDS <= end + 0.0001) {
        this.assertActive(run);
        const chunkEnd = Math.min(end, cursor + MIN_CHUNK_SECONDS);
        const pcm = this.toPCM(audio, cursor, chunkEnd);
        const payload = await streamAudio(streamId, "chunk", pcm, run.controller.signal);
        this.recordStreamingUpdate(run, payload, cursor, chunkEnd);
        cursor = chunkEnd;
      }
      const tail = cursor < end ? this.toPCM(audio, cursor, end) : new Float32Array();
      this.assertActive(run);
      const payload = await streamAudio(streamId, "finish", tail, run.controller.signal);
      this.recordFinal(run, payload, start, end, "streaming final");
      finished = true;
    } finally {
      if (!finished) abortStream(streamId).catch(() => {});
      run.streamId = null;
    }
  }

  async runBatchSegment(run, audio, start, end) {
    const pcm = this.toPCM(audio, start, end);
    const response = await fetch("/api/transcribe", {
      method: "POST",
      signal: run.controller.signal,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Audio-Start": String(start),
        "X-Audio-End": String(end),
        "X-Language": "Chinese"
      },
      body: pcm,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || "辨識失敗");
    this.assertActive(run);
    this.recordFinal(run, payload, start, end, `${(end - start).toFixed(1)} 秒 fast batch`);
  }

  recordStreamingUpdate(run, payload, start, end) {
    this.assertActive(run);
    addInferenceEvent({ type: "ASR", context: `${(end - start).toFixed(1)} 秒 fast stream`, detail: "stateful session", latency: payload.inference_seconds });
    showProvisional(payload.text, start, end);
    run.completedSeconds = end;
    syncUI();
  }

  recordFinal(run, payload, start, end, detail) {
    this.assertActive(run);
    addInferenceEvent({ type: "ASR", context: `${(end - start).toFixed(1)} 秒`, detail, latency: payload.inference_seconds });
    commitFinal(payload.text, start, end, payload.inference_seconds);
  }

  assertActive(run) {
    if (run.controller.signal.aborted || fastTranscription !== run || run.generation !== sessionGeneration) throw new DOMException("快速轉錄已停止", "AbortError");
  }
}

const fastTranscriber = new FastTranscriber();

function isAbortError(error) {
  return error?.name === "AbortError";
}

function cancelFastTranscription({ silent = false } = {}) {
  const run = fastTranscription;
  if (!run || run.cancelling) return;
  run.cancelling = true;
  run.controller.abort();
  if (run.streamId) abortStream(run.streamId).catch(() => {});
  if (!silent) showToast("正在停止快速轉錄");
  syncUI();
}

async function toggleFastTranscription() {
  if (fastTranscription) return cancelFastTranscription();
  if (captureMode !== "media" || mediaUnavailable) return showToast("請先載入音訊／影片後再使用快速轉錄");
  if (!(await readyForCapture())) return;
  activeMedia.pause();
  capturer.discard();
  resetTranscript();
  const run = { controller: new AbortController(), generation: sessionGeneration, streamId: null, totalSeconds: 0, completedSeconds: 0, cancelling: false };
  fastTranscription = run;
  syncUI();
  try {
    await fastTranscriber.run(run);
    if (fastTranscription === run) showToast("快速轉錄完成");
  } catch (error) {
    if (!isAbortError(error)) {
      showToast(`快速轉錄失敗：${error.message}`);
      checkHealth();
    }
  } finally {
    if (fastTranscription === run) fastTranscription = null;
    run.streamId = null;
    syncUI();
  }
}

async function transcribeChunk(pcm, start, end, generation, { provisional = false, utteranceId = null } = {}) {
  pendingRequests++;
  inferenceRange = { start, end };
  renderDraft(0, start, end);
  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Audio-Start": String(start),
        "X-Audio-End": String(end),
        "X-Language": "Chinese"
      },
      body: pcm
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || "辨識失敗");
    if (generation !== sessionGeneration || (utteranceId !== null && utteranceId !== capturer.utteranceId)) return;
    addInferenceEvent({
      type: "ASR",
      context: `${Number(payload.audio_seconds || 0).toFixed(1)} 秒`,
      detail: `${Number(payload.context_samples || pcm.length).toLocaleString()} samples`,
      latency: payload.inference_seconds,
    });
    if (provisional) showProvisional(payload.text, payload.start, payload.end);
    else commitFinal(payload.text, payload.start, payload.end, payload.inference_seconds);
  } catch (error) {
    showToast(`逐字稿暫時無法產生：${error.message}`);
    checkHealth();
  } finally {
    pendingRequests--;
    inferenceRange = null;
    if (!pendingRequests) renderDraft(0);
    syncUI();
  }
}

function showProvisional(rawText, start, end) {
  const text = String(rawText || "").trim();
  if (!text) return;
  const visibleText = liveHypothesis ? commonPrefix(liveHypothesis.visibleText, text) : "";
  liveHypothesis = { start, end, previousEnd: liveHypothesis?.end ?? start, text, visibleText };
  renderCompleted();
}

function commitFinal(rawText, start, end, latency) {
  const text = String(rawText || "").trim();
  if (!text) return;
  const finalVisibleText = liveHypothesis ? commonPrefix(liveHypothesis.visibleText, text) : "";
  liveHypothesis = null;
  hypothesisAnimationId++;
  segments.push({ id: nextSegmentId++, start, end, text, visibleText: finalVisibleText, latency });
  segments.sort((a, b) => a.start - b.start);
  renderCompleted();
  sendSegment({ text, start, end });
}

async function startStream(signal) {
  const response = await fetch("/api/streams", { method: "POST", signal, headers: { "X-Language": "Chinese" } });
  const payload = await response.json();
  if (!response.ok || !payload.stream_id) throw new Error(payload.detail || payload.error || "無法建立串流辨識");
  return payload.stream_id;
}

async function streamAudio(streamId, action, pcm, signal) {
  const response = await fetch(`/api/streams/${streamId}/${action}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/octet-stream" },
    body: pcm,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || payload.error || "串流辨識失敗");
  return payload;
}

async function abortStream(streamId) {
  await fetch(`/api/streams/${streamId}/abort`, { method: "POST" });
}

async function pushStream(streamId, pcm, start, end, generation) {
  pendingRequests++;
  inferenceRange = { start, end };
  try {
    const payload = await streamAudio(streamId, "chunk", pcm);
    if (generation !== sessionGeneration) return;
    addInferenceEvent({ type: "ASR", context: `${(pcm.length / TARGET_SAMPLE_RATE).toFixed(1)} 秒 streaming`, detail: "stateful session", latency: payload.inference_seconds });
    showProvisional(payload.text, start, end);
  } catch (error) {
    showToast(`串流逐字稿暫時無法產生：${error.message}`);
    checkHealth();
  } finally {
    pendingRequests--;
    inferenceRange = null;
    syncUI();
  }
}

async function finishStream(stream, pcm, start, end, generation) {
  pendingRequests++;
  inferenceRange = { start, end };
  try {
    const streamId = stream.id || await stream.startPromise;
    const payload = await streamAudio(streamId, "finish", pcm);
    if (generation !== sessionGeneration) return;
    addInferenceEvent({ type: "ASR", context: `${(pcm.length / TARGET_SAMPLE_RATE).toFixed(1)} 秒 final`, detail: "stateful session", latency: payload.inference_seconds });
    commitFinal(payload.text, start, end, payload.inference_seconds);
  } catch (error) {
    showToast(`串流逐字稿暫時無法完成：${error.message}`);
    checkHealth();
  } finally {
    pendingRequests--;
    inferenceRange = null;
    syncUI();
  }
}

function formatTime(value) {
  if (!Number.isFinite(value)) return "00:00";
  const minutes = Math.floor(value / 60).toString().padStart(2, "0");
  const seconds = Math.floor(value % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function syncUI() {
  const live = captureMode !== "media";
  const current = fastTranscription ? fastTranscription.completedSeconds : captureClock();
  const total = activeMedia.duration || 92.54;
  const fastRatio = fastTranscription?.totalSeconds ? fastTranscription.completedSeconds / fastTranscription.totalSeconds : 0;
  const ratio = fastTranscription ? fastRatio : live || mediaUnavailable ? 0 : Math.min(1, current / total);
  el.currentTime.textContent = formatTime(current);
  el.duration.textContent = live ? "LIVE" : mediaUnavailable ? "--:--" : formatTime(total);
  el.playButton.disabled = !live && mediaUnavailable;
  el.timeline.disabled = live || mediaUnavailable;
  el.restartButton.disabled = !live && mediaUnavailable;
  el.timeline.value = ratio * 100;
  el.timeline.style.setProperty("--progress", `${ratio * 100}%`);
  el.lineCount.textContent = `${segments.length} 段`;
  el.progressBar.style.width = `${ratio * 100}%`;
  const latest = segments.at(-1);
  el.progressText.textContent = fastTranscription
    ? fastTranscription.cancelling ? "正在停止快速轉錄" : fastTranscription.totalSeconds ? `快速轉錄 ${Math.floor(ratio * 100)}%` : "正在讀取音訊"
    : !live && mediaUnavailable ? "尚未載入媒體" : pendingRequests ? "模型正在辨識" : latest ? `已辨識至 ${formatTime(latest.end)}` : isCapturing() ? "正在收音" : "尚未開始";
  el.fastTranscribeButton.disabled = fastTranscription?.cancelling || serverStatus !== "ready" || captureMode !== "media" || mediaUnavailable;
  el.fastTranscribeButton.textContent = fastTranscription ? fastTranscription.cancelling ? "停止中…" : "■ 停止快速轉錄" : "⚡ 快速轉錄";
  const pending = meetingState ? meetingState.pending_segment_count : 0;
  el.summaryButton.disabled = rolloutPending || summaryStatus !== "ready" || !meetingId || !pending;
  el.summaryButton.textContent = rolloutPending ? "更新中…" : "立即整理";
  el.finalizeButton.disabled = rolloutPending || summaryStatus !== "ready" || !meetingId || !segments.length;
  el.onlineSummaryToggle.setAttribute("aria-checked", String(autoRolloutEnabled));
  el.onlineSummaryToggle.classList.toggle("enabled", autoRolloutEnabled);
  el.copySummaryButton.disabled = !meetingState || !meetingState.current_section;
}

function renderCompleted() {
  const stream = el.transcriptStream;
  const stickToBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 48;
  if (!segments.length && !liveHypothesis) {
    renderedHypothesis = null;
    const placeholder = fastTranscription ? "fast" : isCapturing() || pendingRequests ? "listening" : !liveActive && captureMode === "media" && mediaUnavailable ? "no-media" : "idle";
    if (stream.children.length !== 1 || stream.firstElementChild?.dataset.placeholder !== placeholder) {
      stream.innerHTML = placeholder === "fast"
        ? `<div class="list-placeholder" data-placeholder="fast"><i></i>正在快速轉錄，文字很快會出現在這裡</div>`
        : placeholder === "listening"
        ? `<div class="list-placeholder" data-placeholder="listening"><i></i>正在收音，暫定文字很快會出現在這裡</div>`
        : placeholder === "no-media"
        ? `<div class="empty-state" data-placeholder="no-media"><div class="empty-glyph">Aa</div><strong>請先載入音訊或影片</strong><p>本專案未附帶示範音檔。請用右上角的「換一個檔案」上傳本機音訊／影片，或貼上 YouTube 連結。</p></div>`
        : `<div class="empty-state" data-placeholder="idle"><div class="empty-glyph">Aa</div><strong>按下播放，開始即時逐字稿</strong><p>每段聲音會送到本機模型辨識，結果會持續出現在這裡。</p></div>`;
    }
    return;
  }
  stream.querySelectorAll(":scope > .empty-state, :scope > .list-placeholder").forEach(node => node.remove());
  const segmentIds = new Set(segments.map(segment => String(segment.id)));
  stream.querySelectorAll(":scope > article[data-segment-id]").forEach(row => { if (!segmentIds.has(row.dataset.segmentId)) row.remove(); });
  let provisionalRow = stream.querySelector(":scope > article.provisional");
  segments.forEach((segment, index) => {
    let row = stream.querySelector(`:scope > article[data-segment-id="${segment.id}"]`);
    const isNewRow = !row;
    if (isNewRow) {
      row = document.createElement("article");
      row.className = "transcript-line";
      row.dataset.segmentId = String(segment.id);
      row.dataset.start = String(segment.start);
      const time = document.createElement("button"); time.type = "button";
      const text = document.createElement("p");
      row.append(time, text);
      row.addEventListener("click", () => {
        if (captureMode !== "media") return;
        capturer.discard();
        activeMedia.currentTime = Number(row.dataset.start);
        syncUI();
      });
      stream.insertBefore(row, provisionalRow);
    }
    const time = row.querySelector("button");
    time.textContent = formatTime(segment.start);
    time.setAttribute("aria-label", `跳到 ${formatTime(segment.start)}`);
    if (isNewRow) {
      const text = row.querySelector("p");
      const initialText = segment.visibleText ?? segment.text;
      text.textContent = initialText;
      if (initialText !== segment.text) animateFinalSegment(text, segment);
    }
    row.classList.toggle("latest", index === segments.length - 1 && !liveHypothesis);
  });
  if (liveHypothesis) {
    if (!provisionalRow) {
      provisionalRow = document.createElement("article");
      provisionalRow.className = "transcript-line provisional";
      provisionalRow.setAttribute("aria-live", "polite");
      const time = document.createElement("span"); time.className = "provisional-time";
      const text = document.createElement("p");
      const label = document.createElement("small"); label.textContent = "暫定";
      const hypothesisText = document.createElement("span"); hypothesisText.className = "provisional-text";
      const caret = document.createElement("i"); caret.className = "caret";
      text.append(label, hypothesisText, caret); provisionalRow.append(time, text); stream.append(provisionalRow);
    }
    provisionalRow.querySelector(".provisional-time").textContent = formatTime(liveHypothesis.start);
    const target = provisionalRow.querySelector(".provisional-text");
    if (renderedHypothesis !== liveHypothesis) {
      target.textContent = liveHypothesis.visibleText;
      renderedHypothesis = liveHypothesis;
      animateHypothesis(liveHypothesis, target);
    }
  } else { provisionalRow?.remove(); renderedHypothesis = null; }
  if (stickToBottom) stream.scrollTop = stream.scrollHeight;
}

function renderDraft() {}

function animateHypothesis(hypothesis, target) {
  const animationId = ++hypothesisAnimationId;
  const characters = graphemes(hypothesis.text);
  const initialCount = graphemes(hypothesis.visibleText).length;
  const duration = Math.min(1000, Math.max(350, Math.max(.5, hypothesis.end - hypothesis.previousEnd) * 450));
  const startedAt = performance.now();
  const renderFrame = now => {
    if (animationId !== hypothesisAnimationId || !target.isConnected) return;
    const count = initialCount + Math.ceil((characters.length - initialCount) * Math.min(1, (now - startedAt) / duration));
    hypothesis.visibleText = characters.slice(0, count).join(""); target.textContent = hypothesis.visibleText;
    if (count < characters.length) requestAnimationFrame(renderFrame);
  };
  requestAnimationFrame(renderFrame);
}

function animateFinalSegment(target, segment) {
  const animationId = ++finalAnimationId;
  const characters = graphemes(segment.text);
  const initialCount = graphemes(segment.visibleText || "").length;
  const duration = Math.min(700, Math.max(240, (characters.length - initialCount) * 16));
  const startedAt = performance.now();
  const renderFrame = now => {
    if (animationId !== finalAnimationId || !target.isConnected) return;
    const count = initialCount + Math.ceil((characters.length - initialCount) * Math.min(1, (now - startedAt) / duration));
    target.textContent = characters.slice(0, count).join("");
    if (count < characters.length) requestAnimationFrame(renderFrame);
  };
  requestAnimationFrame(renderFrame);
}

function graphemes(text) {
  return typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(part => part.segment) : Array.from(text);
}

function commonPrefix(left, right) {
  const leftCharacters = graphemes(left); const rightCharacters = graphemes(right); let index = 0;
  while (index < leftCharacters.length && leftCharacters[index] === rightCharacters[index]) index++;
  return leftCharacters.slice(0, index).join("");
}

async function togglePlay() {
  if (captureMode !== "media") {
    if (liveActive) { stopLive(); return; }
    if (!(await readyForCapture())) return;
    await startLive();
    return;
  }
  if (mediaUnavailable) return showToast("請先上傳音訊／影片，或貼上 YouTube 連結");
  if (!activeMedia.paused) { activeMedia.pause(); return; }
  if (!(await readyForCapture())) return;
  try {
    await capturer.attach(activeMedia);
    await activeMedia.play();
  } catch (_) { showToast("無法播放或擷取這個檔案的聲音"); }
}

async function readyForCapture() {
  if (serverStatus === "ready") return true;
  showToast(
    serverStatus === "loading" ? "模型仍在載入，請稍候"
    : serverStatus === "offline" ? "請先啟動本機 inference service"
    : serverError ? `模型載入失敗：${briefError(serverError)}` : "模型載入失敗"
  );
  await checkHealth();
  return false;
}

async function requestMicrophone() {
  const deviceId = el.audioDevice.value;
  // Browser conditioning is left off: automatic gain would distort the RMS gate and
  // echo cancellation would strip the far end out of a mixed meeting capture.
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}

// Chrome exposes system and tab audio only through getDisplayMedia, and only when
// the share dialog is asked for video too; that video track is dropped at once.
async function requestSystemAudio() {
  if (!navigator.mediaDevices.getDisplayMedia) throw new Error("這個瀏覽器不支援系統音擷取");
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  stream.getVideoTracks().forEach(track => { track.stop(); stream.removeTrack(track); });
  if (!stream.getAudioTracks().length) throw new Error("分享時請一併勾選「分享分頁音訊／系統音訊」");
  return stream;
}

async function startLive(reset = true) {
  try {
    // Streams land in liveStreams as they are granted, not after both resolve: if the
    // system-audio dialog is cancelled, stopLive() still has to release the microphone.
    liveStreams = [];
    if (captureMode === "microphone" || captureMode === "mixed") liveStreams.push(await requestMicrophone());
    if (captureMode === "system" || captureMode === "mixed") liveStreams.push(await requestSystemAudio());
    const streams = liveStreams;
    streams.forEach(stream => stream.getAudioTracks().forEach(track => track.addEventListener("ended", () => {
      if (!liveActive) return;
      stopLive();
      showToast("收音來源已結束");
    })));
    await capturer.attachStreams(streams);
    if (reset) liveOffset = 0;
    liveStartedAt = capturer.context.currentTime;
    liveActive = true;
    capturer.noiseFloor = 0;
    // A fresh meeting only makes sense once the previous one actually holds
    // transcript; an untouched meeting is reused instead of being orphaned.
    if (reset && segments.length) resetTranscript();
    updatePlaybackState();
    populateDevices();
    showToast(captureMode === "system" ? "開始擷取系統音" : captureMode === "mixed" ? "開始擷取麥克風與系統音" : "開始擷取麥克風");
  } catch (error) {
    stopLive();
    showToast(`無法開始收音：${error.message}`);
  }
}

function stopLive() {
  if (liveActive) {
    liveOffset = liveSeconds();
    capturer.flush();
  }
  liveActive = false;
  capturer.detachStreams();
  liveStreams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
  liveStreams = [];
  renderLevel(0);
  updatePlaybackState();
}

function captureHint() {
  if (captureMode === "microphone") return "按下播放開始收音，麥克風的聲音會即時送去辨識。";
  if (captureMode === "system") return "按下播放後選擇要分享的分頁或螢幕，並勾選分享音訊；macOS 也可改選 BlackHole 之類的虛擬輸入裝置。";
  if (captureMode === "mixed") return "同時收錄你的麥克風與會議播出的聲音，兩路在擷取端混成單聲道。";
  return "播放下方的檔案，播放中的聲音會即時送去辨識。";
}

function applyCaptureMode(mode, reset = true) {
  if (liveActive) stopLive();
  if (mode !== "media") activeMedia.pause();
  captureMode = mode;
  liveOffset = 0;
  capturer.discard();
  el.captureMode.value = mode;
  el.audioDeviceRow.hidden = mode !== "microphone" && mode !== "mixed";
  el.mediaColumn.classList.toggle("live-capture", mode !== "media");
  el.liveHint.textContent = captureHint();
  renderLevel(0);
  if (mode !== "media") populateDevices();
  if (reset && segments.length) resetTranscript();
  updatePlaybackState();
}

// Device labels stay empty until a stream has been granted once, so the list is
// rebuilt again after every successful start.
async function populateDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(device => device.kind === "audioinput");
    const previous = el.audioDevice.value;
    el.audioDevice.innerHTML = ['<option value="">系統預設輸入</option>']
      .concat(inputs.map((device, index) => `<option value="${escapeHTML(device.deviceId)}">${escapeHTML(device.label || `輸入裝置 ${index + 1}`)}</option>`))
      .join("");
    if (previous && inputs.some(device => device.deviceId === previous)) el.audioDevice.value = previous;
  } catch (_) {
    // Device enumeration is a convenience; the default input still works without it.
  }
}

function updatePlaybackState() {
  const live = captureMode !== "media";
  const playing = isCapturing();
  el.playIcon.textContent = playing ? "Ⅱ" : "▶";
  el.playButton.setAttribute("aria-label", playing ? (live ? "停止收音" : "暫停") : live ? "開始收音" : "播放");
  el.statusPill.classList.toggle("active", playing && serverStatus === "ready");
  const idleText = live ? (liveOffset ? "已停止收音" : "可以開始收音") : activeMedia.currentTime ? "已暫停" : "可以開始";
  if (serverStatus === "loading") el.statusText.textContent = "模型載入中";
  else if (serverStatus === "offline") el.statusText.textContent = "後端未連線";
  else if (serverStatus === "error") el.statusText.textContent = "模型載入失敗";
  else el.statusText.textContent = fastTranscription ? "快速轉錄中" : playing ? "辨識中" : idleText;
  if (!playing) capturer.flush();
  renderCompleted();
  syncUI();
}

function bindMedia(media) {
  ["timeupdate", "loadedmetadata", "durationchange"].forEach(name => media.addEventListener(name, syncUI));
  ["play", "pause", "ended"].forEach(name => media.addEventListener(name, updatePlaybackState));
  media.addEventListener("seeking", () => capturer.discard());
  media.addEventListener("error", () => { if (media !== activeMedia) return; mediaUnavailable = true; el.mediaTitle.textContent = "媒體載入失敗"; el.mediaMeta.textContent = "請改用其他檔案或 YouTube 連結"; showToast("這個媒體來源無法載入"); updatePlaybackState(); });
}

function resetTranscript() {
  cancelFastTranscription({ silent: true });
  sessionGeneration++;
  segments = [];
  meetingId = null;
  meetingState = null;
  finalDocument = null;
  rolloutPending = false;
  nextSegmentId = 1;
  inferenceEvents = [];
  liveHypothesis = null;
  hypothesisAnimationId++;
  clearTimeout(statePollTimer);
  statePollTimer = null;
  capturer.discard();
  renderCompleted();
  renderSummary();
  renderInferenceEvents();
  syncUI();
  startMeeting();
}

function activateMediaSource(sourceUrl, { isAudio, label, meta, badgeText, toastMessage }) {
  if (captureMode !== "media") applyCaptureMode("media", false);
  activeMedia.pause();
  mediaUnavailable = false;
  if (isAudio) {
    el.video.pause();
    el.video.classList.remove("visible");
    el.videoCard.hidden = true;
    el.mediaColumn.classList.add("audio-only");
    el.demoAudio.src = sourceUrl;
    activeMedia = el.demoAudio;
  } else {
    el.video.src = sourceUrl;
    activeMedia = el.video;
    el.video.classList.add("visible");
    el.videoCard.hidden = false;
    el.mediaColumn.classList.remove("audio-only");
  }
  el.videoBadge.innerHTML = `<span></span> ${badgeText}`;
  el.mediaTitle.textContent = label;
  el.mediaMeta.textContent = meta;
  resetTranscript();
  updatePlaybackState();
  showToast(toastMessage);
}

function loadMedia(file) {
  if (uploadUrl) URL.revokeObjectURL(uploadUrl);
  uploadUrl = URL.createObjectURL(file);
  const isAudio = file.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(file.name);
  activateMediaSource(uploadUrl, {
    isAudio,
    label: file.name,
    meta: `${formatBytes(file.size)} · realtime inference`,
    badgeText: isAudio ? "本機音訊" : "本機影片",
    toastMessage: `${isAudio ? "音訊" : "影片"}已載入；播放中的聲音會送往本機模型`,
  });
}

async function loadYoutubeMedia(url) {
  el.youtubeUrl.disabled = true;
  el.youtubeSubmit.disabled = true;
  const originalLabel = el.youtubeSubmit.textContent;
  el.youtubeSubmit.textContent = "下載中…";
  showToast("正在從 YouTube 下載音訊，請稍候");
  try {
    const response = await fetch("/api/fetch-media", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || "下載失敗");
    if (uploadUrl) { URL.revokeObjectURL(uploadUrl); uploadUrl = null; }
    activateMediaSource(payload.url, {
      isAudio: true,
      label: payload.title || "YouTube 音訊",
      meta: "YouTube · realtime inference",
      badgeText: "YouTube 音訊",
      toastMessage: "YouTube 音訊已載入；播放中的聲音會送往本機模型",
    });
    el.youtubeUrl.value = "";
  } catch (error) {
    showToast(`YouTube 音訊載入失敗：${error.message}`);
  } finally {
    el.youtubeUrl.disabled = false;
    el.youtubeSubmit.disabled = false;
    el.youtubeSubmit.textContent = originalLabel;
  }
}

function restart() {
  if (captureMode !== "media") {
    stopLive();
    liveOffset = 0;
    resetTranscript();
    updatePlaybackState();
    return;
  }
  activeMedia.pause();
  activeMedia.currentTime = 0;
  resetTranscript();
  updatePlaybackState();
}

async function copyTranscript() {
  const text = segments.map(segment => `[${formatTime(segment.start)}] ${segment.text}`).join("\n");
  if (!text) return showToast("播放後才有逐字稿可以複製");
  try { await navigator.clipboard.writeText(text); showToast("已複製目前的逐字稿"); } catch (_) { showToast("瀏覽器無法存取剪貼簿"); }
}

function sectionBlock(title, items) {
  return items && items.length
    ? `<div class="summary-block"><h3>${title}</h3><ul>${items.map(item => `<li>${escapeHTML(item)}</li>`).join("")}</ul></div>`
    : "";
}

function actionLines(items) {
  return (items || []).map(item => {
    const meta = [item.owner && `負責：${item.owner}`, item.due && `期限：${item.due}`].filter(Boolean).join(" · ");
    return meta ? `${item.description}（${meta}）` : item.description;
  });
}

function renderSummary() {
  const section = meetingState && meetingState.current_section;
  const index = (meetingState && meetingState.section_index) || [];
  if (finalDocument) {
    const topics = finalDocument.topics.map(topic => `<li><strong>${escapeHTML(topic.title)}</strong>：${escapeHTML(topic.summary)}</li>`).join("");
    el.summaryContent.innerHTML = `<div class="summary-grid"><div><div class="summary-block"><h3>會議總結</h3><p>${escapeHTML(finalDocument.executive_summary)}</p></div><div class="summary-block"><h3>各主題</h3><ul>${topics}</ul></div></div><div>${sectionBlock("決策", finalDocument.decisions)}${sectionBlock("待辦事項", actionLines(finalDocument.action_items))}${sectionBlock("風險", finalDocument.risks)}${sectionBlock("未解問題", finalDocument.open_questions)}</div></div>`;
    el.summaryMeta.textContent = `會議已彙整 · ${finalDocument.topics.length} 個主題 · ${finalDocument.finalizer}`;
    syncUI();
    return;
  }
  if (!section) {
    const waiting = Boolean(meetingState && meetingState.pending_segment_count);
    const title = rolloutPending ? "正在建立第一個主題…" : waiting ? "累積中，稍後自動整理" : "會議狀態會出現在這裡";
    const detail = rolloutPending
      ? "模型正在把逐字稿整理成第一個主題。"
      : waiting
      ? `已收到 ${meetingState.pending_segment_count} 段逐字稿，達到門檻就會整理。`
      : "每次整理只會送出「主題索引 + 目前主題 + 新逐字稿」，長度固定。";
    el.summaryContent.innerHTML = `<div class="summary-empty"><strong>${title}</strong><p>${detail}</p></div>`;
    el.summaryMeta.textContent = autoRolloutEnabled ? "自動整理已開啟。" : "自動整理已暫停。";
    syncUI();
    return;
  }
  const indexList = index.length
    ? `<div class="summary-block"><h3>先前主題（已封存）</h3><ul>${index.map(entry => `<li><strong>${escapeHTML(entry.title)}</strong> — ${escapeHTML(entry.short_descriptor)}</li>`).join("")}</ul></div>`
    : "";
  el.summaryContent.innerHTML = `<div class="summary-grid"><div><div class="summary-block"><h3>目前主題：${escapeHTML(section.title)}</h3><p>${escapeHTML(section.summary)}</p></div>${sectionBlock("重點", section.key_points)}${indexList}</div><div>${sectionBlock("決策", section.decisions)}${sectionBlock("待辦事項", actionLines(section.action_items))}${sectionBlock("未解問題", section.open_questions)}</div></div>`;
  const pending = meetingState.pending_segment_count;
  el.summaryMeta.textContent = rolloutPending
    ? "正在整理新的逐字稿…"
    : pending
    ? `已封存 ${index.length} 個主題 · ${pending} 段待整理`
    : `已封存 ${index.length} 個主題 · 第 ${meetingState.state_version} 版狀態`;
  syncUI();
}

async function meetingRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "POST",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || payload.error || "會議狀態更新失敗");
  return payload;
}

async function startMeeting() {
  const generation = sessionGeneration;
  try {
    const payload = await meetingRequest("/api/meetings");
    if (generation !== sessionGeneration) return;
    meetingId = payload.meeting_id;
    applyState(payload.state);
    if (!autoRolloutEnabled) meetingRequest(`/api/meetings/${meetingId}/auto`, { body: { enabled: false } }).catch(() => {});
    schedulePoll();
  } catch (error) {
    showToast(`無法建立會議狀態：${error.message}`);
  }
}

async function sendSegment(segment) {
  if (!meetingId) return;
  const generation = sessionGeneration;
  try {
    const payload = await meetingRequest(`/api/meetings/${meetingId}/segments`, { body: { segments: [segment] } });
    if (generation === sessionGeneration) applyState(payload.state);
  } catch (error) {
    showToast(`逐字稿未能送進會議狀態：${error.message}`);
  }
}

function applyState(state) {
  meetingState = state;
  finalDocument = state.final_document || finalDocument;
  renderSummary();
  renderInferenceEvents();
  syncUI();
}

function schedulePoll() {
  clearTimeout(statePollTimer);
  statePollTimer = setTimeout(pollState, STATE_POLL_MS);
}

async function pollState() {
  if (!meetingId) return;
  const generation = sessionGeneration;
  try {
    const state = await meetingRequest(`/api/meetings/${meetingId}/state`, { method: "GET" });
    if (generation === sessionGeneration) applyState(state);
  } catch (_) {
    // A transient failure just means the next poll tries again.
  } finally {
    if (generation === sessionGeneration) schedulePoll();
  }
}

async function forceRollout() {
  if (!meetingId || rolloutPending) return;
  rolloutPending = true;
  renderSummary();
  try {
    const payload = await meetingRequest(`/api/meetings/${meetingId}/rollout`);
    applyState(payload.state);
    if (payload.status === "failed") showToast(`整理失敗：${payload.reason}`);
    if (payload.status === "skipped" && payload.reason === "no_pending_segments") showToast("沒有待整理的逐字稿");
  } catch (error) {
    showToast(`整理失敗：${error.message}`);
  } finally {
    rolloutPending = false;
    renderSummary();
  }
}

async function finalizeMeeting() {
  if (!meetingId || rolloutPending) return;
  rolloutPending = true;
  renderSummary();
  showToast("正在整理剩餘逐字稿並彙整會議紀錄…");
  try {
    const payload = await meetingRequest(`/api/meetings/${meetingId}/finalize`);
    finalDocument = payload.document;
    applyState(payload.state);
  } catch (error) {
    showToast(`會議彙整失敗：${error.message}`);
  } finally {
    rolloutPending = false;
    renderSummary();
  }
}

function toggleOnlineSummary() {
  autoRolloutEnabled = !autoRolloutEnabled;
  showToast(autoRolloutEnabled ? "自動整理已開啟" : "自動整理已暫停；逐字稿仍會保留並可手動整理");
  if (meetingId) {
    meetingRequest(`/api/meetings/${meetingId}/auto`, { body: { enabled: autoRolloutEnabled } })
      .then(payload => applyState(payload.state))
      .catch(error => showToast(`切換失敗：${error.message}`));
  }
  renderSummary();
}

async function copySummary() {
  const section = meetingState && meetingState.current_section;
  if (!section && !finalDocument) return;
  const source = finalDocument
    ? [
        `會議總結\n${finalDocument.executive_summary}`,
        finalDocument.topics.map(topic => `${topic.title}：${topic.summary}`).join("\n"),
        finalDocument.decisions.length ? `決策\n${finalDocument.decisions.map(item => `- ${item}`).join("\n")}` : "",
        finalDocument.action_items.length ? `待辦事項\n${actionLines(finalDocument.action_items).map(item => `- ${item}`).join("\n")}` : "",
      ]
    : [
        `${section.title}\n${section.summary}`,
        section.key_points.length ? `重點\n${section.key_points.map(item => `- ${item}`).join("\n")}` : "",
        section.decisions.length ? `決策\n${section.decisions.map(item => `- ${item}`).join("\n")}` : "",
        section.action_items.length ? `待辦事項\n${actionLines(section.action_items).map(item => `- ${item}`).join("\n")}` : "",
      ];
  try { await navigator.clipboard.writeText(source.filter(Boolean).join("\n\n")); showToast("已複製會議內容"); } catch (_) { showToast("瀏覽器無法存取剪貼簿"); }
}

function addInferenceEvent(event) {
  inferenceEvents.unshift({ ...event, sequence: inferenceEvents.length + 1 });
  renderInferenceEvents();
}

function rolloutEvents() {
  const rollouts = (meetingState && meetingState.rollouts) || [];
  return rollouts.map(rollout => ({
    type: "STATE",
    context: `${Number(rollout.total_input || 0).toLocaleString()} / ${Number(rollout.budget_input || 0).toLocaleString()} tokens`,
    detail: [
      rollout.operation || "rollout",
      `索引 ${rollout.index || 0} · 主題 ${rollout.current_section || 0} · 新逐字稿 ${rollout.pending_asr || 0}`,
      (rollout.compaction_applied || []).length ? `compaction：${rollout.compaction_applied.join(", ")}` : "",
    ].filter(Boolean).join(" · "),
    latency: Number(rollout.latency_ms || 0) / 1000,
  }));
}

function renderInferenceEvents() {
  const events = [...rolloutEvents(), ...inferenceEvents];
  el.contextCount.textContent = `${events.length} 次推論`;
  if (!events.length) {
    el.contextList.innerHTML = `<p>推論開始後會在這裡顯示每次的 context 長度。</p>`;
    return;
  }
  el.contextList.innerHTML = events.map(event => `<article><span class="context-type ${event.type.toLowerCase()}">${event.type}</span><strong>${escapeHTML(event.context)}</strong><small>${escapeHTML(event.detail)}</small><time>${Number(event.latency || 0).toFixed(2)}s</time></article>`).join("");
}

// Backend errors are full tracebacks; the footer shows a readable head and the
// console keeps the rest so a failed model load is diagnosable from the browser.
function briefError(detail) {
  const firstLine = String(detail).split("\n", 1)[0].trim();
  return firstLine.length > 140 ? `${firstLine.slice(0, 139)}…` : firstLine;
}

async function checkHealth() {
  const previousSummaryStatus = summaryStatus;
  const previousServerError = serverError;
  const previousSummaryError = summaryError;
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error();
    const health = await response.json();
    serverStatus = health.status === "ready" ? "ready" : health.status === "loading" ? "loading" : "error";
    // The backend swallows load failures into health.error; without showing it the UI
    // cannot tell "service not started" from "model failed to load".
    serverError = serverStatus === "error" ? health.error || null : null;
    if (serverError && serverError !== previousServerError) console.error("inference service error:", serverError);
    streamingEnabled = serverStatus === "ready" && health.streaming === true;
    const summaryHealth = health.summary?.status;
    summaryStatus = summaryHealth === "ready" ? "ready"
      : summaryHealth === "loading" ? "loading"
      : summaryHealth === "disabled" ? "disabled" : "error";
    summaryError = summaryStatus === "error" ? health.summary?.error || null : null;
    if (summaryError && summaryError !== previousSummaryError) console.error("summary model error:", summaryError);
    el.runtimeLabel.textContent = health.model
      || (serverStatus === "loading" ? "正在載入 Qwen3-ASR"
      : serverError ? `Inference service 錯誤：${briefError(serverError)}` : "Inference service 發生錯誤");
    const budget = health.summary?.max_context_tokens;
    el.summaryRuntime.textContent = health.summary?.model
      ? `${health.summary.model} · 每輪 ${budget} tokens 預算`
      : summaryStatus === "loading" ? "摘要模型載入中"
      : summaryStatus === "disabled" ? "摘要功能已停用"
      : summaryError ? `摘要模型錯誤：${briefError(summaryError)}` : "摘要模型無法使用";
  } catch (_) {
    serverStatus = "offline";
    serverError = null;
    summaryStatus = "error";
    summaryError = null;
    el.runtimeLabel.textContent = "未連接本機 inference service";
    el.summaryRuntime.textContent = "未連接本機 inference service";
  }
  updatePlaybackState();
  if (previousSummaryStatus !== "ready" && summaryStatus === "ready" && !meetingId) startMeeting();
  clearTimeout(healthTimer);
  if (serverStatus !== "ready" || summaryStatus === "loading") healthTimer = setTimeout(checkHealth, 2000);
  return serverStatus;
}

function formatBytes(bytes) { return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`; }
function escapeHTML(text) { const node = document.createElement("span"); node.textContent = text; return node.innerHTML; }
function showToast(message) { el.toast.textContent = message; el.toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => el.toast.classList.remove("show"), 3000); }

el.playButton.addEventListener("click", togglePlay);
el.fastTranscribeButton.addEventListener("click", toggleFastTranscription);
el.timeline.addEventListener("input", () => {
  if (captureMode !== "media") return;
  capturer.discard();
  const total = activeMedia.duration || 92.54;
  activeMedia.currentTime = (Number(el.timeline.value) / 100) * total;
  syncUI();
});
el.soundButton.addEventListener("click", () => { activeMedia.muted = !activeMedia.muted; el.soundButton.textContent = activeMedia.muted ? "×" : "⌁"; el.soundButton.classList.toggle("muted", activeMedia.muted); });
el.restartButton.addEventListener("click", restart);
el.uploadButton.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", event => {
  if (event.target.files[0]) loadMedia(event.target.files[0]);
  event.target.value = "";
});
el.captureMode.addEventListener("change", () => applyCaptureMode(el.captureMode.value));
el.audioDevice.addEventListener("change", async () => {
  if (!liveActive) return;
  stopLive();
  await startLive(false);
});
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener("devicechange", () => { if (captureMode !== "media") populateDevices(); });
el.copyButton.addEventListener("click", copyTranscript);
el.summaryButton.addEventListener("click", forceRollout);
el.finalizeButton.addEventListener("click", finalizeMeeting);
el.onlineSummaryToggle.addEventListener("click", toggleOnlineSummary);
el.copySummaryButton.addEventListener("click", copySummary);
el.youtubeForm.addEventListener("submit", event => {
  event.preventDefault();
  const url = el.youtubeUrl.value.trim();
  if (!url) return showToast("請先貼上 YouTube 連結");
  loadYoutubeMedia(url);
});
document.addEventListener("keydown", event => { if (event.code === "Space" && !/INPUT|BUTTON/.test(document.activeElement.tagName)) { event.preventDefault(); togglePlay(); } });

bindMedia(el.demoAudio);
bindMedia(el.video);
el.liveHint.textContent = captureHint();
renderCompleted();
renderSummary();
renderInferenceEvents();
checkHealth();
startMeeting();
