import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

import { log } from './log.js'
import { sleep } from './sleep.js'
import { isDomainInCooldown, setDomainCooldown } from './domain-cooldown.js'
import { close, detectCaptcha, detectCaptchaReason, getMeta, getPage } from './services/playwright.js'
const captchaCooldownMs = 10 * 60e3
const captchaSnapshotDir = process.env.CAPTCHA_SNAPSHOT_DIR || path.join('logs', 'captcha')
const defaultSkipArchiveDomains = new Set(['reuters.com'])
const skipArchiveDomains = new Set(
	(process.env.SKIP_ARCHIVE_DOMAINS || '')
		.split(',')
		.map(value => value.trim().toLowerCase())
		.filter(Boolean)
)
const captchaWaitMs = Number.isFinite(Number(process.env.CAPTCHA_WAIT_MS))
	? Number(process.env.CAPTCHA_WAIT_MS)
	: 10000
const captchaPollMs = Number.isFinite(Number(process.env.CAPTCHA_WAIT_POLL_MS))
	? Math.max(250, Number(process.env.CAPTCHA_WAIT_POLL_MS))
	: 1000
const contentWaitMs = Number.isFinite(Number(process.env.CONTENT_WAIT_MS))
	? Number(process.env.CONTENT_WAIT_MS)
	: 10000
const contentPollMs = Number.isFinite(Number(process.env.CONTENT_WAIT_POLL_MS))
	? Math.max(200, Number(process.env.CONTENT_WAIT_POLL_MS))
	: 500

function isBrowserClosedError(error) {
	let message = String(error?.message || error || '').toLowerCase()
	return message.includes('target page') && message.includes('has been closed')
		|| message.includes('context or browser has been closed')
		|| message.includes('browser has been closed')
		|| message.includes('target closed')
		|| error?.name === 'TargetClosedError'
}

function isTimeoutError(error) {
	let message = String(error?.message || error || '').toLowerCase()
	return error?.name === 'TimeoutError' || message.includes('timeout')
}

function shouldSkipArchive(url) {
	if (process.env.SKIP_ARCHIVE === '1') return true
	if (!url) return false
	try {
		let host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
		if (skipArchiveDomains.has(host) || defaultSkipArchiveDomains.has(host)) return true
		for (let domain of skipArchiveDomains) {
			if (domain && host.endsWith(`.${domain}`)) return true
		}
		for (let domain of defaultSkipArchiveDomains) {
			if (domain && host.endsWith(`.${domain}`)) return true
		}
	} catch {}
	return false
}

function buildCaptchaSnapshotPrefix(url, label) {
	let safeUrl = String(url || '')
	let hash = createHash('sha256').update(safeUrl).digest('hex').slice(0, 8)
	let safeLabel = String(label || 'page').replace(/[^a-z0-9_-]+/gi, '_')
	let ts = Date.now()
	return path.join(captchaSnapshotDir, `${hash}-${safeLabel}-${ts}`)
}

async function captureCaptchaSnapshot(page, { url, label, reason } = {}) {
	if (!page) return null
	try {
		fs.mkdirSync(captchaSnapshotDir, { recursive: true })
	} catch {}
	let prefix = buildCaptchaSnapshotPrefix(url, label)
	let meta = {
		url: url || '',
		label: label || '',
		reason: reason || '',
		ts: new Date().toISOString(),
	}
	try {
		meta.pageUrl = page.url()
	} catch {}
	try {
		meta.title = await page.title()
	} catch {}
	try {
		let html = await page.content()
		if (html) fs.writeFileSync(`${prefix}.html`, html.slice(0, 50_000))
	} catch {}
	try {
		await page.screenshot({ path: `${prefix}.png`, fullPage: true })
	} catch {}
	try {
		fs.writeFileSync(`${prefix}.json`, JSON.stringify(meta, null, 2))
	} catch {}
	return { prefix, meta }
}

async function waitForCaptchaClear(page, label) {
	if (!captchaWaitMs || captchaWaitMs <= 0) return false
	let started = Date.now()
	log('[warn] captcha detected on', label, `waiting up to ${Math.ceil(captchaWaitMs / 1000)}s...`)
	while (Date.now() - started < captchaWaitMs) {
		await sleep(Math.min(captchaPollMs, captchaWaitMs - (Date.now() - started)))
		let stillCaptcha = await detectCaptcha(page)
		if (!stillCaptcha) {
			log('[info] captcha cleared on', label)
			return true
		}
	}
	log('[warn] captcha wait timeout on', label)
	return false
}

