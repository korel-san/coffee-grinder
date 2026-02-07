import { log } from './log.js'
import { uploadFolder } from './google-drive.js'
import { autoArchiveFolderId, imageFolderName } from '../config/google-drive.js'

export async function uploadImg() {
	log('Uploading images to Drive...')
	await uploadFolder('../img', autoArchiveFolderId, imageFolderName, ['.jpg', '.png'])
	log('Images uploaded.')
}

if (process.argv[1]?.includes('upload-img')) uploadImg()
