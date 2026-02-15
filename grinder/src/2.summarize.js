import fs from 'fs'

import { log } from './log.js'
import { sleep } from './sleep.js'
import { news } from './store.js'
import { topics, topicsMap } from '../config/topics.js'
// import { restricted } from '../config/agencies.js'
import { decodeGoogleNewsUrl } from './google-news.js'
import { extractArticleInfo, findAlternativeArticles } from './newsapi.js'
import { ai } from './ai.js'
import { collectFacts, collectVideos, describeFactsSettings, describeVideosSettings } from './enrich.js'
import { extractFallbackKeywords, describeFallbackKeywordsSettings } from './fallback-keywords.js'

const MIN_TEXT_LENGTH = 400
const MAX_TEXT_LENGTH = 30000
const FALLBACK_MAX_KEYWORDS = 20

const STOPWORDS = new Set([
	'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'into', 'over', 'under',
	'about', 'after', 'before', 'between', 'while', 'where', 'when', 'what', 'which', 'whose',
	'of', 'in', 'on', 'at', 'to', 'as', 'by', 'via', 'per', 'than',
	'also', 'other', 'more', 'most', 'some', 'than', 'then', 'they', 'them', 'their', 'there',
	'you', 'your', 'yours', 'our', 'ours', 'his', 'her', 'hers', 'its', 'it', 'are', 'was', 'were',
	'will', 'would', 'could', 'should', 'can', 'may', 'might', 'must', 'not', 'but', 'have', 'has',
	'had', 'been', 'being', 'new', 'news', 'latest', 'update', 'live', 'video', 'watch', 'read',
	'world', 'us', 'usa', 'uk', 'eu',
])

function uniq(list) {
	let seen = new Set()
	let out = []
	for (let v of list) {
		if (!v) continue
		if (seen.has(v)) continue
		seen.add(v)
		out.push(v)
	}
	return out
}

function maybeSingularize(s) {
	if (s.endsWith('s') && s.length > 4 && !s.endsWith('ss')) return s.slice(0, -1)
	return s
}

function urlKeywords(articleUrl, limit = FALLBACK_MAX_KEYWORDS) {
	let u
	try {
		u = new URL(articleUrl)
	} catch {
		return []
	}

	let raw = u.pathname.split('/').filter(Boolean).join('-')
	if (!raw) return []

	raw = raw.replace(/\.[a-z]{2,5}$/i, '')

	let tokens = raw
		.split(/[^A-Za-z0-9]+/g)
		.map(s => s.toLowerCase())
		.filter(s => s.length >= 3)
		.map(maybeSingularize)
		.filter(s => !STOPWORDS.has(s))
		.filter(s => !/^\d+$/.test(s))

	return uniq(tokens).slice(0, limit)
}

function countKeywordHits(haystack, keywords) {
	let h = String(haystack || '').toLowerCase()
	let hits = 0
	for (let k of keywords || []) {
		if (!k) continue
		if (h.includes(k.toLowerCase())) hits++
	}
	return hits
}

function ensureColumns(table, cols) {
	table.headers ||= []
	for (let c of cols) {
		if (!table.headers.includes(c)) table.headers.push(c)
	}
}

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
		log(`Extract attempt ${attempt + 1}/2...`)
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