export async function finalyze() {
	await close()
}

function toBrowseError(error) {
	if (isBrowserClosedError(error)) {
		let err = new Error('Playwright browser window is closed')
		err.code = 'BROWSER_CLOSED'
		return err
	}
	if (error?.code === 'CAPTCHA') return error
	if (error?.code === 'TIMEOUT') return error
	let message = String(error?.message || error || '')
	let err = new Error(`Browse failed: ${message}`)
	err.code = 'BROWSE_ERROR'
	return err
}

async function detectArchiveNoResults(page) {
	try {
		let text = await page.textContent('body')
		let lower = String(text || '').toLowerCase()
		if (lower.includes('no results')) return true
		if (lower.includes('no archive')) return true
		if (lower.includes('nothing found')) return true
		if (lower.includes('not in archive')) return true
	} catch {}
	return false
}

async function waitForContentReady(page, timeoutMs = contentWaitMs) {
	if (!timeoutMs || timeoutMs <= 0) return false
	let started = Date.now()
	while (Date.now() - started < timeoutMs) {
		try {
			let ready = await page.evaluate(() => {
				const normalize = text => String(text || '').replace(/\s+/g, ' ').trim()
				const bodyText = normalize(document.body?.innerText || '')
				const article = document.querySelector('article, main, [role="main"]')
				const articleText = normalize(article?.innerText || '')
				const h1 = normalize(document.querySelector('h1')?.innerText || '')
				const words = bodyText ? bodyText.split(/\s+/).length : 0
				const paragraphs = [...document.querySelectorAll('article p, main p, [role="main"] p, p')]
					.map(node => normalize(node?.innerText || ''))
					.filter(text => text.length >= 80)
				return articleText.length >= 160
					|| bodyText.length >= 500
					|| words >= 120
					|| paragraphs.length >= 2
					|| (h1 && bodyText.length >= 200)
			})
			if (ready) return true
		} catch {
			break
		}
		await sleep(Math.min(contentPollMs, timeoutMs - (Date.now() - started)))
	}
	return false
}

