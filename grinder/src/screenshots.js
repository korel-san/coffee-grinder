import { firefox } from 'playwright'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { log } from './log.js'

const IMG_DIR = join(import.meta.dirname, '../../img')
const SCREENSHOTS_FILE = join(IMG_DIR, 'screenshots.txt')

function parseUrl(line) {
	return String(line ?? '')
		.split('||')[0]
		.trim()
}

function isContextDestroyedError(error) {
	const msg = String(error?.message || error || '')
	return msg.includes('Execution context was destroyed')
		|| msg.includes('Cannot find context with specified id')
}

function isDomUnavailableError(error) {
	const msg = String(error?.message || error || '')
	return msg.includes('document.documentElement is null')
		|| msg.includes("can't access property \"clientWidth\"")
		|| msg.includes("can't access property \"style\"")
}

async function safeEvaluate(page, fn) {
	let lastError
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await page.evaluate(fn)
		} catch (e) {
			lastError = e
			if (isContextDestroyedError(e) || isDomUnavailableError(e)) {
				await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
				await page.waitForTimeout(700)
				continue
			}
			throw e
		}
	}
	throw new Error(`evaluate failed after retries: ${String(lastError?.message || lastError || 'unknown')}`)
}

async function clickConsentInFrames(page) {
	const labels = [
		'Accept All',
		'Accept all',
		'I Accept All',
		'Accept',
		'Continue with Recommended Cookies',
		'Continue with ads',
		'Later',
		'I agree',
		'Allow all',
		'Принять',
		'Принять все',
		'Согласен',
		'Соглашаюсь',
		'Согласиться',
		'Akzeptieren',
		'Alle akzeptieren',
		'Zustimmen',
	]

	let clicked = false
	for (const frame of page.frames()) {
		for (const label of labels) {
			const button = frame.getByRole('button', { name: label }).first()
			try {
				if (await button.isVisible({ timeout: 500 })) {
					await button.click({ timeout: 1500 })
					clicked = true
					await page.waitForTimeout(500)
				}
			} catch {}
		}
	}
	return clicked
}

async function clickConsentOnPage(page) {
	const labels = [
		/accept all/i,
		/i accept all/i,
		/continue with recommended cookies/i,
		/continue with ads/i,
		/later/i,
		/соглашаюсь/i,
		/согласиться/i,
		/принять/i,
		/akzeptieren/i,
	]

	let clicked = false
	for (const label of labels) {
		const button = page.getByRole('button', { name: label }).first()
		try {
			if (await button.isVisible({ timeout: 500 })) {
				await button.click({ timeout: 1500 })
				clicked = true
				await page.waitForTimeout(500)
			}
		} catch {}
	}
	return clicked
}

async function cleanupPageForScreenshot(page) {
	for (let pass = 0; pass < 5; pass++) {
		const frameClicked = await clickConsentInFrames(page)
		const pageClicked = await clickConsentOnPage(page)
		let clicked = await safeEvaluate(page, () => {
			if (!document) return false
			const root = document.documentElement
			if (!root) return false

			const clickWords = [
				'accept all', 'accept', 'agree', 'i agree', 'allow all', 'ok',
				'accept cookies', 'continue', 'continue with ads',
				'принять', 'принять все', 'согласен', 'разрешить',
				'akzeptieren', 'alle akzeptieren', 'zustimmen',
			]

			let clickedAny = false
			const clickable = document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')
			for (const el of clickable) {
				const text = String(el.textContent || el.getAttribute('aria-label') || el.getAttribute('value') || '')
					.toLowerCase()
					.trim()
				if (!text) continue
				if (!clickWords.some(word => text.includes(word))) continue
				try {
					el.click()
					clickedAny = true
				} catch {}
			}

			const hardRemove = [
				'[id*="onetrust"]', '[class*="onetrust"]',
				'[id*="sp_message"]', '[class*="sp_message"]', '[id^="sp_message_container"]',
				'[id*="cookie"]', '[class*="cookie"]',
				'[id*="consent"]', '[class*="consent"]',
				'[id*="gdpr"]', '[class*="gdpr"]',
				'[id*="privacy"]', '[class*="privacy"]',
				'[id*="paywall"]', '[class*="paywall"]',
				'[id*="overlay"]', '[class*="overlay"]',
				'[id*="modal"]', '[class*="modal"]',
				'[aria-modal="true"]', '[role="dialog"]',
			]
			for (const sel of hardRemove) {
				document.querySelectorAll(sel).forEach(el => {
					try { el.remove() } catch {}
				})
			}

			const vw = Math.max(window.innerWidth || 0, 1)
			const vh = Math.max(window.innerHeight || 0, 1)
			document.querySelectorAll('*').forEach(el => {
				const style = getComputedStyle(el)
				const isFixed = style.position === 'fixed' || style.position === 'sticky'
				if (!isFixed) return
				const r = el.getBoundingClientRect()
				const coversBigArea = r.width > vw * 0.5 && r.height > vh * 0.2
				const isTallSidebar = r.width > vw * 0.12 && r.height > vh * 0.5
				if (coversBigArea || isTallSidebar) {
					try { el.remove() } catch {}
				}
			})

			if (document.body) document.body.style.overflow = 'auto'
			root.style.overflow = 'auto'
			return clickedAny
		}) || false

		if (!clicked && !frameClicked && !pageClicked) break
		await page.waitForTimeout(700)
	}
}

