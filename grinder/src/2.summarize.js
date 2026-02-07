import fs from 'fs'
import path from 'path'
import { log } from './log.js'
import { sleep } from './sleep.js'
import { news, pauseAutoSave, resumeAutoSave, saveRowByIndex, spreadsheetId, spreadsheetMode } from './store.js'
import { topics, topicsMap } from '../config/topics.js'
import { decodeGoogleNewsUrl, getGoogleNewsDecodeCooldownMs } from './google-news.js'
import { fetchArticle, getLastFetchStatus } from './fetch-article.js'
import { isDomainInCooldown } from './domain-cooldown.js'
import { extractMetaFromHtml } from './meta-extract.js'
import { ai } from './ai.js'
import { browseArticle, finalyze } from './browse-article.js'
import { verifyArticle } from './verify-article.js'
import { buildVerifyContext } from './verify-context.js'
import { searchExternal, sourceFromUrl } from './external-search.js'
import { coffeeTodayFolderId, newsSheet } from '../config/google-drive.js'
import {
	verifyMode,
	verifyMinConfidence,
	verifyShortThreshold,
	verifyFailOpen,
	verifyModel,
	verifyUseSearch,
	verifyProvider,
	verifyMaxChars,
	verifyFallbackMaxChars,
} from '../config/verification.js'
import { summarizeConfig } from '../config/summarize.js'
import { externalSearch } from '../config/external-search.js'
import {
	getAlternativeArticles,
	classifyAlternativeCandidates,
	isRuntimeArticles,
} from './summarize/articles.js'
import {
	backfillMetaFromDisk,
	backfillTextFromDisk,
	getCacheInfo,
	probeCache,
	readHtmlFromDisk,
	saveArticle,
	writeCacheMeta,
} from './summarize/disk.js'
import {
	buildFallbackSearchQueriesWithAi,
	getSearchQuerySource,
	searchGoogleNews,
} from './summarize/gn.js'
import { logEvent } from './summarize/logging.js'
import { logging } from '../config/logging.js'
import { describeError } from './error-guidance.js'
import {
	isBlank,
	isGoogleNewsUrl,
	missingFields,
	normalizeUrl,
	titleFor,
} from './summarize/utils.js'
import { createFetchTextWithRetry, extractText, minTextLength } from './summarize/fetch-text.js'

const contentMethodColumn = 'contentMethod'
const metaTitleColumn = 'metaTitle'
const metaDescriptionColumn = 'metaDescription'
const metaKeywordsColumn = 'metaKeywords'
const metaDateColumn = 'metaDate'
const metaCanonicalUrlColumn = 'metaCanonicalUrl'
const metaImageColumn = 'metaImage'
const metaAuthorColumn = 'metaAuthor'
const metaSiteNameColumn = 'metaSiteName'
const metaSectionColumn = 'metaSection'
const metaTagsColumn = 'metaTags'
const metaLangColumn = 'metaLang'
let progressTracker = null

const summarizeConsoleLogLevel = String(process.env.SUMMARIZE_CONSOLE_LOG_LEVEL || '').toLowerCase()
const summarizeConsoleLong = process.argv.includes('--log-long')
	|| process.env.SUMMARIZE_LOG_LONG === '1'
	|| summarizeConsoleLogLevel === 'long'
const summarizeLogFile = process.env.SUMMARIZE_LOG_FILE || 'logs/summarize.log'
const summarizeHashLength = Number.isFinite(Number(process.env.SUMMARIZE_HASH_LEN))
	? Math.max(4, Number(process.env.SUMMARIZE_HASH_LEN))
	: 8

function createFileLogger(filePath) {
	if (!filePath) return () => {}
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
	} catch {}
	return (shortLine, detailLine) => {
		let short = shortLine || ''
		let detail = detailLine || shortLine || ''
		if (!short && !detail) return
		try {
			let ts = new Date().toISOString()
			let message = detail || short
			let record = {
				ts,
				level: 'long',
				message,
				short,
				detail,
			}
			fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`)
		} catch {}
	}
}

function formatShortUrl(url) {
	if (!url) return ''
	try {
		let parsed = new URL(url)
		let host = parsed.host.replace(/^www\./, '')
		let pathValue = parsed.pathname ? parsed.pathname.replace(/\/+$/, '') : ''
		let segments = pathValue.split('/').filter(Boolean)
		if (segments.length) return `${host}/${segments.slice(-1)[0]}`
		return host
	} catch {
		return url
	}
}

function formatDurationMs(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return ''
	if (ms < 1000) return `${Math.round(ms)}ms`
	return `${(ms / 1000).toFixed(1)}s`
}

function formatTextSample(text, limit = 400) {
	if (!text) return ''
	let clean = String(text).replace(/\s+/g, ' ').trim()
	if (!clean) return ''
	if (!Number.isFinite(limit) || limit <= 0) return clean
	return clean.length > limit ? `${clean.slice(0, limit)}...` : clean
}

function mergeCandidateMeta(meta = {}, hints = {}) {
	let merged = { ...(meta || {}) }
	if (hints && typeof hints === 'object') {
		for (let [key, value] of Object.entries(hints)) {
			if (!value) continue
			if (!merged[key]) merged[key] = value
		}
	}
	if (merged.siteName && !merged.source) merged.source = merged.siteName
	return merged
}

function buildCandidateHints(value = {}) {
	return {
		title: value.titleEn || value.titleRu || '',
		source: value.source || '',
		gnUrl: value.gnUrl || '',
		date: value.date || '',
	}
}

function cacheKeyForUrl(url) {
	let info = getCacheInfo({ url: url || '' }, url || '')
	return info?.key || ''
}

function normalizedUrlForCache(url) {
	let info = getCacheInfo({ url: url || '' }, url || '')
	return info?.url || ''
}

function getOriginalCacheKey(event) {
	if (event?._originalCacheKey !== undefined) return event._originalCacheKey
	let key = cacheKeyForUrl(event?._originalUrl || event?.url || '')
	event._originalCacheKey = key || ''
	return event._originalCacheKey
}

function checkGnCandidateDedup(event, gnUrl) {
	let normalized = normalizeUrl(gnUrl || '')
	if (!normalized) return { skip: false, normalized }
	if (!event._seenGnUrls) event._seenGnUrls = new Set()
	if (event._seenGnUrls.has(normalized)) {
		return { skip: true, reason: 'duplicate_gn_url', normalized }
	}
	event._seenGnUrls.add(normalized)
	return { skip: false, normalized }
}

function checkCandidateDedup(event, url) {
	let normalized = normalizedUrlForCache(url || '') || ''
	let key = cacheKeyForUrl(normalized || url || '')
	let originalKey = getOriginalCacheKey(event)
	if (key && originalKey && key === originalKey) {
		return { skip: true, reason: 'same_url', key, normalized }
	}
	if (key) {
		if (!event._seenCandidateKeys) event._seenCandidateKeys = new Set()
		if (event._seenCandidateKeys.has(key)) {
			return { skip: true, reason: 'duplicate_candidate', key, normalized }
		}
		event._seenCandidateKeys.add(key)
	}
	return { skip: false, key, normalized }
}

function addInlineCandidate(event, url, { reason = 'canonical', source = '', title = '', date = '', gnUrl = '' } = {}) {
	if (!url) return false
	let normalized = normalizedUrlForCache(url)
	if (!normalized || isGoogleNewsUrl(normalized)) return false
	let key = cacheKeyForUrl(normalized)
	if (!key) return false
	let originalKey = cacheKeyForUrl(event?._originalUrl || event?.url || '')
	if (originalKey && originalKey === key) return false
	if (!event._inlineCandidateKeys) event._inlineCandidateKeys = new Set()
	if (event._inlineCandidateKeys.has(key)) return false
	event._inlineCandidateKeys.add(key)
	if (!Array.isArray(event._inlineCandidates)) event._inlineCandidates = []
	event._inlineCandidates.push({
		url: normalized,
		source: source || event?.source || '',
		titleEn: title || '',
		date: date || '',
		gnUrl: gnUrl || '',
		origin: 'inline',
		reason,
	})
	return true
}

function createRunLogger() {
	const writeFile = createFileLogger(summarizeLogFile)
	const logLine = (shortLine, detailLine) => {
		let detail = detailLine || shortLine
		if (shortLine || detailLine) writeFile(shortLine, detailLine)
		let line = summarizeConsoleLong ? (detail || shortLine) : shortLine
		if (line) console.log(line)
	}
	return { logLine }
}

const runLogger = createRunLogger()

const isSummarizeCli = Array.isArray(process.argv)
	? process.argv.some(arg => String(arg).includes('2.summarize'))
	: false
if (isSummarizeCli) {
	globalThis.__LOG_SUPPRESS_ALL = true
}

function createProgressTracker() {
	const states = new Map()
	const stepStarts = new Map()
	const durations = new Map()
	const terminalStatuses = new Set([
		'ok',
		'skipped',
		'miss',
		'mismatch',
		'reject',
		'captcha',
		'timeout',
		'rate_limit',
		'504',
		'fail',
		'error',
		'no_text',
		'unverified',
		'short',
		'blocked',
		'empty',
	])
	const normalizeStatus = value => {
		let text = String(value || '').toLowerCase()
		if (!text) return 'unknown'
		let map = {
			start: 'start',
			wait: 'wait',
			ok: 'ok',
			skipped: 'skipped',
			skip: 'skipped',
			miss: 'miss',
			reject: 'reject',
			mismatch: 'mismatch',
			short: 'short',
			blocked: 'blocked',
			captcha: 'captcha',
			timeout: 'timeout',
			rate_limit: 'rate_limit',
			'504': '504',
			empty: 'empty',
			fail: 'fail',
			error: 'error',
			no_text: 'no_text',
			unverified: 'unverified',
		}
		return map[text] || text
	}
	const buildContextLabel = ({ isFallback, origin }) => {
		if (!isFallback) return 'orig'
		if (origin) return `alt:${origin}`
		return 'alt'
	}
	const getState = event => {
		let existing = states.get(event.id)
		if (existing) return existing
		let created = {
			event,
			contextKey: '',
			contextLabel: '',
			hashShort: '',
			hashFull: '',
			url: '',
			normUrl: '',
			origin: '',
			summarizeModel: '',
		}
		states.set(event.id, created)
		return created
	}
	const formatPrefix = state => {
		let parts = [`#${state.event.id}`]
		if (state.hashShort) parts.push(`[${state.hashShort}]`)
		if (state.contextLabel) parts.push(state.contextLabel)
		return parts.join(' ')
	}
	const logContext = (state, rawUrl, normUrl, hashFull, origin) => {
		let prefix = formatPrefix(state)
		let shortUrl = formatShortUrl(normUrl || rawUrl)
		let shortLine = `${prefix} ctx url=${shortUrl || '--'}`
		let detailLine = `${prefix} ctx url=${rawUrl || ''} norm=${normUrl || ''} hash=${hashFull || ''}${origin ? ` origin=${origin}` : ''}`.trim()
		runLogger.logLine(shortLine, detailLine)
	}
	const stepKey = (state, step) => `${state.event.id}|${state.contextKey}|${step}`
	return {
		start(event) {
			let state = getState(event)
			state.event = event
			let title = titleFor(event)
			let prefix = formatPrefix(state)
			let shortLine = `${prefix} start${title ? ` title="${truncate(title, 80)}"` : ''}`
			let detailLine = `${prefix} start${title ? ` title="${title}"` : ''}`
			runLogger.logLine(shortLine, detailLine)
		},
		setContext(event, { url, isFallback, kind, origin }) {
			let state = getState(event)
			let cacheInfo = getCacheInfo({ url: url || '' }, url || '')
			let normUrl = cacheInfo?.url || url || ''
			let hashFull = cacheInfo?.key || ''
			let hashShort = hashFull ? hashFull.slice(0, summarizeHashLength) : ''
			let contextKey = `${kind || 'net'}:${isFallback ? 'alt' : 'orig'}:${hashFull || normUrl || url || ''}`
			if (contextKey != state.contextKey) {
				state.contextKey = contextKey
				state.contextLabel = buildContextLabel({ isFallback, origin })
				state.hashShort = hashShort
				state.hashFull = hashFull
				state.url = url || ''
				state.normUrl = normUrl || ''
				state.origin = origin || ''
				logContext(state, url || '', normUrl || '', hashFull || '', origin || '')
			}
		},
		setWinnerContext() {},
		setContextContent() {},
		setContextVerify() {},
		setContextPrepare() {},
		setContextPrepareText() {},
		setContextPrepareNote() {},
		setContextText() {},
		setContextNote() {},
		setFooter() {},
		setSummarizeModel(event, model) {
			let state = getState(event)
			state.summarizeModel = model || ''
		},
		step(event, step, status, note) {
			let state = getState(event)
			let normalized = normalizeStatus(status)
			let key = stepKey(state, step)
			if (normalized === 'start' || normalized === 'wait') {
				stepStarts.set(key, Date.now())
			}
			let ms = null
			if (terminalStatuses.has(normalized)) {
				let started = stepStarts.get(key)
				if (started) {
					ms = Date.now() - started
					durations.set(key, ms)
				}
				if (ms === null) {
					let stored = durations.get(key)
					if (Number.isFinite(stored)) ms = stored
				}
			}
			let dur = ms ? ` (${formatDurationMs(ms)})` : ''
			let noteText = note ? ` ${note}` : ''
			let prefix = formatPrefix(state)
			let shortLine = `${prefix} ${step} ${normalized}${dur}${noteText}`.trim()
			runLogger.logLine(shortLine, shortLine)
		},
		setDuration(event, step, ms) {
			let state = getState(event)
			let key = stepKey(state, step)
			if (Number.isFinite(ms)) durations.set(key, ms)
		},
		getDuration(event, step) {
			let state = getState(event)
			let key = stepKey(state, step)
			return durations.get(key) ?? null
		},
		getPrefix(event) {
			let state = getState(event)
			return formatPrefix(state)
		},
		logTextSample(event, text, label = 'text') {
			let state = getState(event)
			let sample = formatTextSample(text, 400)
			if (!sample) return
			let prefix = formatPrefix(state)
			let shortLine = `${prefix} ${label} len=${text.length}`
			let detailLine = `${prefix} ${label} len=${text.length} sample="${sample}"`
			runLogger.logLine(shortLine, detailLine)
		},
		flushSubsteps() {},
		done() {},
	}
}