export async function browseArticle(url, { ignoreCooldown = false, onStep, quiet = false } = {}) {
	let page = await getPage()
	const emitStep = (step, status, info = {}) => {
		if (onStep) onStep(step, status, info)
	}
	try {
		if (page?.isClosed?.()) {
			let err = new Error('Playwright browser window is closed')
			err.code = 'BROWSER_CLOSED'
			throw err
		}
		let skipArchive = shouldSkipArchive(url)
		if (skipArchive) {
			if (!quiet) log('[info] archive skipped for', url)
			emitStep('playwright-archive', 'skipped', { reason: 'skip_archive' })
		} else {
			let archiveStart = Date.now()
			emitStep('playwright-archive', 'start', {})
			try {
				if (!quiet) log('Browsing archive...')
				await page.goto(`https://archive.ph/${url.split('?')[0]}`, {
					waitUntil: 'load',
					timeout: 10e3,
				})
				if (!skipArchive) {
					const versions = await page.$$('.TEXT-BLOCK > a')
					if (versions.length > 0) {
						if (!quiet) log('going to the newest version...')
						await versions[0].click()
						await page.waitForLoadState('load', { timeout: 10e3 })
					}
				}

				await waitForContentReady(page)
				let captchaReason = await detectCaptchaReason(page)
				if (captchaReason) {
					let cleared = await waitForCaptchaClear(page, 'archive')
					if (!cleared) {
						let snapshot = await captureCaptchaSnapshot(page, { url, label: 'archive', reason: captchaReason })
						let snapshotPath = snapshot?.prefix ? `${snapshot.prefix}.png` : ''
						if (snapshotPath && !quiet) log('[info] captcha snapshot saved', snapshotPath)
						if (!quiet) log('[warn] captcha detected on archive; skipping archive')
						skipArchive = true
						emitStep('playwright-archive', 'captcha', { ms: Date.now() - archiveStart, reason: captchaReason, snapshot: snapshotPath })
					}
				} else if (await detectArchiveNoResults(page)) {
					if (!quiet) log('[warn] archive has no results; skipping archive')
					skipArchive = true
					emitStep('playwright-archive', 'no_text', { ms: Date.now() - archiveStart })
				} else {
					if (!quiet) log('no captcha detected')
				}
			} catch (error) {
				if (isBrowserClosedError(error)) {
					let err = new Error('Playwright browser window is closed')
					err.code = 'BROWSER_CLOSED'
					throw err
				}
				if (!quiet) log('[warn] archive failed; skipping archive', error?.message || error)
				skipArchive = true
				emitStep('playwright-archive', 'fail', { error: error?.message || String(error), ms: Date.now() - archiveStart })
			}
			if (!skipArchive) {
				emitStep('playwright-archive', 'ok', { ms: Date.now() - archiveStart })
			}
		}

		let html = skipArchive ? '' : await page.evaluate(() => {
			return [...document.querySelectorAll('.body')].map(x => x.innerHTML).join('')
		})
		let meta = {}

		if (!html) {
			let sourceStart = Date.now()
			emitStep('playwright-source', 'start', {})
			if (!quiet) log('browsing source...')
			let cooldown = isDomainInCooldown(url)
			if (cooldown && !ignoreCooldown) {
				if (!quiet) log('domain cooldown active', cooldown.host, Math.ceil(cooldown.remainingMs / 1000), 's')
				emitStep('playwright-source', 'skipped', { reason: 'cooldown', host: cooldown.host, ms: Date.now() - sourceStart })
				return { html: '', meta: {}, aborted: true, abortReason: 'cooldown' }
			}
			try {
				await page.goto(url, {
					waitUntil: 'load',
					timeout: 10e3,
				})
			} catch (e) {
				if (isBrowserClosedError(e)) {
					let err = new Error('Playwright browser window is closed')
					err.code = 'BROWSER_CLOSED'
					throw err
				}
				if (isTimeoutError(e)) {
					if (!quiet) log('browse timeout', new URL(url).hostname.replace(/^www\./, ''), '10s')
					setDomainCooldown(url, 2 * 60e3, 'timeout')
					let err = new Error('browse timeout')
					err.code = 'TIMEOUT'
					emitStep('playwright-source', 'timeout', { ms: Date.now() - sourceStart })
					throw err
				}
				if (!quiet) log(e)
			}
			try {
				await page.waitForLoadState('networkidle', {
					timeout: 10e3,
				})
			} catch (e) {
				if (isBrowserClosedError(e)) {
					let err = new Error('Playwright browser window is closed')
					err.code = 'BROWSER_CLOSED'
					throw err
				}
				if (isTimeoutError(e)) {
					if (!quiet) log('browse timeout', new URL(url).hostname.replace(/^www\./, ''), '10s')
					setDomainCooldown(url, 2 * 60e3, 'timeout')
					let err = new Error('browse timeout')
					err.code = 'TIMEOUT'
					emitStep('playwright-source', 'timeout', { ms: Date.now() - sourceStart })
					throw err
				}
				if (!quiet) log(e)
			}
			await waitForContentReady(page)
			const captchaReason = await detectCaptchaReason(page)
			if (captchaReason) {
				let cleared = await waitForCaptchaClear(page, 'source')
				if (!cleared) {
					let snapshot = await captureCaptchaSnapshot(page, { url, label: 'source', reason: captchaReason })
					let snapshotPath = snapshot?.prefix ? `${snapshot.prefix}.png` : ''
					if (snapshotPath && !quiet) log('[info] captcha snapshot saved', snapshotPath)
					if (!quiet) log('[warn] captcha detected on source; skipping source', `reason=${captchaReason}`)
					setDomainCooldown(url, captchaCooldownMs, `captcha:${captchaReason}`)
					let err = new Error('captcha detected on source')
					err.code = 'CAPTCHA'
					err.captchaReason = captchaReason
					if (snapshotPath) err.snapshot = snapshotPath
					emitStep('playwright-source', 'captcha', { ms: Date.now() - sourceStart, reason: captchaReason, snapshot: snapshotPath })
					throw err
				}
			}
			html = await page.evaluate(() => {
				return document.body.innerHTML
			})
			try {
				meta = await getMeta({ page })
			} catch {}
			emitStep('playwright-source', 'ok', { ms: Date.now() - sourceStart })
		}
		return { html, meta }
	}
	catch (e) {
		throw toBrowseError(e)
	}
}
