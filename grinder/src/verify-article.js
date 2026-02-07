import {
	verifyMaxChars,
	verifySummaryMaxChars,
	verifyContextMaxChars,
	verifyModel,
	verifyTemperature,
	verifyUseSearch,
	verifyReasoningEffort,
	verifyFallbackMaxChars,
	verifyFallbackContextMaxChars,
	verifyProvider,
	verifyFallbackProvider,
	verifyFallbackModel,
	verifyFallbackUseSearch,
} from '../config/verification.js'
import { log } from './log.js'

const OPENAI_API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/responses'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const XAI_RESPONSES_URL = process.env.XAI_API_URL || 'https://api.x.ai/v1/responses'
const XAI_CHAT_URL = process.env.XAI_CHAT_URL || 'https://api.x.ai/v1/chat/completions'
const XAI_API_KEY = process.env.XAI_API_KEY || ''
const promptFieldMaxChars = 100

const verifySchema = {
	type: 'json_schema',
	name: 'verify_result',
	strict: true,
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			match: { type: 'boolean' },
			confidence: { type: 'number' },
			reason: { type: 'string' },
			page_summary: { type: 'string' },
		},
		required: ['match', 'confidence', 'reason', 'page_summary'],
	},
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

function clampSummary(text) {
	if (!text) return ''
	return text.length > verifySummaryMaxChars ? text.slice(0, verifySummaryMaxChars) : text
}

function clampText(text, limit) {
	if (!text) return ''
	if (!Number.isFinite(limit) || limit <= 0) return text
	return text.length > limit ? text.slice(0, limit) : text
}

function clampMetaField(text) {
	return clampText(text, promptFieldMaxChars)
}

function clampContentField(text, limitOverride) {
	if (!Number.isFinite(limitOverride) || limitOverride <= 0) return text || ''
	return clampText(text, limitOverride)
}

function isLengthError(error) {
	let message = String(error?.message || error || '').toLowerCase()
	return message.includes('context')
		|| message.includes('token')
		|| message.includes('too long')
		|| message.includes('maximum')
		|| message.includes('input size')
		|| message.includes('max_tokens')
}

function buildPayload(original, candidate, { maxChars, contextMaxChars }) {
	return {
		original: {
			title: clampMetaField(original?.title || ''),
			description: clampMetaField(original?.description || ''),
			keywords: clampMetaField(original?.keywords || ''),
			date: clampMetaField(original?.date || ''),
			source: clampMetaField(original?.source || ''),
			url: clampMetaField(original?.url || ''),
			gnUrl: clampMetaField(original?.gnUrl || ''),
		},
		candidate: {
			title: clampMetaField(candidate?.title || ''),
			description: clampMetaField(candidate?.description || ''),
			keywords: clampMetaField(candidate?.keywords || ''),
			date: clampMetaField(candidate?.date || ''),
			source: clampMetaField(candidate?.source || ''),
			url: clampMetaField(candidate?.url || ''),
			gnUrl: clampMetaField(candidate?.gnUrl || ''),
			textSnippet: clampContentField(candidate?.textSnippet || '', contextMaxChars),
			text: clampContentField(candidate?.text || '', maxChars),
		},
	}
}

function buildPrompt(payload) {
	let system = [
		'You verify whether the candidate article is about the same news event as the original article.',
		'Be strict: only mark match=true if it is clearly the same event.',
		'The candidate may contain MORE information, but must NOT contradict the original.',
		'If the candidate omits key facts from the original or is about a related but different event, set match=false.',
		'Use the candidate body text as primary evidence; do NOT rely only on the title.',
		'Ignore site chrome, navigation, ads, and boilerplate in the candidate text.',
		'Use web_search to confirm details when needed.',
		'Candidate context may include title, description, keywords, date, source, and url.',
		'Dates and sources may differ slightly, but the event must be the same.',
		'Return ONLY JSON with keys:',
		'- match (boolean)',
		'- confidence (number 0-1)',
		'- reason (string, <=200 chars)',
		'- page_summary (string, <=200 chars)',
	].join(' ')
	let user = [
		'Original context:',
		JSON.stringify(payload.original, null, 2),
		'Candidate:',
		JSON.stringify(payload.candidate, null, 2),
	].join('\n')
	return { system, user }
}

