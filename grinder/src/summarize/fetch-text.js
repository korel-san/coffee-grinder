import { JSDOM, VirtualConsole } from 'jsdom'
import { htmlToText } from 'html-to-text'

import { log } from '../log.js'
import { extractMetaFromHtml } from '../meta-extract.js'
import { classifyHtmlState } from '../services/playwright.js'
import { summarizeConfig } from '../../config/summarize.js'
import { describeError } from '../error-guidance.js'

export const minTextLength = 400
const maxHtmlToTextChars = 4_000_000

const jsdomVirtualConsole = new VirtualConsole()
jsdomVirtualConsole.on('jsdomError', () => {})
jsdomVirtualConsole.on('error', () => {})
jsdomVirtualConsole.on('warn', () => {})

function extractJsonText(document) {
	let scripts = [...document.querySelectorAll('script[type="application/ld+json"]')]
	let buckets = { body: [], text: [], desc: [] }
	let seen = new Set()
	let collect = node => {
		if (!node || typeof node !== 'object') return
		if (seen.has(node)) return
		seen.add(node)
		if (typeof node.articleBody === 'string') buckets.body.push(node.articleBody)
		if (typeof node.text === 'string') buckets.text.push(node.text)
		if (typeof node.description === 'string') buckets.desc.push(node.description)
		Object.values(node).forEach(collect)
	}
	for (let script of scripts) {
		let raw = script.textContent?.trim()
		if (!raw) continue
		try {
			collect(JSON.parse(raw))
		} catch {
			continue
		}
	}
	let pick = list => list.sort((a, b) => b.length - a.length)[0]
	let candidate =
		pick(buckets.body) ||
		pick(buckets.text) ||
		pick(buckets.desc)
	if (candidate && candidate.length > minTextLength) return candidate.trim()
}

export function classifyPageState(html, meta = {}) {
	let title = meta?.title || meta?.metaTitle || ''
	return classifyHtmlState(html || '', title || '')
}

export function stripHtmlFast(html, limit = maxHtmlToTextChars) {
	let input = html || ''
	if (limit && input.length > limit) input = input.slice(0, limit)
	let text = input.replace(/<[^>]+>/g, ' ')
	text = text.replace(/\s+/g, ' ').trim()
	return text
}

function safeHtmlToText(html) {
	if (!html) return ''
	if (html.length > maxHtmlToTextChars) {
		log('html too large for html-to-text', html.length, 'chars')
		return stripHtmlFast(html)
	}
	try {
		return htmlToText(html)?.trim() || ''
	} catch (error) {
		log('html-to-text failed', error?.message || error)
		return stripHtmlFast(html)
	}
}

function extractDomText(document) {
	const selectors = [
		'[itemprop="articleBody"]',
		'article',
		'main',
		'.article-body',
		'.article-body__content',
		'.story-body',
		'.content__article-body',
		'.ArticleBody',
		'.ArticleBody-articleBody',
	]
	let best = ''
	for (let selector of selectors) {
		let nodes = [...document.querySelectorAll(selector)]
		for (let node of nodes) {
			let text = safeHtmlToText(node.innerHTML || '')
			if (text && text.length > best.length) {
				best = text
			}
		}
	}
	if (best.length > minTextLength) return best
}

export function extractText(html) {
	if (!html) return
	let cleaned = html.replace(/<style[\s\S]*?<\/style>/gi, '')
	if (!/<[a-z][\s\S]*>/i.test(cleaned)) {
		let plain = cleaned.trim()
		if (plain.length > minTextLength) return plain
	}
	try {
		let dom = new JSDOM(cleaned, { virtualConsole: jsdomVirtualConsole })
		let doc = dom.window.document
		let jsonText = extractJsonText(doc)
		if (jsonText) return jsonText
		let domText = extractDomText(doc)
		if (domText) return domText
	} catch {}
	let text = safeHtmlToText(cleaned)
	if (!text || text.length <= minTextLength) return
	return text
}

