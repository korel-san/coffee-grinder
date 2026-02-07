import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'

import { sourceFromUrl } from '../external-search.js'
import { decodeHtmlEntities, isBlank, normalizeUrl } from './utils.js'

const articlesDir = process.env.ARTICLES_DIR || 'articles'
const metaKeys = ['url', 'status', 'method', 'ts', 'textLength']

function formatMetaLines(meta = {}) {
	let lines = []
	for (let key of metaKeys) {
		let value = meta?.[key]
		if (value === undefined || value === null || value === '') continue
		lines.push(`${key}: ${String(value)}`)
	}
	if (!lines.length && meta?.url) {
		lines.push(String(meta.url))
	}
	return lines
}

function parseMetaLines(block = '') {
	let meta = {}
	let lines = String(block || '').split(/\r?\n/)
	for (let raw of lines) {
		let line = raw.trim()
		if (!line) continue
		let idx = line.indexOf(':')
		if (idx === -1) {
			if (!meta.url) meta.url = line
			continue
		}
		let key = line.slice(0, idx).trim().toLowerCase()
		let value = line.slice(idx + 1).trim()
		if (!key) continue
		meta[key] = value
	}
	return meta
}

function extractHtmlMeta(raw = '') {
	if (!raw || !raw.startsWith('<!--')) return { meta: {}, html: raw || '' }
	let end = raw.indexOf('-->')
	if (end === -1) return { meta: {}, html: raw || '' }
	let block = raw.slice(4, end)
	let meta = parseMetaLines(block)
	let html = raw.slice(end + 3)
	return { meta, html }
}

