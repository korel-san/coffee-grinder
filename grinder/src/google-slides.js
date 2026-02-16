import Slides from '@googleapis/slides'
import { nanoid } from 'nanoid'

import { log } from './log.js'
import { sleep } from './sleep.js'
import { auth } from './google-auth.js'
import { copyFile, moveFile, getFile } from './google-drive.js'
import {
  rootFolderId,
  presentationName,
  autoPresentationName,
  templatePresentationId,
  templateSlideId,
  templateTableId,
  archiveFolderId,
  autoArchiveFolderId
} from '../config/google-drive.js'

const argvIndexParam = 2
const isAutoMode = () => process.argv[argvIndexParam]?.endsWith('auto')

function activePresentationName() {
	return isAutoMode() ? autoPresentationName : presentationName
}

function activeArchiveFolderId() {
	return isAutoMode() ? autoArchiveFolderId : archiveFolderId
}

let slides, presentationId
let resolvedTemplateSlideId
let resolvedTemplateTableId
let resolvedTemplateSlidesCount
let resolvedTemplatePlaceholderCells

async function resolveTemplateSlideId() {
	if (resolvedTemplateSlideId) return resolvedTemplateSlideId
	if (templateSlideId) {
		resolvedTemplateSlideId = templateSlideId
		return resolvedTemplateSlideId
	}

	const presentationIdParam = templatePresentationId
	const response = await slides.presentations.get({ presentationId: presentationIdParam })
	const templateSlides = response.data?.slides
	if (resolvedTemplateSlidesCount === undefined && Array.isArray(templateSlides)) {
		resolvedTemplateSlidesCount = templateSlides.length
	}
	const firstSlideId = templateSlides?.[0]?.objectId
	if (!firstSlideId) {
		throw new Error('Template presentation has no slides to infer template slide id')
	}
	resolvedTemplateSlideId = firstSlideId
	return resolvedTemplateSlideId
}

async function resolveTemplateTableId() {
	if (resolvedTemplateTableId) return resolvedTemplateTableId
	if (templateTableId) {
		resolvedTemplateTableId = templateTableId
		return resolvedTemplateTableId
	}

	const presentationIdParam = templatePresentationId
	const slideIdParam = await resolveTemplateSlideId()
	const response = await slides.presentations.get({ presentationId: presentationIdParam })
	if (resolvedTemplateSlidesCount === undefined && Array.isArray(response.data?.slides)) {
		resolvedTemplateSlidesCount = response.data.slides.length
	}
	const slide = response.data?.slides?.find(s => s.objectId === slideIdParam)
	const template = slide ?? response.data?.slides?.[0]
	const table = template?.pageElements?.find(e => e.table && e.objectId)
	if (!table?.objectId) {
		throw new Error(`Template slide ${slideIdParam} has no table object to duplicate`)
	}

	resolvedTemplateTableId = table.objectId
	return resolvedTemplateTableId
}

function readCellText(cell) {
	const textElements = cell?.text?.textElements || []
	let out = ''
	for (const part of textElements) {
		out += part?.textRun?.content || ''
	}
	return out
}

async function resolveTemplatePlaceholderCells() {
	if (resolvedTemplatePlaceholderCells) return resolvedTemplatePlaceholderCells

	const presentationIdParam = templatePresentationId
	const slideIdParam = await resolveTemplateSlideId()
	const tableIdParam = await resolveTemplateTableId()
	const response = await slides.presentations.get({ presentationId: presentationIdParam })
	if (resolvedTemplateSlidesCount === undefined && Array.isArray(response.data?.slides)) {
		resolvedTemplateSlidesCount = response.data.slides.length
	}
	const slide = response.data?.slides?.find(s => s.objectId === slideIdParam) ?? response.data?.slides?.[0]
	const table = slide?.pageElements?.find(e => e.objectId === tableIdParam && e.table)?.table

	const placeholders = ['{{title}}', '{{videos}}', '{{notes}}']
	const out = {}
	for (let rowIndex = 0; rowIndex < (table?.tableRows?.length || 0); rowIndex++) {
		const row = table.tableRows[rowIndex]
		for (let columnIndex = 0; columnIndex < (row?.tableCells?.length || 0); columnIndex++) {
			const cell = row.tableCells[columnIndex]
			const cellText = readCellText(cell)
			for (const placeholder of placeholders) {
				if (!out[placeholder] && cellText.includes(placeholder)) {
					out[placeholder] = { rowIndex, columnIndex }
				}
			}
		}
	}

	resolvedTemplatePlaceholderCells = out
	return resolvedTemplatePlaceholderCells
}

