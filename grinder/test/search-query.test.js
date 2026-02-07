import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSearchQueryContext } from '../src/summarize/search-query.js'
import { searchQueryConfig } from '../config/search-query.js'

test('buildSearchQueryContext ignores URL when title is long enough', () => {
	let prevTitle = searchQueryConfig.minTitleChars
	let prevDesc = searchQueryConfig.minDescriptionChars
	searchQueryConfig.minTitleChars = 10
	searchQueryConfig.minDescriptionChars = 10
	let event = {
		url: 'https://example.com/news/some-article',
		titleEn: 'This is a long enough title',
		description: '',
	}
	let { context, meta } = buildSearchQueryContext(event)
	assert.equal(meta.usedUrl, false)
	assert.equal(context.url, '')
	assert.equal(context.host, '')
	searchQueryConfig.minTitleChars = prevTitle
	searchQueryConfig.minDescriptionChars = prevDesc
})

test('buildSearchQueryContext uses URL when title/description are short', () => {
	let prevTitle = searchQueryConfig.minTitleChars
	let prevDesc = searchQueryConfig.minDescriptionChars
	searchQueryConfig.minTitleChars = 20
	searchQueryConfig.minDescriptionChars = 40
	let event = {
		url: 'https://example.com/news/some-article',
		titleEn: 'CBS News',
		description: 'Short',
	}
	let { context, meta } = buildSearchQueryContext(event)
	assert.equal(meta.usedUrl, true)
	assert.equal(context.url.includes('example.com'), true)
	searchQueryConfig.minTitleChars = prevTitle
	searchQueryConfig.minDescriptionChars = prevDesc
})
