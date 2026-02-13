import fs from 'fs'
import path from 'path'
import Sheets from '@googleapis/sheets'

import { auth } from './google-auth.js'

const isMock = process.env.MOCK_SHEETS === '1'
const mockDir = process.env.MOCK_SHEETS_DIR ?? path.resolve(process.cwd(), 'tests', 'fixtures', 'summarize')
const mockNewsPath = process.env.MOCK_SHEETS_NEWS_PATH ?? path.join(mockDir, 'news.json')
const mockAiPath = process.env.MOCK_SHEETS_AI_PATH ?? path.join(mockDir, 'ai-instructions.json')
const mockSavePath = process.env.MOCK_SHEETS_SAVE_PATH ?? path.join(mockDir, 'news.saved.json')
const mockAiRange = process.env.MOCK_SHEETS_AI_RANGE ?? 'ai-instructions'
const mockNewsRange = process.env.MOCK_SHEETS_NEWS_RANGE ?? 'news'

function readJson(filePath) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Mock sheets file not found: ${filePath}`)
	}
	return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function normalizeTable(raw) {
	let headers = raw.headers
	let rows = raw.rows ?? raw
	if (!Array.isArray(rows)) {
		throw new Error('Mock sheets data must be an array or { headers, rows }')
	}
	if (!headers) {
		headers = rows[0] ? Object.keys(rows[0]) : []
	}
	let data = rows.map(row => {
		let obj = {}
		headers.forEach(h => {
			if (row[h] !== undefined) obj[h] = row[h]
		})
		for (let key of Object.keys(row)) {
			if (!(key in obj)) obj[key] = row[key]
		}
		return obj
	})
	data.headers = headers
	return data
}

function loadMock(range) {
	if (range === mockAiRange) return readJson(mockAiPath)
	if (range === mockNewsRange) {
		let data = normalizeTable(readJson(mockNewsPath))
		return [data.headers, ...data.map(row => data.headers.map(h => row[h] ?? ''))]
	}
	throw new Error(`No mock data for range: ${range}`)
}

let sheets
async function initialize() {
	sheets = await Sheets.sheets({ version: 'v4', auth }).spreadsheets
}
let init = isMock ? null : initialize()

export async function load(spreadsheetId, range) {
	if (isMock) return loadMock(range)
	await init
	const res = await sheets.values.get({ spreadsheetId, range })
	return res.data.values
}

export async function save(spreadsheetId, range, data) {
	if (isMock) return { mocked: true }
	return await sheets.values.update({
		spreadsheetId,
		range,
		// valueInputOption: 'RAW',
		valueInputOption: 'USER_ENTERED',
		requestBody: { values: data },
	})
}

export async function loadTable(spreadsheetId, range) {
	if (isMock) return normalizeTable(readJson(mockNewsPath))
	const rows = await load(spreadsheetId, range)
	// log('Data from sheet:', rows)
	const headers = rows[0]
	const data = rows.slice(1).map(row => {
		let obj = {}
		row.forEach((cell, i) => {
			obj[headers[i]] = cell
		})
		return obj
	})
	data.headers = headers
	return data
}

export async function saveTable(spreadsheetId, range, data) {
	if (isMock) {
		let headers = data.headers
		if (!headers) headers = data[0] ? Object.keys(data[0]) : []
		const rows = data.map(row => {
			let obj = {}
			headers.forEach(h => { obj[h] = row[h] ?? '' })
			return obj
		})
		fs.mkdirSync(path.dirname(mockSavePath), { recursive: true })
		fs.writeFileSync(mockSavePath, JSON.stringify({ headers, rows }, null, 2))
		return
	}
	let { headers } = data
	await init
	const updatedData = [
		headers,
		...data.map(o => headers.map(h => o[h] ?? '')),
	]
	// log({ updatedData })
	return await save(spreadsheetId, range, updatedData)
}
