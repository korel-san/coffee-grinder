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
	{ sqk: 3, titleEn: 'A', summary: 'Hello world.' },
	{ sqk: 4, titleEn: 'B', summary: 'Second summary.' },
	{ sqk: 5, titleEn: 'C' },
	{ titleEn: 'D', summary: 'Missing sqk.' },
]

let speakCalls = []
let uploadCalls = []

mock.module(mod('store.js'), {
	namedExports: { news }
})

mock.module(mod('log.js'), {
	namedExports: { log: () => {} }
})

mock.module(mod('eleven.js'), {
	namedExports: {
		speak: async (sqk, text) => {
			speakCalls.push([sqk, text])
		},
	}
})

mock.module(mod('google-drive.js'), {
	namedExports: {
		uploadFolder: async (...args) => {
			uploadCalls.push(args)
		},
	}
})

const { audio } = await import(mod('4.audio.js'))

test('audio pipeline (mocked)', async () => {
	speakCalls = []
	uploadCalls = []

	await audio()

	assert.deepEqual(speakCalls, [
		[3, 'Hello world.'],
		[4, 'Second summary.'],
	])

	assert.equal(uploadCalls.length, 1)
	const [dir, parentId, folderName, exts] = uploadCalls[0]
	assert.equal(dir, '../audio')
	assert.ok(parentId)
	assert.equal(folderName, 'audio')
	assert.deepEqual(exts, ['.mp3'])
})

