import OpenAI from 'openai'

import { spreadsheetId } from './store.js'
import { log } from './log.js'
import { sleep } from './sleep.js'
import { getPrompt } from './prompts.js'

const openai = new OpenAI()

const DEFAULT_WEBSEARCH_MODEL = 'gpt-5-search-api'
const FALLBACK_WEBSEARCH_MODEL = 'gpt-4o-mini-search-preview'

const explicitWebsearchModel = process.env.OPENAI_WEBSEARCH_MODEL
const explicitFactsModel = process.env.OPENAI_FACTS_MODEL || explicitWebsearchModel
const explicitVideosModel = process.env.OPENAI_VIDEOS_MODEL || explicitWebsearchModel

const factsModel = explicitFactsModel || DEFAULT_WEBSEARCH_MODEL
const videosModel = explicitVideosModel || DEFAULT_WEBSEARCH_MODEL

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

async function chatWithWebSearch({ model, allowFallback, system, user, label }) {
	let opts = webSearchOptions()
	let models = allowFallback && model !== FALLBACK_WEBSEARCH_MODEL
		? [model, FALLBACK_WEBSEARCH_MODEL]
		: [model]

	for (let m of models) {
		for (let i = 0; i < 3; i++) {
			try {
				let res = await openai.chat.completions.create({
					model: m,
					web_search_options: opts,
					temperature: 0.2,
					messages: [
						{ role: 'system', content: system },
						{ role: 'user', content: user },
					],
				})
				let content = res?.choices?.[0]?.message?.content
				if (content) return content.trim()
				log(label, 'AI empty response')
			} catch (e) {
				if (isModelNotFound(e) && allowFallback && m !== FALLBACK_WEBSEARCH_MODEL) {
					log(label, 'Model not available:', m, 'falling back to:', FALLBACK_WEBSEARCH_MODEL)
					break
				}
				log(label, 'AI failed\n', e)
				await sleep(30e3)
			}
		}
	}
}

export async function collectFacts({ titleEn, titleRu, text, url }) {
	let prompt = await getPrompt(spreadsheetId, 'summarize:facts')
	let title = titleRu || titleEn || ''
	let input = `URL: ${url}\nTitle: ${title}\n\nArticle text:\n${text}`
	return await chatWithWebSearch({
		model: factsModel,
		allowFallback: !explicitFactsModel,
		system: prompt,
		user: input,
		label: 'FACTS',
	})
}

export async function collectVideos({ titleEn, titleRu, text, url }) {
	let prompt = await getPrompt(spreadsheetId, 'summarize:videos')
	let title = titleRu || titleEn || ''
	let input = `URL: ${url}\nTitle: ${title}\n\nArticle text:\n${text}`
	return await chatWithWebSearch({
		model: videosModel,
		allowFallback: !explicitVideosModel,
		system: prompt,
		user: input,
		label: 'VIDEOS',
	})
}