async function tryOtherAgencies(e) {
	let keywordsAll = urlKeywords(e.url, FALLBACK_MAX_KEYWORDS)
	let keywords = keywordsAll.filter(k => k.length >= 4)
	if (keywords.length < 2) keywords = keywordsAll
	if (!keywords.length) {
		log('No URL keywords for fallback search')
		return
	}

	log(`Fallback URL keywords (${keywords.length}):`, keywords.join(' '))
	log('Extracting fallback keywords...', describeFallbackKeywordsSettings())
	let aiKeywords = await extractFallbackKeywords(e.url, keywords, 8)
	if (aiKeywords.length) log(`Fallback AI keywords (${aiKeywords.length}):`, aiKeywords.join(' '))
	let searchKeywords = aiKeywords.length ? aiKeywords : keywords
	log(`Fallback search keywords (${searchKeywords.length}):`, searchKeywords.join(' '))

	let candidates = await findAlternativeArticles(e.url, { keywords: searchKeywords })
	if (!candidates.length) {
		log('No alternative articles found')
		return
	}
	log('Found', candidates.length, 'alternative candidates')
	let baseSource = (e.source || '').trim().toLowerCase()
	let baseHost = ''
	try { baseHost = new URL(e.url).hostname } catch {}
	let keywordsForMatch = keywords
	if (keywordsForMatch.length) log('Fallback relevance keywords:', keywordsForMatch.join(' '))

	let minMatchHits = Math.min(2, keywordsForMatch.length)
	let maxTries = 7
	let tries = 0

	for (let a of candidates) {
		if (tries >= maxTries) break
		let url = a?.url
		if (!url || url === e.url) continue
		if (baseSource && a.source && a.source.trim().toLowerCase() === baseSource) continue
		if (baseHost) {
			try {
				if (new URL(url).hostname === baseHost) continue
			} catch {}
		}
		let meta = `${a?.title || ''}\n${url}`
		let metaHits = countKeywordHits(meta, searchKeywords)
		let eventUri = a?.eventUri

		log(
			'Trying fallback candidate',
			a.source || '',
			eventUri ? `eventUri=${eventUri}` : '',
			`metaHits=${metaHits}/${searchKeywords.length}`,
			`url=${url}`,
		)
		tries++

		log('Extracting fallback', a.source || '', 'article...')
		let extracted = await extractVerified(url)
		if (extracted) {
			if (keywordsForMatch.length) {
				let title = extracted.title || ''
				let haystack = `${title}\n${extracted.text || ''}`
				let totalHits = countKeywordHits(haystack, keywordsForMatch)
				if (totalHits < minMatchHits) {
					log('Skipping fallback (low relevance)', a.source || '', `hits=${totalHits}/${keywordsForMatch.length} total`, `url=${url}`)
					continue
				}
			}
			e.url = url
			if (a.source) e.source = a.source
			return extracted
		}
	}
}

export async function summarize() {
	ensureColumns(news, ['url', 'factsRu', 'videoUrls'])

	news.forEach((e, i) => e.id ||= i + 1)

	let list = news.filter(e => !e.summary && e.topic !== 'other')

	let stats = { ok: 0, fail: 0 }
	let last = {
		urlDecode: { time: 0, delay: 30e3, increment: 1000 },
		ai: { time: 0, delay: 0 },
		facts: { time: 0, delay: 0 },
		videos: { time: 0, delay: 0 },
	}
	for (let i = 0; i < list.length; i++) {
		let e = list[i]
		log(`\n#${e.id} [${i + 1}/${list.length}]`, e.titleEn || e.titleRu || '')
		let articleText = ''

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
			log('Extracting', e.source || '', 'article...', e.url ? `url=${e.url}` : '')
			let extracted = await extractVerified(e.url)
			if (!extracted) {
				log('Failed to extract article text, trying another agency...')
				extracted = await tryOtherAgencies(e)
			}
			if (extracted) {
				log('got', extracted.text.length, 'chars')
				fs.writeFileSync(`articles/${e.id}.html`, wrapHtml(extracted))
				articleText = extracted.text
				fs.writeFileSync(`articles/${e.id}.txt`, `${e.titleEn || e.titleRu || ''}\n\n${articleText}`)
			}
		}

		if (articleText.length > 400) {
			await sleep(last.ai.time + last.ai.delay - Date.now())
			last.ai.time = Date.now()
			log('Summarizing', articleText.length, 'chars...')
			let res = await ai({ url: e.url, text: articleText })
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

		if (e.summary && articleText.length > MIN_TEXT_LENGTH) {
			let enrichInput = { ...e, text: articleText }
			if (!e.factsRu) {
				await sleep(last.facts.time + last.facts.delay - Date.now())
				last.facts.time = Date.now()
				log('Collecting facts...', describeFactsSettings())
				e.factsRu = await collectFacts(enrichInput)
			}
			if (!e.videoUrls) {
				await sleep(last.videos.time + last.videos.delay - Date.now())
				last.videos.time = Date.now()
				log('Collecting videos...', describeVideosSettings())
				e.videoUrls = await collectVideos(enrichInput)
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
