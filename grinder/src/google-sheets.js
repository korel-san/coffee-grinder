import Sheets from '@googleapis/sheets'

import { auth } from './google-auth.js'

let sheets
async function initialize() {
	sheets = await Sheets.sheets({ version: 'v4', auth }).spreadsheets
}
let init = initialize()

export async function load(spreadsheetId, range) {
	await init
	const res = await sheets.values.get({ spreadsheetId, range })
	return res.data.values
}

export async function save(spreadsheetId, range, data) {
	return await sheets.values.update({
		spreadsheetId,
		range,
		// valueInputOption: 'RAW',
		valueInputOption: 'USER_ENTERED',
		requestBody: { values: data },
	})
}

export async function clear(spreadsheetId, range) {
	await init
	return await sheets.values.clear({ spreadsheetId, range })
}

export async function append(spreadsheetId, range, data) {
	await init
	return await sheets.values.append({
		spreadsheetId,
		range,
		valueInputOption: 'USER_ENTERED',
		insertDataOption: 'INSERT_ROWS',
		requestBody: { values: data },
	})
}

export async function getSpreadsheet(spreadsheetId, fields = 'sheets.properties.title') {
	await init
	return await sheets.get({ spreadsheetId, fields })
}

export async function ensureSheet(spreadsheetId, title) {
	const res = await getSpreadsheet(spreadsheetId, 'sheets.properties.title')
	const titles = res.data.sheets?.map(s => s.properties?.title).filter(Boolean) ?? []
	if (titles.includes(title)) return
	return await sheets.batchUpdate({
		spreadsheetId,
		requestBody: {
			requests: [
				{ addSheet: { properties: { title } } },
			],
		},
	})
}

export async function loadTable(spreadsheetId, range) {
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
	let { headers } = data
	await init
	const updatedData = [
		headers,
		...data.map(o => headers.map(h => o[h] ?? '')),
	]
	// log({ updatedData })
	return await save(spreadsheetId, range, updatedData)
}
