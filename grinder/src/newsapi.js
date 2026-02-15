import { log } from './log.js'

function get(obj, path) {
	return path.reduce((acc, key) => acc && acc[key], obj)
}

function pickString(obj, paths) {
	for (let path of paths) {
		let v = get(obj, path)
		if (typeof v === 'string' && v.trim()) return v
	}
}

export async function extractArticleInfo(url) {
	let apiKey = process.env.NEWS_API_KEY
	if (!apiKey) {
		log('NEWS_API_KEY is missing')
		return
	}

	let endpoint = new URL('https://analytics.eventregistry.org/api/v1/extractArticleInfo')
	endpoint.searchParams.set('apiKey', apiKey)
	endpoint.searchParams.set('url', url)

	try {
		let response = await fetch(endpoint, {
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
	} catch (e) {
		log('newsapi.ai request failed', e)
	}
}

