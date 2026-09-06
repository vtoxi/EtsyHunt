// Shared extension branding — single source of truth for reports and background scripts.

export const EXT_NAME = 'EtsyHunt';
export const EXT_TAGLINE = 'Free local Etsy niche research';

export function extVersionLabel() {
  try {
    return `${EXT_NAME} v${chrome.runtime.getManifest().version}`;
  } catch {
    return EXT_NAME;
  }
}