function shouldVerify({ isFallback, textLength }) {
	if (verifyMode === 'always') return true
	if (verifyMode === 'fallback') return isFallback
	if (verifyMode === 'short') return textLength < verifyShortThreshold
	return false
}

function cloneEvent(event) {
	let copy = { ...event }
	if (isRuntimeArticles(event) && Array.isArray(event?._articles)) {
		copy._articles = event._articles.map(item => ({ ...item }))
		copy._articlesOrigin = event._articlesOrigin
	}
	return copy
}

function commitEvent(target, source) {
	for (let [key, value] of Object.entries(source || {})) {
		if (key === 'articles' || key === '_articles' || key === '_articlesOrigin') continue
		target[key] = value
	}
}

function ensureColumns(columns) {
	if (!news?.headers) return
	columns.forEach(column => {
		if (!news.headers.includes(column)) {
			news.headers.push(column)
		}
	})
}

function applyVerifyStatus(event, verify) {
	if (!verify) return
	let status = verify.status || (verify.ok ? 'ok' : 'mismatch')
	event._verifyStatus = status
}

function captureOriginalContext(event, base) {
	let source = base || event || {}
	if (!event._originalUrl && !isBlank(source.url)) event._originalUrl = source.url
	if (!event._originalGnUrl && !isBlank(source.gnUrl)) event._originalGnUrl = source.gnUrl
	if (!event._originalTitleEn && !isBlank(source.titleEn)) event._originalTitleEn = source.titleEn
	if (!event._originalTitleRu && !isBlank(source.titleRu)) event._originalTitleRu = source.titleRu
	if (!event._originalSource && !isBlank(source.source)) event._originalSource = source.source
	if (!event._originalDate && !isBlank(source.date)) event._originalDate = source.date
}

function resetTextFields(event) {
	event.text = ''
	event.summary = ''
	event.titleRu = ''
	event.topic = ''
	event.priority = ''
	event.aiTopic = ''
	event.aiPriority = ''
}

function setOriginalUrlIfMissing(event) {
	if (!event._originalUrl && !isBlank(event.url)) event._originalUrl = event.url
}

function applyFallbackSelection(event, alt, altUrl) {
	let origin = String(alt?.origin || '').toLowerCase()
	let isGn = origin === 'gn'
	if (!isGn && isBlank(event.source) && alt?.source) event.source = alt.source
	if (!isGn && isBlank(event.gnUrl) && !isBlank(alt?.gnUrl)) event.gnUrl = alt.gnUrl
	if (!isGn && isBlank(event.titleEn) && !isBlank(alt?.titleEn)) event.titleEn = alt.titleEn
	if (isBlank(event.url) && altUrl) event.url = altUrl
	if (isBlank(event.gnUrl) && isBlank(event.alternativeUrl) && !isBlank(altUrl)) {
		let originalUrl = normalizeUrl(event.url || '')
		if (!originalUrl || originalUrl !== altUrl) {
			event.alternativeUrl = altUrl
		}
	}
	setOriginalUrlIfMissing(event)
}

