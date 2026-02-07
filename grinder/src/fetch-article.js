import { log } from './log.js'
import { isDomainInCooldown, setDomainCooldown } from './domain-cooldown.js'
import { fetchConfig } from '../config/fetch.js'

const defaultHeaders = {
	'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
	'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}
const logAlt = fetchConfig.altFetchLog
const archiveDelayMs = fetchConfig.archiveDelayMs
const archiveCooldownMs = fetchConfig.archiveCooldownMs
let archiveCooldownUntil = 0
let lastArchiveAttempt = 0
const lastFetchStatus = new Map()
const cooldownMsByStatus = {
	401: 10 * 60e3,
	403: 10 * 60e3,
	429: 15 * 60e3,
	500: 2 * 60e3,
	502: 2 * 60e3,
	503: 2 * 60e3,
	504: 2 * 60e3,
}
const captchaCooldownMs = 10 * 60e3
const captchaPatterns = [
	/verify you are human/i,
	/unusual traffic/i,
	/are you a robot/i,
	/recaptcha/i,
	/hcaptcha/i,
	/attention required/i,
	/cloudflare/i,
	/cf-chl/i,
	/please enable cookies/i,
]

function getRetryAfterMs(response) {
	let value = response?.headers?.get?.('retry-after')
	if (!value) return 0
	let seconds = Number(value)
	if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
	let date = Date.parse(value)
	if (!Number.isNaN(date)) {
		let ms = date - Date.now()
		return ms > 0 ? ms : 0
	}
	return 0
}

function buildArchiveUrls(url) {
	let stripped = url.split('?')[0]
	return [
		`https://archive.ph/${stripped}`,
		`https://archive.is/${stripped}`,
		`https://archive.today/${stripped}`,
	]
}

function buildJinaUrl(url) {
	let parsed = new URL(url)
	let protocol = parsed.protocol.replace(':', '')
	return `https://r.jina.ai/${protocol}://${parsed.host}${parsed.pathname}${parsed.search}`
}

function getHost(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, '')
	} catch {
		return ''
	}
}

function looksLikeCaptcha(text) {
	if (!text) return false
	let sample = text.slice(0, 20000)
	let stripped = sample
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	if (stripped.length > 1200) return false
	return captchaPatterns.some(pattern => pattern.test(sample))
}

function setLastStatus(url, status) {
	let host = getHost(url)
	if (host) lastFetchStatus.set(host, status)
}

