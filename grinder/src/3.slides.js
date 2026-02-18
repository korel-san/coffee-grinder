import fs from 'fs'

import { log } from './log.js'
import { news } from './store.js'
import { topics, normalizeTopic } from '../config/topics.js'
import { presentationExists, createPresentation, addSlide } from './google-slides.js'

function normalizeHttpUrl(value) {
	if (!value) return ''
	try {
		let url = new URL(String(value).trim())
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
		return url.toString()
	} catch {
		return ''
	}
}

function hasSummary(value) {
	return String(value ?? '').trim().length > 0
}

export async function slides() {
	log()
	const hadPresentation = !!(await presentationExists())
	await createPresentation()

	let resolvedTopic = new Map(news.map(e => [e, normalizeTopic(e.topic)]))

	let order = e =>
		(topics[resolvedTopic.get(e)]?.id ?? 99) * 100000 +
		(+e.priority || 10) * 1000 +
		(+e.sqk || 999)
	let sortedNews = [...news].sort((a, b) => order(a) - order(b))

	let topicSqk = {}
	let sqk = 4
	if (hadPresentation) {
		let maxSqk = 3
		for (let e of sortedNews) {
			const topicKey = resolvedTopic.get(e)
			topicSqk[topicKey] = Math.max(topicSqk[topicKey] || 1, e.topicSqk || 0)
			let rowSqk = +e.sqk
			if (Number.isFinite(rowSqk) && rowSqk > 0) {
				maxSqk = Math.max(maxSqk, rowSqk)
			}
		}
		sqk = maxSqk + 1
	}

	let list = sortedNews.filter(e =>
		resolvedTopic.get(e) &&
		resolvedTopic.get(e) !== 'other' &&
		hasSummary(e.summary) &&
		(hadPresentation ? !e.sqk : true),
	)
	for (let i = 0; i < list.length; i++) {
		let event = list[i]
		const topicKey = resolvedTopic.get(event)
		if (!topicKey) {
			log(`Cannot map topic '${event.topic || ''}' to known topic map. Skipping article for slides.`)
			continue
		}
		if (!hadPresentation) {
			event.sqk = sqk++
		} else if (!event.sqk) {
			event.sqk = sqk++
		}
		log(`[${i + 1}/${list.length}]`, `${event.sqk}. ${event.titleRu || event.titleEn}`)
		event.topicSqk = topicSqk[topicKey] || 1
		topicSqk[topicKey] = event.topicSqk + 1
		let notes = event.topicSqk > (topics[topicKey]?.max || 0) ? 'NOT INDEXED' : ''
		await addSlide({
			sqk: event.sqk,
			topicId: topics[topicKey]?.cardId ?? topics[topicKey]?.id,
			notes,
			...event,
		 })
	}

	let screenshots = list
		.map(e => ({ sqk: e.sqk, url: normalizeHttpUrl(e.usedUrl || e.url) }))
		.filter(e => e.sqk && e.url)
		.map(e => `${e.sqk}\n${e.url}\n`)
		.join('')
	fs.writeFileSync('../img/screenshots.txt', screenshots)
	log('\nScreenshots list saved')
}

if (process.argv[1].endsWith('slides')) slides()
