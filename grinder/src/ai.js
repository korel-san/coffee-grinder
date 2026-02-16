import OpenAI from 'openai'

import { spreadsheetId } from './store.js'
import { log } from './log.js'
import { sleep } from './sleep.js'
import { getPrompt } from './prompts.js'

const openai = new OpenAI()

const DEFAULT_OPENAI_MODEL = 'gpt-5-mini'
const FALLBACK_OPENAI_MODEL = 'gpt-4o-mini'
const SUMMARIZE_TEMPERATURE = 0

const explicitModel = process.env.OPENAI_SUMMARIZE_MODEL || process.env.OPENAI_MODEL
const modelSource = process.env.OPENAI_SUMMARIZE_MODEL
	? 'OPENAI_SUMMARIZE_MODEL'
	: process.env.OPENAI_MODEL
		? 'OPENAI_MODEL'
		: 'default'

let model = explicitModel || DEFAULT_OPENAI_MODEL
let summaryTemperature = temperatureForModel(model)

const RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'article_summary',
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				titleRu: { type: 'string' },
				summary: { type: 'string' },
				topic: { type: 'string' },
				priority: { type: 'integer', minimum: 1, maximum: 5 },
			},
			required: ['titleRu', 'summary', 'topic', 'priority'],
		},
		strict: true,
	},
}

function temperatureForModel(nextModel) {
	if ((nextModel || '').toLowerCase().startsWith('gpt-5')) return undefined
	return SUMMARIZE_TEMPERATURE
}

function describeSummarizeSettings(currentModel) {
	let src = modelSource ? ` (${modelSource})` : ''
	let tempLabel = summaryTemperature === undefined ? 'unset' : String(summaryTemperature)
	return `api=chat.completions model=${currentModel}${src} temperature=${tempLabel} response_format=json_schema reasoning=unset`
}

function isUnsupportedModel(e) {
	return e?.code === 'unsupported_model' || e?.error?.code === 'unsupported_model'
}

function isModelNotFound(e) {
	return e?.code === 'model_not_found' || e?.status === 404
}

function isTemperatureUnsupported(e) {
	const code = e?.code
	const nested = e?.error?.code
	const message = `${e?.message || ''} ${e?.error?.message || ''}`.toLowerCase()
	return code === 'unsupported_value' || nested === 'unsupported_value' || message.includes('temperature')
}

let instructions = ''
let init = (async () => {
	instructions = await getPrompt(spreadsheetId, 'summarize:summary')
	log('AI summarize:', describeSummarizeSettings(model))
})()

async function chatSummarize({ url, text, logger = log }) {
	let content = `URL: ${url}\nText:\n${text}`
	const request = {
		model,
		response_format: RESPONSE_FORMAT,
		messages: [
			{ role: 'system', content: instructions },
			{ role: 'user', content },
		],
	}
	if (summaryTemperature !== undefined) request.temperature = summaryTemperature

	let res = await openai.chat.completions.create(request)

	let msg = res?.choices?.[0]?.message?.content
	if (!msg) return null

	let parsed
	try {
		parsed = JSON.parse(msg)
	} catch (e) {
		logger('AI fail\n', msg, '\n', e)
		return null
	}

	let used = res?.usage?.total_tokens
	if (Number.isFinite(used)) {
		logger('got', String(parsed?.summary || '').length, 'chars,', used, 'tokens used')
		parsed.delay = used / 30e3 * 60e3
	} else {
		logger('got', String(parsed?.summary || '').length, 'chars')
		parsed.delay = 0
	}
	return parsed
}

export async function ai({ url, text, logger = log }) {
	await init

	for (let i = 0; i < 3; i++) {
		try {
			let res = await chatSummarize({ url, text, logger })
			if (res) return res
			await sleep(30e3)
		} catch (e) {
			if (isTemperatureUnsupported(e) && summaryTemperature !== undefined) {
				summaryTemperature = undefined
				logger('AI summarize: temperature unsupported, retrying without temperature', '\n', e)
				logger('AI summarize:', describeSummarizeSettings(model))
				i--
				continue
			}

			if ((isUnsupportedModel(e) || isModelNotFound(e)) && !explicitModel && model !== FALLBACK_OPENAI_MODEL) {
				logger('AI model failed:', model, '\nFalling back to:', FALLBACK_OPENAI_MODEL, '\n', e)
				model = FALLBACK_OPENAI_MODEL
				summaryTemperature = temperatureForModel(model)
				logger('AI summarize:', describeSummarizeSettings(model))
				i--
				continue
			}

			logger('AI fail\n', e)
			await sleep(30e3)
		}
	}
	return null
}