// ???????????????????? ?????????????? write-???????????????? ?? Slides API
// ??????????: ?????????? ?????????????? ???? ?????????????? ????????, ?? ???? ???????????? ???? ??????????????.
const limiterState = {
  nextAllowedAtMs: 0,
  // ?????????????? ???????????????? ?????????? batchUpdate (????????????????????????????)
  minDelayMs: 1600
}

async function waitForWriteSlot() {
  const nowMs = Date.now()
  const waitMs = Math.max(0, limiterState.nextAllowedAtMs - nowMs)
  if (waitMs > 0) {
    const sleepMsParam = waitMs
    await sleep(sleepMsParam)
  }
}

function markWriteDone() {
  const nowMs = Date.now()
  limiterState.nextAllowedAtMs = nowMs + limiterState.minDelayMs
}

function getRetryAfterMs(e) {
  const headers = e?.response?.headers
  if (!headers) return 0

  // gaxios ?????????? ???????????? ?????????? ?? ???????????? ????????????????
  const retryAfterRaw = headers['retry-after'] ?? headers['Retry-After'] ?? headers['RETRY-AFTER']
  if (!retryAfterRaw) return 0

  const retryAfterSeconds = Number(retryAfterRaw)
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return 0
  return Math.floor(retryAfterSeconds * 1000)
}

function sanitizeFieldValue(value) {
	if (value === undefined || value === null) return ''

	const text = String(value).trim()
	const cleaned = text.replace(/\{\{\s*[^{}]+\s*\}\}/g, '').trim()
	if (!cleaned || /^\{\{\s*[^{}]+\s*\}$/.test(cleaned)) {
		return ''
	}
	return cleaned
}

function replaceWithDefault(value) {
	const normalized = sanitizeFieldValue(value)
	return normalized || '\u200B'
}

function isYoutubeUrl(value) {
	if (!value) return false
	try {
		const host = new URL(String(value).trim()).hostname.toLowerCase().replace(/^www\./, '')
		return host === 'youtube.com'
			|| host.endsWith('.youtube.com')
			|| host === 'youtu.be'
			|| host === 'youtube-nocookie.com'
			|| host.endsWith('.youtube-nocookie.com')
	} catch {
		return false
	}
}

function parseVideoLinks(value) {
	const text = String(value ?? '').trim()
	if (!text) return { text: '', links: [] }

	const urls = []
	const seen = new Set()
	const matches = text.match(/https?:\/\/[^\s]+/g) || []
	for (let raw of matches) {
		const clean = String(raw).replace(/[),.;!?]+$/g, '')
		if (!clean || seen.has(clean)) continue
		seen.add(clean)
		urls.push(clean)
	}
	if (urls.length) {
		const sortedUrls = urls.filter(isYoutubeUrl)
		if (!sortedUrls.length) return { text: '', links: [] }

		let offset = 0
		const links = sortedUrls.map(url => {
			const start = offset
			const end = start + url.length
			offset = end + 1
			return { url, start, end }
		})
		return { text: sortedUrls.join('\n'), links }
	}
	return { text: '', links: [] }
}

function formatFactsForSlide(value) {
	const text = String(value ?? '').replace(/\r/g, '').trim()
	if (!text) return ''

	const lines = text
		.split('\n')
		.map(s => s.trim())
		.filter(Boolean)

	const outLines = []

	for (const rawLine of lines) {
		const line = rawLine.replace(/^[•*\-\u2022]+\s*/, '').trim()
		if (!line) continue

		let fact = line
		let url = ''
		if (line.includes('||')) {
			const [factPart, ...rest] = line.split('||')
			fact = String(factPart ?? '').trim()
			url = String(rest.join('||') ?? '').trim()
		} else {
			const firstUrlMatch = line.match(/https?:\/\/\S+/i)
			if (firstUrlMatch) {
				url = String(firstUrlMatch[0]).replace(/[),.;!?]+$/g, '').trim()
				fact = line.replace(firstUrlMatch[0], '').replace(/\s+/g, ' ').trim()
			}
		}

		if (!fact) continue
		outLines.push(`• ${fact}`)
	}

	return outLines.join('\n')
}

