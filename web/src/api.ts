export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: init.body ? { 'content-type': 'application/json', ...init.headers } : init.headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, body?.error?.code ?? 'UNKNOWN', body?.error?.message ?? 'Something went wrong. Please try again.');
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export interface Account {
  id: number;
  firstName: string;
  lastName: string;
  username: string;
  phone: string;
  needsReauth: boolean;
}

export interface Session {
  storage: 'telegram' | 'fake';
  configured: boolean;
  account: Account | null;
}

export interface PhotoItem {
  id: number;
  width: number;
  height: number;
  takenAt: string;
  filename: string;
  favorite: boolean;
  pending: boolean;
  failed: boolean;
  noPreview: boolean;
  previewComing: boolean;
}

type WireItem = [number, number, number, string, number, string];

function decodeItem([id, width, height, takenAt, flags, filename]: WireItem): PhotoItem {
  return {
    id, width, height, takenAt, filename,
    favorite: (flags & 1) !== 0,
    pending: (flags & 2) !== 0,
    failed: (flags & 4) !== 0,
    noPreview: (flags & 8) !== 0,
    previewComing: (flags & 16) !== 0,
  };
}

export interface PhotoDetail {
  id: number;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  takenAt: string;
  takenSource: 'exif' | 'file' | 'upload' | 'telegram';
  uploadedAt: number;
  sha256: string;
  camera: { make: string | null; model: string | null; lens: string | null; iso: number | null; fNumber: number | null; exposureTime: number | null; focalLength: number | null };
  location: { lat: number; lon: number } | null;
  status: 'queued' | 'uploading' | 'stored' | 'failed';
  error: string | null;
  telegramMessageId: number | null;
  previewState: 'ready' | 'missing' | 'unavailable';
  favorite: boolean;
  trashedAt: number | null;
  purgeAt: number | null;
  albums: { id: number; title: string }[];
}

export interface Album {
  id: number;
  title: string;
  photoCount: number;
  coverId: number | null;
  updatedAt: number;
}

export interface LibraryStats {
  count: number;
  bytes: number;
  trash: number;
  pending: number;
  failed: number;
}

export interface ScanState {
  running: boolean;
  scanned: number;
  added: number;
  error: string | null;
}

export interface ServerUpload {
  id: number;
  filename: string;
  size: number;
  status: 'queued' | 'uploading' | 'failed';
  progress: number | null;
  error: string | null;
  nextAttemptAt: number | null;
}

export interface UploadStatus {
  items: ServerUpload[];
  stats: LibraryStats;
  scan: ScanState;
}

export type PhotoQuery = { view?: 'favorites' | 'trash'; album?: number; q?: string };

export const api = {
  session: () => request<Session>('/api/session'),
  sendCode: (phone: string) => post<{ loginId: string; delivery: 'app' | 'other' }>('/api/auth/phone', { phone }),
  submitCode: (loginId: string, code: string) => post<{ status: 'ok' } | { status: 'password'; hint: string }>('/api/auth/code', { loginId, code }),
  submitPassword: (loginId: string, password: string) => post<{ status: 'ok' }>('/api/auth/password', { loginId, password }),
  logout: () => post('/api/auth/logout'),
  disconnect: () => post('/api/auth/disconnect'),

  photos: async (query: PhotoQuery): Promise<PhotoItem[]> => {
    const params = new URLSearchParams();
    if (query.view) params.set('view', query.view);
    if (query.album) params.set('album', String(query.album));
    if (query.q) params.set('q', query.q);
    const { items } = await request<{ items: WireItem[] }>(`/api/photos?${params}`);
    return items.map(decodeItem);
  },
  photo: (id: number) => request<PhotoDetail>(`/api/photos/${id}`),
  setFavorite: (ids: number[], favorite: boolean) => patch('/api/photos', { ids, favorite }),
  setTrashed: (ids: number[], trashed: boolean) => patch('/api/photos', { ids, trashed }),
  deleteForever: (ids: number[]) => post<{ deleted: number; skipped: number }>('/api/photos/delete-permanently', { ids }),
  emptyTrash: () => post<{ deleted: number; skipped: number }>('/api/trash/empty'),

  albums: async () => (await request<{ albums: Album[] }>('/api/albums')).albums,
  album: (id: number) => request<Album>(`/api/albums/${id}`),
  createAlbum: (title: string, photoIds: number[] = []) => post<{ id: number }>('/api/albums', { title, photoIds }),
  updateAlbum: (id: number, body: { title?: string; coverPhotoId?: number | null }) => patch(`/api/albums/${id}`, body),
  deleteAlbum: (id: number) => request(`/api/albums/${id}`, { method: 'DELETE' }),
  addToAlbum: (id: number, ids: number[]) => post(`/api/albums/${id}/photos`, { ids }),
  removeFromAlbum: (id: number, ids: number[]) => post(`/api/albums/${id}/photos/remove`, { ids }),

  uploadStatus: () => request<UploadStatus>('/api/uploads/status'),
  retryUploads: (ids?: number[]) => post<{ retried: number }>('/api/uploads/retry', ids ? { ids } : {}),
  cancelUpload: (id: number) => request(`/api/uploads/${id}`, { method: 'DELETE' }),
  rescan: () => post<ScanState>('/api/library/rescan'),
  library: () => request<{ stats: LibraryStats; trashRetentionDays: number }>('/api/library'),
};

export const thumbUrl = (id: number) => `/api/photos/${id}/thumb`;
export const previewUrl = (id: number) => `/api/photos/${id}/preview`;
export const originalUrl = (id: number) => `/api/photos/${id}/original`;

/** Goes through the browser's own downloader, so a big file streams straight to disk. */
export function downloadPhotos(ids: number[]): void {
  const link = document.createElement('a');
  link.href = ids.length === 1 ? `/api/photos/${ids[0]}/original?download=1` : `/api/photos/zip?ids=${ids.join(',')}`;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}
