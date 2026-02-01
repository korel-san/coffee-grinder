import fs from 'fs'

import { log } from './log.js'
import { sleep } from './sleep.js'
import { disableAutoSave, enableAutoSave, news, save } from './store.js'
import { topics, topicsMap } from '../config/topics.js'
// import { restricted } from '../config/agencies.js'
import { decodeGoogleNewsUrl } from './google-news.js'
import { fetchArticle } from './fetch-article.js'
import { htmlToText } from './html-to-text.js'
import { ai } from './ai.js'
import { browseArticle, finalyze } from './browse-article.js'
import { copyFile } from './google-drive.js'
import { autoSpreadsheetId, coffeeTodayFolderId } from '../config/google-drive.js'

export async function summarize() {
	news.forEach((e, i) => e.id ||= i + 1)

	let list = news.filter(e => !e.summary && e.topic !== 'other')

	let stats = { ok: 0, fail: 0 }
	let last = {
		urlDecode: { time: 0, delay: 30e3, increment: 1000 },
		ai: { time: 0, delay: 0 },
	}
	for (let i = 0; i < list.length; i++) {
		let e = list[i]
		log(`\n#${e.id} [${i + 1}/${list.length}]`, e.titleEn || e.titleRu || '')

		if (!e.url /*&& !restricted.includes(e.source)*/) {
			await sleep(last.urlDecode.time + last.urlDecode.delay - Date.now())
			last.urlDecode.delay += last.urlDecode.increment
			last.urlDecode.time = Date.now()
			log('Decoding URL...')
			e.url = await decodeGoogleNewsUrl(e.gnUrl)
			if (!e.url) {
				await sleep(5*60e3)
				i--
				continue
			}
			log('got', e.url)
		}

		if (e.url) {
			log('Fetching', e.source || '', 'article...')
			let html = await fetchArticle(e.url) || await browseArticle(e.url)
			if (html) {
				log('got', html.length, 'chars')
				fs.writeFileSync(`articles/${e.id}.html`, `<!--\n${e.url}\n-->\n${html}`)
				e.text = htmlToText(html)
				fs.writeFileSync(`articles/${e.id}.txt`, `${e.titleEn || e.titleRu || ''}\n\n${e.text}`)
				// let skip = text.indexOf((e.titleEn ?? '').split(' ')[0])
				// if (skip > 0 && text.length - skip > 1000) {
				// 	text = text.slice(skip)
				// }
				e.text = e.text.slice(0, 30000)
			}
		}

		if (e.text?.length > 400) {
			await sleep(last.ai.time + last.ai.delay - Date.now())
			last.ai.time = Date.now()
			log('Summarizing', e.text.length, 'chars...')
			let res = await ai(e)
			if (res) {
				last.ai.delay = res.delay
				e.topic ||= topicsMap[res.topic]
				e.priority ||= res.priority
				e.titleRu ||= res.titleRu
				e.summary = res.summary
				e.aiTopic = topicsMap[res.topic]
				e.aiPriority = res.priority
			}
		}

		if (!e.summary) {
			log('failed to summarize')
			stats.fail++
		} else {
			stats.ok++
		}
	}
	let order = e => (+e.sqk || 999) * 1000 + (topics[e.topic]?.id ?? 99) * 10 + (+e.priority || 10)
	news.sort((a, b) => order(a) - order(b))

	finalyze()
	log('\n', stats)
}

if (process.argv[1].endsWith('summarize')) {
  (async () => {
    disableAutoSave();
    await summarize();
    await save();
    enableAutoSave();
    
    // Copy spreadsheet to coffeeTodayFolderId after summarization
    try {
      log('Copying spreadsheet to coffeeTodayFolder...')
      await copyFile(autoSpreadsheetId, coffeeTodayFolderId, "news-today")
      log('Spreadsheet copied successfully')
    } catch (e) {
      log('Failed to copy spreadsheet', e)
    }
  })();
}
