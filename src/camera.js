const SEG_PKG = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9';
const SEG_WASM = SEG_PKG + '/wasm';

const MODEL_MULTICLASS =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite';
const MODEL_SELFIE =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

let video = null;
let segmenter = null;
let prevMaskData = null;
let lastMaskData = null;
let lastMaskW = 0;
let lastMaskH = 0;
let lastMirror = false;
let previewCanvas = null;
let previewCtx = null;
let lastTimestamp = -1;

export const cameraState = {
  ready: false,
  presence: 0,
  motion: 0,
  silhouetteDivs: [], // per-column normalized top Y (-1 if no body) -- legacy name
  colTop: [], // alias of silhouetteDivs
  colBottom: [], // per-column normalized bottom Y (-1 if none)
  colCoverage: [], // per-column body fraction 0..1
  colMotion: [], // per-column frame-diff fraction 0..1
  centroidX: -1, // normalized body centroid (screen space, mirror-aware)
  centroidY: -1,
};

async function tryCreate(fileset, modelPath) {
  return await window.ImageSegmenter.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: modelPath,
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
}

export async function startCamera() {
  if (cameraState.ready) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    const vision = await import(SEG_PKG);
    const { ImageSegmenter, FilesetResolver } = vision;
    window.ImageSegmenter = ImageSegmenter;
    const fileset = await FilesetResolver.forVisionTasks(SEG_WASM);

    try {
      segmenter = await tryCreate(fileset, MODEL_MULTICLASS);
      console.log('[camera] using selfie_multiclass model');
    } catch (e) {
      console.warn('[camera] multiclass model failed, falling back to selfie_segmenter', e);
      segmenter = await tryCreate(fileset, MODEL_SELFIE);
      console.log('[camera] using selfie_segmenter model');
    }

    cameraState.ready = true;
    return true;
  } catch (e) {
    console.warn('[camera] startup failed:', e);
    cameraState.ready = false;
    return false;
  }
}

export function stopCamera() {
  if (video?.srcObject) {
    for (const t of video.srcObject.getTracks()) t.stop();
    video.srcObject = null;
  }
  if (segmenter) {
    try {
      segmenter.close();
    } catch {}
    segmenter = null;
  }
  cameraState.ready = false;
  cameraState.presence = 0;
  cameraState.motion = 0;
  cameraState.silhouetteDivs = [];
  cameraState.colTop = [];
  cameraState.colBottom = [];
  cameraState.colCoverage = [];
  cameraState.colMotion = [];
  cameraState.centroidX = -1;
  cameraState.centroidY = -1;
  prevMaskData = null;
  lastMaskData = null;
  if (previewCtx) previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
}

export function setPreviewCanvas(canvas) {
  previewCanvas = canvas;
  previewCtx = canvas ? canvas.getContext('2d') : null;
}