export function getLastFetchStatus(url) {
	let host = getHost(url)
	if (!host) return null
	return lastFetchStatus.get(host)
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function tryFetchWithStatus(url, label) {
	try {
		let response = await fetch(url, {
			signal: AbortSignal.timeout(10e3),
			headers: defaultHeaders,
		})
		if (!response.ok) {
			if (label) log('article alt fetch failed', label, response.status, response.statusText)
			return { ok: false, status: response.status, statusText: response.statusText }
		}
		let text = await response.text()
		if (label && logAlt) log('article alt fetch ok', label, response.status, text.length)
		return { ok: true, status: response.status, text }
	} catch (e) {
		if (label) log('article alt fetch failed', label, e?.message || e)
		return { ok: false, error: e }
	}
}

async function tryFetchJson(url, label) {
	try {
		let response = await fetch(url, {
			signal: AbortSignal.timeout(10e3),
			headers: {
				...defaultHeaders,
				Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
			},
		})
		if (!response.ok) {
			if (label) log('article alt fetch failed', label, response.status, response.statusText)
			return
		}
		let json = await response.json()
		if (label && logAlt) log('article alt fetch ok', label, response.status, 'json')
		return json
	} catch (e) {
		if (label) log('article alt fetch failed', label, e?.message || e)
	}
}

async function tryWayback(url) {
	let meta = await tryFetchJson(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, 'wayback-meta')
	let snapshot = meta?.archived_snapshots?.closest?.url
	if (!snapshot) {
		log('wayback no snapshot (archive.org has no saved copy for this URL)')
		return { ok: false, reason: 'no_snapshot', reasonDetail: 'archive.org has no saved copy for this URL' }
	}
	let primary = await tryFetchWithStatus(snapshot, 'wayback')
	if (primary?.ok && primary.text) return { ok: true, text: primary.text, source: 'wayback', status: primary.status }
	let fallback = await tryFetchWithStatus(buildJinaUrl(snapshot), 'wayback-jina')
	if (fallback?.ok && fallback.text) return { ok: true, text: fallback.text, source: 'wayback-jina', status: fallback.status }
	return { ok: false, status: primary?.status || fallback?.status || null, reason: 'no_text' }
}

async function tryArchives(url) {
	if (Date.now() < archiveCooldownUntil) {
		log('archive cooldown active', Math.ceil((archiveCooldownUntil - Date.now()) / 1000), 's')
		return { ok: false, skipped: true, reason: 'cooldown' }
	}
	let lastFailure = {}
	for (let archiveUrl of buildArchiveUrls(url)) {
		let wait = archiveDelayMs - (Date.now() - lastArchiveAttempt)
		if (wait > 0) await sleep(wait)
		lastArchiveAttempt = Date.now()
		let result = await tryFetchWithStatus(archiveUrl, `archive:${new URL(archiveUrl).hostname}`)
		if (result?.ok && result.text) {
			return {
				ok: true,
				text: result.text,
				status: result.status,
				host: new URL(archiveUrl).hostname,
			}
		}
		lastFailure = {
			status: result?.status || null,
			statusText: result?.statusText || '',
			host: new URL(archiveUrl).hostname,
		}
		if (result?.status === 429) {
			archiveCooldownUntil = Date.now() + archiveCooldownMs
			log('archive cooldown set', Math.ceil(archiveCooldownMs / 1000), 's')
			return {
				ok: false,
				status: result.status,
				host: new URL(archiveUrl).hostname,
				reason: 'rate_limit',
			}
		}
	}
	return { ok: false, ...lastFailure }
}

export async function fetchArticle(url, { onMethod, onStep } = {}) {
	let cooldown = isDomainInCooldown(url)
	if (cooldown) {
		log('domain cooldown active', cooldown.host, Math.ceil(cooldown.remainingMs / 1000), 's')
		if (onStep) {
			onStep('fetch', 'skipped', { reason: 'cooldown', host: cooldown.host })
		}
		return
	}
	const emitStep = (step, status, info = {}) => {
		if (onStep) onStep(step, status, info)
	}
	for (let i = 0; i < 2; i++) {
		try {
			let fetchStart = Date.now()
			emitStep('fetch', 'start', { attempt: i + 1 })
			let response = await fetch(url, {
				signal: AbortSignal.timeout(10e3),
				headers: defaultHeaders,
			})
			if (response.ok) {
				let text = await response.text()
				emitStep('fetch', 'ok', { status: response.status, bytes: text.length, ms: Date.now() - fetchStart })
				if (looksLikeCaptcha(text)) {
					log('article fetch blocked by captcha', getHost(url))
					setLastStatus(url, 'captcha')
					setDomainCooldown(url, captchaCooldownMs, 'captcha')
					if (onMethod) onMethod('captcha')
					return
				}
				setLastStatus(url, 200)
				if (onMethod) onMethod('fetch')
				return text
			}
			emitStep('fetch', 'fail', { status: response.status, statusText: response.statusText, ms: Date.now() - fetchStart })
			setLastStatus(url, response.status)

			let retryAfter = getRetryAfterMs(response)
			let baseCooldown = cooldownMsByStatus[response.status] || 0
			let cooldownMs = retryAfter || baseCooldown
			if (cooldownMs) setDomainCooldown(url, cooldownMs, response.status)

			if (response.status === 429) {
				log('article fetch failed', response.status, response.statusText)
				return
			}

			if ([401, 403, 429].includes(response.status)) {
				let jinaStart = Date.now()
				emitStep('jina', 'start', {})
				let jinaRes = await tryFetchWithStatus(buildJinaUrl(url), 'jina')
				if (jinaRes?.ok && jinaRes.text) {
					setLastStatus(url, 'jina')
					if (onMethod) onMethod('jina')
					emitStep('jina', 'ok', { status: jinaRes.status, bytes: jinaRes.text.length, ms: Date.now() - jinaStart })
					return jinaRes.text
				}
				emitStep('jina', 'fail', { status: jinaRes?.status || null, ms: Date.now() - jinaStart })

				let archiveStart = Date.now()
				emitStep('archive', 'start', {})
				let archiveRes = await tryArchives(url)
				if (archiveRes?.ok && archiveRes.text) {
					emitStep('archive', 'ok', { status: archiveRes.status, host: archiveRes.host, bytes: archiveRes.text.length, ms: Date.now() - archiveStart })
					if (onMethod) onMethod('archive')
					return archiveRes.text
				}
				if (archiveRes?.skipped) {
					emitStep('archive', 'skipped', { reason: archiveRes.reason || '', ms: Date.now() - archiveStart })
				} else {
					emitStep('archive', 'fail', { status: archiveRes?.status || null, host: archiveRes?.host || '', ms: Date.now() - archiveStart })
				}

				let waybackStart = Date.now()
				emitStep('wayback', 'start', {})
				let waybackRes = await tryWayback(url)
				if (waybackRes?.ok && waybackRes.text) {
					emitStep('wayback', 'ok', { status: waybackRes.status || null, source: waybackRes.source || '', bytes: waybackRes.text.length, ms: Date.now() - waybackStart })
					if (onMethod) onMethod('wayback')
					return waybackRes.text
				}
				let reason = waybackRes?.reason || ''
				if (reason === 'no_snapshot') {
					reason = 'no_snapshot (archive.org has no saved copy for this URL)'
				}
				emitStep('wayback', 'fail', { status: waybackRes?.status || null, reason, ms: Date.now() - waybackStart })
			} else {
				emitStep('jina', 'skipped', { reason: `status_${response.status}` })
				emitStep('archive', 'skipped', { reason: `status_${response.status}` })
				emitStep('wayback', 'skipped', { reason: `status_${response.status}` })
			}

			log('article fetch failed', response.status, response.statusText)
			if (response.status === 401 || response.status === 403) break
		} catch(e) {
			let message = e?.message || String(e)
			let isTimeout = e?.name === 'TimeoutError' || message.includes('aborted due to timeout')
			if (isTimeout) {
				emitStep('fetch', 'timeout', {})
				log('article fetch failed', 'timeout')
				setLastStatus(url, 'timeout')
				setDomainCooldown(url, 2 * 60e3, 'timeout')
				if (onMethod) onMethod('timeout')
			} else {
				emitStep('fetch', 'error', { error: message })
				log('article fetch failed', message)
				setLastStatus(url, 'error')
				setDomainCooldown(url, 2 * 60e3, 'error')
			}
		}
	}
	// let response
	// if (paywalled.some(u => url.includes(u))) {
	// 	url = 'https://archive.ph/' + url
	// 	log(url)
	// 	response = await fetch(url)
	// } else {
	// 	response = await fetch(url)
	// 	if (!response.ok) {
	// 		log(response.status, response.statusText)
	// 		url = 'https://archive.ph/' + url
	// 		log(url)
	// 		response = await fetch(url)
	// 	}
	// }
	// if (response.ok) {
	// 	return await response.text()
	// } else {
	// 	log('article fetch failed', response.status, response.statusText)
	// }
}
