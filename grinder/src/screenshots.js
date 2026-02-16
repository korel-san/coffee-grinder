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
		let page
		try {
			page = await context.newPage()
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
			await page.waitForTimeout(4000)

			await page.evaluate(() => {
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
				document.documentElement.style.overflow = 'auto'
			})

			await page.evaluate(() => {
				let h1 = document.querySelector('h1')
				if (h1) {
					h1.scrollIntoView({ block: 'start' })
					window.scrollBy(0, -20)
				}
			})

			await page.waitForTimeout(500)

			let filePath = join(IMG_DIR, `${index}.jpg`)
			await page.screenshot({ path: filePath, type: 'jpeg', quality: 90 })
		} catch (e) {
			let error = e?.message || String(e)
			log(`  Error: ${error}`)
		} finally {
			if (page) {
				try { await page.close() } catch {}
			}
		}
	}

	await browser.close()
	log('Screenshots done.')
}

if (process.argv[1]?.includes('screenshots')) screenshots()