function sanitizeContentText(text) {
	if (!text) return ''
	let cleaned = String(text)
		.replace(/<[^>]+>/g, ' ')
		.replace(/[\u0000-\u001F\u007F]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	let maxChars = Number.isFinite(logging.contentTextMaxChars) ? logging.contentTextMaxChars : 0
	let hardLimit = Number.isFinite(logging.maxDataStringLength) ? logging.maxDataStringLength : 0
	let limit = maxChars > 0 ? maxChars : 0
	if (hardLimit > 0 && limit > 0) limit = Math.min(limit, hardLimit)
	if (limit > 0 && cleaned.length > limit) {
		let suffix = `... (${cleaned.length - limit} more chars)`
		cleaned = cleaned.slice(0, Math.max(0, limit - suffix.length)) + suffix
	}
	return cleaned
}

function setContentSource(event, { url, source, method, isFallback }) {
	const resolveContentDuration = methodLabel => {
		if (!progressTracker?.getDuration) return null
		if (!methodLabel) return null
		let normalized = String(methodLabel).toLowerCase()
		if (normalized === 'cache') return 0
		if (normalized === 'fetch') return progressTracker.getDuration(event, 'fetch')
		if (normalized === 'jina') return progressTracker.getDuration(event, 'jina')
		if (normalized === 'archive') return progressTracker.getDuration(event, 'archive')
		if (normalized === 'wayback') return progressTracker.getDuration(event, 'wayback')
		if (normalized === 'wayback-jina') return progressTracker.getDuration(event, 'wayback')
		if (normalized === 'browse' || normalized === 'playwright') return progressTracker.getDuration(event, 'playwright')
		return null
	}
	if (event._contentUrl) {
		let methodLabel = event._contentMethod || method || ''
		let durationMs = resolveContentDuration(methodLabel)
		progressTracker?.setContext?.(event, { url: event._contentUrl, isFallback: event._contentIsFallback, kind: 'net' })
		progressTracker?.setWinnerContext?.(event, { url: event._contentUrl, isFallback: event._contentIsFallback, kind: 'net' })
		progressTracker?.setContextContent?.(event, { status: 'ok', method: methodLabel, ms: durationMs })
		if (Number.isFinite(durationMs)) progressTracker?.setDuration?.(event, 'content', durationMs)
		progressTracker?.step(event, 'content', 'ok', methodLabel)
		progressTracker?.flushSubsteps?.(event)
		return
	}
	event._contentUrl = url || ''
	event._contentSource = source || ''
	event._contentMethod = method || ''
	event._contentIsFallback = Boolean(isFallback)
	event[contentMethodColumn] = event._contentMethod
	let contentText = ''
	if (logging.includeContentText) {
		contentText = sanitizeContentText(event.text || '')
	}
	logEvent(event, {
		phase: 'content_selected',
		status: 'ok',
		contentUrl: event._contentUrl,
		contentSource: event._contentSource,
		contentMethod: event._contentMethod,
		contentIsFallback: event._contentIsFallback,
		originalUrl: event._originalUrl || '',
		originalGnUrl: event._originalGnUrl || '',
		contentText,
	}, `#${event.id} content selected (${event._contentMethod})`, 'info')
	let durationMs = resolveContentDuration(event._contentMethod || '')
	progressTracker?.setContext?.(event, { url: event._contentUrl, isFallback: event._contentIsFallback, kind: 'net' })
	progressTracker?.setWinnerContext?.(event, { url: event._contentUrl, isFallback: event._contentIsFallback, kind: 'net' })
	progressTracker?.setContextContent?.(event, { status: 'ok', method: event._contentMethod, ms: durationMs })
	if (Number.isFinite(durationMs)) progressTracker?.setDuration?.(event, 'content', durationMs)
	progressTracker?.flushSubsteps?.(event)
	progressTracker?.step(event, 'content', 'ok', event._contentMethod)
}

function applyContentMeta(event, meta, method) {
	if (!meta || typeof meta !== 'object') return
	if (!event._contentMeta) event._contentMeta = {}
	let target = event._contentMeta
	for (let [key, value] of Object.entries(meta)) {
		if (!value) continue
		if (!target[key]) target[key] = value
	}
	if (!event._contentMetaMethod && method) event._contentMetaMethod = method
	if (isBlank(event.titleEn) && meta.title) event.titleEn = meta.title
	if (isBlank(event.date) && meta.date) event.date = meta.date
	if (isBlank(event.url) && meta.canonicalUrl) event.url = meta.canonicalUrl
	if (isBlank(event.description) && meta.description) event.description = meta.description
	if (isBlank(event.keywords) && meta.keywords) event.keywords = meta.keywords

	if (isBlank(event[metaTitleColumn]) && meta.title) event[metaTitleColumn] = meta.title
	if (isBlank(event[metaDescriptionColumn]) && meta.description) event[metaDescriptionColumn] = meta.description
	if (isBlank(event[metaKeywordsColumn]) && meta.keywords) event[metaKeywordsColumn] = meta.keywords
	if (isBlank(event[metaDateColumn]) && (meta.publishedTime || meta.date)) event[metaDateColumn] = meta.publishedTime || meta.date
	if (isBlank(event[metaCanonicalUrlColumn]) && meta.canonicalUrl) event[metaCanonicalUrlColumn] = meta.canonicalUrl
	if (isBlank(event[metaImageColumn]) && meta.image) event[metaImageColumn] = meta.image
	if (isBlank(event[metaAuthorColumn]) && meta.author) event[metaAuthorColumn] = meta.author
	if (isBlank(event[metaSiteNameColumn]) && meta.siteName) event[metaSiteNameColumn] = meta.siteName
	if (isBlank(event[metaSectionColumn]) && meta.section) event[metaSectionColumn] = meta.section
	if (isBlank(event[metaTagsColumn]) && meta.tags) event[metaTagsColumn] = meta.tags
	if (isBlank(event[metaLangColumn]) && (meta.lang || meta.locale)) event[metaLangColumn] = meta.lang || meta.locale
}

function truncate(text, max = 220) {
	if (!text) return ''
	if (text.length <= max) return text
	return text.slice(0, max - 3) + '...'
}

function summarizeSearchResults(results, limit = 8) {
	if (!Array.isArray(results) || !results.length) return []
	return results.slice(0, limit).map(item => ({
		source: item.source || '',
		title: truncate(String(item.titleEn || item.titleRu || '').replace(/\s+/g, ' '), 140),
		url: item.url || '',
		gnUrl: item.gnUrl || '',
		origin: item.origin || item.provider || item.from || '',
		level: item.level,
	}))
}

function getLogPrefix(event) {
	return progressTracker?.getPrefix?.(event) || `#${event.id}`
}

function logSearchQuery(event, { phase, provider, query, queries, reason }) {
	let prefix = getLogPrefix(event)
	let label = provider ? `${provider}` : ''
	let reasonText = reason ? ` reason=${reason}` : ''
	let shortLine = `${prefix} ${phase} query${label ? ` (${label})` : ''}${query ? ` ${truncate(query, 120)}` : ''}${reasonText}`.trim()
	let detailLine = `${prefix} ${phase} query${label ? ` (${label})` : ''}${query ? ` ${query}` : ''}${reasonText}`.trim()
	runLogger.logLine(shortLine, detailLine)
	logEvent(event, {
		phase,
		status: 'query',
		provider,
		query,
		queries,
		reason,
	}, `#${event.id} ${phase} query`, 'info')
}

function logSearchResults(event, { phase, provider, query, results }) {
	let count = Array.isArray(results) ? results.length : 0
	let prefix = getLogPrefix(event)
	let label = provider ? `${provider}` : ''
	let shortLine = `${prefix} ${phase} results${label ? ` (${label})` : ''} count=${count}`.trim()
	let detailLine = `${prefix} ${phase} results${label ? ` (${label})` : ''} count=${count}${query ? ` query="${query}"` : ''}`.trim()
	runLogger.logLine(shortLine, detailLine)
	logEvent(event, {
		phase,
		status: count ? 'ok' : 'empty',
		provider,
		query,
		count,
		results: summarizeSearchResults(results),
	}, `#${event.id} ${phase} ${count}`, count ? 'info' : 'warn')
}

function logSearchQueryContext(event, { phase, queryInfo, provider }) {
	if (!queryInfo) return
	let meta = queryInfo.contextMeta || {}
	let context = queryInfo.logContext || queryInfo.context || {}
	let mode = meta.mode || (meta.usedUrl ? 'url' : 'title_desc')
	let titleLen = Number.isFinite(meta.titleLength) ? meta.titleLength : String(context.title || '').trim().length
	let descLen = Number.isFinite(meta.descriptionLength) ? meta.descriptionLength : String(context.description || '').trim().length
	let urlLen = Number.isFinite(meta.urlLength) ? meta.urlLength : String(context.url || '').trim().length
	let providerName = queryInfo.provider || provider || ''
	let modelName = queryInfo.model || ''
	let aiUsed = queryInfo.aiUsed ? '1' : '0'
	let aiResponse = queryInfo.aiResponse || ''
	let prefix = getLogPrefix(event)
	let shortLine = `${prefix} ${phase} context mode=${mode} titleLen=${titleLen} descLen=${descLen} urlLen=${urlLen} ai=${aiUsed}${providerName ? ` provider=${providerName}` : ''}${modelName ? ` model=${modelName}` : ''}`.trim()
	let includeAiResponse = queryInfo.aiUsed ? ` aiResponse="${truncate(aiResponse || '', 200)}"` : ''
	let detailLine = `${shortLine} title="${truncate(context.title || '', 120)}" description="${truncate(context.description || '', 120)}" url="${truncate(context.url || '', 120)}"${includeAiResponse}`.trim()
	runLogger.logLine(shortLine, detailLine)
	logEvent(event, {
		phase: `${phase}_context`,
		status: 'ok',
		mode,
		titleLength: titleLen,
		descriptionLength: descLen,
		urlLength: urlLen,
		provider: providerName,
		model: modelName,
		aiUsed: queryInfo.aiUsed || false,
		aiResponse,
		context,
	}, shortLine, 'info')
}

function logCandidateDecision(event, candidate, status, reason, { phase = 'fallback_candidate', provider = '', query = '' } = {}) {
	let level = Number.isFinite(candidate?.level) ? candidate.level : undefined
	let logLevel = (status === 'accepted' || status === 'attempt' || status === 'selected') ? 'info' : 'warn'
	let prefix = getLogPrefix(event)
	let source = candidate?.source || ''
	let link = candidate?.url || candidate?.gnUrl || ''
	let shortLink = link ? formatShortUrl(link) : ''
	let shortLine = `${prefix} ${phase} ${status}${source ? ` ${source}` : ''}${reason ? ` (${reason})` : ''}${shortLink ? ` link=${shortLink}` : ''}`.trim()
	let detailLine = `${shortLine}${candidate?.url ? ` url=${candidate.url}` : ''}${(!candidate?.url && candidate?.gnUrl) ? ` gnUrl=${candidate.gnUrl}` : ''}`.trim()
	runLogger.logLine(shortLine, detailLine)
	logEvent(event, {
		phase,
		status,
		reason,
		provider,
		query,
		candidateSource: candidate?.source || '',
		candidateUrl: candidate?.url || '',
		candidateGnUrl: candidate?.gnUrl || '',
		candidateTitle: candidate?.titleEn || candidate?.titleRu || '',
		candidateOrigin: candidate?.origin || candidate?.provider || candidate?.from || '',
		candidateLevel: level,
	}, `#${event.id} ${phase} ${status} ${candidate?.source || ''}${reason ? ` (${reason})` : ''}`, logLevel)
}

async function fetchGnCandidates(event, last) {
	let queryInfo = await buildFallbackSearchQueriesWithAi(event, { allowAi: true })
	logSearchQueryContext(event, { phase: 'gn_search', queryInfo, provider: 'gn' })
	let queries = Array.isArray(queryInfo?.queries) ? queryInfo.queries : []
	if (!queries.length) {
		let skipReason = queryInfo?.reason || 'no_queries'
		logEvent(event, {
			phase: 'gn_search',
			status: 'skipped',
			reason: skipReason,
			provider: 'gn',
		}, `#${event.id} gn search skipped (${skipReason})`, 'warn')
		return []
	}
	let combined = []
	for (let query of queries) {
		logSearchQuery(event, { phase: 'gn_search', provider: 'gn', query, reason: queryInfo?.reason || getSearchQuerySource(event) })
		let results = await searchGoogleNews(query, last, event)
		logSearchResults(event, { phase: 'gn_search', provider: 'gn', query, results })
		if (results.length) combined.push(...results)
	}
	return combined
}

async function tryCache(event, url, { isFallback = false, origin = '', last, contentSource = '' } = {}) {
	progressTracker?.setContext?.(event, { url, isFallback, kind: 'net', origin })
	progressTracker?.step(event, 'cache', 'start')
	let cacheProbe = probeCache(event, url)
	if (!cacheProbe.available) {
		if (cacheProbe.reason === 'missing') {
			logEvent(event, {
				phase: 'cache',
				status: 'miss',
				reason: 'no_files',
				cacheKey: cacheProbe.key,
				cacheUrl: cacheProbe.url,
			}, `#${event.id} cache miss (no files)`, 'warn')
			progressTracker?.step(event, 'cache', 'miss', 'no_files')
			return { ok: false, cacheMetaHit: false, cacheTextHit: false, reason: 'no_files' }
		}
		logEvent(event, {
			phase: 'cache',
			status: 'skip',
			reason: cacheProbe.reason,
		}, `#${event.id} cache skip (${cacheProbe.reason})`, 'warn')
		progressTracker?.step(event, 'cache', 'skipped', cacheProbe.reason || '')
		return { ok: false, cacheMetaHit: false, cacheTextHit: false, reason: cacheProbe.reason }
	}
	let metaStatus = String(cacheProbe.meta?.status || '').toLowerCase()
	let metaMethod = String(cacheProbe.meta?.method || '')
	if (['mismatch', 'short', 'blocked'].includes(metaStatus)) {
		let cachedHtml = cacheProbe?.hasHtml ? readHtmlFromDisk(event, url) : ''
		let candidateMeta = cachedHtml ? extractMetaFromHtml(cachedHtml) : {}
		candidateMeta = mergeCandidateMeta(candidateMeta, buildCandidateHints(event))
		let canonicalUrl = candidateMeta?.canonicalUrl || ''
		logEvent(event, {
			phase: 'cache',
			status: metaStatus,
			method: metaMethod,
			cacheKey: cacheProbe.key,
			cacheUrl: cacheProbe.url,
		}, `#${event.id} cache status ${metaStatus}`, 'warn')
		progressTracker?.step(event, 'cache', metaStatus, metaMethod || '')
		return { ok: false, cached: true, status: metaStatus, method: metaMethod, final: true, candidateMeta, canonicalUrl }
	}
	logEvent(event, {
		phase: 'cache',
		status: 'probe',
		cacheKey: cacheProbe.key,
		cacheUrl: cacheProbe.url,
		hasHtml: cacheProbe.hasHtml,
		hasTxt: cacheProbe.hasTxt,
	}, `#${event.id} cache probe`, 'info')

	let cacheMetaHit = backfillMetaFromDisk(event, url)
	let cacheTextHit = backfillTextFromDisk(event, url)
	let textLength = event.text?.length || 0
	let cachedHtml = ''
	if (cacheTextHit && textLength > 0 && textLength <= minTextLength) {
		cacheTextHit = false
		event.text = ''
	}
	if (!cacheTextHit) {
		cachedHtml = readHtmlFromDisk(event, url)
		if (cachedHtml) {
			let extracted = extractText(cachedHtml)
			if (extracted) {
				event.text = extracted
				textLength = extracted.length
				cacheTextHit = extracted.length > minTextLength
			}
		}
	}
	if (cacheTextHit) {
		progressTracker?.step(event, 'cache', 'ok', metaMethod || '')
		progressTracker?.logTextSample?.(event, event.text || '')
	} else if (textLength > 0 && textLength <= minTextLength) {
		logEvent(event, {
			phase: 'cache',
			status: 'short',
			reason: 'short_text',
			cacheUrl: url || '',
			cacheKey: cacheProbe?.key,
			textLength,
		}, `#${event.id} cache short text`, 'warn')
		writeCacheMeta(event, url, { status: 'short', method: metaMethod || 'cache', textLength })
		progressTracker?.step(event, 'cache', 'short', `len=${textLength}`)
		return { ok: false, cacheMetaHit, cacheTextHit: false, status: 'short', final: true }
	} else {
		logEvent(event, {
			phase: 'cache',
			status: 'miss',
			reason: cacheMetaHit ? 'meta_only' : 'no_text',
			cacheUrl: url || '',
			cacheKey: cacheProbe?.key,
		}, `#${event.id} cache miss`, 'warn')
		progressTracker?.step(event, 'cache', 'miss', cacheMetaHit ? 'meta_only' : 'no_text')
		return { ok: false, cacheMetaHit, cacheTextHit: false, reason: 'no_text' }
	}

	let candidateMeta = cachedHtml ? extractMetaFromHtml(cachedHtml) : {}
	candidateMeta = mergeCandidateMeta(candidateMeta, buildCandidateHints(event))

	progressTracker?.setContext?.(event, { url, isFallback, kind: 'net', origin })
	progressTracker?.setWinnerContext?.(event, { url, isFallback, kind: 'net', origin })
	progressTracker?.setContextContent?.(event, { status: 'ready', method: 'cache', ms: 0 })
	let verify = await verifyText({
		event,
		url,
		text: event.text,
		isFallback,
		method: 'cache',
		attempt: 0,
		last,
		contextKind: 'net',
		candidateMeta,
	})
	if (verify?.ok) {
		let overallStatus = verify?.status === 'skipped' ? 'skipped' : (verify?.status === 'unverified' ? 'unverified' : 'ok')
		if (Number.isFinite(verify?.durationMs)) {
			progressTracker?.setDuration?.(event, 'verify', verify.durationMs)
		}
		let verifyNote = formatVerifyNote(verify)
		let note = 'cache'
		if (verifyNote) note = `${note} ${verifyNote}`
		progressTracker?.step(event, 'verify', overallStatus, note)
		applyVerifyStatus(event, verify)
		setContentSource(event, {
			url,
			source: contentSource || event._originalSource || event.source || '',
			method: 'cache',
			isFallback,
		})
		if (cachedHtml) {
			saveArticle(event, cachedHtml || '', event.text || '', url, { status: 'ok', method: 'cache' })
		} else {
			writeCacheMeta(event, url, { status: 'ok', method: 'cache', textLength: event.text?.length || 0 })
		}
		return { ok: true, cacheMetaHit, cacheTextHit, verify, candidateMeta, canonicalUrl: candidateMeta?.canonicalUrl || '' }
	}
	if (verify?.status === 'mismatch') {
		logEvent(event, {
			phase: 'cache_verify',
			status: 'mismatch',
			reason: verify?.reason,
			pageSummary: verify?.pageSummary,
		}, `#${event.id} cached text mismatch`, 'warn')
		progressTracker?.step(event, 'cache', 'mismatch')
		progressTracker?.setContextContent?.(event, { status: 'mismatch', method: 'cache', ms: 0 })
		if (cachedHtml) {
			saveArticle(event, cachedHtml || '', event.text || '', url, { status: 'mismatch', method: 'cache', mutateEvent: false })
		} else {
			writeCacheMeta(event, url, { status: 'mismatch', method: 'cache', textLength: event.text?.length || 0 })
		}
		resetTextFields(event)
		return { ok: false, cacheMetaHit, cacheTextHit, mismatch: true, status: 'mismatch', candidateMeta, canonicalUrl: candidateMeta?.canonicalUrl || '' }
	}
	return { ok: false, cacheMetaHit, cacheTextHit, reason: 'verify_failed', candidateMeta, canonicalUrl: candidateMeta?.canonicalUrl || '' }
}

async function decodeUrl(gnUrl, last) {
	if (gnUrl && isGoogleNewsUrl(gnUrl)) {
		let cooldownMs = getGoogleNewsDecodeCooldownMs()
		if (cooldownMs > 0) {
			log('google news decode cooldown active', Math.ceil(cooldownMs / 1000), 's')
			return ''
		}
	}
	await sleep(last.urlDecode.time + last.urlDecode.delay - Date.now())
	let maxDelay = Number.isFinite(last.urlDecode.maxDelay)
		? last.urlDecode.maxDelay
		: last.urlDecode.delay
	last.urlDecode.delay = Math.min(last.urlDecode.delay + last.urlDecode.increment, maxDelay)
	last.urlDecode.time = Date.now()
	log('Decoding URL...')
	if (!gnUrl) return ''
	if (!isGoogleNewsUrl(gnUrl)) return gnUrl
	return await decodeGoogleNewsUrl(gnUrl)
}


function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return ''
	if (ms < 1000) return `${Math.round(ms)}ms`
	let seconds = ms / 1000
	if (seconds < 60) return `${seconds.toFixed(1)}s`
	let minutes = Math.floor(seconds / 60)
	let remainder = Math.round(seconds % 60)
	return `${minutes}m${String(remainder).padStart(2, '0')}s`
}

