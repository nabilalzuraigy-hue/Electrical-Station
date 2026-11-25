import { createWorker, PSM, type Worker } from 'tesseract.js';

export interface OcrPassDetail {
  engine: string;
  label: string;
  reading: number | null;
  rawDigits: string;
  confidence: number;
}

export interface MeterOcrResult {
  accepted: boolean;
  reading: number | null;
  rawDigits: string;
  confidence: number;
  agreementCount: number;
  totalPasses: number;
  passes: OcrPassDetail[];
  enhancedPreviewUrl: string;
  zoomedBwPreviewUrl: string;
  lowLightDetected: boolean;
  illogicalJump?: boolean;
  rejectedReason?:
    | 'unreadable'
    | 'no_consensus'
    | 'low_confidence'
    | 'illogical_jump';
  engine: 'hybrid' | 'offline';
  message?: string;
}

let cachedWorker: Worker | null = null;

async function getOfflineOcrWorker(): Promise<Worker> {
  if (cachedWorker) return cachedWorker;
  const worker = await createWorker('eng');
  await worker.setParameters({
    tessedit_char_whitelist: '0123456789.',
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
  });
  cachedWorker = worker;
  return worker;
}

/**
 * Measures average luminance (0..255) from a live video stream frame
 * so the collector camera can automatically trigger the torch in dim light.
 */
export function measureVideoLuminance(video: HTMLVideoElement): number {
  if (!video.videoWidth || !video.videoHeight) return 128;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 128;
  ctx.drawImage(video, 0, 0, 64, 48);
  const { data } = ctx.getImageData(0, 0, 64, 48);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return Math.round(sum / (data.length / 4));
}

function applyMedianDespeckle3x3(
  src: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(src.length);
  const win = new Uint8Array(9);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        dst[y * width + x] = src[y * width + x];
        continue;
      }
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          win[k++] = src[(y + dy) * width + (x + dx)];
        }
      }
      win.sort();
      dst[y * width + x] = win[4];
    }
  }
  return dst;
}

function applyUnsharpAndContrast(
  src: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  // 1. Histogram stretch (p2..p98)
  const hist = new Uint32Array(256);
  for (let i = 0; i < src.length; i++) hist[src[i]]++;
  const total = src.length;
  let low = 0;
  let high = 255;
  let cum = 0;
  for (let i = 0; i < 256; i++) {
    cum += hist[i];
    if (cum >= total * 0.02) {
      low = i;
      break;
    }
  }
  cum = 0;
  for (let i = 255; i >= 0; i--) {
    cum += hist[i];
    if (cum >= total * 0.02) {
      high = i;
      break;
    }
  }
  const range = Math.max(24, high - low);
  const stretched = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i++) {
    stretched[i] = Math.max(0, Math.min(255, ((src[i] - low) * 255) / range));
  }

  // 2. 3x3 sharpening kernel
  const dst = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        dst[idx] = stretched[idx];
        continue;
      }
      const sharp =
        5 * stretched[idx] -
        stretched[idx - 1] -
        stretched[idx + 1] -
        stretched[idx - width] -
        stretched[idx + width];
      dst[idx] = Math.max(0, Math.min(255, sharp));
    }
  }
  return dst;
}

function computeAdaptiveBinary(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  thresholdRatio = 0.13,
): Uint8ClampedArray {
  const integral = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[y * width + x] =
        rowSum + (y > 0 ? integral[(y - 1) * width + x] : 0);
    }
  }

  const radius = Math.max(9, Math.round(Math.min(width, height) / 14));
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(width - 1, x + radius);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integral[y2 * width + x2] -
        (y1 > 0 ? integral[(y1 - 1) * width + x2] : 0) -
        (x1 > 0 ? integral[y2 * width + (x1 - 1)] : 0) +
        (x1 > 0 && y1 > 0 ? integral[(y1 - 1) * width + (x1 - 1)] : 0);
      const localMean = sum / count;
      const val = gray[y * width + x];
      out[y * width + x] = val < localMean * (1 - thresholdRatio) ? 0 : 255;
    }
  }
  return out;
}

