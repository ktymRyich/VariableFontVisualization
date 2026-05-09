const SEG_PKG = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9';
const SEG_WASM = SEG_PKG + '/wasm';
const SEG_MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

let video = null;
let segmenter = null;
let prevMaskData = null;
let previewCanvas = null;
let previewCtx = null;
let lastTimestamp = -1;

export const cameraState = {
  ready: false,
  presence: 0,
  motion: 0,
  silhouetteDivs: [],
};

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
    const fileset = await FilesetResolver.forVisionTasks(SEG_WASM);
    segmenter = await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: SEG_MODEL,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      outputCategoryMask: true,
      outputConfidenceMasks: false,
    });

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
  prevMaskData = null;
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

  let fgCount = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) fgCount++;
  }
  const presenceRaw = Math.min(1, fgCount / data.length / 0.05);
  cameraState.presence = cameraState.presence * 0.85 + presenceRaw * 0.15;

  let motionRaw = 0;
  if (prevMaskData && prevMaskData.length === data.length) {
    let diff = 0;
    for (let i = 0; i < data.length; i++) {
      if ((data[i] !== 0) !== (prevMaskData[i] !== 0)) diff++;
    }
    motionRaw = Math.min(1, diff / data.length / 0.04);
  }
  prevMaskData = new Uint8Array(data);
  cameraState.motion = cameraState.motion * 0.8 + motionRaw * 0.2;

  if (cameraState.silhouetteDivs.length !== cols) {
    cameraState.silhouetteDivs = new Array(cols).fill(1);
  }
  for (let i = 0; i < cols; i++) {
    const srcIdx = mirror ? cols - 1 - i : i;
    const x0 = Math.floor((srcIdx / cols) * w);
    const x1 = Math.max(x0 + 1, Math.floor(((srcIdx + 1) / cols) * w));
    let topY = h;
    scan: for (let y = 0; y < h; y++) {
      const rowOff = y * w;
      for (let x = x0; x < x1; x++) {
        if (data[rowOff + x] !== 0) {
          topY = y;
          break scan;
        }
      }
    }
    cameraState.silhouetteDivs[i] = topY / h;
  }

  if (previewCtx) drawPreview(w, h, mirror);

  try {
    mask.close();
  } catch {}
}

function drawPreview(maskW, maskH, mirror) {
  const cw = previewCanvas.width;
  const ch = previewCanvas.height;
  previewCtx.save();
  previewCtx.fillStyle = '#000';
  previewCtx.fillRect(0, 0, cw, ch);
  if (mirror) {
    previewCtx.scale(-1, 1);
    previewCtx.drawImage(video, -cw, 0, cw, ch);
  } else {
    previewCtx.drawImage(video, 0, 0, cw, ch);
  }
  previewCtx.restore();

  previewCtx.fillStyle = 'rgba(255, 0, 200, 0.95)';
  const divs = cameraState.silhouetteDivs;
  for (let i = 0; i < divs.length; i++) {
    const x = ((i + 0.5) / divs.length) * cw;
    const y = divs[i] * ch;
    previewCtx.beginPath();
    previewCtx.arc(x, y, 4, 0, Math.PI * 2);
    previewCtx.fill();
  }

  previewCtx.fillStyle = '#fff';
  previewCtx.font = '11px ui-monospace, monospace';
  previewCtx.fillText(
    `pres ${cameraState.presence.toFixed(2)}  mot ${cameraState.motion.toFixed(2)}`,
    6,
    ch - 6
  );
}