function formatCountdown(ms) {
	let totalSeconds = Math.max(0, Math.ceil((ms || 0) / 1000))
	let minutes = Math.floor(totalSeconds / 60)
	let seconds = totalSeconds % 60
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
	return `${seconds}s`
}

function formatVerifyNote(result) {
	if (!result) return ''
	let parts = []
	if (Number.isFinite(result.confidence)) parts.push(`conf=${result.confidence.toFixed(2)}`)
	if (result.reason) parts.push(`reason=${truncate(String(result.reason), 120)}`)
	return parts.join(' ')
}

const fetchTextWithRetry = createFetchTextWithRetry({
	fetchArticle,
	browseArticle,
	verifyText,
	logEvent,
	getLastFetchStatus,
	applyContentMeta,
	formatVerifyNote,
	getProgressTracker: () => progressTracker,
})

async function sleepWithCountdown(totalMs, onTick, intervalMs = 1000) {
	let start = Date.now()
	let remaining = Math.max(0, totalMs || 0)
	if (onTick) onTick(remaining)
	while (remaining > 0) {
		let step = Math.min(intervalMs, remaining)
		await sleep(step)
		remaining = Math.max(0, totalMs - (Date.now() - start))
		if (onTick) onTick(remaining)
	}
}



async function verifyText({ event, url, text, isFallback, method, attempt, last, contextKind = 'net', progress = true, candidateMeta }) {
	const clampPromptField = value => {
		if (value === null || value === undefined) return ''
		let raw = String(value)
		return raw.length > 100 ? raw.slice(0, 100) : raw
	}
	if (progress) {
		progressTracker?.setContext?.(event, { url, isFallback, kind: contextKind })
		progressTracker?.setContextVerify?.(event, { status: 'start', ms: 0 })
	}
	let waitMs = 0
	let prepareMs = 0
	let aiMs = 0
	let rawTextLength = Number.isFinite(text?.length) ? text.length : 0
	let primaryLimit = Number.isFinite(verifyMaxChars) && verifyMaxChars > 0 ? verifyMaxChars : 0
	let sentTextLength = primaryLimit ? Math.min(rawTextLength, primaryLimit) : rawTextLength
	let fallbackLimit = Number.isFinite(verifyFallbackMaxChars) && verifyFallbackMaxChars > 0 ? verifyFallbackMaxChars : 0
	let fallbackSentLength = fallbackLimit ? Math.min(rawTextLength, fallbackLimit) : rawTextLength
	if (!shouldVerify({ isFallback, textLength: text.length })) {
		let durationMs = 0
		logEvent(event, {
			phase: 'verify',
			status: 'skipped',
			method,
			attempt,
			textLength: text.length,
		}, `#${event.id} verify skipped (${method})`, 'info')
		if (progress) {
			progressTracker?.setContextPrepare?.(event, { status: 'skipped', ms: 0 })
			progressTracker?.setContextVerify?.(event, { status: 'skipped', ms: durationMs })
		}
		return { ok: true, status: 'skipped', verified: false, skipped: true, durationMs }
	}
	if (isBlank(event._originalUrl) && !isBlank(event.gnUrl)) {
		let decoded = await decodeUrl(event.gnUrl, last)
		if (decoded && isBlank(event.url)) {
			event.url = decoded
		}
		setOriginalUrlIfMissing(event)
	}
	let verifyWait = last.verify.time + last.verify.delay - Date.now()
	if (verifyWait > 0) {
		let waitStart = Date.now()
		await sleepWithCountdown(verifyWait, remaining => {
			if (!progress) return
			let note = `wait:${formatCountdown(remaining)} left`
			progressTracker?.setContextVerify?.(event, { status: 'wait', ms: 0, note })
		})
		waitMs = Math.max(0, Date.now() - waitStart)
	}
	last.verify.time = Date.now()
	if (progress) progressTracker?.setContextPrepare?.(event, { status: 'start', ms: 0 })
	let prepareStart = Date.now()
	let context = await buildVerifyContext(event)
	prepareMs = Date.now() - prepareStart
	if (progress) progressTracker?.setContextPrepare?.(event, { status: 'ok', ms: prepareMs })
	if (logging.includeVerifyPrompt) {
		try {
			let candidate = { ...(candidateMeta && typeof candidateMeta === 'object' ? candidateMeta : {}) }
			if (!candidate.textSnippet && candidate.description) candidate.textSnippet = candidate.description
			if (!candidate.textSnippet) candidate.textSnippet = formatTextSample(text, 400)
			candidate.url = url
			candidate.text = text
			let promptOriginal = {
				title: clampPromptField(context?.title || ''),
				description: clampPromptField(context?.description || ''),
				keywords: clampPromptField(context?.keywords || ''),
				date: clampPromptField(context?.date || ''),
				source: clampPromptField(context?.source || ''),
				url: clampPromptField(context?.url || ''),
				gnUrl: clampPromptField(context?.gnUrl || ''),
			}
			let promptCandidate = {
				title: clampPromptField(candidate?.title || ''),
				description: clampPromptField(candidate?.description || ''),
				keywords: clampPromptField(candidate?.keywords || ''),
				date: clampPromptField(candidate?.date || ''),
				source: clampPromptField(candidate?.source || ''),
				url: clampPromptField(candidate?.url || ''),
				gnUrl: clampPromptField(candidate?.gnUrl || ''),
				textSnippet: clampPromptField(candidate?.textSnippet || ''),
				text: clampPromptField(candidate?.text || ''),
			}
			let payload = {
				original: promptOriginal,
				candidate: promptCandidate,
			}
			let raw = JSON.stringify(payload, null, 2)
			let maxChars = Number.isFinite(logging.verifyPromptMaxChars) ? logging.verifyPromptMaxChars : 0
			let trimmed = maxChars > 0 ? truncate(raw, maxChars) : raw
			let prefix = getLogPrefix(event)
			runLogger.logLine('', `${prefix} verify_payload ${trimmed}`)
		} catch {}
	}
	const verifyStarted = Date.now()
	let aiStart = Date.now()
	let candidate = { ...(candidateMeta && typeof candidateMeta === 'object' ? candidateMeta : {}) }
	if (!candidate.textSnippet && candidate.description) candidate.textSnippet = candidate.description
	if (!candidate.textSnippet) candidate.textSnippet = formatTextSample(text, 400)
	candidate.url = url
	candidate.text = text
	let result = await verifyArticle({
		original: context,
		candidate,
		minConfidence: verifyMinConfidence,
		failOpen: verifyFailOpen,
		debug: logging.includeVerifyPrompt,
		debugMaxChars: logging.verifyPromptMaxChars,
	})
	aiMs = Date.now() - aiStart
	applyVerifyStatus(event, result)
	let verifyDebug = result?.debug
	let modelName = result?.model || verifyDebug?.model || verifyModel || ''
	let useSearch = result?.useSearch ?? verifyDebug?.useSearch ?? verifyUseSearch
	let modelLabel = modelName
	if (modelLabel && useSearch) modelLabel = `${modelLabel}+search`
	if (modelLabel && result?.fallbackUsed) modelLabel = `${modelLabel}+fallback`
	let status = result?.status || (result?.ok ? 'ok' : (result?.error ? 'error' : 'mismatch'))
	let summarySnippet = result?.pageSummary ? ` | ${truncate(result.pageSummary)}` : ''
	let lengthNote = rawTextLength
		? ` textLen=${rawTextLength}${sentTextLength !== rawTextLength ? `->${sentTextLength}` : ''}`
		: ''
	let errorMessage = result?.error ? String(result.error?.message || result.error) : undefined
	let statusMessage = status === 'unverified' ? 'unverified (gpt unavailable)' : status
	let durationMs = Date.now() - verifyStarted
	let verifyNote = ''
	let verifyScope = verifyProvider === 'xai' ? 'xai' : 'openai'
	let guidance = result?.error
		? describeError(result.error, { scope: verifyScope })
		: (status === 'unverified' || status === 'error' ? describeError({ reason: status }, { scope: verifyScope }) : null)
	let action = guidance?.action ? ` | action: ${guidance.action}` : ''
	logEvent(event, {
		phase: 'verify',
		status,
		method,
		attempt,
		textLength: text.length,
		match: result?.match,
		confidence: result?.confidence,
		reason: result?.reason,
		pageSummary: result?.pageSummary,
		verified: result?.verified,
		error: errorMessage,
		tokens: result?.tokens,
		waitMs,
		contextMs: prepareMs,
		aiMs,
		verifyModel: modelName || verifyDebug?.model,
		verifyTemperature: verifyDebug?.temperature,
		verifyUseSearch: useSearch,
		verifyFallback: result?.fallbackUsed || verifyDebug?.fallbackUsed,
		verifyProvider: result?.provider,
		verifyProviderFallbackUsed: result?.providerFallbackUsed,
		verifyFallbackMaxChars: verifyDebug?.fallbackMaxChars,
		verifyFallbackContextMaxChars: verifyDebug?.fallbackContextMaxChars,
		verifyTextLengthRaw: rawTextLength,
		verifyTextLengthSent: sentTextLength,
		verifyTextLengthFallback: (result?.fallbackUsed || verifyDebug?.fallbackUsed) ? fallbackSentLength : undefined,
		verifyTextLimit: primaryLimit || undefined,
		verifyFallbackTextLimit: fallbackLimit || undefined,
		verifySystem: verifyDebug?.system,
		verifyPrompt: verifyDebug?.prompt,
		action: guidance?.action,
	}, `#${event.id} verify ${statusMessage} (${method})${lengthNote}${summarySnippet}${action}`, result?.ok ? 'ok' : 'warn')
	let contextStatus = status === 'unverified' ? 'unverified' : (result?.ok ? 'ok' : status)
	if (progress) {
		progressTracker?.setContextVerify?.(event, { status: contextStatus, ms: durationMs, note: verifyNote, model: modelLabel })
	}
	if (!verifyFailOpen && (status === 'error' || status === 'unverified')) {
		let summary = guidance?.summary || errorMessage || status
		let message = summary ? `verify unavailable: ${summary}` : 'verify unavailable'
		let fatal = new Error(message)
		fatal.code = 'VERIFY_FATAL'
		fatal.action = guidance?.action
		fatal.status = status
		fatal.model = modelName || verifyModel
		throw fatal
	}
	result.durationMs = durationMs
	result.verifyNote = verifyNote
	result.prepareMs = prepareMs
	if (modelLabel) result.modelLabel = modelLabel
	return result
}