function grayBufferToCanvas(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const imgData = ctx.createImageData(width, height);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    imgData.data[i * 4] = v;
    imgData.data[i * 4 + 1] = v;
    imgData.data[i * 4 + 2] = v;
    imgData.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

export interface PreprocessedMeterVariants {
  enhancedFullCanvas: HTMLCanvasElement;
  enhancedFullDataUrl: string;
  zoomedGrayCanvas: HTMLCanvasElement;
  zoomedBwCanvas: HTMLCanvasElement;
  zoomedBwDataUrl: string;
  averageLuminance: number;
}

/**
 * Enhances raw meter image before OCR:
 * 1) Illumination normalization to strip shadows/glare
 * 2) 3x3 median filter to remove dust/noise
 * 3) Contrast stretching + sharpening
 * 4) 2x zoom crop on the central digit window
 * 5) Adaptive Black & White binarization
 */
export async function preprocessMeterImageVariants(
  imageDataUrl: string,
): Promise<PreprocessedMeterVariants> {
  const img = new Image();
  img.src = imageDataUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('تعذر تحميل صورة العداد للمعالجة'));
  });

  const w = img.naturalWidth || img.width || 640;
  const h = img.naturalHeight || img.height || 480;

  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = w;
  baseCanvas.height = h;
  const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true });
  if (!baseCtx) {
    return {
      enhancedFullCanvas: baseCanvas,
      enhancedFullDataUrl: imageDataUrl,
      zoomedGrayCanvas: baseCanvas,
      zoomedBwCanvas: baseCanvas,
      zoomedBwDataUrl: imageDataUrl,
      averageLuminance: 128,
    };
  }
  baseCtx.drawImage(img, 0, 0, w, h);
  const srcData = baseCtx.getImageData(0, 0, w, h).data;

  // Compute raw grayscale and average ambient luminance
  const rawGray = new Uint8ClampedArray(w * h);
  let totalLuma = 0;
  for (let i = 0; i < w * h; i++) {
    const lum = Math.round(
      0.299 * srcData[i * 4] +
        0.587 * srcData[i * 4 + 1] +
        0.114 * srcData[i * 4 + 2],
    );
    rawGray[i] = lum;
    totalLuma += lum;
  }
  const averageLuminance = Math.round(totalLuma / Math.max(1, w * h));

  // Estimate coarse background illumination map (shadow removal)
  const bgW = Math.max(12, Math.round(w / 14));
  const bgH = Math.max(10, Math.round(h / 14));
  const bgSmallCanvas = document.createElement('canvas');
  bgSmallCanvas.width = bgW;
  bgSmallCanvas.height = bgH;
  const bgSmallCtx = bgSmallCanvas.getContext('2d');
  const bgFullCanvas = document.createElement('canvas');
  bgFullCanvas.width = w;
  bgFullCanvas.height = h;
  const bgFullCtx = bgFullCanvas.getContext('2d');

  let shadowRemoved = rawGray;
  if (bgSmallCtx && bgFullCtx) {
    const grayCanvas = grayBufferToCanvas(rawGray, w, h);
    bgSmallCtx.drawImage(grayCanvas, 0, 0, bgW, bgH);
    bgFullCtx.imageSmoothingEnabled = true;
    bgFullCtx.imageSmoothingQuality = 'high';
    bgFullCtx.drawImage(bgSmallCanvas, 0, 0, w, h);
    const bgPixels = bgFullCtx.getImageData(0, 0, w, h).data;

    shadowRemoved = new Uint8ClampedArray(w * h);
    for (let i = 0; i < w * h; i++) {
      const bg = Math.max(22, bgPixels[i * 4]);
      shadowRemoved[i] = Math.max(
        0,
        Math.min(255, Math.round((rawGray[i] / bg) * 168)),
      );
    }
  }

  // Dust removal + contrast enhancement + sharpen on full frame
  const despeckled = applyMedianDespeckle3x3(shadowRemoved, w, h);
  const enhancedGray = applyUnsharpAndContrast(despeckled, w, h);
  const enhancedFullCanvas = grayBufferToCanvas(enhancedGray, w, h);
  const enhancedFullDataUrl = enhancedFullCanvas.toDataURL('image/jpeg', 0.88);

  // Crop & 2x zoom central digit register window (matches guide frame)
  const cropX = Math.round(w * 0.08);
  const cropY = Math.round(h * 0.2);
  const cropW = Math.max(60, Math.round(w * 0.84));
  const cropH = Math.max(40, Math.round(h * 0.6));
  const zoomW = Math.min(1280, cropW * 2);
  const zoomH = Math.min(960, cropH * 2);

  const zoomedGrayCanvas = document.createElement('canvas');
  zoomedGrayCanvas.width = zoomW;
  zoomedGrayCanvas.height = zoomH;
  const zCtx = zoomedGrayCanvas.getContext('2d', { willReadFrequently: true });
  let zoomedBwCanvas = zoomedGrayCanvas;
  if (zCtx) {
    zCtx.imageSmoothingEnabled = true;
    zCtx.imageSmoothingQuality = 'high';
    zCtx.drawImage(
      enhancedFullCanvas,
      cropX,
      cropY,
      cropW,
      cropH,
      0,
      0,
      zoomW,
      zoomH,
    );
    const zPixels = zCtx.getImageData(0, 0, zoomW, zoomH).data;
    const zGray = new Uint8ClampedArray(zoomW * zoomH);
    for (let i = 0; i < zGray.length; i++) {
      zGray[i] = zPixels[i * 4];
    }
    const zBw = computeAdaptiveBinary(zGray, zoomW, zoomH, 0.14);
    zoomedBwCanvas = grayBufferToCanvas(zBw, zoomW, zoomH);
  }
  const zoomedBwDataUrl = zoomedBwCanvas.toDataURL('image/jpeg', 0.9);

  return {
    enhancedFullCanvas,
    enhancedFullDataUrl,
    zoomedGrayCanvas,
    zoomedBwCanvas,
    zoomedBwDataUrl,
    averageLuminance,
  };
}