function isRateLimitError(e) {
  const status = e?.response?.status ?? e?.status
  const reason = e?.errors?.[0]?.reason
  return status === 429 || reason === 'rateLimitExceeded'
}

function jitterMs(maxJitterMs) {
  const maxParam = maxJitterMs
  return Math.floor(Math.random() * maxParam)
}

async function initialize() {
	const slidesVersionParam = 'v1'
	const authParam = auth
	const slidesInitParams = { version: slidesVersionParam, auth: authParam }

	slides = await Slides.slides(slidesInitParams)

	const activeName = activePresentationName()
	const rootFolderIdParam = rootFolderId
	const fileNameParam = activeName
	const existingFile = await getFile(rootFolderIdParam, fileNameParam)

	presentationId = existingFile?.id
}
let init = initialize()

export async function archivePresentation(name) {
  await init
  if (!presentationId) return

	log('Archiving presentation...')
	const fileIdParam = presentationId
	const targetFolderIdParam = activeArchiveFolderId()
	const newNameParam = name

  await moveFile(fileIdParam, targetFolderIdParam, newNameParam)
  presentationId = null
}

export async function presentationExists() {
  await init
  return presentationId
}

export async function createPresentation() {
	await init
	if (!presentationId) {
		const presentationName = activePresentationName()
		if (!presentationName) {
			throw new Error('Missing presentation name for current run mode')
		}
		const existingFile = await getFile(rootFolderId, presentationName)
		if (existingFile?.id) {
			presentationId = existingFile.id
			return presentationId
		}

		log('Creating presentation...\n')

		const srcFileIdParam = templatePresentationId
		const dstFolderIdParam = rootFolderId
		const dstNameParam = presentationName

		const copied = await copyFile(srcFileIdParam, dstFolderIdParam, dstNameParam)
		presentationId = copied.id
	}
	return presentationId
}

