import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyAlternativeCandidates } from '../src/summarize/articles.js'
import { setDomainCooldown } from '../src/domain-cooldown.js'

test('classifyAlternativeCandidates filters and orders', () => {
	let event = {
		source: 'AP News',
		url: 'https://apnews.com/story1',
		date: '2026-02-01',
	}
	let candidates = [
		{
			source: 'Reuters',
			url: 'https://reuters.com/article/one',
			date: '2026-02-02',
			origin: 'gn',
			titleEn: 'One',
		},
		{
			source: 'Reuters',
			url: 'https://reuters.com/article/two',
			date: '2026-02-03',
			origin: 'gn',
			titleEn: 'Two',
		},
		{
			source: 'AP News',
			url: 'https://apnews.com/story1',
			date: '2026-02-02',
			origin: 'gn',
			titleEn: 'Same',
		},
		{
			source: 'Local News',
			url: 'https://local.example.com/story',
			date: '2026-01-15',
			origin: 'gn',
			titleEn: 'Old',
		},
	]
	let { accepted, rejected } = classifyAlternativeCandidates(event, candidates)
	assert.equal(accepted.length, 1)
	assert.equal(accepted[0].source, 'Reuters')
	let reasons = new Map(rejected.map(item => [item.url, item.reason]))
	assert.equal(reasons.get('https://apnews.com/story1'), 'same_source_same_link')
	assert.equal(reasons.get('https://reuters.com/article/two'), 'same_domain')
	assert.equal(reasons.get('https://local.example.com/story'), 'date_out_of_range')
})

test('classifyAlternativeCandidates marks same_source', () => {
	let event = {
		source: 'Reuters',
		url: 'https://reuters.com/original',
		date: '2026-02-01',
	}
	let candidates = [
		{
			source: 'Reuters',
			url: 'https://reuters.com/another',
			date: '2026-02-02',
			origin: 'gn',
			titleEn: 'Another',
		},
	]
	let { accepted, rejected } = classifyAlternativeCandidates(event, candidates)
	assert.equal(accepted.length, 0)
	assert.equal(rejected[0].reason, 'same_source')
})

test('classifyAlternativeCandidates skips domain cooldown', () => {
	setDomainCooldown('https://apnews.com/story2', 60_000, '429')
	let event = {
		source: 'Reuters',
		url: 'https://reuters.com/original',
		date: '2026-02-01',
	}
	let candidates = [
		{
			source: 'AP News',
			url: 'https://apnews.com/story2',
			date: '2026-02-02',
			origin: 'gn',
			titleEn: 'Blocked',
		},
	]
	let { accepted, rejected } = classifyAlternativeCandidates(event, candidates)
	assert.equal(accepted.length, 0)
	assert.equal(rejected[0].reason, 'domain_cooldown')
})