export async function screenshots() {
	// ???????????? ???????? ???? ?????????????? ????????????????????
	let content
	try {
		content = await readFile(SCREENSHOTS_FILE, 'utf-8')
	} catch (e) {
		log('No screenshots.txt found')
		return
	}

	// ????????????: ???????????????? ???????????? - ????????????, ???????????? - URL
	let lines = content.trim().split('\n').filter(l => l.trim())
	let items = []
	for (let i = 0; i < lines.length; i += 2) {
		let index = lines[i].trim()
		let url = parseUrl(lines[i + 1])
		if (index && url) {
			items.push({ index, url })
		}
	}

	if (items.length === 0) {
		log('No screenshots to take')
		return
	}

	log(`Taking ${items.length} screenshots...`)

	// Firefox ?????????? ?????????????? ???????????????? ??????????
	let browser = await firefox.launch({ headless: true })
	let context = await browser.newContext({
		viewport: { width: 1920, height: 1080 },
		deviceScaleFactor: 1,
		locale: 'en-US'
	})

	for (let { index, url } of items) {
		log(`[${index}] ${url}`)
		let done = false
		for (let attempt = 0; attempt < 2 && !done; attempt++) {
			let page
			try {
				page = await context.newPage()
				await page.goto(url, { waitUntil: 'commit', timeout: 60000 })
				await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {})
				await page.waitForTimeout(4000)
				await cleanupPageForScreenshot(page)
				await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
				await page.waitForTimeout(700)

				await safeEvaluate(page, () => {
					if (!document || !document.documentElement) return
					let removeSelectors = [
						'[class*="cookie"]', '[class*="consent"]', '[class*="popup"]',
						'[class*="modal"]', '[class*="overlay"]', '[class*="paywall"]',
						'[id*="cookie"]', '[id*="consent"]', '[id*="popup"]', '[id*="modal"]',
						'[class*="newsletter"]', '[class*="subscribe"]'
					]
					removeSelectors.forEach(sel => {
						document.querySelectorAll(sel).forEach(el => el.remove())
					})

					document.querySelectorAll('*').forEach(el => {
						let style = getComputedStyle(el)
						if (style.position === 'fixed' || style.position === 'sticky') {
							el.remove()
						}
					})

					if (document.body) document.body.style.overflow = 'auto'
					if (document.documentElement) document.documentElement.style.overflow = 'auto'
				})

				await safeEvaluate(page, () => {
					let h1 = document.querySelector('h1')
					if (h1) {
						h1.scrollIntoView({ block: 'start' })
						window.scrollBy(0, -20)
						return
					}
					let anchor = document.querySelector('article, main')
					if (anchor) {
						anchor.scrollIntoView({ block: 'start' })
						window.scrollBy(0, -20)
					}
				})

				await page.waitForTimeout(500)

				let filePath = join(IMG_DIR, `${index}.jpg`)
				await page.screenshot({ path: filePath, type: 'jpeg', quality: 90 })
				done = true
			} catch (e) {
				let error = e?.message || String(e)
				log(`  Error: ${error}`)
				if ((isContextDestroyedError(e) || isDomUnavailableError(e)) && attempt === 0) {
					log('  Retrying after navigation/context reset...')
					await page?.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
					continue
				}
			} finally {
				if (page) {
					try { await page.close() } catch {}
				}
			}
		}
	}

	await browser.close()
	log('Screenshots done.')
}

if (process.argv[1]?.includes('screenshots')) screenshots()
