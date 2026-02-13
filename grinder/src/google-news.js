import fs from 'fs'
import path from 'path'
import { JSDOM } from 'jsdom'

import { log } from './log.js'

const isMock = process.env.MOCK_GOOGLE_NEWS === '1'
const mockDir = process.env.MOCK_DATA_DIR ?? path.resolve(process.cwd(), 'tests', 'fixtures', 'summarize')
const mockPath = process.env.MOCK_GOOGLE_NEWS_PATH ?? path.join(mockDir, 'google-news.json')
let mockMap
function loadMockMap() {
	if (!mockMap) {
		if (!fs.existsSync(mockPath)) throw new Error(`Mock Google News map not found: ${mockPath}`)
		mockMap = JSON.parse(fs.readFileSync(mockPath, 'utf8'))
	}
	return mockMap
}

export async function decodeGoogleNewsUrl(url) {
	if (isMock) {
		const map = loadMockMap()
		return map[url]
	}
	for (let i = 0; i < 5; i++) {
		try {
			let parsedUrl = new URL(url)
			let id = parsedUrl.pathname.split('/').pop()
			let response = await fetch(`https://news.google.com/articles/${id}`)
			if (!response.ok) {
				log(`Fetch failed: ${response.status} ${response.statusText}`)
				if (response.status === 429) return
			}
			let html = await response.text()
			let dom = new JSDOM(html)
			let div = dom.window.document.querySelector('c-wiz > div[jscontroller]')
			let [sg, ts] = [div.getAttribute('data-n-a-sg'), div.getAttribute('data-n-a-ts')]
			let payload = [
				'Fbv4je',
				`["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`,
			]
			let json = await (await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
				body: new URLSearchParams({ 'f.req': JSON.stringify([[payload]]) }).toString(),
			})).text()
			return JSON.parse(JSON.parse(json.split('\n\n')[1].slice(0))[0][2])[1]
		} catch(e) {
			log('Fetch failed:', e)
		}
	}
}
