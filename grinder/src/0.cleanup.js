import { news, spreadsheetId } from './store.js'
import { archivePresentation } from './google-slides.js'
import { sleep } from './sleep.js'
import { copyFile, getFile, moveFile } from './google-drive.js'
import { rootFolderId, archiveFolderId, audioFolderName, imageFolderName } from '../config/google-drive.js'
import { log } from './log.js'

export async function cleanup() {
	let name = new Date(Date.now() - 24*60*60e3).toISOString().split('T')[0]
	//if (news.length) {
	//	log('Archiving spreadsheet...')
	//	await copyFile(spreadsheetId, archiveFolderId, name)
	//	news.forEach((e, i) => news[i] = {})
	//	await sleep(1)
	//	news.length = 0
	//}
	await archivePresentation(name)
	let audio = await getFile(rootFolderId, audioFolderName)
	if (audio) {
		log('Archiving audio...')
		await moveFile(audio.id, archiveFolderId, `${name}_${audioFolderName}`)
	}
	let image = await getFile(rootFolderId, imageFolderName)
	if (image) {
		log('Archiving images...')
		await moveFile(image.id, archiveFolderId, `${name}_${imageFolderName}`)
	}
}

if (process.argv[1].endsWith('cleanup')) cleanup()