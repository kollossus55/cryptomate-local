import { base44 } from './base44Client';

/**
 * File uploads.
 *
 * Base44's Core integrations are replaced by local endpoints on the server.
 * The signatures match what the app already calls, so no call site changes.
 */
export const UploadPublicFile = base44.integrations.Core.UploadPublicFile;
export const UploadPrivateFile = base44.integrations.Core.UploadPrivateFile;
export const CreateFileSignedUrl = base44.integrations.Core.CreateFileSignedUrl;
