// Types for app-protocol.js (the desktop shell is plain JavaScript run directly by Electron).
export const APP_ID: string;
export const APP_SCHEME: string;
export const APP_HOST: string;
export const APP_ORIGIN: string;
export const APP_ENTRY_URL: string;
export const CONTENT_SECURITY_POLICY: string;
export function isAppUrl(url: string): boolean;
export function resolveAppFile(rootDir: string, requestUrl: string): string | null;
