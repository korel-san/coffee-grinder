import test from 'node:test'
import assert from 'node:assert/strict'

import { extractSearchTermsFromUrl } from '../src/summarize/utils.js'

test('extractSearchTermsFromUrl skips numeric tail segments', () => {
	let url = 'https://www.govexec.com/pay-benefits/2026/02/congress-guarantees-furloughed-feds-backpay-continued-white-house-maneuvering/411174/'
	let terms = extractSearchTermsFromUrl(url)
	assert.ok(terms.length > 0)
	assert.match(terms, /congress guarantees furloughed feds backpay/)
	assert.equal(/411174/.test(terms), false)
})
