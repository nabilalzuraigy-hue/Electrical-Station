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
let workerPromise: Promise<Worker> | null = null;

async function getOfflineOcrWorker(): Promise<Worker> {
  if (cachedWorker) return cachedWorker;
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng');
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789.',
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
      });
      cachedWorker = worker;
      return worker;
    })();
  }
  return workerPromise;
}

/**
 * Measures average luminance (0..255) from a live video stream frame
 * so the collector camera can automatically trigger the torch in dim light.
 */
export function measureVideoLuminance(video: HTMLVideoElement): number {
  if (!video.videoWidth || !video.videoHeight) return 128;
  const canvas = document.createElement('canvas');
  canvas.width = 48;
  canvas.height = 36;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 128;
  ctx.drawImage(video, 0, 0, 48, 36);
  const { data } = ctx.getImageData(0, 0, 48, 36);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return Math.round(sum / (data.length / 4));
}

function applyFastContrastAndSharpen(
  src: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
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
  const scale = 255 / range;
  const stretched = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = (src[i] - low) * scale;
    stretched[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }

  const dst = new Uint8ClampedArray(src.length);
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowOff + x;
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
      dst[idx] = sharp < 0 ? 0 : sharp > 255 ? 255 : sharp;
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
  const integral = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      rowSum += gray[rowOff + x];
      integral[rowOff + x] =
        rowSum + (y > 0 ? integral[rowOff - width + x] : 0);
    }
  }

  const radius = Math.max(8, Math.round(Math.min(width, height) / 14));
  const out = new Uint8ClampedArray(width * height);
  const factor = 1 - thresholdRatio;
  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(height - 1, y + radius);
    const rowOff = y * width;
    const y2Off = y2 * width;
    const y1Off = (y1 - 1) * width;
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(width - 1, x + radius);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integral[y2Off + x2] -
        (y1 > 0 ? integral[y1Off + x2] : 0) -
        (x1 > 0 ? integral[y2Off + (x1 - 1)] : 0) +
        (x1 > 0 && y1 > 0 ? integral[y1Off + (x1 - 1)] : 0);
      out[rowOff + x] = gray[rowOff + x] * count < sum * factor ? 0 : 255;
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
  const d = imgData.data;
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    const p = i * 4;
    d[p] = v;
    d[p + 1] = v;
    d[p + 2] = v;
    d[p + 3] = 255;
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
 * Fast meter preprocessing pipeline (typically <25ms on mobile):
 * 1) Downscale to 640px max width
 * 2) Illumination normalization + contrast stretch + sharpen
 * 3) Tight crop on central digit window + adaptive binary mask
 */
