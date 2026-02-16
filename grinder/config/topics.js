export let topicsMap = {
	'Trump': '02. Trump',
	'US': '03. US',
	'Left reaction': '04. Left reaction',
	'Ukraine': '05. Ukraine',
	'Coffee grounds': '06. Coffee grounds',
	'World': '07. World',
	'Marasmus': '08. Marasmus',
	'Tech':	'10. Tech',
	'Crazy': '11. Crazy',
	'other': 'other',
}

// id — логический порядок/сортировка; cardId — номер placeholder'а catX_cardY в шаблоне Google Slides
// cardId соответствует текущему шаблону: cat3=Left reaction, cat4=Ukraine, cat5=Coffee grounds,
// cat6=World, cat7=Marasmus/Blitz, cat8=Tech, cat9=Crazy. Big picture/Trump/US используют 1–2.
export let topics = {
	'01. Big picture':   { id: 1,  cardId: 1, max: 6 },
	'02. Trump':         { id: 2,  cardId: 2, max: 24 },
	'03. US':            { id: 3,  cardId: 2, max: 6 },
	'04. Left reaction': { id: 4,  cardId: 3, max: 6 },
	'05. Ukraine':       { id: 5,  cardId: 4, max: 24 },
	'06. Coffee grounds':{ id: 6,  cardId: 5, max: 6 },
	'07. World':         { id: 7,  cardId: 6, max: 24 },
	'08. Marasmus':      { id: 8,  cardId: 7, max: 6 },
	'09. Blitz':         { id: 9,  cardId: 7, max: 6 },
	'10. Tech':          { id: 10, cardId: 8, max: 6 },
	'11. Crazy':         { id: 11, cardId: 9, max: 6 },
}

const topicAliases = {
	'america': '03. US',
	'world news': '07. World',
	'worldnews': '07. World',
	'left is losing it': '04. Left reaction',
	'left is losing it?': '04. Left reaction',
	'left-is-losing-it': '04. Left reaction',
	'leftislosingit': '04. Left reaction',
	'гадание на кофе': '06. Coffee grounds',
	'gadanie na kofe': '06. Coffee grounds',
}

function normalizeAlias(topic) {
	const normalized = String(topic || '').trim().toLowerCase().replace(/\s+/g, ' ')
	return topicAliases[normalized]
}

export function normalizeTopic(topic) {
	const trimmed = String(topic || '').trim()
	if (!trimmed) return ''
	if (topics[trimmed]) return trimmed

	const withoutNumber = trimmed.replace(/^\d+\.\s*/, '')
	if (topics[withoutNumber]) return withoutNumber

	const alias = normalizeAlias(withoutNumber)
	if (alias) return alias

	const normalized = withoutNumber.toLowerCase().replace(/\s+/g, ' ')
	const byName = Object.keys(topics).find(key => key.toLowerCase().replace(/^\d+\.\s*/, '').replace(/\s+/g, ' ') === normalized)
	return byName || ''
}
