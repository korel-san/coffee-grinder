import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeConfig } from '../config/summarize.js'
import { createFetchTextWithRetry } from '../src/summarize/fetch-text.js'

const makeText = length => 'A'.repeat(length)

test('fetchTextWithRetry scenarios', async () => {
	const last = { verify: { time: 0, delay: 0 } }

	// Scenario 1: fetch ok, verify ok, browse skipped.
	{
		const fetchTextWithRetry = createFetchTextWithRetry({
			logEvent: () => {},
			getLastFetchStatus: () => null,
			fetchArticle: async (url, { onMethod } = {}) => {
				if (onMethod) onMethod('fetch')
				return makeText(500)
			},
			browseArticle: async () => {
				throw new Error('browse should not be called')
			},
			verifyText: async () => ({ ok: true, status: 'ok', durationMs: 5 }),
			getProgressTracker: () => null,
		})
		let event = { id: 't1', url: 'https://example.com/article' }
		let result = await fetchTextWithRetry(event, event.url, last, { origin: 'original' })
		assert.equal(result.ok, true)
		assert.equal(result.method, 'fetch')
	}

	// Scenario 2: fetch no text, browse ok.
	{
		const fetchTextWithRetry = createFetchTextWithRetry({
			logEvent: () => {},
			getLastFetchStatus: () => null,
			fetchArticle: async () => '',
			browseArticle: async () => ({ html: makeText(500), meta: {} }),
			verifyText: async () => ({ ok: true, status: 'ok', durationMs: 5 }),
			getProgressTracker: () => null,
		})
		let event = { id: 't2', url: 'https://example.com/article2' }
		let result = await fetchTextWithRetry(event, event.url, last, { origin: 'original' })
		assert.equal(result.ok, true)
		assert.equal(result.method, 'browse')
	}

	// Scenario 3: verify mismatch stops when browseOnMismatch=false.
	{
		let prevBrowseOnMismatch = summarizeConfig.browseOnMismatch
		summarizeConfig.browseOnMismatch = false
		const fetchTextWithRetry = createFetchTextWithRetry({
			logEvent: () => {},
			getLastFetchStatus: () => null,
			fetchArticle: async () => makeText(500),
			browseArticle: async () => {
				throw new Error('browse should not be called')
			},
			verifyText: async () => ({ ok: false, status: 'mismatch', reason: 'test' }),
			getProgressTracker: () => null,
		})
		let event = { id: 't3', url: 'https://example.com/article3' }
		let result = await fetchTextWithRetry(event, event.url, last, { origin: 'original' })
		assert.equal(result.ok, false)
		assert.equal(result.mismatch, true)
		assert.equal(result.method, 'fetch')
		summarizeConfig.browseOnMismatch = prevBrowseOnMismatch
	}

	// Scenario 4: short text returns short=true after attempts.
	{
		const fetchTextWithRetry = createFetchTextWithRetry({
			logEvent: () => {},
			getLastFetchStatus: () => null,
			fetchArticle: async () => 'short text',
			browseArticle: async () => ({ html: '', meta: {} }),
			verifyText: async () => ({ ok: true, status: 'ok', durationMs: 1 }),
			getProgressTracker: () => null,
		})
		let event = { id: 't4', url: 'https://example.com/article4' }
		let result = await fetchTextWithRetry(event, event.url, last, { origin: 'original' })
		assert.equal(result.ok, false)
		assert.equal(result.short, true)
	}

	// Scenario 5: browse captcha abort stops retries.
	{
		let fetchCalls = 0
		let browseCalls = 0
		const fetchTextWithRetry = createFetchTextWithRetry({
			logEvent: () => {},
			getLastFetchStatus: () => null,
			fetchArticle: async () => {
				fetchCalls += 1
				return ''
			},
			browseArticle: async () => {
				browseCalls += 1
				let err = new Error('captcha')
				err.code = 'CAPTCHA'
				throw err
			},
			verifyText: async () => ({ ok: false, status: 'mismatch' }),
			getProgressTracker: () => null,
		})
		let event = { id: 't5', url: 'https://example.com/captcha' }
		let result = await fetchTextWithRetry(event, event.url, last, { origin: 'original' })
		assert.equal(fetchCalls, 1)
		assert.equal(browseCalls, 1)
		assert.equal(result.ok, false)
		assert.equal(result.status, 'captcha')
	}

	// Scenario 6: cooldown abort stops retries.
	{
		let fetchCalls = 0
		let browseCalls = 0
		const fetchTextWithRetry = createFetchTextWithRetry({
			logEvent: () => {},
			getLastFetchStatus: () => null,
			fetchArticle: async () => {
				fetchCalls += 1
				return ''
			},
			browseArticle: async () => {
				browseCalls += 1
				return { html: '', meta: {}, aborted: true, abortReason: 'cooldown' }
			},
			verifyText: async () => ({ ok: false, status: 'mismatch' }),
			getProgressTracker: () => null,
		})
		let event = { id: 't6', url: 'https://example.com/cooldown' }
		let result = await fetchTextWithRetry(event, event.url, last, { origin: 'original' })
		assert.equal(fetchCalls, 1)
		assert.equal(browseCalls, 1)
		assert.equal(result.ok, false)
		assert.equal(result.status, 'cooldown')
	}

	// Scenario 7: content ok step is not emitted inside fetchTextWithRetry.
	{
		let steps = []
		const progress = {
			step: (event, step, status) => {
				steps.push({ step, status })
			},
		}
		const fetchTextWithRetry = createFetchTextWithRetry({
			logEvent: () => {},
			getLastFetchStatus: () => null,
			fetchArticle: async () => makeText(500),
			browseArticle: async () => ({ html: '', meta: {} }),
			verifyText: async () => ({ ok: true, status: 'ok', durationMs: 5 }),
			getProgressTracker: () => progress,
		})
		let event = { id: 't7', url: 'https://example.com/article7' }
		let result = await fetchTextWithRetry(event, event.url, last, { origin: 'original' })
		assert.equal(result.ok, true)
		let contentOk = steps.filter(item => item.step === 'content' && item.status === 'ok')
		assert.equal(contentOk.length, 0)
	}
})