export async function addSlide(event) {
  await init

  // ???? ???????????? ????????????: ???????? ?????????????????????? ?????? ??????, ??????????????
  const createdPresentationId = await createPresentation()
  presentationId = createdPresentationId

  const newSlideId = 's' + nanoid()
  const newTableId = 't' + nanoid()

  const title = `${event.titleEn || event.titleRu || ''}`
  const linkUrl = event.usedUrl || event.directUrl || event.url || ''
  const titleWithSource = [title, linkUrl].filter(Boolean).join('\n')
  const videosPayload = parseVideoLinks(event.videoUrls)
  const factsText = formatFactsForSlide(event.factsRu || event.notes)

  // ???????????? ????????????
  const replaceMap = {
    '{{title}}': replaceWithDefault(titleWithSource),
    '{{summary}}': replaceWithDefault(event.summary),
    '{{videos}}': replaceWithDefault(videosPayload.text),
    '{{sqk}}': replaceWithDefault(event.sqk),
    '{{priority}}': replaceWithDefault(event.priority),
    '{{notes}}': replaceWithDefault(factsText)
  }

  // ??????????:
  // 1) ?????????????? duplicateObject ?? ?????????????????? templateTableId -> newTableId
  // 2) ?????????? updateTextStyle ???? newTableId
  // 3) updateSlidesPosition ???????????? ?????????????? newSlideId, ?? ???? templateSlideId
  const templateSlideObjectId = await resolveTemplateSlideId()
  const templateTableObjectId = await resolveTemplateTableId()
  const templatePlaceholderCells = await resolveTemplatePlaceholderCells()

  const baseSlidesCount = Number(resolvedTemplateSlidesCount || 0)
  const sqkNumber = Number(event.sqk || 0)
  const insertionIndex = (Number.isFinite(baseSlidesCount) && Number.isFinite(sqkNumber) && sqkNumber >= 3)
    ? baseSlidesCount + (sqkNumber - 3)
    : Math.max(0, baseSlidesCount || 0)

  const objectIds = {
    [templateSlideObjectId]: newSlideId,
    [templateTableObjectId]: newTableId
  }
  const titleCell = templatePlaceholderCells?.['{{title}}'] || null
  const videosCell = templatePlaceholderCells?.['{{videos}}'] || null

  const requests = [
    {
      duplicateObject: {
        objectId: templateSlideObjectId,
        objectIds: {
          ...objectIds
        }
      }
    },
    ...Object.entries(replaceMap).map(([key, value]) => ({
      replaceAllText: {
        containsText: { text: key },
        replaceText: String(value ?? ''),
        // Scope to the newly created slide (avoid touching existing slides).
        pageObjectIds: [newSlideId]
      }
    })),
		...((titleCell && titleWithSource && linkUrl) ? [{
			updateTextStyle: {
				fields: 'link',
				objectId: newTableId,
				cellLocation: {
					rowIndex: titleCell.rowIndex,
					columnIndex: titleCell.columnIndex
				},
				textRange: {
					type: 'FIXED_RANGE',
					startIndex: title ? title.length + 1 : 0,
					endIndex: (title ? title.length + 1 : 0) + linkUrl.length
				},
				style: {
					link: {
						url: linkUrl
					}
				}
			}
		}] : []),
		...((videosCell && videosPayload.links.length) ? videosPayload.links.map(link => ({
			updateTextStyle: {
				fields: 'link',
				objectId: newTableId,
				cellLocation: {
					rowIndex: videosCell.rowIndex,
					columnIndex: videosCell.columnIndex
				},
				textRange: {
					type: 'FIXED_RANGE',
					startIndex: link.start,
					endIndex: link.end
				},
				style: {
					link: {
						url: link.url
					}
				}
			}
		})) : []),
    {
      replaceAllText: {
        containsText: { text: `{{cat${event.topicId}_card${event.topicSqk}}}` },
        replaceText: String(`${event.sqk ?? ''} ${title}`),
        // ?????? pageObjectIds: ?????????????????? ?????????? ?????????????????/???????????????????????, ???????? ???? ???????? ?? ??????????????????????
      }
    },
    {
      updateSlidesPosition: {
        slideObjectIds: [newSlideId],
        // insertionIndex ???????????? ???????? int >= 0
        insertionIndex: Math.max(0, insertionIndex)
      }
    }
  ]

  // ???????????? ?? backoff ???? 429
  const maxAttempts = 6
  let backoffMs = 2000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await waitForWriteSlot()

      const presentationIdParam = presentationId
      const requestBodyParam = { requests }
      const batchUpdateParams = {
        presentationId: presentationIdParam,
        requestBody: requestBodyParam
      }

      await slides.presentations.batchUpdate(batchUpdateParams)

      // ???????????????? ???????????????? write, ?????????? ???????????????????? ???????????????? ???????? ?????? ????????????
      markWriteDone()
      return
    } catch (e) {
      log(e)

      // ???????? ?????? ???? 429, ???? ???????????? ???????????? ??????????????
      if (!isRateLimitError(e)) {
        throw e
      }

      // ???? 429: Retry-After ???????? ????????, ?????????? backoff
      const retryAfterMs = getRetryAfterMs(e)
      const jitterParam = 500
      const delayMs = Math.max(retryAfterMs, backoffMs) + jitterMs(jitterParam)

      const sleepMsParam = delayMs
      await sleep(sleepMsParam)

      // ?????????????????????? backoff, ???? ????????????????????????
      backoffMs = Math.min(backoffMs * 2, 120000)

      // ?????????????????????????? ???????? ???????????????????????????? ??????????????????, ?????????? ???????? ???????????? 429
      limiterState.minDelayMs = Math.min(Math.max(limiterState.minDelayMs, 1600) + 250, 5000)
    }
  }

  // ???????? ?????????? ????????, ???????????? ?????? ?????????????? ??????????????????
  throw new Error('???? ?????????????? ???????????????? ??????????: ???????????????????? rate limit (429).')
}

if (process.argv[1].endsWith('google-slides')) {
  // ?????????? ?????????? ???????????????? ?????????????? ?????? ??????????????????????????
}
