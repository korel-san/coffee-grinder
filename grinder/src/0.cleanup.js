import { news, spreadsheetId } from './store.js'
import { archivePresentation } from './google-slides.js'
import { sleep } from './sleep.js'
import { copyFile, moveFolderContents, getFile, moveFile, getFileName, renameFile } from './google-drive.js'
import { rootFolderId, audioFolderName, imageFolderName, coffeeTodayFolderId, archiveFolderId } from '../config/google-drive.js'
import { log } from './log.js'

export async function cleanup() {
	let name = new Date(Date.now() - 24*60*60e3).toISOString().split('T')[0]
	
	// Move coffeeTodayFolderId contents to archiveFolderId before any cleanup
	try {
		log('Moving coffeeTodayFolder contents to autoArchiveFolder...')
		const folderName = await getFileName(coffeeTodayFolderId)
		const timestamp = new Date().toISOString().replace('T', '_').slice(0, 16).replace(':', '-')
		await moveFolderContents(coffeeTodayFolderId, archiveFolderId, folderName)
		log('Folder contents moved successfully')
		
		// Rename the original folder
		log('Renaming coffeeTodayFolder...')
		await renameFile(coffeeTodayFolderId, `coffee-today-${timestamp}`)
		log('Folder renamed successfully')
	} catch (e) {
		log('Failed to move/rename folder', e)
	}
	
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