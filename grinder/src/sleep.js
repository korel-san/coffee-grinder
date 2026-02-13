import { log } from './log.js'

export function sleep(ms) {
	if (ms <= 0) return
	if (ms >= 1e3) {
		log('resting', (ms/1e3).toFixed() + 's...')
	}
	return new Promise(resolve => setTimeout(resolve, ms))
}
