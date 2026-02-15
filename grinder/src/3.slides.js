import fs from 'fs'

import { log } from './log.js'
import { news } from './store.js'
import { topics } from '../config/topics.js'
import { presentationExists, createPresentation, addSlide } from './google-slides.js'

export async function slides() {
	log()
	const hadPresentation = !!(await presentationExists())
	await createPresentation()

	let order = e => (+e.sqk || 999) * 1000 + (topics[e.topic]?.id ?? 99) * 10 + (+e.priority || 10)
	news.sort((a, b) => order(a) - order(b))

	let topicSqk = {}
	let hasSqk = false
	let sqk = news.reduce((nextSqk, e) => {
		topicSqk[e.topic] = Math.max(topicSqk[e.topic] || 1, e.topicSqk || 0)
		let rowSqk = +e.sqk
		if (Number.isFinite(rowSqk) && rowSqk > 0) {
			hasSqk = true
			return Math.max(nextSqk, rowSqk)
		}
		return nextSqk
	}, 3)
	sqk = hasSqk ? sqk + 1 : 3

	let list = news.filter(e => e.topic !== 'other' && (hadPresentation ? !e.sqk : true))
	for (let i = 0; i < list.length; i++) {
		let event = list[i]
		if (!event.sqk) {
			event.sqk = sqk++
		}
		log(`[${i + 1}/${list.length}]`, `${event.sqk}. ${event.titleEn || event.titleRu}`)
		event.topicSqk = topicSqk[event.topic]++
		let notes = event.topicSqk > (topics[event.topic]?.max || 0) ? 'NOT INDEXED' : ''
		await addSlide({
			sqk: event.sqk,
			topicId: topics[event.topic]?.cardId ?? topics[event.topic]?.id,
			notes,
			...event,
		 })
	}

	let screenshots = list.map(e => `${e.sqk}\n${e.url}\n`).join('')
	fs.writeFileSync('../img/screenshots.txt', screenshots)
	log('\nScreenshots list saved')
}

if (process.argv[1].endsWith('slides')) slides()
