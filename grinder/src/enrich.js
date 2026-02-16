import OpenAI from 'openai'

import { spreadsheetId } from './store.js'
import { log } from './log.js'
import { sleep } from './sleep.js'
import { getPrompt } from './prompts.js'
import {
	assertWebSearchWithTemperatureModel,
	buildWebSearchWithTemperatureResponseBody,
	extractResponseOutputText,
	normalizeWebSearchWithTemperatureModel,
} from './openai-websearch-templates.js'

const openai = new OpenAI()

const DEFAULT_WEBSEARCH_MODEL = 'gpt-5.2'
const FALLBACK_WEBSEARCH_MODEL = 'gpt-4.1'

const FACTS_TEMPERATURE = 0.2
const VIDEOS_TEMPERATURE = 0.2
const TITLE_LOOKUP_TEMPERATURE = 0.2

const explicitWebsearchModel = process.env.OPENAI_WEBSEARCH_MODEL
const explicitFactsModel = process.env.OPENAI_FACTS_MODEL || explicitWebsearchModel
const explicitVideosModel = process.env.OPENAI_VIDEOS_MODEL || explicitWebsearchModel

const factsModel = explicitFactsModel || DEFAULT_WEBSEARCH_MODEL
const videosModel = explicitVideosModel || DEFAULT_WEBSEARCH_MODEL
const factsModelSource = process.env.OPENAI_FACTS_MODEL
	? 'OPENAI_FACTS_MODEL'
	: process.env.OPENAI_WEBSEARCH_MODEL
		? 'OPENAI_WEBSEARCH_MODEL'
		: ''
const videosModelSource = process.env.OPENAI_VIDEOS_MODEL
	? 'OPENAI_VIDEOS_MODEL'
	: process.env.OPENAI_WEBSEARCH_MODEL
		? 'OPENAI_WEBSEARCH_MODEL'
		: ''

function webSearchOptions() {
	let search_context_size = process.env.OPENAI_WEBSEARCH_CONTEXT_SIZE
	let country = process.env.OPENAI_WEBSEARCH_COUNTRY
	let city = process.env.OPENAI_WEBSEARCH_CITY
	let region = process.env.OPENAI_WEBSEARCH_REGION
	let timezone = process.env.OPENAI_WEBSEARCH_TIMEZONE

	let opts = {}
	if (search_context_size) opts.search_context_size = search_context_size

	if (country || city || region || timezone) {
		opts.user_location = {
			type: 'approximate',
			country,
			city,
			region,
			timezone,
		}
	}

	return opts
}

function isModelNotFound(e) {
	return e?.code === 'model_not_found' || e?.status === 404
}

function formatWebSearchOptions(opts) {
	let parts = []
	if (opts?.search_context_size) parts.push(`context=${opts.search_context_size}`)
	if (opts?.user_location) parts.push(`location=${JSON.stringify(opts.user_location)}`)
	return parts.length ? parts.join(' ') : 'context=default'
}

export function describeFactsSettings() {
	let family = normalizeWebSearchWithTemperatureModel(factsModel)
	let reasoning = family === 'gpt-5.2' ? 'reasoning.effort=none' : 'reasoning=unset'
	let src = factsModelSource ? ` (${factsModelSource})` : ''
	return `api=responses tool=web_search model=${factsModel}${src} temp=${FACTS_TEMPERATURE} ${reasoning} ${formatWebSearchOptions(webSearchOptions())}`
}

export function describeVideosSettings() {
	let family = normalizeWebSearchWithTemperatureModel(videosModel)
	let reasoning = family === 'gpt-5.2' ? 'reasoning.effort=none' : 'reasoning=unset'
	let src = videosModelSource ? ` (${videosModelSource})` : ''
	return `api=responses tool=web_search model=${videosModel}${src} temp=${VIDEOS_TEMPERATURE} ${reasoning} ${formatWebSearchOptions(webSearchOptions())}`
}

export function describeTitleLookupSettings() {
	let family = normalizeWebSearchWithTemperatureModel(factsModel)
	let reasoning = family === 'gpt-5.2' ? 'reasoning.effort=none' : 'reasoning=unset'
	let src = factsModelSource ? ` (${factsModelSource})` : ''
	return `api=responses tool=web_search model=${factsModel}${src} temp=${TITLE_LOOKUP_TEMPERATURE} ${reasoning} ${formatWebSearchOptions(webSearchOptions())}`
}

