import { fetchArticle } from './fetch-article.js'
import { log } from './log.js'
import { extractMetaFromHtml } from './meta-extract.js'
import { normalizeTitleForSearch } from './summarize/utils.js'

export async function buildVerifyContext(event) {
	if (event?._verifyContext) return event._verifyContext
	let context = {
		url: event?._originalUrl || event?.url || '',
		gnUrl: event?._originalGnUrl || event?.gnUrl || '',
		title: event?._originalTitleEn || event?._originalTitleRu || event?.titleEn || event?.titleRu || '',
		source: event?._originalSource || event?.source || '',
		date: event?._originalDate || event?.date || '',
		description: '',
		keywords: '',
	}
	if (context.url) {
		let html = await fetchArticle(context.url)
		if (html) {
			let meta = extractMetaFromHtml(html)
			if (meta.title) context.title = meta.title
			if (meta.description) context.description = meta.description
			if (meta.keywords) context.keywords = meta.keywords
			if (meta.date) context.date = meta.date
			if (meta.canonicalUrl && !context.url) context.url = meta.canonicalUrl
		}
	}
	context.title = normalizeTitleForSearch(context.title)
	event._verifyContext = context
	return context
}
