import fs from 'fs'
import path from 'path'
import { chromium } from 'playwright'
import os from 'os'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

import { log } from './log.js'
import { sleep } from './sleep.js'

const isMock = process.env.MOCK_BROWSE === '1'
const mockDir = process.env.MOCK_DATA_DIR ?? path.resolve(process.cwd(), 'tests', 'fixtures', 'summarize')
const mockPath = process.env.MOCK_BROWSE_PATH ?? path.join(mockDir, 'fetch.json')
let mockMap
function loadMockMap() {
	if (!mockMap) {
		if (!fs.existsSync(mockPath)) throw new Error(`Mock browse map not found: ${mockPath}`)
		mockMap = JSON.parse(fs.readFileSync(mockPath, 'utf8'))
	}
	return mockMap
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function initialize() {
	const chromeProfilePath = `${os.homedir()}/AppData/Local/Google/Chrome/Playwright Profile`
	// log(`Chrome profile path: ${chromeProfilePath}`)
	let extension = `${__dirname}/../extensions/captcha-solver/0.2.1_0`
	let context = await chromium.launchPersistentContext(chromeProfilePath, {
		headless: false,
		executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		viewport: { width: 1024, height: 600 },
		screen: { width: 1024, height: 600 },
		args: [
			'--start-maximized',
			`--disable-extensions-except=${extension}`,
			`--load-extension=${extension}`,
		],
	})
	let page = await context.newPage()
	return { context, page }
}
let init = isMock ? null : initialize()

export async function finalyze() {
	if (isMock) return
	let { context } = await init
	context?.close()
}

export async function browseArticle(url) {
	if (isMock) {
		const map = loadMockMap()
		return map[url]
	}
	let { page } = await init
	try {
		log('Browsing archive...')
		await page.goto(`https://archive.ph/${url.split('?')[0]}`, {
			waitUntil: 'load',
		})

		let captcha = await page.$('iframe[src*="recaptcha"]')
		if (captcha) {
			log('waiting for captcha to be solved...')
			await page.waitForSelector('#CONTENT', { timeout: 180e3 })
			log('captcha solved')
		} else {
			log('no captcha detected')
		}

		const versions = await page.$$('.TEXT-BLOCK > a')
		if (versions.length > 0) {
			log('going to the newest version...')
			await versions[0].click()
			await page.waitForLoadState('load')
		}

		let html =  await page.evaluate(() => {
			return [...document.querySelectorAll('.body')].map(x => x.innerHTML).join('')
		})

		if (!html) {
			log('browsing source...')
			try {
				await page.goto(url, {
					waitUntil: 'load',
					timeout: 10e3,
				})
			} catch (e) {
				log(e)
			}
			try {
				await page.waitForLoadState('networkidle', {
					timeout: 10e3,
				})
			} catch (e) {
				log(e)
			}
			html = await page.evaluate(() => {
				return document.body.innerHTML
			})
		}
		return html
	}
	catch (e) {
		log('article browsing failed\n', e)
	}
}
