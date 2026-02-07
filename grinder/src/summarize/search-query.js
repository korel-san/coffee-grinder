import OpenAI from 'openai'

import { searchQueryConfig } from '../../config/search-query.js'
import { normalizeTitleForSearch } from './utils.js'

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const XAI_CHAT_URL = process.env.XAI_CHAT_URL || 'https://api.x.ai/v1/chat/completions'
const XAI_API_KEY = process.env.XAI_API_KEY || ''

let openaiClient = null

function clampText(value, limit) {
	if (!value) return ''
	let text = String(value)
	if (!Number.isFinite(limit) || limit <= 0) return text
	return text.length > limit ? text.slice(0, limit) : text
}

function normalizeQuery(value) {
	if (!value) return ''
	return String(value).replace(/\s+/g, ' ').trim()
}

function hasLetters(value) {
	return /\p{L}/u.test(String(value || ''))
}

export function isWeakSearchQuery(query) {
	let cleaned = String(query || '')
		.replace(/site:\S+/gi, '')
		.replace(/["']/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	if (!cleaned) return true
	if (!hasLetters(cleaned)) return true
	let tokens = cleaned.split(/\s+/).filter(Boolean)
	let alphaTokens = tokens.filter(token => hasLetters(token))
	if (!alphaTokens.length) return true
	if (alphaTokens.length >= 2) return false
	let longest = Math.max(...alphaTokens.map(token => token.length))
	return longest < 4
}

export function shouldUseAiSearchQuery(event, queries = []) {
	if (!event) return true
	if (!Array.isArray(queries) || !queries.length) return true
	return queries.every(query => isWeakSearchQuery(query))
}

export function buildSearchQueryContext(event) {
	let meta = event?._contentMeta || {}
	let url = event?._originalUrl || event?.url || event?.gnUrl || ''
	let host = ''
	try {
		host = url ? new URL(url).hostname.replace(/^www\./, '') : ''
	} catch {
		host = ''
	}
	let titleRaw = normalizeTitleForSearch(event?._originalTitleEn || event?._originalTitleRu || event?.titleEn || event?.titleRu || meta?.title || event?.metaTitle || '')
	let descriptionRaw = event?.description || meta?.description || event?.metaDescription || ''
	let titleLength = titleRaw.trim().length
	let descriptionLength = descriptionRaw.trim().length
	let minTitle = Number.isFinite(searchQueryConfig.minTitleChars) ? searchQueryConfig.minTitleChars : 0
	let minDescription = Number.isFinite(searchQueryConfig.minDescriptionChars) ? searchQueryConfig.minDescriptionChars : 0
	let useUrl = !(titleLength >= minTitle || descriptionLength >= minDescription)
	let contextFull = {
		url,
		host,
		title: titleRaw,
		description: descriptionRaw,
		keywords: event?.keywords || meta?.keywords || event?.metaKeywords || '',
		date: event?.date || meta?.publishedTime || meta?.date || event?.metaDate || '',
		source: event?._originalSource || event?.source || meta?.siteName || meta?.source || event?.metaSiteName || '',
	}
	let contextAi = { ...contextFull }
	if (!useUrl) {
		contextAi.url = ''
		contextAi.host = ''
	}
	return {
		context: contextAi,
		logContext: contextFull,
		meta: {
			mode: useUrl ? 'url' : 'title_desc',
			titleLength,
			descriptionLength,
			urlLength: url.trim().length,
			hasTitle: titleLength > 0,
			hasDescription: descriptionLength > 0,
			usedUrl: useUrl,
		},
	}
}

function buildPrompt(context, maxQueries) {
	let system = [
		'Generate a short web search query to find the original news article.',
		'Use ONLY the provided context fields. Do not invent names, places, or facts.',
		'If the context is insufficient or looks like an ID/placeholder, return {"queries": []}.',
		'The query should be 3-10 words, no URLs, no site: operators.',
		'You may include the source name if helpful.',
		`Return JSON only: {"query": "..."} or {"queries": []}.`,
	].join(' ')
	let user = `Context:\n${JSON.stringify(context, null, 2)}`
	return { system, user }
}

function cleanJsonText(text) {
	if (!text) return ''
	let trimmed = text.trim()
	if (trimmed.startsWith('```')) {
		trimmed = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
	}
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
	let match = trimmed.match(/\{[\s\S]*\}/)
	return match ? match[0] : trimmed
}

function parseQueries(raw) {
	if (!raw) return []
	let jsonText = cleanJsonText(raw)
	try {
		let parsed = JSON.parse(jsonText)
		if (Array.isArray(parsed)) return parsed
		if (Array.isArray(parsed?.queries)) return parsed.queries
		if (typeof parsed?.query === 'string') return [parsed.query]
		if (typeof parsed?.queries === 'string') return [parsed.queries]
	} catch {
		return []
	}
	return []
}

function sanitizeQueries(queries, maxQueries, maxQueryChars) {
	let seen = new Set()
	let cleaned = []
	for (let query of queries || []) {
		let normalized = normalizeQuery(query)
		if (!normalized) continue
		if (maxQueryChars && normalized.length > maxQueryChars) {
			normalized = normalized.slice(0, maxQueryChars)
		}
		let key = normalized.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		if (isWeakSearchQuery(normalized)) continue
		cleaned.push(normalized)
		if (cleaned.length >= maxQueries) break
	}
	return cleaned
}

async function callOpenAI({ system, user, model, temperature, maxQueries }) {
	if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set')
	if (!openaiClient) openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY })
	let schema = {
		name: 'search_queries',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				queries: {
					type: 'array',
					items: { type: 'string' },
					maxItems: maxQueries,
				},
			},
			required: ['queries'],
		},
		strict: true,
	}
	let response = await openaiClient.chat.completions.create({
		model,
		temperature,
		max_tokens: 200,
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: user },
		],
		response_format: { type: 'json_schema', json_schema: schema },
	})
	return response?.choices?.[0]?.message?.content || ''
}