export async function summarize() {
	const wasSuppressAll = globalThis.__LOG_SUPPRESS_ALL === true
	globalThis.__LOG_SUPPRESS_ALL = true
	pauseAutoSave()
	let stats = { ok: 0, fail: 0 }
	try {
		let runStart = Date.now()
		globalThis.__LOG_SUPPRESS = true
		ensureColumns([
			'titleEn',
			'titleRu',
			'gnUrl',
			'alternativeUrl',
			'url',
			'source',
			contentMethodColumn,
			metaTitleColumn,
			metaDescriptionColumn,
			metaKeywordsColumn,
			metaDateColumn,
			metaCanonicalUrlColumn,
			metaImageColumn,
			metaAuthorColumn,
			metaSiteNameColumn,
			metaSectionColumn,
			metaTagsColumn,
			metaLangColumn,
		])

		let list = news.filter(e => (
			isBlank(e.summary)
			|| isBlank(e.titleRu)
			|| isBlank(e.titleEn)
			|| isBlank(e.topic)
			|| isBlank(e.priority)
		))
		progressTracker = createProgressTracker()

		let failures = []
		let last = {
			urlDecode: { time: 0, delay: 30e3, increment: 1000, maxDelay: 60e3 },
			ai: { time: 0, delay: 0 },
			verify: { time: 0, delay: 1000 },
			gnSearch: { time: 0, delay: 1000, increment: 0 },
		}
		for (let i = 0; i < list.length; i++) {
			let base = list[i]
			let e = cloneEvent(base)
			let rowIndex = news.indexOf(base) + 1
			if (!e.id) e.id = base.id || rowIndex
			captureOriginalContext(e, base)
			progressTracker?.start(e, i)
			captureOriginalContext(e, e)
			e.gnUrl = normalizeUrl(e.gnUrl)
			if ((isBlank(e.url) || e.url === '') && !isBlank(e.gnUrl) && (!e.text || e.text.length <= minTextLength)) {
				let decoded = await decodeUrl(e.gnUrl, last)
				if (decoded) {
					e.url = decoded
					setOriginalUrlIfMissing(e)
					logEvent(e, {
						phase: 'decode_url',
						status: 'ok',
						url: e.url,
					}, `#${e.id} url decoded`, 'ok')
				} else {
					logEvent(e, {
						phase: 'decode_url',
						status: 'fail',
					}, `#${e.id} url decode failed`, 'warn')
				}
			}
			e.url = normalizeUrl(e.url)

			let cacheResult = await tryCache(e, e.url, { isFallback: false, origin: 'original', last, contentSource: e.source })
			if (!cacheResult?.ok && cacheResult?.canonicalUrl) {
				addInlineCandidate(e, cacheResult.canonicalUrl, {
					reason: 'canonical',
					source: cacheResult?.candidateMeta?.source || e.source || '',
					title: cacheResult?.candidateMeta?.title || '',
					date: cacheResult?.candidateMeta?.date || '',
					gnUrl: cacheResult?.candidateMeta?.gnUrl || '',
				})
			}
			let needsTextFields = (
				isBlank(e.summary)
				|| isBlank(e.titleRu)
				|| isBlank(e.titleEn)
				|| isBlank(e.topic)
				|| isBlank(e.priority)
			)
			let hasText = e.text?.length > minTextLength
			let skipOriginalFetch = Boolean(cacheResult?.final)

			if ((hasText || !needsTextFields) && isBlank(e.url) && !isBlank(e.gnUrl)) {
				let decoded = await decodeUrl(e.gnUrl, last)
				if (decoded) {
					e.url = decoded
					setOriginalUrlIfMissing(e)
					logEvent(e, {
						phase: 'decode_url',
						status: 'ok',
						url: e.url,
					}, `#${e.id} url decoded`, 'ok')
				} else {
					logEvent(e, {
						phase: 'decode_url',
						status: 'fail',
					}, `#${e.id} url decode failed`, 'warn')
				}
			}

			if (isBlank(e.source) && e.url && !e.url.includes('news.google.com')) {
				let inferred = sourceFromUrl(e.url)
				if (inferred) e.source = inferred
			}

			if (needsTextFields && !hasText) {
				let fetched = false
				if (!skipOriginalFetch) {
					if (!e.url /*&& !restricted.includes(e.source)*/) {
						e.url = await decodeUrl(e.gnUrl, last)
						if (!e.url) {
							logEvent(e, {
								phase: 'decode_url',
								status: 'fail',
							}, `#${e.id} url decode failed`, 'warn')
							await sleep(5 * 60e3)
							i--
							continue
						}
						setOriginalUrlIfMissing(e)
						logEvent(e, {
							phase: 'decode_url',
							status: 'ok',
							url: e.url,
						}, `#${e.id} url decoded`, 'ok')
					}

					if (e.url) {
						if (isBlank(e.source) && e.url && !e.url.includes('news.google.com')) {
							let inferred = sourceFromUrl(e.url)
							if (inferred) e.source = inferred
						}
						let result = await fetchTextWithRetry(e, e.url, last, { origin: 'original', candidateHints: buildCandidateHints(e) })
						if (!result?.ok && result?.canonicalUrl) {
							addInlineCandidate(e, result.canonicalUrl, {
								reason: 'canonical',
								source: result?.meta?.source || e.source || '',
								title: result?.meta?.title || '',
								date: result?.meta?.date || '',
								gnUrl: result?.meta?.gnUrl || '',
							})
						}
						if (result?.ok) {
							saveArticle(e, result.html, result.text, result.url || e.url || '', { status: 'ok', method: result.method || 'fetch' })
							applyVerifyStatus(e, result.verify)
							setContentSource(e, {
								url: result.url || e.url || '',
								source: e.source || '',
								method: result.method || 'fetch',
								isFallback: false,
							})
							fetched = true
						} else if (result?.mismatch) {
							e._fallbackReason = 'verify_mismatch'
							if (result?.html || result?.text) {
							saveArticle(e, result.html || '', result.text || '', result.url || e.url || '', { status: 'mismatch', method: result.method || 'fetch', mutateEvent: false })
							} else {
								writeCacheMeta(e, e.url || '', { status: 'mismatch', method: result.method || 'fetch' })
							}
							logEvent(e, {
								phase: 'verify_mismatch',
								status: 'fail',
								pageSummary: result?.verify?.pageSummary,
								reason: result?.verify?.reason,
							}, `#${e.id} text mismatch, switching to fallback`, 'warn')
						} else if (result?.short) {
							e._fallbackReason = 'short'
							saveArticle(e, result.html || '', '', result.url || e.url || '', { status: 'short', method: result.method || 'fetch', mutateEvent: false })
						} else if (result?.blocked) {
							let blockedReason = result?.status ? `blocked_${result.status}` : 'blocked'
							e._fallbackReason = blockedReason
							writeCacheMeta(e, e.url || '', { status: 'blocked', method: result.method || 'fetch' })
						} else if (!result?.ok) {
							e._fallbackReason = result?.status || 'no_text'
						}
					}
				}

				if (!fetched) {
					let fallbackReason = ''
					if (cacheResult?.final) {
						fallbackReason = `cache_${cacheResult.status || 'skip'}`
					}
					if (fallbackReason) e._fallbackReason = fallbackReason
					let reasonFromOriginal = e._fallbackReason || ''
					const logDeferredCandidates = process.env.LOG_DEFERRED === '1'
					const tryAlternative = async (alt, { allowWait, reason } = {}) => {
						let attemptReason = reason || alt?.reason || reasonFromOriginal || ''
						let altUrl = normalizeUrl(alt.url)
						let decodeMethod = altUrl ? 'direct' : 'gn'
						if (!altUrl && alt.gnUrl) {
							let gnDedup = checkGnCandidateDedup(e, alt.gnUrl)
							if (gnDedup?.normalized) alt.gnUrl = gnDedup.normalized
							if (gnDedup?.skip) {
								logEvent(e, {
									phase: 'fallback_dedupe',
									status: 'skip',
									reason: gnDedup.reason || '',
									candidateSource: alt.source,
									level: alt.level,
									gnUrl: alt.gnUrl,
								}, `#${e.id} fallback skip (${alt.source})`, 'info')
								logCandidateDecision(e, alt, 'rejected', gnDedup.reason || 'duplicate', { phase: 'fallback_attempt' })
								return { fetched: false, skipped: true }
							}
							if (!allowWait) {
								let waitMs = (last.urlDecode.time + last.urlDecode.delay) - Date.now()
								if (waitMs > 0) {
									if (logDeferredCandidates) {
										logEvent(e, {
											phase: 'fallback_decode',
											status: 'deferred',
											candidateSource: alt.source,
											level: alt.level,
											method: decodeMethod,
											waitMs,
										}, `#${e.id} fallback decode deferred (${alt.source})`, 'info')
									}
									return { deferred: true }
								}
							}
							altUrl = await decodeUrl(alt.gnUrl, last)
						}
						if (!altUrl) {
							logEvent(e, {
								phase: 'fallback_decode',
								status: 'fail',
								candidateSource: alt.source,
								level: alt.level,
								method: decodeMethod,
							}, `#${e.id} fallback decode failed (${alt.source})`, 'warn')
							logCandidateDecision(e, alt, 'rejected', 'decode_fail', { phase: 'fallback_attempt' })
							return { fetched: false }
						}
						let dedupe = checkCandidateDedup(e, altUrl)
						if (dedupe?.normalized) altUrl = dedupe.normalized
						if (dedupe?.skip) {
							logEvent(e, {
								phase: 'fallback_dedupe',
								status: 'skip',
								reason: dedupe.reason || '',
								candidateSource: alt.source,
								level: alt.level,
								url: altUrl,
							}, `#${e.id} fallback skip (${alt.source})`, 'info')
							logCandidateDecision(e, alt, 'rejected', dedupe.reason || 'duplicate', { phase: 'fallback_attempt' })
							return { fetched: false, skipped: true }
						}
						let cooldown = isDomainInCooldown(altUrl)
						if (cooldown) {
							logEvent(e, {
								phase: 'fallback_filter',
								status: 'skip',
								reason: 'domain_cooldown',
								candidateSource: alt.source,
								level: alt.level,
								url: altUrl,
								host: cooldown.host,
								remainingMs: cooldown.remainingMs,
							}, `#${e.id} fallback skip (${alt.source}) domain cooldown`, 'warn')
							logCandidateDecision(e, alt, 'rejected', 'domain_cooldown', { phase: 'fallback_attempt' })
							return { fetched: false, skipped: true }
						}
						log('Trying alternative source', alt.source, `(level ${alt.level})...`)
						if (!alt.url) alt.url = altUrl
						logCandidateDecision(e, alt, 'attempt', attemptReason, { phase: 'fallback_attempt' })
						let origin = alt.origin || alt.provider || alt.from || ''
						logEvent(e, {
							phase: 'fallback_decode',
							status: 'ok',
							candidateSource: alt.source,
							level: alt.level,
							method: decodeMethod,
							url: altUrl,
						}, `#${e.id} fallback url decoded (${alt.source})`, 'ok')

						let cacheResult = await tryCache(e, altUrl, { isFallback: true, origin, last, contentSource: alt.source || '' })
						if (cacheResult?.ok) {
							applyFallbackSelection(e, alt, altUrl)
							fetched = true
							logEvent(e, {
								phase: 'fallback_selected',
								status: 'ok',
								candidateSource: alt.source,
								level: alt.level,
							}, `#${e.id} fallback selected ${alt.source}`, 'ok')
							logCandidateDecision(e, alt, 'selected', attemptReason, { phase: 'fallback_attempt' })
							return { fetched: true, cached: true }
						}
						if (cacheResult?.final) {
							logCandidateDecision(e, alt, 'rejected', `cache_${cacheResult.status || 'skip'}`, { phase: 'fallback_attempt' })
							return { fetched: false, cached: true }
						}

						let result = await fetchTextWithRetry(e, altUrl, last, { isFallback: true, origin, candidateHints: buildCandidateHints(alt) })
						if (result?.ok) {
							applyFallbackSelection(e, alt, altUrl)
							saveArticle(e, result.html, result.text, result.url || altUrl || '', { status: 'ok', method: result.method || 'fetch' })
							applyVerifyStatus(e, result.verify)
							setContentSource(e, {
								url: result.url || altUrl || '',
								source: e.source || alt.source || '',
								method: result.method || 'fetch',
								isFallback: true,
							})
							fetched = true
							logEvent(e, {
								phase: 'fallback_selected',
								status: 'ok',
								candidateSource: alt.source,
								level: alt.level,
							}, `#${e.id} fallback selected ${alt.source}`, 'ok')
							logCandidateDecision(e, alt, 'selected', attemptReason, { phase: 'fallback_attempt' })
							return { fetched: true }
						} else if (result?.mismatch) {
							if (result?.html || result?.text) {
								saveArticle(e, result.html || '', result.text || '', result.url || altUrl || '', { status: 'mismatch', method: result.method || 'fetch', mutateEvent: false })
							} else {
								writeCacheMeta(e, altUrl, { status: 'mismatch', method: result.method || 'fetch' })
							}
							logEvent(e, {
								phase: 'fallback_verify_mismatch',
								status: 'fail',
								candidateSource: alt.source,
								level: alt.level,
								pageSummary: result?.verify?.pageSummary,
								reason: result?.verify?.reason,
							}, `#${e.id} fallback text mismatch (${alt.source})`, 'warn')
							logCandidateDecision(e, alt, 'rejected', 'verify_mismatch', { phase: 'fallback_attempt' })
						} else if (result?.short) {
							saveArticle(e, result.html || '', '', result.url || altUrl || '', { status: 'short', method: result.method || 'fetch', mutateEvent: false })
							logCandidateDecision(e, alt, 'rejected', 'short', { phase: 'fallback_attempt' })
						} else if (result?.blocked) {
							writeCacheMeta(e, altUrl, { status: 'blocked', method: result.method || 'fetch' })
							let blockedReason = result?.status ? `blocked_${result.status}` : 'blocked'
							logCandidateDecision(e, alt, 'rejected', blockedReason, { phase: 'fallback_attempt' })
						} else {
							let reason = result?.status || (result?.rateLimited ? 'rate_limited' : 'no_text')
							logCandidateDecision(e, alt, 'rejected', reason, { phase: 'fallback_attempt' })
						}
						return { fetched: false }
					}

					let inlineCandidates = Array.isArray(e._inlineCandidates) ? e._inlineCandidates : []
					if (inlineCandidates.length) {
						for (let alt of inlineCandidates) {
							let res = await tryAlternative(alt, { allowWait: true, reason: alt.reason || 'canonical' })
							if (res?.fetched) {
								fetched = true
								break
							}
						}
					}

					if (!fetched) {
						let alternatives = getAlternativeArticles(e)
						let classified = null
						if (!alternatives.length) {
							let gnResults = await fetchGnCandidates(e, last)
							classified = classifyAlternativeCandidates(e, gnResults)
							alternatives = classified.accepted
						}
						if (!classified) {
							classified = classifyAlternativeCandidates(e, alternatives)
							alternatives = classified.accepted
						}
						if (classified.accepted.length || classified.rejected.length) {
							for (let alt of classified.accepted) {
								logCandidateDecision(e, alt, 'accepted', e._fallbackReason || '', { phase: 'fallback_candidate' })
							}
							for (let alt of classified.rejected) {
								logCandidateDecision(e, alt, 'rejected', alt.reason || 'filtered', { phase: 'fallback_candidate' })
							}
						}

						if (!alternatives.length) {
							logEvent(e, {
								phase: 'fallback_candidates',
								status: 'empty',
							}, `#${e.id} no fallback candidates`, 'warn')
						}

						let deferredCandidate = null

						for (let j = 0; j < alternatives.length; j++) {
							let alt = alternatives[j]
							let res = await tryAlternative(alt, { allowWait: false })
							if (res?.deferred) {
								deferredCandidate = alt
								break
							}
							if (res?.fetched) break
						}
						if (!fetched && deferredCandidate) {
							let res = await tryAlternative(deferredCandidate, { allowWait: true })
							if (res?.fetched) fetched = true
						}
						if (!fetched) {
							let externalResults = []
							if (!externalSearch?.enabled) {
								logEvent(e, {
									phase: 'serpapi_search',
									status: 'skipped',
									reason: 'disabled',
									provider: externalSearch?.provider || '',
								}, `#${e.id} serpapi search skipped (disabled)`, 'warn')
							} else if (!externalSearch.apiKey) {
								logEvent(e, {
									phase: 'serpapi_search',
									status: 'skipped',
									reason: 'missing_api_key',
									provider: externalSearch.provider,
								}, `#${e.id} serpapi search skipped (missing api key)`, 'warn')
							} else {
								let queryInfo = await buildFallbackSearchQueriesWithAi(e, { allowAi: true })
								logSearchQueryContext(e, { phase: 'serpapi_search', queryInfo, provider: externalSearch.provider })
								if (queryInfo?.error) {
									let scope = queryInfo?.provider === 'xai' ? 'xai' : 'openai'
									let info = describeError(queryInfo.error, { scope })
									let actionNote = info.action ? ` action=${info.action}` : ''
									let message = `#${e.id} serpapi ai query failed ${info.summary || 'unknown'}${actionNote}`
									runLogger.logLine(message, message)
									logEvent(e, {
										phase: 'serpapi_query_ai',
										status: 'fail',
										reason: info.summary || '',
										action: info.action || '',
										provider: queryInfo?.provider || '',
										model: queryInfo?.model || '',
									}, message, 'warn')
								}
								let queries = Array.isArray(queryInfo?.queries) ? queryInfo.queries : []
								if (!queries.length) {
									let skipReason = queryInfo?.reason || 'no_queries'
									logEvent(e, {
										phase: 'serpapi_search',
										status: 'skipped',
										reason: skipReason,
										provider: externalSearch.provider,
									}, `#${e.id} serpapi search skipped (${skipReason})`, 'warn')
								} else {
									for (let query of queries) {
										logSearchQuery(e, { phase: 'serpapi_search', provider: externalSearch.provider, query, reason: queryInfo?.reason || getSearchQuerySource(e) })
										let results = await searchExternal(query)
										logSearchResults(e, { phase: 'serpapi_search', provider: externalSearch.provider, query, results })
										if (results.length) externalResults.push(...results)
									}
								}
							}
							if (externalResults.length && !fetched) {
								let externalClassified = classifyAlternativeCandidates(e, externalResults)
								let externalAlternatives = externalClassified.accepted
								for (let alt of externalClassified.accepted) {
									logCandidateDecision(e, alt, 'accepted', e._fallbackReason || '', { phase: 'serpapi_candidate', provider: externalSearch?.provider || '' })
								}
								for (let alt of externalClassified.rejected) {
									logCandidateDecision(e, alt, 'rejected', alt.reason || 'filtered', { phase: 'serpapi_candidate', provider: externalSearch?.provider || '' })
								}
								if (externalAlternatives.length) {
									let deferredExternal = null
									for (let alt of externalAlternatives) {
										let res = await tryAlternative(alt, { allowWait: false })
										if (res?.deferred) {
											deferredExternal = alt
											break
										}
										if (res?.fetched) {
											fetched = true
											break
										}
									}
									if (!fetched && deferredExternal) {
										let res = await tryAlternative(deferredExternal, { allowWait: true })
										if (res?.fetched) fetched = true
									}
								}
							}
						}
						if (!fetched) {
							logEvent(e, {
								phase: 'fallback_failed',
								status: 'fail',
							}, `#${e.id} fallback exhausted`, 'warn')
						}
					}
				}
			}

			if (needsTextFields && e.text?.length > minTextLength) {
				let aiWaitMs = last.ai.time + last.ai.delay - Date.now()
				if (aiWaitMs > 0) {
					progressTracker?.step(e, 'summarize', 'wait')
					await sleep(aiWaitMs)
				}
				last.ai.time = Date.now()
				log('Summarizing', e.text.length, 'chars...')
				let summarizeStart = Date.now()
				progressTracker?.step(e, 'summarize', 'start')
				let res = await ai({
					url: e.url,
					text: e.text,
					titleEn: e.titleEn,
					titleRu: e.titleRu,
					source: e.source,
					id: e.id,
					meta: e._contentMeta,
				})
				let summarizeMs = Date.now() - summarizeStart
				logEvent(e, {
					phase: 'summarize',
					status: res ? 'ok' : 'empty',
					durationMs: summarizeMs,
					inputChars: e.text?.length || 0,
					outputChars: res?.summary?.length || 0,
				}, `#${e.id} summarize ${summarizeMs}ms`, res ? 'info' : 'warn')
				if (res?.model) {
					progressTracker?.setSummarizeModel?.(e, res.model)
				}
				progressTracker?.setDuration?.(e, 'summarize', summarizeMs)
				progressTracker?.step(e, 'summarize', res ? 'ok' : 'fail', res?.summary ? truncate(res.summary, 160) : undefined)
				if (res) {
					last.ai.delay = res.delay
					e.topic ||= topicsMap[res.topic]
					e.priority ||= res.priority
					e.titleRu ||= res.titleRu
					if (isBlank(e.summary)) e.summary = res.summary
					if (isBlank(e.aiTopic)) e.aiTopic = topicsMap[res.topic]
					if (isBlank(e.aiPriority)) e.aiPriority = res.priority
				}
			} else if (!needsTextFields) {
				progressTracker?.step(e, 'summarize', 'skipped', 'already filled')
			}

			progressTracker?.flushSubsteps?.(e)
			if (!e.summary) {
				logEvent(e, {
					phase: 'summary',
					status: 'missing',
				}, `#${e.id} summary missing`, 'warn')
				progressTracker?.step(e, 'summarize', 'fail', 'summary missing')
			}
			if (isBlank(e.gnUrl) && !isBlank(base.gnUrl)) {
				e.gnUrl = base.gnUrl
			}
			let missing = missingFields(e)
			let complete = missing.length === 0
			let verifiedOk = e._verifyStatus === 'ok' || e._verifyStatus === 'skipped'
			if (!complete || !verifiedOk) {
				failures.push({
					id: e.id,
					title: titleFor(e),
					source: e.source || '',
					url: e.url || '',
					phase: e._lastPhase || '',
					status: e._lastStatus || '',
					method: e._lastMethod || '',
					reason: missing.length
						? `missing: ${missing.join(', ')}`
						: (verifiedOk ? (e._lastReason || '') : `verify status: ${e._verifyStatus || 'unknown'}`),
				})
			}
			if (complete && verifiedOk) stats.ok++
			else stats.fail++
			commitEvent(base, e)
			if (rowIndex > 0) {
				progressTracker?.step(e, 'write', 'start')
				let saved = await saveRowByIndex(rowIndex + 1, base)
				progressTracker?.step(e, 'write', saved ? 'ok' : 'fail')
			} else {
				log(`[warn] #${e.id} row index not found; save skipped`)
				progressTracker?.step(e, 'write', 'fail', 'row index not found')
			}
		}
		let order = e => (+e.sqk || 999) * 1000 + (topics[e.topic]?.id ?? 99) * 10 + (+e.priority || 10)
		news.sort((a, b) => order(a) - order(b))

		if (failures.length) {
			let limit = summarizeConfig.failSummaryLimit || 0
			runLogger.logLine(`Failed rows: ${failures.length}`, `Failed rows: ${failures.length}`)
			let items = limit > 0 ? failures.slice(0, limit) : failures
			for (let item of items) {
				let meta = [item.phase, item.status, item.method].filter(Boolean).join('/')
				let parts = [item.title, item.source, meta].filter(Boolean)
				if (item.reason) parts.push(item.reason)
				runLogger.logLine(`[fail] #${item.id} ${parts.join(' | ')}`, `[fail] #${item.id} ${parts.join(' | ')}`)
			}
			if (limit > 0 && failures.length > limit) {
				runLogger.logLine(`... ${failures.length - limit} more`, `... ${failures.length - limit} more`)
			}
		}
		finalyze()
		let copyStatusLine = ''
		if (isSummarizeCli) {
			if (!coffeeTodayFolderId) {
				copyStatusLine = 'copy spreadsheet: skipped (coffeeTodayFolderId not set)'
			} else {
				try {
					let { copyFile } = await import('./google-drive.js')
					await copyFile(spreadsheetId, coffeeTodayFolderId, 'news-today')
					copyStatusLine = `copy spreadsheet: ${spreadsheetId} -> ${coffeeTodayFolderId} (ok)`
				} catch (e) {
					let status = e?.status || e?.code
					let reason = e?.errors?.[0]?.reason
					let message = e?.errors?.[0]?.message || e?.message || ''
					let guidance = describeError(e, {
						scope: 'drive',
						resource: 'folder',
						id: coffeeTodayFolderId,
						email: process.env.SERVICE_ACCOUNT_EMAIL,
					})
					let action = guidance.action ? ` action=${guidance.action}` : ''
					if (status === 404 || reason === 'notFound') {
						copyStatusLine = `copy spreadsheet: skipped (folder not found or no access${action ? `;${action}` : ''})`
					} else {
						let suffix = [
							status ? `status=${status}` : '',
							reason ? `reason=${reason}` : '',
							message ? `msg=${message}` : '',
							guidance.action ? `action=${guidance.action}` : '',
						].filter(Boolean).join(' ')
						copyStatusLine = `copy spreadsheet: failed${suffix ? ` (${suffix})` : ''}`
					}
				}
			}
		}
		let runMs = Date.now() - runStart
		let footer = [
			`sheet read/write: ${spreadsheetId} (sheet=${newsSheet}, mode=${spreadsheetMode})`,
			logging.fetchLogFile ? `fetch log: ${logging.fetchLogFile}` : '',
			`run time: ${formatDuration(runMs) || `${Math.round(runMs)}ms`}`,
			`rows: ${stats.ok}/${stats.ok + stats.fail} ok`,
			copyStatusLine,
		]
		for (let line of footer.filter(Boolean)) {
			runLogger.logLine(line, line)
		}
		runLogger.logLine(`stats: ok=${stats.ok} fail=${stats.fail}`, `stats: ok=${stats.ok} fail=${stats.fail}`)
		return stats
	} catch (error) {
		if (error?.code === 'VERIFY_FATAL') {
			let modelNote = error?.model ? ` model=${error.model}` : ''
			let actionNote = error?.action ? ` action=${error.action}` : ''
			let message = error?.message || 'verify unavailable'
			runLogger.logLine(`[fatal] ${message}${modelNote}${actionNote}`, `[fatal] ${message}${modelNote}${actionNote}`)
			try {
				await finalyze()
			} catch {}
			if (isSummarizeCli) process.exitCode = 1
			return stats
		} else if (error?.code === 'SEARCH_QUERY_FATAL') {
			let provider = error?.provider || ''
			let model = error?.model || ''
			let scope = provider === 'xai' ? 'xai' : 'openai'
			let guidance = describeError(error?.cause || error, { scope })
			let actionNote = guidance?.action ? ` action=${guidance.action}` : ''
			let message = error?.message || 'search query unavailable'
			let modelNote = model ? ` model=${model}` : ''
			let providerNote = provider ? ` provider=${provider}` : ''
			runLogger.logLine(`[fatal] ${message}${providerNote}${modelNote}${actionNote}`, `[fatal] ${message}${providerNote}${modelNote}${actionNote}`)
			try {
				await finalyze()
			} catch {}
			if (isSummarizeCli) process.exitCode = 1
			return stats
		} else if (error?.code === 'BROWSER_CLOSED') {
			runLogger.logLine('[fatal] browser window closed; stopping summarize', '[fatal] browser window closed; stopping summarize')
		}
		throw error
	} finally {
		globalThis.__LOG_SUPPRESS = false
		if (!isSummarizeCli) globalThis.__LOG_SUPPRESS_ALL = wasSuppressAll
		await resumeAutoSave({ flush: false })
	}
}

if (process.argv[1].endsWith('summarize')) {
	;(async () => {
		await summarize()
	})()
}
