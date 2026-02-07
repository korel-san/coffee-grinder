import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const articlesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grinder-articles-'))
process.env.ARTICLES_DIR = articlesDir

process.on('exit', () => {
	try {
		fs.rmSync(articlesDir, { recursive: true, force: true })
	} catch {}
})

const disk = await import(new URL('../src/summarize/disk.js', import.meta.url))
const {
	saveArticle,
	readHtmlFromDisk,
	backfillTextFromDisk,
	readCacheMeta,
	writeCacheMeta,
	getCacheInfo,
} = disk

test('saveArticle writes meta header and readHtmlFromDisk strips it', () => {
	let event = { url: 'https://example.com/news?utm_source=grinder', titleEn: 'Hello' }
	let html = '<html><head><title>Test</title></head><body>Body</body></html>'
	let text = 'Some text content.'
	let ts = '2025-01-01T00:00:00.000Z'
	saveArticle(event, html, text, event.url, { status: 'ok', method: 'fetch', ts })
	let cache = getCacheInfo(event, event.url)
	let rawHtml = fs.readFileSync(path.join(articlesDir, `${cache.key}.html`), 'utf8')
	assert.match(rawHtml, /status: ok/)
	assert.match(rawHtml, /method: fetch/)
	assert.match(rawHtml, /url: https:\/\/example.com\/news/)
	let cleaned = readHtmlFromDisk(event, event.url)
	assert.equal(cleaned.trim(), html)
})

test('readCacheMeta reads meta from html/txt cache', () => {
	let event = { url: 'https://example.com/article?utm_campaign=1', titleEn: 'Title' }
	let html = '<html><body>Article</body></html>'
	let text = 'Article text.'
	let ts = '2025-01-02T03:04:05.000Z'
	saveArticle(event, html, text, event.url, { status: 'short', method: 'fetch', ts })
	let meta = readCacheMeta(event, event.url)
	assert.equal(meta.status, 'short')
	assert.equal(meta.method, 'fetch')
	assert.equal(meta.url, 'https://example.com/article')
})

test('writeCacheMeta updates status without removing body', () => {
	let event = { url: 'https://example.com/update', titleEn: 'Update' }
	let html = '<html><body>Update body</body></html>'
	let text = 'Update text.'
	saveArticle(event, html, text, event.url, { status: 'ok', method: 'fetch' })
	writeCacheMeta(event, event.url, { status: 'mismatch', method: 'verify', textLength: 0 })
	let meta = readCacheMeta(event, event.url)
	assert.equal(meta.status, 'mismatch')
	assert.equal(meta.method, 'verify')
	let cleaned = readHtmlFromDisk(event, event.url)
	assert.equal(cleaned.trim(), html)
})

test('backfillTextFromDisk ignores meta header', () => {
	let event = { url: 'https://example.com/backfill', titleEn: 'Backfill' }
	let html = '<html><body>Backfill</body></html>'
	let text = 'Line one.\nLine two.'
	saveArticle(event, html, text, event.url, { status: 'ok', method: 'fetch' })
	let fresh = { url: event.url }
	let did = backfillTextFromDisk(fresh, event.url)
	assert.equal(did, true)
	assert.equal(fresh.text, text)
})

test('saveArticle does not mutate event when mutateEvent=false', () => {
	let event = { url: 'https://example.com/mismatch', titleEn: 'Original', source: 'OrigSource' }
	let html = '<html><body>New</body></html>'
	let text = 'New text that should be cached but not applied.'
	saveArticle(event, html, text, event.url, { status: 'mismatch', method: 'fetch', mutateEvent: false })
	assert.equal(event.text, undefined)
	assert.equal(event.titleEn, 'Original')
	assert.equal(event.source, 'OrigSource')
})