async function callXAI({ system, user, model, temperature, timeoutMs }) {
	if (!XAI_API_KEY) throw new Error('XAI_API_KEY is not set')
	let response = await fetch(XAI_CHAT_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${XAI_API_KEY}`,
		},
		signal: AbortSignal.timeout(timeoutMs || 10000),
		body: JSON.stringify({
			model,
			temperature,
			max_tokens: 200,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
		}),
	})
	let data = await response.json().catch(() => ({}))
	if (!response.ok) {
		let message = data?.error?.message || data?.message || response.statusText
		let err = new Error(`xAI API error: ${message}`)
		err.status = response.status
		err.reason = data?.error?.code || data?.error?.type || data?.message || ''
		err.code = data?.error?.code || ''
		throw err
	}
	return data?.choices?.[0]?.message?.content || ''
}

export async function generateSearchQueries(event, options = {}) {
	if (!searchQueryConfig.enabled) return { queries: [], provider: searchQueryConfig.provider, model: searchQueryConfig.model }
	let provider = options.provider || searchQueryConfig.provider
	let model = options.model || searchQueryConfig.model
	let fallbackProvider = searchQueryConfig.fallbackProvider || ''
	let fallbackModel = searchQueryConfig.fallbackModel || model
	let maxQueries = Number.isFinite(options.maxQueries) ? options.maxQueries : searchQueryConfig.maxQueries
	let temperature = Number.isFinite(options.temperature) ? options.temperature : searchQueryConfig.temperature
	let maxQueryChars = searchQueryConfig.maxQueryChars || 120
	let contextInfo = buildSearchQueryContext(event)
	let { system, user } = buildPrompt(contextInfo.context, maxQueries)
	let raw = ''
	let usedProvider = provider
	let usedModel = model
	let fallbackUsed = false
	try {
		if (provider === 'xai') {
			raw = await callXAI({ system, user, model, temperature, timeoutMs: searchQueryConfig.timeoutMs })
		} else {
			raw = await callOpenAI({ system, user, model, temperature, maxQueries })
		}
	} catch (error) {
		if (provider === 'xai' && fallbackProvider === 'openai') {
			raw = await callOpenAI({ system, user, model: fallbackModel, temperature, maxQueries })
			usedProvider = 'openai'
			usedModel = fallbackModel
			fallbackUsed = true
		} else {
			throw error
		}
	}
	let parsed = parseQueries(raw)
	let queries = sanitizeQueries(parsed, maxQueries, maxQueryChars)
	return {
		queries,
		provider: usedProvider,
		model: usedModel,
		context: contextInfo.context,
		contextMeta: contextInfo.meta,
		raw,
		fallbackUsed,
	}
}