export function processFrame(cols, mirror) {
  if (!cameraState.ready || !video || video.readyState < 2 || !segmenter) return;

  const ts = performance.now();
  if (ts === lastTimestamp) return;
  lastTimestamp = ts;

  let result;
  try {
    result = segmenter.segmentForVideo(video, ts);
  } catch (e) {
    return;
  }
  if (!result || !result.categoryMask) return;

  const mask = result.categoryMask;
  let data;
  try {
    data = mask.getAsUint8Array();
  } catch {
    try {
      mask.close();
    } catch {}
    return;
  }
  const w = mask.width;
  const h = mask.height;

  const hasPrev = prevMaskData && prevMaskData.length === data.length;

  let fgCount = 0;
  let sumX = 0;
  let sumY = 0;
  let diffTotal = 0;
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rowOff + x;
      const fg = data[idx] !== 0;
      if (fg) {
        fgCount++;
        sumX += x;
        sumY += y;
      }
      if (hasPrev && fg !== (prevMaskData[idx] !== 0)) diffTotal++;
    }
  }

  const presenceRaw = Math.min(1, fgCount / data.length / 0.04);
  cameraState.presence = cameraState.presence * 0.85 + presenceRaw * 0.15;

  const motionRaw = hasPrev ? Math.min(1, diffTotal / data.length / 0.04) : 0;
  cameraState.motion = cameraState.motion * 0.8 + motionRaw * 0.2;

  if (fgCount > 0) {
    let cx = sumX / fgCount / w;
    const cy = sumY / fgCount / h;
    cameraState.centroidX = mirror ? 1 - cx : cx;
    cameraState.centroidY = cy;
  } else {
    cameraState.centroidX = -1;
    cameraState.centroidY = -1;
  }

  if (cameraState.silhouetteDivs.length !== cols) {
    cameraState.silhouetteDivs = new Array(cols).fill(-1);
    cameraState.colTop = cameraState.silhouetteDivs;
    cameraState.colBottom = new Array(cols).fill(-1);
    cameraState.colCoverage = new Array(cols).fill(0);
    cameraState.colMotion = new Array(cols).fill(0);
  }
  for (let i = 0; i < cols; i++) {
    const srcIdx = mirror ? cols - 1 - i : i;
    const x0 = Math.floor((srcIdx / cols) * w);
    const x1 = Math.max(x0 + 1, Math.floor(((srcIdx + 1) / cols) * w));
    const sliceW = x1 - x0;
    let topY = -1;
    let bottomY = -1;
    let colFg = 0;
    let colDiff = 0;
    for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      let hits = 0;
      for (let x = x0; x < x1; x++) {
        const idx = rowOff + x;
        const fg = data[idx] !== 0;
        if (fg) {
          hits++;
          colFg++;
        }
        if (hasPrev && fg !== (prevMaskData[idx] !== 0)) colDiff++;
      }
      if (hits >= 2) {
        if (topY < 0) topY = y;
        bottomY = y;
      }
    }
    cameraState.silhouetteDivs[i] = topY < 0 ? -1 : topY / h;
    cameraState.colBottom[i] = bottomY < 0 ? -1 : bottomY / h;
    cameraState.colCoverage[i] = colFg / (sliceW * h);
    cameraState.colMotion[i] = hasPrev ? Math.min(1, colDiff / (sliceW * h) / 0.08) : 0;
  }
  cameraState.colTop = cameraState.silhouetteDivs;

  prevMaskData = new Uint8Array(data);

  lastMaskData = data;
  lastMaskW = w;
  lastMaskH = h;
  lastMirror = mirror;

  if (previewCtx) drawPreview();

  try {
    mask.close();
  } catch {}
}

function drawPreview() {
  if (!previewCtx || !video) return;
  const cw = previewCanvas.width;
  const ch = previewCanvas.height;

  previewCtx.save();
  previewCtx.fillStyle = '#000';
  previewCtx.fillRect(0, 0, cw, ch);
  if (lastMirror) {
    previewCtx.scale(-1, 1);
    previewCtx.drawImage(video, -cw, 0, cw, ch);
  } else {
    previewCtx.drawImage(video, 0, 0, cw, ch);
  }
  previewCtx.restore();

  if (lastMaskData && lastMaskW > 0 && lastMaskH > 0) {
    const STEP = 3;
    previewCtx.fillStyle = 'rgba(255, 0, 200, 0.35)';
    for (let py = 0; py < ch; py += STEP) {
      const my = Math.floor((py / ch) * lastMaskH);
      const rowOff = my * lastMaskW;
      for (let px = 0; px < cw; px += STEP) {
        const sx = lastMirror ? cw - 1 - px : px;
        const mx = Math.floor((sx / cw) * lastMaskW);
        if (lastMaskData[rowOff + mx] !== 0) {
          previewCtx.fillRect(px, py, STEP, STEP);
        }
      }
    }
  }

  const divs = cameraState.silhouetteDivs;
  previewCtx.fillStyle = 'rgba(255, 255, 0, 0.95)';
  for (let i = 0; i < divs.length; i++) {
    if (divs[i] < 0) continue;
    const x = ((i + 0.5) / divs.length) * cw;
    const y = divs[i] * ch;
    previewCtx.beginPath();
    previewCtx.arc(x, y, 4, 0, Math.PI * 2);
    previewCtx.fill();
  }

  previewCtx.fillStyle = '#fff';
  previewCtx.font = '11px ui-monospace, monospace';
  const found = divs.filter((v) => v >= 0).length;
  previewCtx.fillText(
    `pres ${cameraState.presence.toFixed(2)}  mot ${cameraState.motion.toFixed(2)}  cols ${found}/${divs.length}`,
    6,
    ch - 6
  );
}
