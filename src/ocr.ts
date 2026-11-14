import { createWorker } from 'tesseract.js'

type OcrWorker = Awaited<ReturnType<typeof createWorker>>
type WorkerParams = Parameters<OcrWorker['setParameters']>[0]

type Candidate = {
  text: string
  confidence: number
  // How much contact information was found in the text (see `rate` below)
  signal: number
}

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

// Tesseract confidence (0-100) that counts as a clean read.
const GOOD_CONFIDENCE = 85

// Contact signal: at least an email, a phone number or a proper name was found.
const FOUND_SIGNAL = 2
// Contact signal: e.g. email + phone, or email + name. No need to look further.
const COMPLETE_SIGNAL = 5

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
      reject(new Error('Could not open the image. Please try another photo.'))
    }

    img.src = url
  })
}

// Drawing through <img> + canvas applies the EXIF orientation of phone photos.
function drawScaled(img: HTMLImageElement) {
  const longest = Math.max(img.naturalWidth, img.naturalHeight)

  if (!longest) {
    throw new Error('Could not open the image. Please try another photo.')
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
    throw new Error('Your browser does not support image processing.')
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
    return Promise.reject(new Error('Your browser does not support image processing.'))
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
        reject(new Error('Could not prepare the image.'))
      }
    }, 'image/png')
  })
}

async function prepareImages(file: File): Promise<Prepared> {
  const img = await loadImage(file)
  const { width, height, data } = drawScaled(img)

  // Note: light-on-dark cards are NOT inverted here. A photo with a dark table
  // around a normal card would be flipped by mistake, and Tesseract 5 already
  // tries the inverted image on its own.
  const gray = toGray(data)
  stretchContrast(gray)

  const enhanced = await grayToBlob(gray, width, height)
  const binary = await grayToBlob(adaptiveThreshold(gray, width, height), width, height)

  return { width, height, gray, enhanced, binary }
}

/* ---------- Recognition ---------- */

// Real words and numbers count; stray specks and punctuation from noise do not.
function textScore(candidate: Candidate) {
  const tokens = candidate.text.match(/\p{L}{3,}|\d{3,}/gu) ?? []
  return candidate.confidence * Math.sqrt(tokens.join('').length)
}

// More contact information wins first; then a cleaner, longer read.
function isBetter(a: Candidate, b: Candidate) {
  return a.signal !== b.signal ? a.signal > b.signal : textScore(a) > textScore(b)
}

function pickBest(candidates: Candidate[]) {
  return candidates.reduce((best, current) => (isBetter(current, best) ? current : best))
}

/**
 * Reads the text from a business card photo.
 *
 * 1. Prepares the image (orientation, size, contrast, shadows).
 * 2. Recognizes with German + English only, so Latin text is not mixed up
 *    with look-alike Cyrillic letters.
 * 3. Unless the result already holds the contact details: tries a binarized
 *    copy, then rotated copies, then Russian/Ukrainian. Every extra attempt is
 *    optional: if one fails, the best result so far is kept.
 *
 * `rate` scores how much contact information (email, phone, name...) a text
 * contains, so the best attempt wins by what matters, not by text length.
 */
export async function recognizeBusinessCard(
  file: File,
  onProgress: (percent: number) => void,
  onStage: (message: string) => void,
  rate: (text: string) => number
): Promise<string> {
  onStage('Preparing the image...')

  // If preparation fails for any reason, fall back to the original photo.
  const prepared: Prepared | null = await prepareImages(file).catch(error => {
    console.warn('Image preparation failed, using the original photo', error)
    return null
  })

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

  const runPass = async (worker: OcrWorker, image: Blob, psm: string): Promise<Candidate> => {
    passProgress = 0
    await worker.setParameters({ tessedit_pageseg_mode: psm } as WorkerParams)

    const { data } = await worker.recognize(image)

    done += 1
    passProgress = 0
    report()

    return { text: data.text, confidence: data.confidence, signal: rate(data.text) }
  }

  const results: Candidate[] = []

  const attempt = async (job: () => Promise<Candidate>) => {
    try {
      results.push(await job())
    } catch (error) {
      console.warn('A recognition pass failed', error)
    }
  }

  const bestSignal = () => (results.length ? pickBest(results).signal : 0)

  const isGoodEnough = () => {
    if (!results.length) return false

    const best = pickBest(results)

    return (
      best.signal >= COMPLETE_SIGNAL ||
      (best.confidence >= GOOD_CONFIDENCE && best.signal >= FOUND_SIGNAL)
    )
  }

  let latinWorker: OcrWorker

  try {
    latinWorker = await openWorker('deu+eng')
  } catch (error) {
    console.warn('Could not start text recognition', error)
    throw new Error('Could not load the text recognition data. Check your internet connection and try again.')
  }

  try {
    onStage('Reading the text...')
    await attempt(() => runPass(latinWorker, prepared ? prepared.enhanced : file, PSM_AUTO))

    // The prepared image failed: try the untouched photo.
    if (!results.length && prepared) {
      await attempt(() => runPass(latinWorker, file, PSM_AUTO))
    }

    if (prepared && !isGoodEnough()) {
      onStage('Refining the result...')
      await attempt(() => runPass(latinWorker, prepared.binary, PSM_SPARSE))
    }

    // Nothing useful found: the card may have been photographed sideways.
    if (prepared && bestSignal() < FOUND_SIGNAL) {
      onStage('Checking photo rotation...')
      planned = done + 2

      for (const clockwise of [true, false]) {
        await attempt(async () => {
          const rotated = rotateGray(prepared.gray, prepared.width, prepared.height, clockwise)
          const blob = await grayToBlob(rotated.gray, rotated.width, rotated.height)
          return runPass(latinWorker, blob, PSM_AUTO)
        })
      }
    }
  } finally {
    await latinWorker.terminate()
  }

  // Still nothing: the card may be in Russian or Ukrainian.
  if (results.length && bestSignal() < FOUND_SIGNAL) {
    onStage('Trying other languages...')
    planned = done + 1

    try {
      const cyrillicWorker = await openWorker('rus+ukr+eng')

      try {
        await attempt(() => runPass(cyrillicWorker, prepared ? prepared.enhanced : file, PSM_AUTO))
      } finally {
        await cyrillicWorker.terminate()
      }
    } catch (error) {
      console.warn('Could not run the additional languages', error)
    }
  }

  if (!results.length) {
    throw new Error('Text recognition failed. Please try again or use another photo.')
  }

  return pickBest(results).text
}
