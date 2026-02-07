import Drive from '@googleapis/drive'
import { createReadStream } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'

import { log } from './log.js'
import { auth } from './google-auth.js'
import { describeError } from './error-guidance.js'

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

function wrapDriveError(error, { op, resource, id } = {}) {
	if (error?._isDriveError) return error
	let guidance = describeError(error, {
		scope: 'drive',
		resource: resource || 'resource',
		id,
		email: process.env.SERVICE_ACCOUNT_EMAIL,
	})
	let detail = guidance.summary || guidance.message || error?.message || 'unknown error'
	let action = guidance.action ? ` action: ${guidance.action}` : ''
	let contextParts = []
	if (resource) contextParts.push(`resource=${resource}`)
	if (id) contextParts.push(`id=${id}`)
	let context = contextParts.length ? ` (${contextParts.join(' ')})` : ''
	let wrapped = new Error(`Drive ${op || 'request'} failed${context}: ${detail}${action}`)
	wrapped.cause = error
	wrapped.details = {
		op,
		resource,
		id,
		status: guidance.status,
		reason: guidance.reason,
		action: guidance.action,
	}
	wrapped._isDriveError = true
	return wrapped
}

async function driveCall(op, ctx, fn) {
	try {
		return await fn()
	} catch (error) {
		throw wrapDriveError(error, { op, ...ctx })
	}
}

export async function createFolder(folderId, name) {
	let drive = await init
	const file = await driveCall('createFolder', { resource: 'folder', id: folderId }, async () => (
		await drive.files.create({	resource: {
			'parents': [folderId],
			name,
			'mimeType': 'application/vnd.google-apps.folder',
		}})
	))
	return file.data.id
}

export async function getFile(folderId, name) {
	let drive = await init
	let files = (await driveCall('getFile', { resource: 'folder', id: folderId }, async () => (
		await drive.files.list({
			q: `'${folderId}' in parents and name = '${name}'`,
		})
	))).data.files
	return files[0]
}

export async function moveFile(fileId, newFolderId, newName = null) {
	let drive = await init
	const res = await driveCall('getFile', { resource: 'file', id: fileId }, async () => (
		await drive.files.get({
			fileId: fileId,
			fields: 'parents, name'
		})
	))
	await driveCall('moveFile', { resource: 'file', id: fileId }, async () => (
		await drive.files.update({
			fileId: fileId,
			removeParents: res.data.parents,
			addParents: newFolderId,
			resource: {
				name: newName || res.data.name,
			},
		})
	))
}

export async function trashFile(fileId) {
	let drive = await init
	await driveCall('trashFile', { resource: 'file', id: fileId }, async () => (
		await drive.files.update({
			fileId: fileId,
			resource: { trashed: true },
		})
	))
}

export async function getFileName(fileId) {
	let drive = await init
	const res = await driveCall('getFileName', { resource: 'file', id: fileId }, async () => (
		await drive.files.get({
			fileId: fileId,
			fields: 'name'
		})
	))
	return res.data.name
}

export async function renameFile(fileId, newName) {
	let drive = await init
	await driveCall('renameFile', { resource: 'file', id: fileId }, async () => (
		await drive.files.update({
			fileId: fileId,
			resource: {
				name: newName
			}
		})
	))
}

export async function copyFile(fileId, folderId, name) {
	let drive = await init
	let res = await driveCall('copyFile', { resource: 'file', id: fileId }, async () => (
		await drive.files.copy({
			fileId,
			requestBody: {
				name,
				parents: [folderId],
			},
		})
	))
	return res.data
}

export async function moveFolderContents(sourceFolderId, destinationFolderId, newFolderName) {
	let drive = await init
	
	const sourceFolder = await driveCall('getFolder', { resource: 'folder', id: sourceFolderId }, async () => (
		await drive.files.get({
			fileId: sourceFolderId,
			fields: 'name, mimeType'
		})
	))
	
	if (sourceFolder.data.mimeType !== 'application/vnd.google-apps.folder') {
		throw new Error('Source is not a folder')
	}
	
	// Create new folder with the same name as the source folder
	const newFolder = await driveCall('createFolder', { resource: 'folder', id: destinationFolderId }, async () => (
		await drive.files.create({
			resource: {
				name: newFolderName || sourceFolder.data.name,
				mimeType: 'application/vnd.google-apps.folder',
				parents: [destinationFolderId]
			}
		})
	))
	const newFolderId = newFolder.data.id
	log(`Created folder: ${newFolderName || sourceFolder.data.name}`)
	
	let pageToken = null
	do {
		const response = await driveCall('listFolder', { resource: 'folder', id: sourceFolderId }, async () => (
			await drive.files.list({
				q: `'${sourceFolderId}' in parents and trashed = false`,
				fields: 'nextPageToken, files(id, name, mimeType)',
				pageToken,
			})
		))
		
		const items = response.data.files || []
		
		for (const item of items) {
			try {
				await moveFile(item.id, newFolderId, item.name)
				log(`  Moved ${item.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file'}: ${item.name}`)
			} catch (e) {
				let wrapped = wrapDriveError(e, { op: 'moveFile', resource: 'file', id: item.id })
				log(`  Failed to move ${item.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file'} ${item.name}: ${wrapped.message}`)
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
		let created = await driveCall('createFolder', { resource: 'folder', id: parentFolderId }, async () => (
			await drive.files.create({
				resource: {
					name: folderName,
					mimeType: 'application/vnd.google-apps.folder',
					parents: [parentFolderId]
				}
			})
		))
		folderId = created.data.id
		log(`Created new folder: ${folderName}`)
	}

	// Загрузить файлы
	for (let fileName of filesToUpload) {
		log(`  Uploading ${fileName}...`)
		await driveCall('uploadFile', { resource: 'folder', id: folderId }, async () => (
			await drive.files.create({
				requestBody: {
					name: fileName,
					parents: [folderId]
				},
				media: {
					body: createReadStream(join(localPath, fileName))
				}
			})
		))
	}

	return folderId
}