async function responseWithWebSearch({ model, allowFallback, system, user, label, temperature, logger = log }) {
	let opts = webSearchOptions()
	let models = allowFallback && model !== FALLBACK_WEBSEARCH_MODEL
		? [model, FALLBACK_WEBSEARCH_MODEL]
		: [model]

	for (let m of models) {
		assertWebSearchWithTemperatureModel(m)
		for (let i = 0; i < 3; i++) {
			try {
				let body = buildWebSearchWithTemperatureResponseBody({
					model: m,
					system,
					user,
					temperature,
					webSearchOptions: opts,
				})
				let res = await openai.post('/responses', { body })
				let content = extractResponseOutputText(res)
				if (content) return content.trim()
				logger(label, 'AI empty response')
			} catch (e) {
				if (isModelNotFound(e) && allowFallback && m !== FALLBACK_WEBSEARCH_MODEL) {
					logger(label, 'Model not available:', m, 'falling back to:', FALLBACK_WEBSEARCH_MODEL)
					break
				}

				// Bad requests won't be fixed by retrying.
				if (e?.status === 400) {
					logger(label, 'AI bad request\n', e)
					break
				}

				logger(label, 'AI failed\n', e)
				await sleep(30e3)
			}
		}
	}
}

export async function collectFacts({ titleEn, titleRu, text, url }, { logger = log } = {}) {
	assertWebSearchWithTemperatureModel(factsModel, factsModelSource)
	let prompt = await getPrompt(spreadsheetId, 'summarize:facts')
	let title = titleRu || titleEn || ''
	let input = `URL: ${url}\nTitle: ${title}\n\nArticle text:\n${text}`
	return await responseWithWebSearch({
		model: factsModel,
		allowFallback: !explicitFactsModel,
		system: prompt,
		user: input,
		label: 'FACTS',
		temperature: FACTS_TEMPERATURE,
		logger,
	})
}

export async function collectVideos({ titleEn, titleRu, text, url }, { logger = log } = {}) {
	assertWebSearchWithTemperatureModel(videosModel, videosModelSource)
	let prompt = await getPrompt(spreadsheetId, 'summarize:videos')
	let title = titleRu || titleEn || ''
	let input = `URL: ${url}\nTitle: ${title}\n\nArticle text:\n${text}`
	return await responseWithWebSearch({
		model: videosModel,
		allowFallback: !explicitVideosModel,
		system: prompt,
		user: input,
		label: 'VIDEOS',
		temperature: VIDEOS_TEMPERATURE,
		logger,
	})
}

function parseStructuredTitleLookup(raw) {
	let text = String(raw || '').trim()
	if (!text) return

	let candidate = text
	let fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
	if (fence?.[1]) candidate = fence[1].trim()
	let objectMatch = candidate.match(/\{[\s\S]*\}/)
	if (objectMatch) candidate = objectMatch[0]

	try {
		let parsed = JSON.parse(candidate)
		if (!parsed || typeof parsed !== 'object') return
		return {
			titleEn: String(parsed.titleEn || parsed.title || '').trim(),
			titleRu: String(parsed.titleRu || '').trim(),
			extra: String(parsed.extra || parsed.context || parsed.summary || '').trim(),
		}
	} catch {
		return {
			titleEn: text,
			titleRu: '',
			extra: '',
		}
	}
}

export async function collectTitleByUrl({ url }, { logger = log } = {}) {
	assertWebSearchWithTemperatureModel(factsModel, factsModelSource)
	let prompt = await getPrompt(spreadsheetId, 'summarize:title-by-url')
	let input = `URL: ${url}`
	let raw = await responseWithWebSearch({
		model: factsModel,
		allowFallback: !explicitFactsModel,
		system: prompt,
		user: input,
		label: 'TITLE_BY_URL',
		temperature: TITLE_LOOKUP_TEMPERATURE,
		logger,
	})
	return parseStructuredTitleLookup(raw)
}
