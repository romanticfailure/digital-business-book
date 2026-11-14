import { createWorker } from 'tesseract.js'

type OcrWorker = Awaited<ReturnType<typeof createWorker>>
type WorkerParams = Parameters<OcrWorker['setParameters']>[0]

type PassResult = { text: string; confidence: number }

type Prepared = {
  width: number
  height: number
  gray: Uint8ClampedArray
  enhanced: Blob
  binary: Blob
}

// Phone photos are far larger than Tesseract needs; very small images are too blurry.
const MAX_SIDE = 2400
const MIN_SIDE = 1600

// Tesseract page segmentation modes: 3 = automatic layout, 11 = sparse text.
const PSM_AUTO = '3'
const PSM_SPARSE = '11'

// Confidence (0-100) at which a result is good enough to stop, or bad enough to try harder.
const GOOD_CONFIDENCE = 85
const POOR_CONFIDENCE = 60

/* ---------- Image preparation ---------- */

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()

    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Не удалось открыть изображение. Попробуй другое фото.'))
    }

    img.src = url
  })
}

// Drawing through <img> + canvas applies the EXIF orientation of phone photos.
function drawScaled(img: HTMLImageElement) {
  const longest = Math.max(img.naturalWidth, img.naturalHeight)

  if (!longest) {
    throw new Error('Не удалось открыть изображение. Попробуй другое фото.')
  }

  const scale =
    longest > MAX_SIDE ? MAX_SIDE / longest
    : longest < MIN_SIDE ? MIN_SIDE / longest
    : 1

  const width = Math.round(img.naturalWidth * scale)
  const height = Math.round(img.naturalHeight * scale)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  if (!ctx) {
    throw new Error('Браузер не поддерживает обработку изображений.')
  }

  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(img, 0, 0, width, height)

  return { width, height, data: ctx.getImageData(0, 0, width, height) }
}

function toGray(image: ImageData): Uint8ClampedArray {
  const pixels = image.width * image.height
  const gray = new Uint8ClampedArray(pixels)
  const rgba = image.data

  for (let i = 0, j = 0; i < pixels; i++, j += 4) {
    gray[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000
  }

  return gray
}

// Stretches the 1st-99th brightness percentiles to the full range (fixes dull, grey photos).
function stretchContrast(gray: Uint8ClampedArray) {
  const histogram = new Uint32Array(256)

  for (let i = 0; i < gray.length; i++) {
    histogram[gray[i]]++
  }

  const lowTarget = gray.length * 0.01
  const highTarget = gray.length * 0.99

  let low = 0
  let high = 255
  let sum = 0

  for (let v = 0; v < 256; v++) {
    sum += histogram[v]
    if (sum >= lowTarget) {
      low = v
      break
    }
  }

  sum = 0

  for (let v = 0; v < 256; v++) {
    sum += histogram[v]
    if (sum >= highTarget) {
      high = v
      break
    }
  }

  if (high - low < 20) return

  const factor = 255 / (high - low)

  for (let i = 0; i < gray.length; i++) {
    gray[i] = (gray[i] - low) * factor
  }
}

// Tesseract expects dark text on a light background; flip light-on-dark cards.
function normalizePolarity(gray: Uint8ClampedArray) {
  let total = 0

  for (let i = 0; i < gray.length; i++) {
    total += gray[i]
  }

  if (total / gray.length >= 110) return

  for (let i = 0; i < gray.length; i++) {
    gray[i] = 255 - gray[i]
  }
}

// Local-mean binarization: copes with shadows and uneven light on phone photos.
function adaptiveThreshold(gray: Uint8ClampedArray, width: number, height: number) {
  const stride = width + 1
  const integral = new Uint32Array(stride * (height + 1))

  for (let y = 0; y < height; y++) {
    let rowSum = 0

    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x]
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum
    }
  }

  const radius = Math.max(12, Math.round(Math.min(width, height) / 24))
  const output = new Uint8ClampedArray(gray.length)

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius)
    const y1 = Math.min(height - 1, y + radius)

    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)

      const area = (x1 - x0 + 1) * (y1 - y0 + 1)
      const sum =
        integral[(y1 + 1) * stride + x1 + 1] -
        integral[y0 * stride + x1 + 1] -
        integral[(y1 + 1) * stride + x0] +
        integral[y0 * stride + x0]

      const index = y * width + x
      output[index] = gray[index] < (sum / area) * 0.88 ? 0 : 255
    }
  }

  return output
}