function extractTxtMeta(raw = '') {
	if (!raw) return { meta: {}, body: '' }
	let lines = String(raw).split(/\r?\n/)
	let metaLines = []
	let i = 0
	for (; i < lines.length; i++) {
		let line = lines[i]
		if (!line.startsWith('#')) break
		metaLines.push(line.replace(/^#\s?/, ''))
	}
	while (i < lines.length && lines[i].trim() === '') i++
	let meta = parseMetaLines(metaLines.join('\n'))
	let body = lines.slice(i).join('\n')
	return { meta, body }
}

function buildHtmlWithMeta(html, meta) {
	let lines = formatMetaLines(meta)
	let header = lines.length ? `<!--\n${lines.join('\n')}\n-->\n` : ''
	return `${header}${html || ''}`
}

function buildTxtWithMeta(title, text, meta) {
	let lines = formatMetaLines(meta).map(line => `# ${line}`)
	let header = lines.length ? `${lines.join('\n')}\n\n` : ''
	let safeTitle = title || ''
	let safeText = text || ''
	return `${header}${safeTitle}\n\n${safeText}`
}

function extractTitleFromHtml(html) {
	if (!html) return ''
	let metaPatterns = [
		/<meta[^>]+(?:property|name)=["']og:title["'][^>]*>/i,
		/<meta[^>]+(?:property|name)=["']twitter:title["'][^>]*>/i,
		/<meta[^>]+name=["']title["'][^>]*>/i,
	]
	for (let pattern of metaPatterns) {
		let match = html.match(pattern)
		if (!match) continue
		let content = match[0].match(/content=["']([^"']+)["']/i)
		if (content?.[1]) return decodeHtmlEntities(content[1]).trim()
	}
	let title = html.match(/<title[^>]*>([^<]*)<\/title>/i)
	if (title?.[1]) return decodeHtmlEntities(title[1]).trim()
	let h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
	if (h1?.[1]) {
		let text = h1[1].replace(/<[^>]+>/g, ' ')
		text = decodeHtmlEntities(text).replace(/\s+/g, ' ').trim()
		if (text) return text
	}
	return ''
}

function stripTrackingParams(url) {
	if (!url) return ''
	try {
		let parsed = new URL(url)
		let params = parsed.searchParams
		let trackingPrefixes = ['utm_', 'gaa_', 'ga_']
		let trackingKeys = new Set([
			'gclid',
			'fbclid',
			'yclid',
			'mc_cid',
			'mc_eid',
			'igshid',
			'cmpid',
			'ref',
			'refsrc',
			'mkt_tok',
		])
		for (let key of [...params.keys()]) {
			let lower = key.toLowerCase()
			if (trackingPrefixes.some(prefix => lower.startsWith(prefix)) || trackingKeys.has(lower)) {
				params.delete(key)
			}
		}
		let query = params.toString()
		parsed.search = query ? `?${query}` : ''
		return parsed.toString()
	} catch {
		return url
	}
}

export function getCacheInfo(event, urlOverride) {
	let override = isBlank(urlOverride) ? '' : normalizeUrl(urlOverride)
	let url = override || normalizeUrl(event?.url || '')
	if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
		url = `https://${url}`
	}
	if (!url) return null
	let cleaned = stripTrackingParams(url)
	if (!cleaned) return null
	let key = createHash('sha256').update(cleaned).digest('hex')
	return { key, url: cleaned }
}

export function probeCache(event, urlOverride) {
	let cache = getCacheInfo(event, urlOverride)
	if (!cache) {
		return { available: false, reason: 'no_url' }
	}
	let htmlPath = path.join(articlesDir, `${cache.key}.html`)
	let txtPath = path.join(articlesDir, `${cache.key}.txt`)
	let hasHtml = fs.existsSync(htmlPath)
	let hasTxt = fs.existsSync(txtPath)
	let meta = {}
	if (hasHtml) {
		try {
			let raw = fs.readFileSync(htmlPath, 'utf8')
			meta = extractHtmlMeta(raw).meta || {}
		} catch {}
	}
	if (!meta?.status && hasTxt) {
		try {
			let raw = fs.readFileSync(txtPath, 'utf8')
			meta = extractTxtMeta(raw).meta || {}
		} catch {}
	}
	return {
		available: hasHtml || hasTxt,
		reason: hasHtml || hasTxt ? 'found' : 'missing',
		key: cache.key,
		url: cache.url,
		htmlPath,
		txtPath,
		hasHtml,
		hasTxt,
		meta,
	}
}

export function backfillMetaFromDisk(event, urlOverride) {
	let changed = false
	let cache = getCacheInfo(event, urlOverride)
	if (!cache) return false
	let htmlPath = path.join(articlesDir, `${cache.key}.html`)
	if (fs.existsSync(htmlPath)) {
		let raw = fs.readFileSync(htmlPath, 'utf8')
		let { meta, html } = extractHtmlMeta(raw)
		if (meta?.url && isBlank(event.url)) {
			event.url = String(meta.url).trim()
			changed = true
		}
		let beforeTitle = event.titleEn
		let beforeSource = event.source
		if (isBlank(event.titleEn)) {
			let extracted = extractTitleFromHtml(html)
			if (extracted) event.titleEn = extracted
		}
		if (isBlank(event.source) && event.url && !event.url.includes('news.google.com')) {
			let inferred = sourceFromUrl(event.url)
			if (inferred) event.source = inferred
		}
		if (event.titleEn !== beforeTitle || event.source !== beforeSource) changed = true
	} else if (isBlank(event.source) && event.url && !event.url.includes('news.google.com')) {
		let inferred = sourceFromUrl(event.url)
		if (inferred) {
			event.source = inferred
			changed = true
		}
	}
	return changed
}

export function backfillTextFromDisk(event, urlOverride) {
	if (event?.text?.length) return false
	let cache = getCacheInfo(event, urlOverride)
	if (!cache) return false
	let txtPath = path.join(articlesDir, `${cache.key}.txt`)
	if (!fs.existsSync(txtPath)) return false
	let raw = fs.readFileSync(txtPath, 'utf8')
	if (!raw) return false
	let { body } = extractTxtMeta(raw)
	let [, text] = body.split(/\n\n/, 2)
	let trimmed = (text || body || raw).trim()
	if (!trimmed) return false
	event.text = trimmed.slice(0, 30000)
	return true
}

export function readHtmlFromDisk(event, urlOverride) {
	let cache = getCacheInfo(event, urlOverride)
	if (!cache) return ''
	let htmlPath = path.join(articlesDir, `${cache.key}.html`)
	if (!fs.existsSync(htmlPath)) return ''
	let raw = fs.readFileSync(htmlPath, 'utf8')
	if (!raw) return ''
	let { html } = extractHtmlMeta(raw)
	return html || ''
}

export function writeTextCache(event, text, urlOverride) {
	let cache = getCacheInfo(event, urlOverride)
	if (!cache) return false
	let txtPath = path.join(articlesDir, `${cache.key}.txt`)
	let title = event.titleEn || event.titleRu || ''
	let body = text || ''
	let meta = {
		url: cache.url,
		status: 'ok',
		method: 'cache',
		ts: new Date().toISOString(),
		textLength: body.length,
	}
	fs.mkdirSync(path.dirname(txtPath), { recursive: true })
	fs.writeFileSync(txtPath, buildTxtWithMeta(title, body, meta))
	return true
}

export function saveArticle(event, html, text, urlOverride, meta = {}) {
	let cache = getCacheInfo(event, urlOverride)
	let mutateEvent = meta?.mutateEvent !== false
	let textBody = (text || '').slice(0, 30000)
	if (mutateEvent) {
		if (isBlank(event.titleEn) && html) {
			let extracted = extractTitleFromHtml(html)
			if (extracted) event.titleEn = extracted
		}
		if (isBlank(event.source) && event.url && !event.url.includes('news.google.com')) {
			let inferred = sourceFromUrl(event.url)
			if (inferred) event.source = inferred
		}
		event.text = textBody
	}
	if (!cache) return
	let metaPayload = {
		url: cache.url,
		status: meta.status || '',
		method: meta.method || '',
		ts: meta.ts || new Date().toISOString(),
		textLength: textBody.length || 0,
	}
	let htmlPath = path.join(articlesDir, `${cache.key}.html`)
	let txtPath = path.join(articlesDir, `${cache.key}.txt`)
	fs.mkdirSync(path.dirname(htmlPath), { recursive: true })
	fs.writeFileSync(htmlPath, buildHtmlWithMeta(html || '', metaPayload))
	fs.writeFileSync(txtPath, buildTxtWithMeta(event.titleEn || event.titleRu || '', textBody, metaPayload))
}

export function writeCacheMeta(event, urlOverride, meta = {}) {
	let cache = getCacheInfo(event, urlOverride)
	if (!cache) return false
	let htmlPath = path.join(articlesDir, `${cache.key}.html`)
	let txtPath = path.join(articlesDir, `${cache.key}.txt`)
	let metaPayload = {
		url: cache.url,
		status: meta.status || '',
		method: meta.method || '',
		ts: meta.ts || new Date().toISOString(),
		textLength: Number.isFinite(meta.textLength) ? meta.textLength : undefined,
	}
	let html = ''
	if (fs.existsSync(htmlPath)) {
		try {
			let raw = fs.readFileSync(htmlPath, 'utf8')
			html = extractHtmlMeta(raw).html || ''
		} catch {}
	}
	let title = ''
	let text = ''
	if (fs.existsSync(txtPath)) {
		try {
			let raw = fs.readFileSync(txtPath, 'utf8')
			let extracted = extractTxtMeta(raw)
			let [, bodyText] = (extracted.body || '').split(/\n\n/, 2)
			text = (bodyText || '').trim()
			title = (extracted.body || '').split(/\n\n/, 1)[0] || ''
		} catch {}
	}
	if (!html && !fs.existsSync(htmlPath)) {
		fs.mkdirSync(path.dirname(htmlPath), { recursive: true })
		fs.writeFileSync(htmlPath, buildHtmlWithMeta('', metaPayload))
	} else {
		fs.writeFileSync(htmlPath, buildHtmlWithMeta(html || '', metaPayload))
	}
	if (text || title || fs.existsSync(txtPath)) {
		fs.mkdirSync(path.dirname(txtPath), { recursive: true })
		fs.writeFileSync(txtPath, buildTxtWithMeta(title || event?.titleEn || event?.titleRu || '', text || '', metaPayload))
	}
	return true
}

export function readCacheMeta(event, urlOverride) {
	let cache = getCacheInfo(event, urlOverride)
	if (!cache) return {}
	let htmlPath = path.join(articlesDir, `${cache.key}.html`)
	if (fs.existsSync(htmlPath)) {
		try {
			let raw = fs.readFileSync(htmlPath, 'utf8')
			return extractHtmlMeta(raw).meta || {}
		} catch {}
	}
	let txtPath = path.join(articlesDir, `${cache.key}.txt`)
	if (fs.existsSync(txtPath)) {
		try {
			let raw = fs.readFileSync(txtPath, 'utf8')
			return extractTxtMeta(raw).meta || {}
		} catch {}
	}
	return {}
}
