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
  autoArchiveFolderId,
  coffeeTodayFolderId
} from '../config/google-drive.js'

// Режим auto
const argvIndexParam = 2
const argvValueParam = process.argv[argvIndexParam]
const isAuto = argvValueParam?.endsWith('auto')

const activePresentationName = isAuto ? autoPresentationName : presentationName
const activeArchiveFolderId = isAuto ? autoArchiveFolderId : archiveFolderId

let slides, presentationId

// Глобальный лимитер write-запросов к Slides API
// Важно: лимит считать по успехам тоже, а не только по ошибкам.
const limiterState = {
  nextAllowedAtMs: 0,
  // Базовая задержка между batchUpdate (подкручивается)
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

  // gaxios может давать ключи в разном регистре
  const retryAfterRaw = headers['retry-after'] ?? headers['Retry-After'] ?? headers['RETRY-AFTER']
  if (!retryAfterRaw) return 0

  const retryAfterSeconds = Number(retryAfterRaw)
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return 0
  return Math.floor(retryAfterSeconds * 1000)
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

  const rootFolderIdParam = rootFolderId
  const fileNameParam = activePresentationName
  const existingFile = await getFile(rootFolderIdParam, fileNameParam)

  presentationId = existingFile?.id
}
let init = initialize()

export async function archivePresentation(name) {
  await init
  if (!presentationId) return

  log('Archiving presentation...')
  const fileIdParam = presentationId
  const targetFolderIdParam = activeArchiveFolderId
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
    log('Creating presentation...\n')

    const srcFileIdParam = templatePresentationId
    const dstFolderIdParam = coffeeTodayFolderId
    const dstNameParam = activePresentationName

    const copied = await copyFile(srcFileIdParam, dstFolderIdParam, dstNameParam)
    presentationId = copied.id
  }
  return presentationId
}

export async function addSlide(event) {
  await init

  // На всякий случай: если презентации ещё нет, создаём
  const createdPresentationId = await createPresentation()
  presentationId = createdPresentationId

  const newSlideId = 's' + nanoid()
  const newTableId = 't' + nanoid()

  const title = `${event.titleEn || event.titleRu || ''}`
  const hasTitle = title.trim().length > 0

  // Замены текста
  const replaceMap = {
    '{{title}}': title,
    '{{summary}}': event.summary ?? '',
    '{{sqk}}': event.sqk ?? '',
    '{{priority}}': event.priority ?? '',
    '{{notes}}': event.notes ?? ''
  }

  const linkUrl = event.directUrl || event.url || ''
  const shouldLinkTitle = Boolean(linkUrl && hasTitle)

  // Важно:
  // 1) СНАЧАЛА duplicateObject с маппингом templateTableId -> newTableId
  // 2) Потом замены текста
  // 3) Потом updateTextStyle на newTableId (после замены текста)
  // 4) updateSlidesPosition должен двигать newSlideId, а не templateSlideId
  const requests = [
    {
      duplicateObject: {
        objectId: templateSlideId,
        objectIds: {
          [templateSlideId]: newSlideId,
          [templateTableId]: newTableId
        }
      }
    },
    ...Object.entries(replaceMap).map(([key, value]) => ({
      replaceAllText: {
        containsText: { text: key },
        replaceText: String(value ?? ''),
        pageObjectIds: [newSlideId]
      }
    })),
    {
      replaceAllText: {
        containsText: { text: `{{cat${event.topicId}_card${event.topicSqk}}}` },
        replaceText: String(`${event.sqk ?? ''} ${title}`),
        // Без pageObjectIds: обновляет общий “каталог/оглавление”, если он есть в презентации
      }
    }
  ]

  if (shouldLinkTitle) {
    requests.push({
      updateTextStyle: {
        fields: 'link',
        objectId: newTableId,
        cellLocation: {
          rowIndex: 0,
          columnIndex: 0
        },
        // Применяем ссылку только к заголовку
        textRange: {
          type: 'FIXED_RANGE',
          startIndex: 0,
          endIndex: title.length
        },
        style: {
          link: {
            url: linkUrl
          }
        }
      }
    })
  }

  requests.push({
    updateSlidesPosition: {
      slideObjectIds: [newSlideId],
      // insertionIndex должен быть int >= 0
      insertionIndex: Math.max(0, Number(event.sqk ?? 0) + 1)
    }
  })

  // Ретраи с backoff на 429
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

      // Помечаем успешный write, чтобы ограничить скорость даже без ошибок
      markWriteDone()
      return
    } catch (e) {
      log(e)

      // Если это не 429, не долбим дальше вслепую
      if (!isRateLimitError(e)) {
        throw e
      }

      // На 429: Retry-After если есть, иначе backoff
      const retryAfterMs = getRetryAfterMs(e)
      const jitterParam = 500
      const delayMs = Math.max(retryAfterMs, backoffMs) + jitterMs(jitterParam)

      const sleepMsParam = delayMs
      await sleep(sleepMsParam)

      // Увеличиваем backoff, но ограничиваем
      backoffMs = Math.min(backoffMs * 2, 120000)

      // Дополнительно чуть “замедляемся” глобально, чтобы реже ловить 429
      limiterState.minDelayMs = Math.min(Math.max(limiterState.minDelayMs, 1600) + 250, 5000)
    }
  }

  // Если дошли сюда, значит все попытки исчерпаны
  throw new Error('Не удалось добавить слайд: постоянный rate limit (429).')
}

if (process.argv[1].endsWith('google-slides')) {
  // Здесь можно добавить отладку при необходимости
}