function selectBestMeterNumber(
  rawText: string,
  previousReading: number,
): number | null {
  const normalized = rawText
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/,/g, '.')
    .replace(/\s+/g, ' ');

  const matches = normalized.match(/\d{2,7}(?:\.\d{1,2})?/g) ?? [];
  const nums = matches
    .map((m) => Number(m))
    .filter((n) => Number.isFinite(n) && n >= 0);

  if (nums.length === 0) return null;

  const plausible = nums.filter(
    (n) =>
      n >= previousReading &&
      (previousReading === 0 || n <= previousReading + 50000),
  );
  if (plausible.length > 0) {
    return Math.round(plausible[0] * 100) / 100;
  }

  const sorted = [...nums].sort((a, b) => b - a);
  return Math.round(sorted[0] * 100) / 100;
}

async function runSingleTesseractPass(
  canvas: HTMLCanvasElement,
  previousReading: number,
  psm: PSM,
  engine: string,
  label: string,
): Promise<OcrPassDetail> {
  try {
    const worker = await getOfflineOcrWorker();
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789.',
      tessedit_pageseg_mode: psm,
    });
    const { data } = await worker.recognize(canvas);
    const extracted = selectBestMeterNumber(data.text || '', previousReading);
    return {
      engine,
      label,
      reading: extracted,
      rawDigits: (data.text || '').trim(),
      confidence: extracted !== null ? Math.round(data.confidence || 0) : 0,
    };
  } catch {
    return {
      engine,
      label,
      reading: null,
      rawDigits: '',
      confidence: 0,
    };
  }
}

export function isIllogicalReadingJump(params: {
  reading: number;
  previousReading: number;
  avg3MonthsKwh?: number;
}): { illogical: boolean; reason?: string } {
  const diff = params.reading - params.previousReading;
  if (diff <= 0) return { illogical: false };

  const avg = params.avg3MonthsKwh ?? 0;
  if (avg > 0 && diff > Math.max(avg * 8, 1500)) {
    return {
      illogical: true,
      reason: `الاستهلاك المحسوب (${Math.round(diff * 100) / 100} ك.و.س) أكبر بـ 8 أضعاف من متوسط آخر 3 أشهر (${Math.round(avg)} ك.و.س) — يرجى التحقق من الفاصلة العشرية أو انعكاس الضوء وإعادة التصوير.`,
    };
  }

  if (
    diff > 25000 ||
    (params.previousReading >= 100 && diff > Math.max(params.previousReading * 4, 12000))
  ) {
    return {
      illogical: true,
      reason: `القفزة بين القراءة السابقة (${params.previousReading}) والمقروءة (${params.reading}) غير منطقية (+${Math.round(diff)} ك.و.س) — قد تكون الفاصلة العشرية غير ظاهرة، أعد تصوير العداد بوضوح.`,
    };
  }

  return { illogical: false };
}