export async function preprocessMeterImageVariants(
  imageDataUrl: string,
): Promise<PreprocessedMeterVariants> {
  const img = new Image();
  img.src = imageDataUrl;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('تعذر تحميل صورة العداد'));
  });

  const naturalW = img.naturalWidth || img.width || 640;
  const naturalH = img.naturalHeight || img.height || 480;
  const maxW = 640;
  const scale = naturalW > maxW ? maxW / naturalW : 1;
  const w = Math.max(64, Math.round(naturalW * scale));
  const h = Math.max(48, Math.round(naturalH * scale));

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

  const rawGray = new Uint8ClampedArray(w * h);
  let totalLuma = 0;
  for (let i = 0; i < rawGray.length; i++) {
    const p = i * 4;
    const lum = Math.round(
      0.299 * srcData[p] + 0.587 * srcData[p + 1] + 0.114 * srcData[p + 2],
    );
    rawGray[i] = lum;
    totalLuma += lum;
  }
  const averageLuminance = Math.round(totalLuma / Math.max(1, rawGray.length));

  // Fast coarse shadow normalization
  const bgW = Math.max(10, Math.round(w / 16));
  const bgH = Math.max(8, Math.round(h / 16));
  const bgSmallCanvas = document.createElement('canvas');
  bgSmallCanvas.width = bgW;
  bgSmallCanvas.height = bgH;
  const bgSmallCtx = bgSmallCanvas.getContext('2d');
  const bgFullCanvas = document.createElement('canvas');
  bgFullCanvas.width = w;
  bgFullCanvas.height = h;
  const bgFullCtx = bgFullCanvas.getContext('2d');

  let normalizedGray = rawGray;
  if (bgSmallCtx && bgFullCtx) {
    const grayCanvas = grayBufferToCanvas(rawGray, w, h);
    bgSmallCtx.drawImage(grayCanvas, 0, 0, bgW, bgH);
    bgFullCtx.imageSmoothingEnabled = true;
    bgFullCtx.drawImage(bgSmallCanvas, 0, 0, w, h);
    const bgPixels = bgFullCtx.getImageData(0, 0, w, h).data;
    normalizedGray = new Uint8ClampedArray(w * h);
    for (let i = 0; i < normalizedGray.length; i++) {
      const bg = Math.max(24, bgPixels[i * 4]);
      const v = Math.round((rawGray[i] / bg) * 168);
      normalizedGray[i] = v > 255 ? 255 : v;
    }
  }

  const enhancedGray = applyFastContrastAndSharpen(normalizedGray, w, h);
  const enhancedFullCanvas = grayBufferToCanvas(enhancedGray, w, h);
  const enhancedFullDataUrl = enhancedFullCanvas.toDataURL('image/jpeg', 0.85);

  const cropX = Math.round(w * 0.08);
  const cropY = Math.round(h * 0.2);
  const cropW = Math.max(60, Math.round(w * 0.84));
  const cropH = Math.max(40, Math.round(h * 0.6));
  const zoomW = Math.min(760, Math.round(cropW * 1.5));
  const zoomH = Math.min(480, Math.round(cropH * 1.5));

  const zoomedGrayCanvas = document.createElement('canvas');
  zoomedGrayCanvas.width = zoomW;
  zoomedGrayCanvas.height = zoomH;
  const zCtx = zoomedGrayCanvas.getContext('2d', { willReadFrequently: true });
  let zoomedBwCanvas = zoomedGrayCanvas;
  if (zCtx) {
    zCtx.imageSmoothingEnabled = true;
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
  const zoomedBwDataUrl = zoomedBwCanvas.toDataURL('image/jpeg', 0.86);

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
      reason: `الاستهلاك المحسوب (${Math.round(diff * 100) / 100} ك.و.س) أكبر بكثير من المعتاد (${Math.round(avg)} ك.و.س) — يرجى التحقق من الرقم.`,
    };
  }

  if (
    diff > 25000 ||
    (params.previousReading >= 100 && diff > Math.max(params.previousReading * 4, 12000))
  ) {
    return {
      illogical: true,
      reason: `القراءة المقروءة (${params.reading}) بعيدة جداً عن السابقة (${params.previousReading}) — يرجى التحقق من الرقم.`,
    };
  }

  return { illogical: false };
}

