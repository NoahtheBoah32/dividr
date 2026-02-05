export const MEDIA_SERVER_HOST = 'localhost';
export const MEDIA_SERVER_PORT = 3001;

export const isMediaServerUrl = (value: string): boolean => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.hostname === MEDIA_SERVER_HOST &&
      url.port === String(MEDIA_SERVER_PORT)
    );
  } catch {
    return false;
  }
};

export const toMediaServerUrl = (
  pathOrUrl: string,
  port = MEDIA_SERVER_PORT,
): string => {
  if (!pathOrUrl) return '';
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `http://${MEDIA_SERVER_HOST}:${port}/${encodeURIComponent(pathOrUrl)}`;
};

