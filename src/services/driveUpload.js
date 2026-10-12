const { Readable } = require('stream')
const { getClient, hasCredentials } = require('../config/googleDrive')
const Settings = require('../models/Settings')

// Keyed by rootFolderId as well as name — an admin can repoint GOOGLE_DRIVE_FOLDER_ID (now
// Settings.googleDriveFolderId) to a different drive at any time, and a folder id resolved
// under the OLD root would be meaningless (or belong to a different folder entirely) under a
// new one. clearFolderCache() below is also called whenever the setting changes, as a second
// line of defense, but scoping the key itself means a stale process that missed that call still
// can't cross-contaminate.
const folderIdCache = new Map()

function clearFolderCache() {
  folderIdCache.clear()
}

async function getRootFolderId() {
  const settings = await Settings.getSettings()
  return settings.googleDriveFolderId || ''
}

// True only once both the service-account credentials AND an admin-configured Drive folder are
// in place — either alone isn't enough to actually upload anything.
async function isConfigured() {
  if (!hasCredentials()) return false
  return Boolean(await getRootFolderId())
}

function escapeForQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

async function getOrCreateSubfolder(drive, rootFolderId, parentId, name) {
  const query = [
    `'${parentId}' in parents`,
    `name = '${escapeForQuery(name)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
  ].join(' and ')

  const existing = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'drive',
    driveId: rootFolderId,
  })

  let folderId = existing.data.files?.[0]?.id
  if (!folderId) {
    const created = await drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
      fields: 'id',
      supportsAllDrives: true,
    })
    folderId = created.data.id
  }
  return folderId
}

// Folder layout: a single-location practice gets just ONE folder (named for the client/account)
// with audio uploaded directly into it. A multi-location group gets that same client folder acting
// as the group folder, with one subfolder per location inside it — the extra nesting only exists
// when there's actually more than one location to keep separate. locationName is only passed by
// the frontend when the submission belongs to a group, so its absence is exactly the signal for
// "single location, don't nest."
async function getOrCreateLocationFolder(drive, rootFolderId, clientName, locationName) {
  const clientFolderName = (clientName || 'Unnamed Practice').trim() || 'Unnamed Practice'
  const clientCacheKey = `${rootFolderId}::${clientFolderName}`

  let clientFolderId = folderIdCache.get(clientCacheKey)
  if (!clientFolderId) {
    clientFolderId = await getOrCreateSubfolder(drive, rootFolderId, rootFolderId, clientFolderName)
    folderIdCache.set(clientCacheKey, clientFolderId)
  }

  const locationFolderName = (locationName || '').trim()
  if (!locationFolderName) return clientFolderId

  const locationCacheKey = `${rootFolderId}::${clientFolderName}::${locationFolderName}`
  if (folderIdCache.has(locationCacheKey)) return folderIdCache.get(locationCacheKey)

  const locationFolderId = await getOrCreateSubfolder(drive, rootFolderId, clientFolderId, locationFolderName)
  folderIdCache.set(locationCacheKey, locationFolderId)
  return locationFolderId
}

async function uploadToDrive(buffer, filename, mimeType, practiceName, locationName) {
  const rootFolderId = await getRootFolderId()
  if (!hasCredentials() || !rootFolderId) return null

  const drive = getClient()
  const parentId = await getOrCreateLocationFolder(drive, rootFolderId, practiceName, locationName)

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [parentId],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  })

  return { fileId: res.data.id, url: res.data.webViewLink }
}

function avatarsCacheKey(rootFolderId) {
  return `${rootFolderId}::\0avatars` // NUL prefix can't collide with a real client folder name
}

async function getOrCreateAvatarsFolder(drive, rootFolderId) {
  const cacheKey = avatarsCacheKey(rootFolderId)
  let folderId = folderIdCache.get(cacheKey)
  if (!folderId) {
    folderId = await getOrCreateSubfolder(drive, rootFolderId, rootFolderId, 'Avatars')
    folderIdCache.set(cacheKey, folderId)
  }
  return folderId
}

// Profile pictures get their own flat folder, separate from the per-client/location layout —
// there's no practice/location context for an avatar, just the account uploading it.
async function uploadAvatarToDrive(buffer, filename, mimeType) {
  const rootFolderId = await getRootFolderId()
  if (!hasCredentials() || !rootFolderId) return null

  const drive = getClient()
  const parentId = await getOrCreateAvatarsFolder(drive, rootFolderId)

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [parentId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  })

  return { fileId: res.data.id, url: res.data.webViewLink }
}

module.exports = { uploadToDrive, uploadAvatarToDrive, isConfigured, clearFolderCache }
