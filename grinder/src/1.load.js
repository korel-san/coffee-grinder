import { xml2json } from 'xml-js'

import { log } from './log.js'
import { news } from './store.js'
import feeds from '../config/feeds.js'

async function get({ url }) {
	return await (await fetch(url)).text()
}

function parse(xml) {
	// log('Parsing', xml.length, 'bytes...')
	let feed = JSON.parse(xml2json(xml, { compact: true }))
	let items = feed?.rss?.channel?.item?.map(event => {
		if (!event.pubDate?._text) return null
		return {
			titleEn: event.title?._text, // .replace(` - ${event.source?._text}`, ''),
			gnUrl: event.link?._text,
			source: event.source?._text,
			date: new Date(event.pubDate._text),
		}
	}).filter(Boolean)
	return items || []
}

function mergeInto(target, source) {
	let index = {}
	let seen = event => {
		index[event.titleEn] = event
		index[event.gnUrl] = event
	}
	target.forEach(seen)
	source.forEach(event => {
		if (index[event.titleEn] || index[event.gnUrl]) return
		seen(event)
		target.push(event)
	})
}

function intersect(target, source) {
	let index = {}
	let seen = event => {
		index[event.titleEn] = event
		index[event.gnUrl] = event
	}
	source.forEach(e => {
		seen(e)
		if (Array.isArray(e.articles)) e.articles.forEach(seen)
	})
	target.forEach(event => {
		if (!index[event.titleEn] && !index[event.gnUrl]) {
			event.priority = 9
		}
	})
}

export async function load() {
	let [date, time] = new Date().toISOString().split('T')
	let cutoff = new Date(date + 'T00:00:00Z')
	if (time < '12:00') {
		cutoff -= 24 * 60 * 60e3
	}
	if (new Date(cutoff).getUTCDate() === 0) {
		cutoff -= 2 * 24 * 60 * 60e3
	}
	log('Loading', feeds.length, 'feeds', 'starting at', new Date(cutoff).toISOString(), '...')

	let raw = await Promise.all(feeds.map(get))

	let incoming = raw.map(parse)
	.map(a => a.filter(e => e.date >= cutoff))
	.map((a, i) => a.slice(0, feeds[i].max))
	.flat()

	let newsN = news.length
	if (newsN) {
		intersect(news, incoming)
	} else {
		news.push(...incoming)
	}
	log('\ngot', news.length, `(+${news.length - newsN})`, 'events')
	return news
}

if (process.argv[1].endsWith('load')) load()
