import fs from 'fs'
import path from 'path'

import { log } from './log.js'

const isMock = process.env.MOCK_FETCH === '1'
const mockDir = process.env.MOCK_DATA_DIR ?? path.resolve(process.cwd(), 'tests', 'fixtures', 'summarize')
const mockPath = process.env.MOCK_FETCH_PATH ?? path.join(mockDir, 'fetch.json')
let mockMap
function loadMockMap() {
	if (!mockMap) {
		if (!fs.existsSync(mockPath)) throw new Error(`Mock fetch map not found: ${mockPath}`)
		mockMap = JSON.parse(fs.readFileSync(mockPath, 'utf8'))
	}
	return mockMap
}

export async function fetchArticle(url) {
	if (isMock) {
		const map = loadMockMap()
		return map[url]
	}
	for (let i = 0; i < 2; i++) {
		try {
			let response = await fetch(url, {
				signal: AbortSignal.timeout(10e3)
			})
			if (response.ok) {
				return await response.text()
			} else {
				log('article fetch failed', response.status, response.statusText)
				return
			}
		} catch(e) {
			log('article fetch failed', e)
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