function evaluateMultiEngineConsensus(params: {
  passes: OcrPassDetail[];
  previousReading: number;
  avg3MonthsKwh?: number;
  enhancedPreviewUrl: string;
  zoomedBwPreviewUrl: string;
  lowLightDetected: boolean;
  engineMode: 'hybrid' | 'offline';
}): MeterOcrResult {
  const validPasses = params.passes.filter(
    (p): p is OcrPassDetail & { reading: number } =>
      p.reading !== null && Number.isFinite(p.reading) && p.reading >= 0,
  );

  if (validPasses.length === 0) {
    return {
      accepted: false,
      reading: null,
      rawDigits: '',
      confidence: 0,
      agreementCount: 0,
      totalPasses: params.passes.length,
      passes: params.passes,
      enhancedPreviewUrl: params.enhancedPreviewUrl,
      zoomedBwPreviewUrl: params.zoomedBwPreviewUrl,
      lowLightDetected: params.lowLightDetected,
      rejectedReason: 'unreadable',
      engine: params.engineMode,
      message:
        'لم تظهر أرقام العداد بوضوح في الصورة — يرجى تنظيف الزجاج، تشغيل الفلاش، وإعادة التصوير.',
    };
  }

  // Group identical readings (within 0.01 rounding) and count votes
  const groups = new Map<string, Array<OcrPassDetail & { reading: number }>>();
  for (const p of validPasses) {
    const key = p.reading.toFixed(2);
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  let bestGroup: Array<OcrPassDetail & { reading: number }> = [];
  for (const group of groups.values()) {
    if (group.length > bestGroup.length) {
      bestGroup = group;
    } else if (group.length === bestGroup.length && bestGroup.length > 0) {
      const avgG = group.reduce((s, x) => s + x.confidence, 0) / group.length;
      const avgB =
        bestGroup.reduce((s, x) => s + x.confidence, 0) / bestGroup.length;
      if (avgG > avgB) bestGroup = group;
    }
  }

  const consensusReading = bestGroup[0]?.reading ?? null;
  const agreementCount = bestGroup.length;
  const avgConfidence =
    bestGroup.length > 0
      ? Math.round(
          bestGroup.reduce((s, x) => s + x.confidence, 0) / bestGroup.length,
        )
      : 0;

  if (consensusReading === null || agreementCount < 2) {
    return {
      accepted: false,
      reading: consensusReading,
      rawDigits: bestGroup[0]?.rawDigits || '',
      confidence: avgConfidence,
      agreementCount,
      totalPasses: params.passes.length,
      passes: params.passes,
      enhancedPreviewUrl: params.enhancedPreviewUrl,
      zoomedBwPreviewUrl: params.zoomedBwPreviewUrl,
      lowLightDetected: params.lowLightDetected,
      rejectedReason: 'no_consensus',
      engine: params.engineMode,
      message:
        'تضاربت القراءات بين محركات OCR الثلاثة (أقل من تطابقين) — يرجى تثبيت الكاميرا وإعادة التصوير بوضوح.',
    };
  }

  if (avgConfidence < 85) {
    return {
      accepted: false,
      reading: consensusReading,
      rawDigits: bestGroup[0]?.rawDigits || String(consensusReading),
      confidence: avgConfidence,
      agreementCount,
      totalPasses: params.passes.length,
      passes: params.passes,
      enhancedPreviewUrl: params.enhancedPreviewUrl,
      zoomedBwPreviewUrl: params.zoomedBwPreviewUrl,
      lowLightDetected: params.lowLightDetected,
      rejectedReason: 'low_confidence',
      engine: params.engineMode,
      message: `نسبة الثقة (${avgConfidence}%) أقل من 85% المطلوبة — يرجى تقريب الكاميرا وتشغيل الفلاش وإعادة التصوير.`,
    };
  }

  const jumpCheck = isIllogicalReadingJump({
    reading: consensusReading,
    previousReading: params.previousReading,
    avg3MonthsKwh: params.avg3MonthsKwh,
  });

  if (jumpCheck.illogical) {
    return {
      accepted: false,
      reading: consensusReading,
      rawDigits: bestGroup[0]?.rawDigits || String(consensusReading),
      confidence: avgConfidence,
      agreementCount,
      totalPasses: params.passes.length,
      passes: params.passes,
      enhancedPreviewUrl: params.enhancedPreviewUrl,
      zoomedBwPreviewUrl: params.zoomedBwPreviewUrl,
      lowLightDetected: params.lowLightDetected,
      illogicalJump: true,
      rejectedReason: 'illogical_jump',
      engine: params.engineMode,
      message: jumpCheck.reason,
    };
  }

  return {
    accepted: true,
    reading: consensusReading,
    rawDigits: bestGroup[0]?.rawDigits || String(consensusReading),
    confidence: avgConfidence,
    agreementCount,
    totalPasses: params.passes.length,
    passes: params.passes,
    enhancedPreviewUrl: params.enhancedPreviewUrl,
    zoomedBwPreviewUrl: params.zoomedBwPreviewUrl,
    lowLightDetected: params.lowLightDetected,
    engine: params.engineMode,
  };
}

export async function extractMeterReadingFromImage(params: {
  imageDataUrl: string;
  stationId: string;
  staffToken: string;
  previousReading: number;
  avg3MonthsKwh?: number;
}): Promise<MeterOcrResult> {
  const variants = await preprocessMeterImageVariants(params.imageDataUrl);
  const lowLightDetected = variants.averageLuminance < 85;
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : false;

  if (isOnline && params.staffToken) {
    try {
      const [cloudRes, localPass3] = await Promise.all([
        fetch(
          `/api/stations/${encodeURIComponent(params.stationId)}/ocr-meter`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${params.staffToken}`,
            },
            body: JSON.stringify({
              imageBase64: variants.enhancedFullDataUrl,
              zoomedBwBase64: variants.zoomedBwDataUrl,
              previousReading: params.previousReading,
            }),
          },
        ),
        runSingleTesseractPass(
          variants.zoomedBwCanvas,
          params.previousReading,
          PSM.SINGLE_LINE,
          'tesseract-zoomed-bw',
          'محرك محلي (أبيض وأسود مكبّر)',
        ),
      ]);

      if (cloudRes.ok) {
        const data = (await cloudRes.json()) as {
          passes?: Array<{
            engine: string;
            reading: number | null;
            rawDigits: string;
            confidence: number;
          }>;
        };

        const cloudPasses: OcrPassDetail[] = (data.passes ?? []).map((p, i) => ({
          engine: p.engine,
          label:
            i === 0
              ? 'محرك سحابي 1 (صورة محسّنة)'
              : 'محرك سحابي 2 (نطاق الأرقام أبيض/أسود)',
          reading: p.reading,
          rawDigits: p.rawDigits,
          confidence: p.confidence,
        }));

        const allPasses = [...cloudPasses, localPass3];
        // Ensure at least 3 passes even if server returned 1 pass
        if (allPasses.length < 3) {
          const extraPass = await runSingleTesseractPass(
            variants.zoomedGrayCanvas,
            params.previousReading,
            PSM.SINGLE_BLOCK,
            'tesseract-zoomed-gray',
            'محرك محلي 2 (تباين عالٍ مكبّر)',
          );
          allPasses.push(extraPass);
        }

        return evaluateMultiEngineConsensus({
          passes: allPasses.slice(0, 3),
          previousReading: params.previousReading,
          avg3MonthsKwh: params.avg3MonthsKwh,
          enhancedPreviewUrl: variants.enhancedFullDataUrl,
          zoomedBwPreviewUrl: variants.zoomedBwDataUrl,
          lowLightDetected,
          engineMode: 'hybrid',
        });
      }
    } catch {
      // Fall back cleanly to 3-pass offline Tesseract OCR
    }
  }

  // Offline / Fallback: 3 sequential Tesseract passes with 3 distinct image pipelines & PSM modes
  const pass1 = await runSingleTesseractPass(
    variants.enhancedFullCanvas,
    params.previousReading,
    PSM.SINGLE_BLOCK,
    'tesseract-enhanced-full',
    'قراءة 1 (إزالة الظل + تباين)',
  );
  const pass2 = await runSingleTesseractPass(
    variants.zoomedBwCanvas,
    params.previousReading,
    PSM.SINGLE_LINE,
    'tesseract-zoomed-bw',
    'قراءة 2 (أبيض وأسود مكبّر)',
  );
  const pass3 = await runSingleTesseractPass(
    variants.zoomedGrayCanvas,
    params.previousReading,
    PSM.SINGLE_BLOCK,
    'tesseract-zoomed-gray',
    'قراءة 3 (رمادي حاد مكبّر)',
  );

  return evaluateMultiEngineConsensus({
    passes: [pass1, pass2, pass3],
    previousReading: params.previousReading,
    avg3MonthsKwh: params.avg3MonthsKwh,
    enhancedPreviewUrl: variants.enhancedFullDataUrl,
    zoomedBwPreviewUrl: variants.zoomedBwDataUrl,
    lowLightDetected,
    engineMode: 'offline',
  });
}