export function createFetchTextWithRetry(deps = {}) {
	const {
		fetchArticle,
		browseArticle,
		verifyText,
		logEvent,
		getLastFetchStatus,
		applyContentMeta,
		formatVerifyNote,
		getProgressTracker,
	} = deps

	const mergeCandidateMeta = (meta = {}, hints = {}) => {
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

	const logEventFn = typeof logEvent === 'function' ? logEvent : () => {}
	const getLastFetchStatusFn = typeof getLastFetchStatus === 'function' ? getLastFetchStatus : () => null
	const applyContentMetaFn = typeof applyContentMeta === 'function' ? applyContentMeta : () => {}
	const formatVerifyNoteFn = typeof formatVerifyNote === 'function' ? formatVerifyNote : () => ''
	const getProgress = typeof getProgressTracker === 'function' ? getProgressTracker : () => null

	return async function fetchTextWithRetry(event, url, last, { isFallback = false, origin = '', candidateHints = null } = {}) {
		let foundText = false
		let lastPageState = null
		let shortHtml = ''
		let shortMethod = ''
		let shortTextLength = 0
		let candidateMetaSnapshot = null
		let candidateCanonicalUrl = ''
		let hints = candidateHints && typeof candidateHints === 'object' ? candidateHints : {}
		let fetchSkippedReason = ''
		const formatStepNote = info => {
			if (!info || typeof info !== 'object') return ''
			let parts = []
			if (info.attempt) parts.push(`attempt=${info.attempt}`)
			if (info.status) parts.push(`status=${info.status}`)
			if (info.host) parts.push(`host=${info.host}`)
			if (info.source) parts.push(`source=${info.source}`)
			if (info.reason) parts.push(`reason=${info.reason}`)
			if (info.snapshot) parts.push(`snapshot=${info.snapshot}`)
			if (info.bytes) parts.push(`len=${info.bytes}`)
			return parts.join(' ')
		}
		const onFetchStep = (step, status, info) => {
			if (step === 'fetch' && status === 'skipped') {
				fetchSkippedReason = info?.reason || 'skipped'
			}
			let progressTracker = getProgress()
			progressTracker?.step(event, step, status, formatStepNote(info))
		}
		const onBrowseStep = (step, status, info) => {
			let progressTracker = getProgress()
			progressTracker?.step(event, step, status, formatStepNote(info))
		}
		const normalizeFetchStatus = value => {
			if (value === null || value === undefined) return ''
			if (typeof value === 'number') return value
			let text = String(value).trim().toLowerCase()
			if (/^\\d+$/.test(text)) return Number(text)
			return text
		}
		const isNonRetryableStatus = status => {
			return status === 429 || status === 403 || status === 401 || status === 503 || status === 'captcha'
		}
		let progressTracker = getProgress()
		progressTracker?.setContext?.(event, { url, isFallback, kind: 'net', origin })
		let lastFailureStatus = null
		let lastFailureMethod = null
		for (let attempt = 1; attempt <= 2; attempt++) {
			let blockedStatus = null
			let mismatchResult = null
			let mismatchHtml = null
			let mismatchText = null
			let mismatchMethod = ''
			let browsePromise = null
			let browseStarted = false
			let fetchMethod = ''
			let fetchMeta = null
			let fetchStepLogged = false
			let onFetchMethod = method => {
				fetchMethod = method
				if (['fetch', 'jina', 'archive', 'wayback', 'wayback-jina'].includes(method)) lastFailureMethod = method
				if (method === 'captcha') {
					lastFailureStatus = 'captcha'
					lastFailureMethod = 'fetch'
					progressTracker = getProgress()
					progressTracker?.step(event, 'fetch', 'captcha')
					let durationMs = progressTracker?.getDuration?.(event, 'fetch')
					progressTracker?.setContextContent?.(event, { status: 'captcha', method: 'fetch', ms: durationMs })
					fetchStepLogged = true
				}
				if (method === 'timeout') {
					lastFailureStatus = 'timeout'
					lastFailureMethod = 'fetch'
					progressTracker = getProgress()
					progressTracker?.step(event, 'fetch', 'timeout')
					let durationMs = progressTracker?.getDuration?.(event, 'fetch')
					progressTracker?.setContextContent?.(event, { status: 'timeout', method: 'fetch', ms: durationMs })
					fetchStepLogged = true
				}
			}
			let updateContentFromMethod = methodLabel => {
				if (!methodLabel) return
				let normalized = String(methodLabel).toLowerCase()
				let durationMs = null
				progressTracker = getProgress()
				if (normalized === 'cache') durationMs = 0
				else if (normalized === 'fetch') durationMs = progressTracker?.getDuration?.(event, 'fetch')
				else if (normalized === 'jina') durationMs = progressTracker?.getDuration?.(event, 'jina')
				else if (normalized === 'archive') durationMs = progressTracker?.getDuration?.(event, 'archive')
				else if (normalized === 'wayback' || normalized === 'wayback-jina') durationMs = progressTracker?.getDuration?.(event, 'wayback')
				else if (normalized === 'browse' || normalized === 'playwright') durationMs = progressTracker?.getDuration?.(event, 'playwright')
				if (Number.isFinite(durationMs)) progressTracker?.setDuration?.(event, 'content', durationMs)
				progressTracker?.setContextContent?.(event, { status: 'ok', method: methodLabel, ms: durationMs })
			}
			let startBrowse = async () => {
				browseStarted = true
				let html = ''
				let meta = {}
				let browseFailed = false
				let aborted = false
				let abortReason = ''
				progressTracker = getProgress()
				progressTracker?.step(event, 'playwright', 'start')
				try {
					let result = await browseArticle(url, { ignoreCooldown: !isFallback, onStep: onBrowseStep, quiet: true })
					if (result && typeof result === 'object') {
						html = result.html || ''
						meta = result.meta || {}
						aborted = Boolean(result.aborted)
						abortReason = result.abortReason || ''
					} else {
						html = result || ''
					}
				} catch (error) {
					if (error?.code === 'BROWSER_CLOSED') throw error
					if (error?.code === 'CAPTCHA') {
						let guidance = describeError({ code: 'CAPTCHA' }, { scope: 'playwright' })
						let action = guidance.action ? ` | action: ${guidance.action}` : ''
						logEventFn(event, {
							phase: 'browse',
							method: 'browse',
							status: 'captcha',
							attempt,
							action: guidance.action,
						}, `#${event.id} browse captcha${action}`, 'warn')
						progressTracker = getProgress()
						progressTracker?.step(event, 'playwright', 'captcha')
						let durationMs = progressTracker?.getDuration?.(event, 'playwright')
						progressTracker?.setContextContent?.(event, { status: 'captcha', method: 'playwright', ms: durationMs })
						return { html: '', meta: {}, browseFailed: false, aborted: true, abortReason: 'captcha' }
					}
					if (error?.code === 'TIMEOUT') {
						let guidance = describeError({ code: 'TIMEOUT' }, { scope: 'playwright' })
						let action = guidance.action ? ` | action: ${guidance.action}` : ''
						logEventFn(event, {
							phase: 'browse',
							method: 'browse',
							status: 'timeout',
							attempt,
							action: guidance.action,
						}, `#${event.id} browse timeout${action}`, 'warn')
						progressTracker = getProgress()
						progressTracker?.step(event, 'playwright', 'timeout')
						let durationMs = progressTracker?.getDuration?.(event, 'playwright')
						progressTracker?.setContextContent?.(event, { status: 'timeout', method: 'playwright', ms: durationMs })
						return { html: '', meta: {}, browseFailed: true, aborted: true, abortReason: 'timeout' }
					}
					browseFailed = true
					let guidance = describeError({ code: error?.code || 'ERROR' }, { scope: 'playwright' })
					let action = guidance.action ? ` | action: ${guidance.action}` : ''
					logEventFn(event, {
						phase: 'browse',
						method: 'browse',
						status: 'error',
						error: error?.message || String(error),
						errorCode: error?.code || '',
						action: guidance.action,
					}, `#${event.id} browse failed${action}`, 'warn')
					html = ''
					return { html: '', meta: {}, browseFailed: true, aborted: true, abortReason: 'error' }
				}
				return { html, meta, browseFailed, aborted, abortReason }
			}
			let html = await fetchArticle(url, { onMethod: onFetchMethod, onStep: onFetchStep })
			if (html) fetchMeta = extractMetaFromHtml(html)
			if (fetchMeta && Object.values(fetchMeta).some(Boolean)) {
				let mergedMeta = mergeCandidateMeta(fetchMeta, hints)
				candidateMetaSnapshot = candidateMetaSnapshot || mergedMeta
				if (mergedMeta?.canonicalUrl && !candidateCanonicalUrl) candidateCanonicalUrl = mergedMeta.canonicalUrl
			} else if (hints && Object.values(hints).some(Boolean) && !candidateMetaSnapshot) {
				candidateMetaSnapshot = mergeCandidateMeta({}, hints)
			}
			let lastStatus = getLastFetchStatusFn(url)
			if (fetchSkippedReason) {
				lastStatus = null
				lastFailureStatus = fetchSkippedReason
				lastFailureMethod = 'fetch'
			}
			let text = extractText(html)
			let shortByText = false
			if (text && text.length < minTextLength) {
				shortByText = true
				shortHtml = html
				shortMethod = fetchMethod || 'fetch'
				shortTextLength = text.length
				lastFailureStatus = 'short'
				lastFailureMethod = shortMethod
				logEventFn(event, {
					phase: 'fetch',
					method: shortMethod,
					status: 'short',
					attempt,
					textLength: text.length,
				}, `#${event.id} ${(shortMethod || 'fetch')} short (${text.length})`, 'warn')
				text = ''
			}
			let fetchState = classifyPageState(html, fetchMeta)
			lastPageState = fetchState
			let normalizedStatus = normalizeFetchStatus(lastStatus || lastFailureStatus)
			if (!text && isNonRetryableStatus(normalizedStatus)) {
				let statusLabel = normalizedStatus === 'captcha'
					? 'captcha'
					: (normalizedStatus === 429 || normalizedStatus === 503 ? 'rate_limited' : 'forbidden')
				let guidance = describeError({ status: normalizedStatus, reason: statusLabel }, { scope: 'fetch' })
				let action = guidance.action ? ` | action: ${guidance.action}` : ''
				if (!fetchStepLogged) {
					logEventFn(event, {
						phase: 'fetch',
						method: 'fetch',
						status: statusLabel,
						attempt,
						httpStatus: typeof normalizedStatus === 'number' ? normalizedStatus : undefined,
						action: guidance.action,
					}, `#${event.id} fetch ${statusLabel} (${normalizedStatus})${action}`, 'warn')
					progressTracker = getProgress()
					if (statusLabel === 'rate_limited') progressTracker?.step(event, 'fetch', 'rate_limit')
					else if (statusLabel === 'captcha') progressTracker?.step(event, 'fetch', 'captcha')
					else progressTracker?.step(event, 'fetch', 'error')
					fetchStepLogged = true
				}
				lastFailureStatus = statusLabel
				lastFailureMethod = 'fetch'
				blockedStatus = normalizedStatus
				let durationMs = progressTracker?.getDuration?.(event, 'fetch') || 0
				progressTracker?.setContextContent?.(event, {
					status: statusLabel === 'forbidden' ? 'error' : (statusLabel === 'rate_limited' ? 'rate_limit' : 'captcha'),
					method: 'fetch',
					ms: durationMs,
				})
				progressTracker?.step(event, 'content', statusLabel === 'forbidden' ? 'error' : (statusLabel === 'rate_limited' ? 'rate_limit' : 'captcha'), 'fetch')
			}
			if (!text && lastStatus === 504) {
				progressTracker = getProgress()
				progressTracker?.step(event, 'fetch', '504')
				lastFailureStatus = '504'
				lastFailureMethod = 'fetch'
			}
			if (!text && !lastFailureStatus) {
				progressTracker = getProgress()
				progressTracker?.step(event, 'fetch', 'no_text')
				lastFailureStatus = 'no_text'
				lastFailureMethod = 'fetch'
			}
			if (text) {
				foundText = true
				logEventFn(event, {
					phase: 'fetch',
					method: fetchMethod || 'fetch',
					status: 'ok',
					attempt,
					textLength: text.length,
				}, `#${event.id} ${(fetchMethod || 'fetch')} ok (${attempt}/2)`, 'ok')
				let methodLabel = fetchMethod || 'fetch'
				progressTracker = getProgress()
				progressTracker?.step(event, 'playwright', 'skipped', 'fetch ok')
				progressTracker?.logTextSample?.(event, text, 'text')
				updateContentFromMethod(methodLabel)
				let verifyMeta = mergeCandidateMeta(fetchMeta, hints)
				let verify = await verifyText({ event, url, text, isFallback, method: methodLabel, attempt, last, contextKind: 'net', candidateMeta: verifyMeta })
				if (verify?.ok) {
					let overallStatus = verify?.status === 'skipped' ? 'skipped' : (verify?.status === 'unverified' ? 'unverified' : 'ok')
					if (Number.isFinite(verify?.durationMs)) {
						progressTracker = getProgress()
						progressTracker?.setDuration?.(event, 'verify', verify.durationMs)
					}
					let verifyNote = formatVerifyNoteFn(verify)
					let note = methodLabel
					if (verifyNote) note = `${note} ${verifyNote}`
					progressTracker = getProgress()
					progressTracker?.step(event, 'verify', overallStatus, note)
					if (fetchMeta && Object.values(fetchMeta).some(Boolean)) {
						applyContentMetaFn(event, fetchMeta, methodLabel)
					}
					return { ok: true, html, text, verify, method: methodLabel, url, meta: verifyMeta, canonicalUrl: candidateCanonicalUrl }
				}
				if (verify?.status === 'mismatch') {
					mismatchResult = verify
					mismatchHtml = html
					mismatchText = text
					mismatchMethod = methodLabel
					if (Number.isFinite(verify?.durationMs)) {
						progressTracker = getProgress()
						progressTracker?.setDuration?.(event, 'verify', verify.durationMs)
					}
					let verifyNote = formatVerifyNoteFn(verify)
					let note = methodLabel
					if (verifyNote) note = `${note} ${verifyNote}`
					progressTracker = getProgress()
					progressTracker?.step(event, 'verify', 'mismatch', note)
				}
			} else {
				if (!shortByText && html) {
					let preview = stripHtmlFast(html, 400)
					if (preview) {
						progressTracker = getProgress()
						progressTracker?.logTextSample?.(event, preview, 'preview')
					}
					let probe = stripHtmlFast(html, 4000)
					if (probe && probe.length > 0 && probe.length <= minTextLength) {
						shortHtml = html
						shortMethod = fetchMethod || 'fetch'
						shortTextLength = probe.length
						lastFailureStatus = 'short'
						lastFailureMethod = shortMethod
					}
				}
				if (!shortByText) {
					let guidance = describeError({ reason: 'no_text' }, { scope: 'fetch' })
					let action = guidance.action ? ` | action: ${guidance.action}` : ''
					logEventFn(event, {
						phase: 'fetch',
						method: 'fetch',
						status: 'no_text',
						attempt,
						pageState: fetchState?.state || '',
						pageStateReason: fetchState?.reason || '',
						action: guidance.action,
					}, `#${event.id} fetch no text (${attempt}/2)${action}`, 'warn')
				}
			}

			if (mismatchResult && !summarizeConfig.browseOnMismatch) {
				progressTracker = getProgress()
				progressTracker?.step(event, 'playwright', 'skipped', 'mismatch')
				return { ok: false, mismatch: true, verify: mismatchResult, html: mismatchHtml, text: mismatchText, method: mismatchMethod || fetchMethod || 'fetch', url, meta: candidateMetaSnapshot, canonicalUrl: candidateCanonicalUrl }
			}

			if (!browsePromise) browsePromise = startBrowse()
			let browseResult = await browsePromise
			html = browseResult?.html || ''
			let browseMeta = browseResult?.meta || {}
			if (!browseMeta || !Object.values(browseMeta).some(Boolean)) {
				browseMeta = html ? extractMetaFromHtml(html) : {}
			}
			if (browseMeta && Object.values(browseMeta).some(Boolean)) {
				let mergedMeta = mergeCandidateMeta(browseMeta, hints)
				candidateMetaSnapshot = candidateMetaSnapshot || mergedMeta
				if (mergedMeta?.canonicalUrl && !candidateCanonicalUrl) candidateCanonicalUrl = mergedMeta.canonicalUrl
			} else if (hints && Object.values(hints).some(Boolean) && !candidateMetaSnapshot) {
				candidateMetaSnapshot = mergeCandidateMeta({}, hints)
			}
			let browseState = classifyPageState(html, browseMeta)
			lastPageState = browseState
			let browseFailed = Boolean(browseResult?.browseFailed)
			text = extractText(html)
			let abortReason = browseResult?.abortReason || ''
			if (!text && browseResult?.aborted && abortReason) {
				lastFailureStatus = abortReason
				lastFailureMethod = 'playwright'
				if (['captcha', 'cooldown', 'timeout'].includes(abortReason)) {
					blockedStatus = null
					break
				}
			}
			let browseShortByText = false
			if (text && text.length < minTextLength) {
				browseShortByText = true
				shortHtml = html
				shortMethod = 'browse'
				shortTextLength = text.length
				lastFailureStatus = 'short'
				lastFailureMethod = 'browse'
				logEventFn(event, {
					phase: 'fetch',
					method: 'browse',
					status: 'short',
					attempt,
					textLength: text.length,
				}, `#${event.id} browse short (${text.length})`, 'warn')
				text = ''
			}
			if (text) {
				foundText = true
				logEventFn(event, {
					phase: 'fetch',
					method: 'browse',
					status: 'ok',
					attempt,
					textLength: text.length,
				}, `#${event.id} browse ok (${attempt}/2)`, 'ok')
				progressTracker = getProgress()
				progressTracker?.step(event, 'playwright', 'ok')
				progressTracker?.logTextSample?.(event, text, 'text')
				updateContentFromMethod('browse')
				let verifyMeta = mergeCandidateMeta(browseMeta, hints)
				let verify = await verifyText({ event, url, text, isFallback, method: 'browse', attempt, last, contextKind: 'net', candidateMeta: verifyMeta })
				if (verify?.ok) {
					let overallStatus = verify?.status === 'skipped' ? 'skipped' : (verify?.status === 'unverified' ? 'unverified' : 'ok')
					if (Number.isFinite(verify?.durationMs)) {
						progressTracker = getProgress()
						progressTracker?.setDuration?.(event, 'verify', verify.durationMs)
					}
					let verifyNote = formatVerifyNoteFn(verify)
					let note = 'browse'
					if (verifyNote) note = `${note} ${verifyNote}`
					progressTracker = getProgress()
					progressTracker?.step(event, 'verify', overallStatus, note)
					if (browseMeta && Object.values(browseMeta).some(Boolean)) {
						applyContentMetaFn(event, browseMeta, 'browse')
					}
					return { ok: true, html, text, verify, method: 'browse', url, meta: verifyMeta, canonicalUrl: candidateCanonicalUrl }
				}
				if (verify?.status === 'mismatch') {
					mismatchResult = verify
					mismatchHtml = html
					mismatchText = text
					mismatchMethod = 'browse'
					if (Number.isFinite(verify?.durationMs)) {
						progressTracker = getProgress()
						progressTracker?.setDuration?.(event, 'verify', verify.durationMs)
					}
					let verifyNote = formatVerifyNoteFn(verify)
					let note = 'browse'
					if (verifyNote) note = `${note} ${verifyNote}`
					progressTracker = getProgress()
					progressTracker?.step(event, 'verify', 'mismatch', note)
				}
			} else if (!browseFailed && !browseResult?.aborted) {
				if (!browseShortByText && html) {
					let preview = stripHtmlFast(html, 400)
					if (preview) {
						progressTracker = getProgress()
						progressTracker?.logTextSample?.(event, preview, 'preview')
					}
					let probe = stripHtmlFast(html, 4000)
					if (probe && probe.length > 0 && probe.length <= minTextLength) {
						shortHtml = html
						shortMethod = 'browse'
						shortTextLength = probe.length
						lastFailureStatus = 'short'
						lastFailureMethod = 'browse'
					}
				}
				if (!browseShortByText) {
					let guidance = describeError({ reason: 'no_text' }, { scope: 'fetch' })
					let action = guidance.action ? ` | action: ${guidance.action}` : ''
					logEventFn(event, {
						phase: 'fetch',
						method: 'browse',
						status: 'no_text',
						attempt,
						pageState: browseState?.state || '',
						pageStateReason: browseState?.reason || '',
						action: guidance.action,
					}, `#${event.id} browse no text (${attempt}/2)${action}`, 'warn')
					progressTracker = getProgress()
					progressTracker?.step(event, 'playwright', 'no_text')
				}
			}

			if (mismatchResult) {
				return { ok: false, mismatch: true, verify: mismatchResult, html: mismatchHtml, text: mismatchText, method: mismatchMethod || 'browse', url, meta: candidateMetaSnapshot, canonicalUrl: candidateCanonicalUrl }
			}
			if (blockedStatus) {
				return { ok: false, blocked: true, status: blockedStatus, method: lastFailureMethod || 'fetch', meta: candidateMetaSnapshot, canonicalUrl: candidateCanonicalUrl }
			}
		}
		if (!foundText) {
			let finalStatus = lastFailureStatus || (shortHtml ? 'short' : 'no_text')
			let finalMethod = lastFailureMethod || 'fetch'
			let durationMs = 0
			progressTracker = getProgress()
			if (finalMethod === 'fetch') durationMs = progressTracker?.getDuration?.(event, 'fetch') || 0
			else if (finalMethod === 'jina') durationMs = progressTracker?.getDuration?.(event, 'jina') || 0
			else if (finalMethod === 'archive') durationMs = progressTracker?.getDuration?.(event, 'archive') || 0
			else if (finalMethod === 'wayback' || finalMethod === 'wayback-jina') durationMs = progressTracker?.getDuration?.(event, 'wayback') || 0
			else if (finalMethod === 'playwright') durationMs = progressTracker?.getDuration?.(event, 'playwright') || 0
			progressTracker?.setContextContent?.(event, { status: finalStatus, method: finalMethod, ms: durationMs })
			progressTracker?.step(event, 'content', finalStatus, finalMethod)
			let guidance = describeError({ reason: finalStatus }, { scope: 'fetch' })
			let action = guidance.action ? ` | action: ${guidance.action}` : ''
			logEventFn(event, {
				phase: 'fetch',
				status: finalStatus,
				attempts: 2,
				pageState: lastPageState?.state || '',
				pageStateReason: lastPageState?.reason || '',
				action: guidance.action,
			}, `#${event.id} no text after 2 attempts${action}`, 'warn')
			if (shortHtml) {
				return { ok: false, short: true, html: shortHtml, method: shortMethod || finalMethod, textLength: shortTextLength, url, meta: candidateMetaSnapshot, canonicalUrl: candidateCanonicalUrl }
			}
			return { ok: false, status: finalStatus, method: finalMethod, url, meta: candidateMetaSnapshot, canonicalUrl: candidateCanonicalUrl }
		}
	}
}
