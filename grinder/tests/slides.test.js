import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href

const news = [
	{
		topic: '03. US',
		priority: 1,
		titleEn: 'US story',
		url: 'https://example.com/us',
	},
	{
		topic: '10. Tech',
		priority: 5,
		titleEn: 'Tech story',
		url: 'https://example.com/tech',
	},
	{
		topic: 'other',
		priority: 1,
		titleEn: 'Other story',
		url: 'https://example.com/other',
	},
]

let calls = []
let written = null

mock.module(mod('store.js'), {
	namedExports: { news }
})

mock.module(mod('log.js'), {
	namedExports: { log: () => {} }
})

mock.module(mod('google-slides.js'), {
	namedExports: {
		presentationExists: async () => false,
		createPresentation: async () => {
			calls.push(['createPresentation'])
		},
		addSlide: async (payload) => {
			calls.push(['addSlide', payload])
		},
	}
})

mock.module('fs', {
	defaultExport: {
		writeFileSync: (filePath, data) => {
			written = { filePath, data }
		},
	}
})

const { slides } = await import(mod('3.slides.js'))

test('slides pipeline (mocked)', async () => {
	calls = []
	written = null

	news.forEach(e => {
		delete e.sqk
		delete e.topicSqk
	})

	await slides()

	assert.deepEqual(calls.filter(c => c[0] === 'createPresentation'), [['createPresentation']])

	const added = calls.filter(c => c[0] === 'addSlide').map(c => c[1])
	assert.equal(added.length, 2)

	assert.equal(added[0].sqk, 3)
	assert.equal(added[0].topicId, 3)
	assert.equal(added[0].notes, '')

	assert.equal(added[1].sqk, 4)
	assert.equal(added[1].topicId, 10)
	assert.equal(added[1].notes, '')

	assert.ok(written, 'Expected screenshots.txt to be written')
	assert.equal(written.filePath, '../img/screenshots.txt')
	assert.equal(written.data, '3\nhttps://example.com/us\n4\nhttps://example.com/tech\n')

	assert.equal(news.find(e => e.topic === '03. US').sqk, 3)
	assert.equal(news.find(e => e.topic === '10. Tech').sqk, 4)
	assert.equal(news.find(e => e.topic === 'other').sqk, undefined)
})

