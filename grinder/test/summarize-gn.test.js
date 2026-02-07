import test from 'node:test'
import assert from 'node:assert/strict'

import { buildFallbackSearchQueriesWithAi, buildSearchQuery, shouldDropSiteForFallback } from '../src/summarize/gn.js'
import { searchQueryConfig } from '../config/search-query.js'

test('buildSearchQuery drops site when fallback reason indicates block', () => {
	let event = {
		url: 'https://reuters.com/world/us/foo-bar-2026-02-03/',
		_fallbackReason: 'captcha',
	}
	let defaultQuery = buildSearchQuery(event)
	assert.match(defaultQuery, /^site:reuters\.com /)
	let allowSite = !shouldDropSiteForFallback(event)
	let fallbackQuery = buildSearchQuery(event, { allowSite })
	assert.equal(allowSite, false)
	assert.equal(fallbackQuery.startsWith('site:'), false)
	assert.match(fallbackQuery, /foo bar 2026 02 03/)
})

test('shouldDropSiteForFallback detects blocked reasons', () => {
	assert.equal(shouldDropSiteForFallback({ _fallbackReason: 'blocked_403' }), true)
	assert.equal(shouldDropSiteForFallback({ _fallbackReason: 'cooldown' }), true)
	assert.equal(shouldDropSiteForFallback({ _fallbackReason: 'no_text' }), false)
})

test('buildFallbackSearchQueriesWithAi uses AI when queries are weak', async () => {
	let prevEnabled = searchQueryConfig.enabled
	searchQueryConfig.enabled = true
	let event = { url: 'https://example.com/411174' }
	let result = await buildFallbackSearchQueriesWithAi(event, {
		allowAi: true,
		generate: async () => ({ queries: ['\"congress guarantees backpay\"'], provider: 'xai', model: 'test' }),
	})
	assert.equal(result.reason, 'ai_url')
	assert.deepEqual(result.queries, ['\"congress guarantees backpay\"'])
	searchQueryConfig.enabled = prevEnabled
})

test('buildFallbackSearchQueriesWithAi uses title+description without AI when long enough', async () => {
	let prevEnabled = searchQueryConfig.enabled
	let prevTitle = searchQueryConfig.minTitleChars
	let prevDesc = searchQueryConfig.minDescriptionChars
	searchQueryConfig.enabled = true
	searchQueryConfig.minTitleChars = 10
	searchQueryConfig.minDescriptionChars = 10
	let event = {
		url: 'https://example.com/news/some-article',
		titleEn: 'Long enough title',
		description: 'Some additional description text',
	}
	let result = await buildFallbackSearchQueriesWithAi(event, {
		allowAi: true,
		generate: async () => { throw new Error('AI should not be called') },
	})
	assert.equal(result.aiUsed, false)
	assert.equal(result.reason, 'title_desc')
	assert.deepEqual(result.queries, ['"Long enough title" Some additional description text'])
	searchQueryConfig.enabled = prevEnabled
	searchQueryConfig.minTitleChars = prevTitle
	searchQueryConfig.minDescriptionChars = prevDesc
})

test('buildFallbackSearchQueriesWithAi returns empty when AI yields none', async () => {
	let prevEnabled = searchQueryConfig.enabled
	searchQueryConfig.enabled = true
	let event = { url: 'https://example.com/411174' }
	let result = await buildFallbackSearchQueriesWithAi(event, {
		allowAi: true,
		generate: async () => ({ queries: [], provider: 'openai', model: 'test' }),
	})
	assert.equal(result.reason, 'ai_empty')
	assert.deepEqual(result.queries, [])
	searchQueryConfig.enabled = prevEnabled
})
