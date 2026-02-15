import fs from 'fs'

import { log } from './log.js'
import { sleep } from './sleep.js'
import { news } from './store.js'
import { topics, topicsMap } from '../config/topics.js'
// import { restricted } from '../config/agencies.js'
import { decodeGoogleNewsUrl } from './google-news.js'
import { extractArticleInfo } from './newsapi.js'
import { ai } from './ai.js'

const MIN_TEXT_LENGTH = 400
const MAX_TEXT_LENGTH = 30000

function normalizeText(text) {
	return String(text ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

function escapeHtml(text) {
	return String(text)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

function wrapHtml({ url, html, text }) {
	if (html) {
		return `<!--\n${url}\n-->\n${html}`
	}
	if (text) {
		return `<!--\n${url}\n-->\n<pre>${escapeHtml(text)}</pre>`
	}
	return `<!--\n${url}\n-->`
}

async function extractVerified(url) {
	for (let attempt = 0; attempt < 2; attempt++) {
		let info = await extractArticleInfo(url)
		let text = normalizeText(info?.body)
		if (text.length > MIN_TEXT_LENGTH) {
			return {
				url,
				title: info?.title,
				text: text.slice(0, MAX_TEXT_LENGTH),
				html: info?.bodyHtml,
			}
		}
		if (attempt === 0) log('No text extracted, retrying...')
	}
}

async function decodeWithThrottle(last, gnUrl, label = 'Decoding URL...') {
	await sleep(last.urlDecode.time + last.urlDecode.delay - Date.now())
	last.urlDecode.delay += last.urlDecode.increment
	last.urlDecode.time = Date.now()
	log(label)
	return await decodeGoogleNewsUrl(gnUrl)
}

async function tryOtherAgencies(e, last) {
	if (!Array.isArray(e.articles) || !e.articles.length) return

	for (let a of e.articles) {
		let url = a.url
		if (!url) {
			if (!a?.gnUrl) continue
			if (a.gnUrl === e.gnUrl) continue
			url = await decodeWithThrottle(last, a.gnUrl, `Decoding fallback URL (${a.source || 'unknown'})...`)
		}
		if (!url || url === e.url) continue

		log('Extracting fallback', a.source || '', 'article...')
		let extracted = await extractVerified(url)
		if (extracted) {
			e.url = url
			if (a.source) e.source = a.source
			return extracted
		}
	}
}

export async function summarize() {
	news.forEach((e, i) => e.id ||= i + 1)

	let list = news.filter(e => !e.summary && e.topic !== 'other')

	let stats = { ok: 0, fail: 0 }
	let last = {
		urlDecode: { time: 0, delay: 30e3, increment: 1000 },
		ai: { time: 0, delay: 0 },
	}
	for (let i = 0; i < list.length; i++) {
		let e = list[i]
		log(`\n#${e.id} [${i + 1}/${list.length}]`, e.titleEn || e.titleRu || '')

		if (!e.url /*&& !restricted.includes(e.source)*/) {
			e.url = await decodeWithThrottle(last, e.gnUrl)
			if (!e.url) {
				await sleep(5*60e3)
				i--
				continue
			}
			log('got', e.url)
		}

		if (e.url) {
			log('Extracting', e.source || '', 'article...')
			let extracted = await extractVerified(e.url)
			if (!extracted) {
				log('Failed to extract article text, trying another agency...')
				extracted = await tryOtherAgencies(e, last)
			}
			if (extracted) {
				log('got', extracted.text.length, 'chars')
				fs.writeFileSync(`articles/${e.id}.html`, wrapHtml(extracted))
				e.text = extracted.text
				fs.writeFileSync(`articles/${e.id}.txt`, `${e.titleEn || e.titleRu || ''}\n\n${e.text}`)
			}
		}

		if (e.text?.length > 400) {
			await sleep(last.ai.time + last.ai.delay - Date.now())
			last.ai.time = Date.now()
			log('Summarizing', e.text.length, 'chars...')
			let res = await ai(e)
			if (res) {
				last.ai.delay = res.delay
				e.topic ||= topicsMap[res.topic]
				e.priority ||= res.priority
				e.titleRu ||= res.titleRu
				e.summary = res.summary
				e.aiTopic = topicsMap[res.topic]
				e.aiPriority = res.priority
			}
		}

		if (!e.summary) {
			log('failed to summarize')
			stats.fail++
		} else {
			stats.ok++
		}
	}
	let order = e => (+e.sqk || 999) * 1000 + (topics[e.topic]?.id ?? 99) * 10 + (+e.priority || 10)
	news.sort((a, b) => order(a) - order(b))

	log('\n', stats)
}

if (process.argv[1].endsWith('summarize')) summarize()