function rotateGray(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  clockwise: boolean
) {
  const rotated = new Uint8ClampedArray(gray.length)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const newX = clockwise ? height - 1 - y : y
      const newY = clockwise ? x : width - 1 - x
      rotated[newY * height + newX] = gray[y * width + x]
    }
  }

  return { gray: rotated, width: height, height: width }
}

function grayToBlob(gray: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')

  if (!ctx) {
    return Promise.reject(new Error('Браузер не поддерживает обработку изображений.'))
  }

  const image = ctx.createImageData(width, height)
  const out = image.data

  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    out[j] = gray[i]
    out[j + 1] = gray[i]
    out[j + 2] = gray[i]
    out[j + 3] = 255
  }

  ctx.putImageData(image, 0, 0)

  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) {
        resolve(blob)
      } else {
        reject(new Error('Не удалось подготовить изображение.'))
      }
    }, 'image/png')
  })
}

async function prepareImages(file: File): Promise<Prepared> {
  const img = await loadImage(file)
  const { width, height, data } = drawScaled(img)

  const gray = toGray(data)
  stretchContrast(gray)
  normalizePolarity(gray)

  const enhanced = await grayToBlob(gray, width, height)
  const binary = await grayToBlob(adaptiveThreshold(gray, width, height), width, height)

  return { width, height, gray, enhanced, binary }
}

/* ---------- Recognition ---------- */

// More confident results with more real text win.
function score(result: PassResult) {
  const characters = (result.text.match(/[\p{L}\p{N}]/gu) ?? []).length
  return result.confidence * Math.sqrt(characters)
}

function pickBest(results: PassResult[]) {
  return results.reduce((best, current) => (score(current) > score(best) ? current : best))
}

/**
 * Reads the text from a business card photo.
 *
 * 1. Prepares the image (orientation, size, contrast, shadows).
 * 2. Recognizes with German + English only, so Latin text is not mixed up
 *    with look-alike Cyrillic letters.
 * 3. If the result is weak: tries a binarized copy, then rotated copies,
 *    then Russian/Ukrainian, and keeps the best result.
 */
export async function recognizeBusinessCard(
  file: File,
  onProgress: (percent: number) => void,
  onStage: (message: string) => void
): Promise<string> {
  onStage('Подготавливаем изображение...')
  const prepared = await prepareImages(file)

  let planned = 2
  let done = 0
  let passProgress = 0
  let lastReported = 0

  const report = () => {
    const percent = Math.min(99, Math.round(((done + passProgress) / planned) * 100))
    lastReported = Math.max(lastReported, percent)
    onProgress(lastReported)
  }

  const openWorker = (languages: string) =>
    createWorker(languages, 1, {
      logger: info => {
        if (info.status === 'recognizing text') {
          passProgress = info.progress
          report()
        }
      },
    })

  const runPass = async (worker: OcrWorker, image: Blob, psm: string): Promise<PassResult> => {
    passProgress = 0
    await worker.setParameters({ tessedit_pageseg_mode: psm } as WorkerParams)

    const { data } = await worker.recognize(image)

    done += 1
    passProgress = 0
    report()

    return { text: data.text, confidence: data.confidence }
  }

  const results: PassResult[] = []

  const latinWorker = await openWorker('deu+eng')

  try {
    onStage('Распознаём текст...')
    results.push(await runPass(latinWorker, prepared.enhanced, PSM_AUTO))

    if (pickBest(results).confidence < GOOD_CONFIDENCE) {
      onStage('Уточняем результат...')
      results.push(await runPass(latinWorker, prepared.binary, PSM_SPARSE))
    }

    if (pickBest(results).confidence < POOR_CONFIDENCE) {
      onStage('Проверяем поворот фото...')
      planned = done + 2

      for (const clockwise of [true, false]) {
        const rotated = rotateGray(prepared.gray, prepared.width, prepared.height, clockwise)
        const blob = await grayToBlob(rotated.gray, rotated.width, rotated.height)
        results.push(await runPass(latinWorker, blob, PSM_AUTO))
      }
    }
  } finally {
    await latinWorker.terminate()
  }

  if (pickBest(results).confidence < POOR_CONFIDENCE) {
    onStage('Пробуем другие языки...')
    planned = done + 1

    const cyrillicWorker = await openWorker('rus+ukr+eng')

    try {
      results.push(await runPass(cyrillicWorker, prepared.enhanced, PSM_AUTO))
    } finally {
      await cyrillicWorker.terminate()
    }
  }

  return pickBest(results).text
}
