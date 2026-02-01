import Drive from '@googleapis/drive'
import { createReadStream } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'

import { log } from './log.js'
import { auth } from './google-auth.js'

import { google } from 'googleapis';

async function initializeOAuth2Client() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  });

  return await google.drive({ version: 'v3', auth: oauth2Client });
}

async function initialize() {
	return await Drive.drive({ version: 'v3', auth })
}
let init = initialize()
// let init = initializeOAuth2Client() // for local development

export async function createFolder(folderId, name) {
	let drive = await init
	const file = await drive.files.create({	resource: {
		'parents': [folderId],
		name,
		'mimeType': 'application/vnd.google-apps.folder',
	}})
    return file.data.id
}

export async function getFile(folderId, name) {
	let drive = await init
	let files = (await drive.files.list({
		q: `'${folderId}' in parents and name = '${name}'`,
	})).data.files
	return files[0]
}

export async function moveFile(fileId, newFolderId, newName = null) {
	let drive = await init
	const res = await drive.files.get({
		fileId: fileId,
		fields: 'parents, name'
	})
	await drive.files.update({
		fileId: fileId,
		removeParents: res.data.parents,
		addParents: newFolderId,
		resource: {
			name: newName || res.data.name,
		},
	})
}

export async function trashFile(fileId) {
	let drive = await init
	await drive.files.update({
		fileId: fileId,
		resource: { trashed: true },
	})
}

export async function getFileName(fileId) {
	let drive = await init
	const res = await drive.files.get({
		fileId: fileId,
		fields: 'name'
	})
	return res.data.name
}

export async function renameFile(fileId, newName) {
	let drive = await init
	await drive.files.update({
		fileId: fileId,
		resource: {
			name: newName
		}
	})
}

export async function copyFile(fileId, folderId, name) {
	let drive = await init
	let res = await drive.files.copy({
		fileId,
		requestBody: {
			name,
			parents: [folderId],
		},
	})
	return res.data
}

export async function moveFolderContents(sourceFolderId, destinationFolderId, newFolderName) {
	let drive = await init
	
	const sourceFolder = await drive.files.get({
		fileId: sourceFolderId,
		fields: 'name, mimeType'
	})
	
	if (sourceFolder.data.mimeType !== 'application/vnd.google-apps.folder') {
		throw new Error('Source is not a folder')
	}
	
	// Create new folder with the same name as the source folder
	const newFolder = await drive.files.create({
		resource: {
			name: newFolderName || sourceFolder.data.name,
			mimeType: 'application/vnd.google-apps.folder',
			parents: [destinationFolderId]
		}
	})
	const newFolderId = newFolder.data.id
	log(`Created folder: ${newFolderName || sourceFolder.data.name}`)
	
	let pageToken = null
	do {
		const response = await drive.files.list({
			q: `'${sourceFolderId}' in parents and trashed = false`,
			fields: 'nextPageToken, files(id, name, mimeType)',
			pageToken,
		})
		
		const items = response.data.files || []
		
		for (const item of items) {
			try {
				await moveFile(item.id, newFolderId, item.name)
				log(`  Moved ${item.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file'}: ${item.name}`)
			} catch (e) {
				log(`  Failed to move ${item.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file'} ${item.name}:`, e.message)
			}
		}
		
		pageToken = response.data.nextPageToken
	} while (pageToken)
}

export async function uploadFolder(localPath, parentFolderId, folderName, extensions = null) {
	let drive = await init

	// Получить список файлов для загрузки
	let allFiles = await readdir(localPath)
	let filesToUpload = allFiles.filter(fileName => {
		if (fileName.startsWith('.')) return false
		if (extensions && !extensions.some(ext => fileName.endsWith(ext))) return false
		return true
	})

	// Не создавать папку если нет файлов
	if (filesToUpload.length === 0) {
		log('No files to upload in', localPath)
		return null
	}

	// Найти существующую папку или создать новую
	let folder = await getFile(parentFolderId, folderName)
	let folderId
	if (folder) {
		folderId = folder.id
		log(`Using existing folder: ${folderName}`)
	} else {
		let created = await drive.files.create({
			resource: {
				name: folderName,
				mimeType: 'application/vnd.google-apps.folder',
				parents: [parentFolderId]
			}
		})
		folderId = created.data.id
		log(`Created new folder: ${folderName}`)
	}

	// Загрузить файлы
	for (let fileName of filesToUpload) {
		log(`  Uploading ${fileName}...`)
		await drive.files.create({
			requestBody: {
				name: fileName,
				parents: [folderId]
			},
			media: {
				body: createReadStream(join(localPath, fileName))
			}
		})
	}

	return folderId
}