function extractResponseText(response) {
	if (!response) return ''
	if (typeof response.output_text === 'string') return response.output_text
	if (Array.isArray(response.output)) {
		for (let item of response.output) {
			if (item?.type !== 'message') continue
			if (!Array.isArray(item.content)) continue
			let text = item.content
				.filter(part => part && (part.type === 'output_text' || typeof part.text === 'string'))
				.map(part => part.text || '')
				.join('')
			if (text) return text
		}
	}
	let fallback = response?.choices?.[0]?.message?.content
	return typeof fallback === 'string' ? fallback : ''
}

async function callOpenAI({ system, prompt, temperature, useSearch, model, reasoningEffort }) {
	if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set')
	let modelName = model || verifyModel
	let effort = reasoningEffort ?? verifyReasoningEffort
	let supportsTemperature = !/^gpt-5/i.test(modelName || '')
	if (/^gpt-5\.1/i.test(modelName || '') && effort === 'none') {
		supportsTemperature = true
	}
	let body = {
		model: modelName,
		input: [
			{ role: 'system', content: [{ type: 'input_text', text: system }] },
			{ role: 'user', content: [{ type: 'input_text', text: prompt }] },
		],
		text: { format: verifySchema },
	}
	if (effort) {
		body.reasoning = { effort }
	}
	if (supportsTemperature && Number.isFinite(temperature)) body.temperature = temperature
	if (useSearch) body.tools = [{ type: 'web_search' }]
	let response = await fetch(OPENAI_API_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${OPENAI_API_KEY}`,
		},
		body: JSON.stringify(body),
	})
	let data = await response.json().catch(() => ({}))
	if (!response.ok) {
		let message = data?.error?.message || data?.message || response.statusText
		throw new Error(`OpenAI API error: ${message}`)
	}
	return data
}

async function callXAI({ system, prompt, temperature, useSearch, model }) {
	if (!XAI_API_KEY) throw new Error('XAI_API_KEY is not set')
	let modelName = model || verifyModel
	let baseResponses = {
		model: modelName,
		input: [
			{ role: 'system', content: [{ type: 'input_text', text: system }] },
			{ role: 'user', content: [{ type: 'input_text', text: prompt }] },
		],
	}
	let baseChat = {
		model: modelName,
		messages: [
			{ role: 'system', content: system },
			{ role: 'user', content: prompt },
		],
	}
	if (Number.isFinite(temperature)) {
		baseResponses.temperature = temperature
		baseChat.temperature = temperature
	}
	let toolVariants = useSearch
		? [
			[{ type: 'web_search' }],
			[{ type: 'x_search' }],
			[{ type: 'web_search' }, { type: 'x_search' }],
		]
		: [[]]
	let attempts = []
	let noToolAttempts = []
	let addAttempt = (label, url, body) => {
		if (!url) return
		attempts.push({ label, url, body })
	}
	let addNoToolAttempt = (label, url, body) => {
		if (!url) return
		noToolAttempts.push({ label, url, body })
	}
	for (let tools of toolVariants) {
		let toolsLabel = tools.length ? `tools=${tools[0].type}` : 'no-tools'
		let bodyWithTools = { ...baseResponses }
		if (tools.length) bodyWithTools.tools = tools
		addAttempt(`responses+schema+${toolsLabel}`, XAI_RESPONSES_URL, {
			...bodyWithTools,
			text: { format: verifySchema },
		})
		addAttempt(`responses+raw+${toolsLabel}`, XAI_RESPONSES_URL, {
			...bodyWithTools,
		})
	}
	for (let tools of toolVariants) {
		let toolsLabel = tools.length ? `tools=${tools[0].type}` : 'no-tools'
		let bodyWithTools = { ...baseChat }
		if (tools.length) bodyWithTools.tools = tools
		addAttempt(`chat+schema+${toolsLabel}`, XAI_CHAT_URL, {
			...bodyWithTools,
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: verifySchema.name || 'verify_result',
					schema: verifySchema.schema || {},
					strict: verifySchema.strict === true,
				},
			},
		})
		addAttempt(`chat+raw+${toolsLabel}`, XAI_CHAT_URL, {
			...bodyWithTools,
		})
	}
	if (useSearch) {
		let bodyResponses = { ...baseResponses }
		let bodyChat = { ...baseChat }
		addNoToolAttempt('responses+schema+no-tools', XAI_RESPONSES_URL, {
			...bodyResponses,
			text: { format: verifySchema },
		})
		addNoToolAttempt('responses+raw+no-tools', XAI_RESPONSES_URL, {
			...bodyResponses,
		})
		addNoToolAttempt('chat+schema+no-tools', XAI_CHAT_URL, {
			...bodyChat,
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: verifySchema.name || 'verify_result',
					schema: verifySchema.schema || {},
					strict: verifySchema.strict === true,
				},
			},
		})
		addNoToolAttempt('chat+raw+no-tools', XAI_CHAT_URL, {
			...bodyChat,
		})
	}
	let lastError = null
	for (let attempt of attempts) {
		try {
			let response = await fetch(attempt.url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${XAI_API_KEY}`,
				},
				body: JSON.stringify(attempt.body),
			})
			let data = await response.json().catch(() => ({}))
			if (response.ok) return data
			let message = data?.error?.message || data?.message || response.statusText
			let status = response.status
			if (status === 401 || status === 403) {
				throw new Error(`xAI API error: ${message}`)
			}
			let suffix = ` (attempt=${attempt.label} status=${status})`
			lastError = new Error(`xAI API error: ${message}${suffix}`)
		} catch (error) {
			lastError = error
		}
	}
	if (useSearch && noToolAttempts.length) {
		for (let attempt of noToolAttempts) {
			try {
				let response = await fetch(attempt.url, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${XAI_API_KEY}`,
					},
					body: JSON.stringify(attempt.body),
				})
				let data = await response.json().catch(() => ({}))
				if (response.ok) {
					throw new Error('xAI API error: live search unavailable for this model/account; disable VERIFY_USE_SEARCH or enable search access.')
				}
				let message = data?.error?.message || data?.message || response.statusText
				let status = response.status
				if (status === 401 || status === 403) {
					throw new Error(`xAI API error: ${message}`)
				}
				let suffix = ` (attempt=${attempt.label} status=${status})`
				lastError = new Error(`xAI API error: ${message}${suffix}`)
			} catch (error) {
				lastError = error
			}
		}
	}
	if (lastError) throw lastError
	throw new Error('xAI API error: request failed')
}

export async function verifyArticle({
	original,
	candidate,
	minConfidence,
	failOpen,
	debug,
	debugMaxChars,
}) {
	let payload = buildPayload(original, candidate, {
		maxChars: verifyMaxChars,
		contextMaxChars: verifyContextMaxChars,
	})
	try {
		let { system, user } = buildPrompt(payload)
		let debugSystem = ''
		let debugUser = ''
		let completion
		let fallbackUsed = false
		let providerFallbackUsed = false
		let providerUsed = verifyProvider
		let modelUsed = verifyModel
		let useSearchUsed = verifyUseSearch
		const runProvider = async ({ provider, model, useSearch }) => {
			let localSystem = system
			let localUser = user
			let localDebugSystem = ''
			let localDebugUser = ''
			if (debug) {
				localDebugSystem = clampText(localSystem, debugMaxChars)
				localDebugUser = clampText(localUser, debugMaxChars)
			}
			try {
				if (provider === 'xai') {
					return {
						completion: await callXAI({
							system: localSystem,
							prompt: localUser,
							temperature: verifyTemperature,
							useSearch,
							model,
						}),
						debugSystem: localDebugSystem,
						debugUser: localDebugUser,
						lengthFallbackUsed: false,
					}
				}
				return {
					completion: await callOpenAI({
						system: localSystem,
						prompt: localUser,
						temperature: verifyTemperature,
						useSearch,
						model,
						reasoningEffort: verifyReasoningEffort,
					}),
					debugSystem: localDebugSystem,
					debugUser: localDebugUser,
					lengthFallbackUsed: false,
				}
			} catch (error) {
				if (!isLengthError(error)) throw error
				let fallbackPayload = buildPayload(original, candidate, {
					maxChars: verifyFallbackMaxChars,
					contextMaxChars: verifyFallbackContextMaxChars,
				})
				let fallbackPrompt = buildPrompt(fallbackPayload)
				localSystem = fallbackPrompt.system
				localUser = fallbackPrompt.user
				if (debug) {
					localDebugSystem = clampText(localSystem, debugMaxChars)
					localDebugUser = clampText(localUser, debugMaxChars)
				}
				if (provider === 'xai') {
					return {
						completion: await callXAI({
							system: localSystem,
							prompt: localUser,
							temperature: verifyTemperature,
							useSearch,
							model,
						}),
						debugSystem: localDebugSystem,
						debugUser: localDebugUser,
						lengthFallbackUsed: true,
					}
				}
				return {
					completion: await callOpenAI({
						system: localSystem,
						prompt: localUser,
						temperature: verifyTemperature,
						useSearch,
						model,
						reasoningEffort: verifyReasoningEffort,
					}),
					debugSystem: localDebugSystem,
					debugUser: localDebugUser,
					lengthFallbackUsed: true,
				}
			}
		}

		try {
			let primary = await runProvider({
				provider: verifyProvider,
				model: verifyModel,
				useSearch: verifyUseSearch,
			})
			completion = primary.completion
			debugSystem = primary.debugSystem
			debugUser = primary.debugUser
			fallbackUsed = primary.lengthFallbackUsed
		} catch (error) {
			if (verifyProvider !== 'xai' || verifyFallbackProvider !== 'openai') throw error
			let fallback = await runProvider({
				provider: 'openai',
				model: verifyFallbackModel,
				useSearch: verifyFallbackUseSearch,
			})
			completion = fallback.completion
			debugSystem = fallback.debugSystem
			debugUser = fallback.debugUser
			fallbackUsed = fallback.lengthFallbackUsed
			providerFallbackUsed = true
			providerUsed = 'openai'
			modelUsed = verifyFallbackModel
			useSearchUsed = verifyFallbackUseSearch
		}
		let content = extractResponseText(completion)
		let jsonText = cleanJsonText(content)
		let parsed = JSON.parse(jsonText)
		let match = Boolean(parsed.match)
		let confidence = Number(parsed.confidence ?? 0)
		let reason = clampSummary(String(parsed.reason ?? ''))
		let pageSummary = clampSummary(String(parsed.page_summary ?? parsed.pageSummary ?? ''))
		let ok = match && confidence >= minConfidence
		return {
			ok,
			match,
			confidence,
			reason,
			pageSummary,
			verified: true,
			status: ok ? 'ok' : 'mismatch',
			model: modelUsed,
			useSearch: useSearchUsed,
			provider: providerUsed,
			tokens: completion?.usage?.total_tokens
				?? completion?.usage?.totalTokens
				?? completion?.usage?.total,
			debug: debug
				? {
					model: modelUsed,
					temperature: verifyTemperature,
					useSearch: useSearchUsed,
					fallbackUsed,
					provider: providerUsed,
					providerFallbackUsed,
					fallbackMaxChars: verifyFallbackMaxChars,
					fallbackContextMaxChars: verifyFallbackContextMaxChars,
					system: debugSystem,
					prompt: debugUser,
				}
				: undefined,
			fallbackUsed,
			providerFallbackUsed,
		}
	} catch (error) {
		log('verify failed', error)
		if (failOpen) {
			return {
				ok: true,
				match: false,
				confidence: 0,
				reason: 'verification unavailable',
				pageSummary: '',
				verified: false,
				status: 'unverified',
				model: verifyModel,
				useSearch: verifyUseSearch,
				error,
			}
		}
		return {
			ok: false,
			match: false,
			confidence: 0,
			reason: 'verification failed',
			pageSummary: '',
			verified: false,
			status: 'error',
			model: verifyModel,
			useSearch: verifyUseSearch,
			error,
		}
	}
}
