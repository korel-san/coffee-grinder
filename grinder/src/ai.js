import OpenAI from 'openai'

import { spreadsheetId } from './store.js'
import { log } from './log.js'
import { sleep } from './sleep.js'
import { getPrompt } from './prompts.js'

const DEFAULT_OPENAI_MODEL = 'gpt-5-mini'
const FALLBACK_OPENAI_MODEL = 'gpt-4o-mini'

const explicitModel = process.env.OPENAI_SUMMARIZE_MODEL || process.env.OPENAI_MODEL
const openAiModel = explicitModel || DEFAULT_OPENAI_MODEL
const modelSource = process.env.OPENAI_SUMMARIZE_MODEL
	? 'OPENAI_SUMMARIZE_MODEL'
	: process.env.OPENAI_MODEL
		? 'OPENAI_MODEL'
		: 'default'

let openai = new OpenAI()
let assistant

function describeSummarizeSettings(model) {
	let src = modelSource ? ` (${modelSource})` : ''
	// Keep this in sync with createAssistant() args: we currently don't set temperature/top_p/response_format.
	return `api=assistants model=${model}${src} temperature=unset top_p=unset response_format=unset reasoning=unset`
}

async function createAssistant({ instructions, model }) {
	return await openai.beta.assistants.create({
		name: "Summarizer",
		instructions,
		model,
	})
}

async function initialize() {
	let instructions = await getPrompt(spreadsheetId, 'summarize:summary')
	try {
		assistant = await createAssistant({ instructions, model: openAiModel })
		log('AI summarize:', describeSummarizeSettings(openAiModel))
	} catch (e) {
		if (explicitModel) throw e
		log('AI model failed:', openAiModel, '\nFalling back to:', FALLBACK_OPENAI_MODEL, '\n', e)
		assistant = await createAssistant({ instructions, model: FALLBACK_OPENAI_MODEL })
		log('AI summarize:', describeSummarizeSettings(FALLBACK_OPENAI_MODEL))
	}
}
let init = initialize()

export async function ai({ url, text }) {
	await init
	for (let i = 0; i < 3; i++) {
		let thread = await openai.beta.threads.create()
		let content = `URL: ${url}\nText:\n${text}`
		const message = await openai.beta.threads.messages.create(thread.id, {
			role: "user",
			content,
		})
		try {
			let run = await openai.beta.threads.runs.createAndPoll(thread.id, {
				assistant_id: assistant.id,
			})
			if (run?.status === 'completed') {
				const messages = await openai.beta.threads.messages.list(run.thread_id)
				// log(run)
				// log(messages.data[0].content)
				let json = messages.data[0].content[0].text.value.replace('```json', '').replace('```', '')
				try {
					let res = JSON.parse(json)
					log('got', res.summary.length, 'chars,', run.usage.total_tokens, 'tokens used')
					res.delay = run.usage.total_tokens / 30e3 * 60e3
					return res
				} catch (e) {
					log('AI fail\n', json, '\n', e)
					return null
				}
			} else {
				log('AI fail\n', run?.last_error || run)
				await sleep(30e3)
			}
		} catch(e) {
			log('AI fail\n', e)
			await sleep(30e3)
		}
	}
}
