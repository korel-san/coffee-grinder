import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const srcDir = path.join(rootDir, 'src')

const mod = relativePath => pathToFileURL(path.join(srcDir, relativePath)).href

let calls = []
let moved = []

mock.module(mod('store.js'), {
	namedExports: {
		news: [],
		spreadsheetId: 'spreadsheet-id',
	}
})

mock.module(mod('google-slides.js'), {
	namedExports: {
		archivePresentation: async (name) => {
			calls.push(['archivePresentation', name])
		},
	}
})

mock.module(mod('google-drive.js'), {
	namedExports: {
		copyFile: async () => {},
		getFile: async (_folderId, name) => {
			calls.push(['getFile', name])
			if (name === 'audio') return { id: 'audio123' }
			if (name === 'img') return { id: 'img123' }
			return null
		},
		moveFile: async (id, _folderId, newName) => {
			moved.push({ id, newName })
		},
	}
})

mock.module(mod('sleep.js'), {
	namedExports: {
		sleep: async () => {},
	}
})

mock.module(mod('log.js'), {
	namedExports: {
		log: () => {},
	}
})

const { cleanup } = await import(mod('0.cleanup.js'))

test('cleanup pipeline (mocked)', async () => {
	calls = []
	moved = []

	const originalNow = Date.now
	Date.now = () => Date.parse('2026-02-15T12:00:00Z')
	try {
		await cleanup()
	} finally {
		Date.now = originalNow
	}

	assert.deepEqual(
		calls.filter(c => c[0] === 'archivePresentation'),
		[['archivePresentation', '2026-02-14']],
	)

	assert.deepEqual(
		calls.filter(c => c[0] === 'getFile'),
		[['getFile', 'audio'], ['getFile', 'img']],
	)

	assert.deepEqual(
		moved
			.map(({ id, newName }) => ({ id, newName }))
			.sort((a, b) => a.newName.localeCompare(b.newName)),
		[
			{ id: 'audio123', newName: '2026-02-14_audio' },
			{ id: 'img123', newName: '2026-02-14_img' },
		],
	)
})

