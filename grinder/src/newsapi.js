import { log } from './log.js'

const ER_API_BASE = 'https://eventregistry.org/api/v1'
const ER_ANALYTICS_BASE = 'https://analytics.eventregistry.org/api/v1'

function get(obj, path) {
	return path.reduce((acc, key) => acc && acc[key], obj)
}

function pickString(obj, paths) {
	for (let path of paths) {
		let v = get(obj, path)
		if (typeof v === 'string' && v.trim()) return v
	}
}

function firstValue(obj) {
	if (!obj || typeof obj !== 'object') return
	let keys = Object.keys(obj)
	if (!keys.length) return
	return obj[keys[0]]
}

function uniqBy(list, keyFn) {
	let seen = new Set()
	let out = []
	for (let item of list) {
		let key = keyFn(item)
		if (key == null) continue
		if (seen.has(key)) continue
		seen.add(key)
		out.push(item)
	}
	return out
}

function getApiKey() {
	let apiKey = process.env.NEWS_API_KEY
	if (!apiKey) {
		log('NEWS_API_KEY is missing')
		return
	}
	return apiKey
}

function buildUrl(base, params) {
	let u = new URL(base)
	for (let [k, v] of Object.entries(params || {})) {
		if (v == null) continue
		if (Array.isArray(v)) {
			v.forEach(x => {
				if (x != null) u.searchParams.append(k, String(x))
			})
			continue
		}
		u.searchParams.set(k, String(v))
	}
	return u
}

async function getJson(url, params) {
	try {
		let response = await fetch(buildUrl(url, params), {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(30e3),
		})
		if (!response.ok) {
			log('newsapi.ai request failed', response.status, response.statusText)
			return
		}
		let json = await response.json()
		if (json?.error) {
			log('newsapi.ai error', json.error)
			return
		}
		return json
	} catch (e) {
		log('newsapi.ai request failed', e)
	}
}

export async function extractArticleInfo(url) {
	let apiKey = getApiKey()
	if (!apiKey) return

	let json = await getJson(`${ER_ANALYTICS_BASE}/extractArticleInfo`, { apiKey, url })
	if (!json) return

	return {
		title: pickString(json, [
			['title'],
			['article', 'title'],
			['info', 'title'],
		]),
		body: pickString(json, [
			['body'],
			['text'],
			['content'],
			['article', 'body'],
			['article', 'text'],
			['article', 'content'],
			['article', 'bodyText'],
			['article', 'contentText'],
		]),
		bodyHtml: pickString(json, [
			['bodyHtml'],
			['html'],
			['article', 'bodyHtml'],
			['article', 'html'],
			['article', 'contentHtml'],
		]),
	}
}

async function mapUrlToArticleUris(articleUrl) {
	let apiKey = getApiKey()
	if (!apiKey) return []

	let json = await getJson(`${ER_API_BASE}/articleMapper`, {
		apiKey,
		articleUrl,
		deep: true,
	})
	if (!json) return []

	let mapped = json?.[articleUrl]
	if (!mapped) mapped = firstValue(json)
	if (!mapped) return []

	let uris = Array.isArray(mapped) ? mapped : [mapped]
	return uris.filter(Boolean)
}

async function getArticleInfo(articleUri) {
	let apiKey = getApiKey()
	if (!apiKey) return

	let json = await getJson(`${ER_API_BASE}/article/getArticle`, {
		apiKey,
		resultType: 'info',
		articleUri,
		includeArticleEventUri: true,
		includeArticleBasicInfo: true,
		includeArticleTitle: true,
		includeSourceTitle: true,
	})
	if (!json) return

	let data = json?.[articleUri]
	if (!data) data = firstValue(json)
	return data?.info
}

async function getEventArticles(eventUri) {
	let apiKey = getApiKey()
	if (!apiKey) return []

	let json = await getJson(`${ER_API_BASE}/event/getEvent`, {
		apiKey,
		resultType: 'articles',
		eventUri,
		articlesIncludeDuplicates: true,
		includeArticleBasicInfo: true,
		includeArticleTitle: true,
		includeSourceTitle: true,
	})
	if (!json) return []

	let data = json?.[eventUri]
	if (!data) data = firstValue(json)

	let results = data?.articles?.results
	if (!Array.isArray(results)) return []

	return results
		.map(a => ({
			url: a?.url,
			title: a?.title,
			source: a?.source?.title,
			sourceUri: a?.source?.uri,
		}))
		.filter(a => a.url)
}

export async function findAlternativeArticles(articleUrl) {
	let articleUris = await mapUrlToArticleUris(articleUrl)
	if (!articleUris.length) return []

	let info = await getArticleInfo(articleUris[0])
	let eventUri = info?.eventUri
	if (!eventUri) return []

	let articles = await getEventArticles(eventUri)
	articles = articles.filter(a => a.url !== articleUrl)
	articles = uniqBy(articles, a => a.url)
	return articles.slice(0, 20)
}