function evaluateConsensus(params: {
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
      message: 'لم يتم التعرف على أرقام عداد في الصورة.',
    };
  }

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

  const highSingleConfidence =
    validPasses.length === 1 && avgConfidence >= 88;
  const hasConsensus = agreementCount >= 2 || highSingleConfidence;

  if (consensusReading === null || !hasConsensus) {
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
      message: 'الصورة غير واضحة لقراءة الرقم — أعد التصوير أو أدخل القراءة يدوياً.',
    };
  }

  if (avgConfidence < 82) {
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
      message: 'الأرقام غير واضحة بما يكفي — أعد التصوير أو أدخل القراءة يدوياً.',
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
      const cloudRes = await fetch(
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
      );

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
          label: i === 0 ? 'قراءة 1' : 'قراءة 2',
          reading: p.reading,
          rawDigits: p.rawDigits,
          confidence: p.confidence,
        }));

        const validCloud = cloudPasses.filter((p) => p.reading !== null);
        // Fast fail when there is no meter in the image at all
        if (validCloud.length === 0) {
          return evaluateConsensus({
            passes: cloudPasses,
            previousReading: params.previousReading,
            avg3MonthsKwh: params.avg3MonthsKwh,
            enhancedPreviewUrl: variants.enhancedFullDataUrl,
            zoomedBwPreviewUrl: variants.zoomedBwDataUrl,
            lowLightDetected,
            engineMode: 'hybrid',
          });
        }

        // Fast accept when cloud passes already agree cleanly
        const fastEval = evaluateConsensus({
          passes: cloudPasses,
          previousReading: params.previousReading,
          avg3MonthsKwh: params.avg3MonthsKwh,
          enhancedPreviewUrl: variants.enhancedFullDataUrl,
          zoomedBwPreviewUrl: variants.zoomedBwDataUrl,
          lowLightDetected,
          engineMode: 'hybrid',
        });
        if (fastEval.accepted) {
          return fastEval;
        }

        // Tie-breaker pass locally only if cloud passes conflicted
        const tiePass = await runSingleTesseractPass(
          variants.zoomedBwCanvas,
          params.previousReading,
          PSM.SINGLE_LINE,
          'tesseract-tie',
          'قراءة 3',
        );
        return evaluateConsensus({
          passes: [...cloudPasses, tiePass],
          previousReading: params.previousReading,
          avg3MonthsKwh: params.avg3MonthsKwh,
          enhancedPreviewUrl: variants.enhancedFullDataUrl,
          zoomedBwPreviewUrl: variants.zoomedBwDataUrl,
          lowLightDetected,
          engineMode: 'hybrid',
        });
      }
    } catch {
      // Fall back to offline Tesseract OCR
    }
  }

  // Offline / Fallback: run fast cropped ROI passes
  const pass1 = await runSingleTesseractPass(
    variants.zoomedGrayCanvas,
    params.previousReading,
    PSM.SINGLE_LINE,
    'tesseract-zoomed-gray',
    'قراءة 1',
  );
  const pass2 = await runSingleTesseractPass(
    variants.zoomedBwCanvas,
    params.previousReading,
    PSM.SINGLE_LINE,
    'tesseract-zoomed-bw',
    'قراءة 2',
  );

  // Fast fail if neither cropped pass sees digits
  if (pass1.reading === null && pass2.reading === null) {
    return evaluateConsensus({
      passes: [pass1, pass2],
      previousReading: params.previousReading,
      avg3MonthsKwh: params.avg3MonthsKwh,
      enhancedPreviewUrl: variants.enhancedFullDataUrl,
      zoomedBwPreviewUrl: variants.zoomedBwDataUrl,
      lowLightDetected,
      engineMode: 'offline',
    });
  }

  // Fast accept if both match
  if (
    pass1.reading !== null &&
    pass2.reading !== null &&
    pass1.reading.toFixed(2) === pass2.reading.toFixed(2)
  ) {
    return evaluateConsensus({
      passes: [pass1, pass2],
      previousReading: params.previousReading,
      avg3MonthsKwh: params.avg3MonthsKwh,
      enhancedPreviewUrl: variants.enhancedFullDataUrl,
      zoomedBwPreviewUrl: variants.zoomedBwDataUrl,
      lowLightDetected,
      engineMode: 'offline',
    });
  }

  const pass3 = await runSingleTesseractPass(
    variants.enhancedFullCanvas,
    params.previousReading,
    PSM.SINGLE_BLOCK,
    'tesseract-enhanced-full',
    'قراءة 3',
  );

  return evaluateConsensus({
    passes: [pass1, pass2, pass3],
    previousReading: params.previousReading,
    avg3MonthsKwh: params.avg3MonthsKwh,
    enhancedPreviewUrl: variants.enhancedFullDataUrl,
    zoomedBwPreviewUrl: variants.zoomedBwDataUrl,
    lowLightDetected,
    engineMode: 'offline',
  });
}
