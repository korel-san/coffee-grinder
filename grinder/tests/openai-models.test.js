import assert from 'node:assert/strict'
import test from 'node:test'

import {
	assertWebSearchWithTemperatureModel,
	buildWebSearchWithTemperatureResponseBody,
	extractResponseOutputText,
	normalizeWebSearchWithTemperatureModel,
} from '../src/openai-websearch-templates.js'

test('web_search+temperature model allowlist supports snapshots and avoids prefix collisions', () => {
	assert.equal(normalizeWebSearchWithTemperatureModel('gpt-4o-mini'), null)
	assert.equal(normalizeWebSearchWithTemperatureModel('gpt-4o-mini-search-preview'), null)
	assert.equal(normalizeWebSearchWithTemperatureModel('gpt-4.1'), 'gpt-4.1')
	assert.equal(normalizeWebSearchWithTemperatureModel('gpt-4.1-2025-04-14'), 'gpt-4.1')
	assert.equal(normalizeWebSearchWithTemperatureModel('gpt-4.1-nano'), null)
	assert.equal(normalizeWebSearchWithTemperatureModel('gpt-4.1-mini'), 'gpt-4.1-mini')
	assert.equal(normalizeWebSearchWithTemperatureModel('gpt-4.1-mini-2025-04-14'), 'gpt-4.1-mini')
	assert.equal(normalizeWebSearchWithTemperatureModel('gpt-5.2'), 'gpt-5.2')
	assert.equal(normalizeWebSearchWithTemperatureModel('gpt-5.2-2025-12-11'), 'gpt-5.2')
	assert.equal(normalizeWebSearchWithTemperatureModel('gpt-5.2-pro'), null)
})

test('assertWebSearchWithTemperatureModel throws a helpful error', () => {
	assert.throws(() => assertWebSearchWithTemperatureModel('gpt-4o-mini-search-preview', 'OPENAI_FACTS_MODEL'), e => {
		let msg = String(e)
		assert.ok(msg.includes('gpt-4o-mini-search-preview'))
		assert.ok(msg.includes('OPENAI_FACTS_MODEL'))
		assert.ok(msg.includes('web_search+temperature'))
		return true
	})
})

test('gpt-5.2 template forces reasoning.effort=none to keep temperature compatible', () => {
	let body = buildWebSearchWithTemperatureResponseBody({
		model: 'gpt-5.2',
		system: 'sys',
		user: 'user',
		temperature: 0.2,
		webSearchOptions: { search_context_size: 'low' },
	})
	assert.deepEqual(body.reasoning, { effort: 'none' })
	assert.equal(body.temperature, 0.2)
	assert.equal(body.tools?.[0]?.type, 'web_search')
})

test('extractResponseOutputText parses raw Responses shape', () => {
	let text = extractResponseOutputText({
		output: [
			{
				type: 'message',
				role: 'assistant',
				content: [
					{ type: 'output_text', text: 'hello' },
					{ type: 'output_text', text: { value: 'world' } },
				],
			},
		],
	})
	assert.equal(text, 'hello\nworld')
})
