import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEngine } from '../src/api';
import { uploader } from '../src/lib/uploads';
import { Device, makeJpeg } from './helpers';

vi.mock('../src/api', async () => {
  const { UserFacingError } = await import('../src/engine/types');
  return { ApiError: UserFacingError, getEngine: vi.fn() };
});

describe('retrying selected uploads', () => {
  let device: Device;
  beforeEach(async () => {
    device = await new Device().open();
    await device.signIn();
    vi.mocked(getEngine).mockResolvedValue(device.engine);
  });
  afterEach(async () => {
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    uploader.clearSettled(() => true);
    await device.close();
    vi.restoreAllMocks();
  });

  it('retries all 50 selected files after preparation fails', async () => {
    const files = Array.from({ length: 50 }, (_, i) =>
      new File([makeJpeg({ color: `local-${i}` }) as BlobPart], `${i}.jpg`, { type: 'image/jpeg' }));
    vi.mocked(getEngine).mockRejectedValue(new Error('Temporarily unavailable'));
    uploader.add(files);
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    expect(uploader.snapshot()).toHaveLength(50);
    expect(uploader.snapshot().every((entry) => entry.stage === 'error' && entry.file !== null)).toBe(true);

    vi.mocked(getEngine).mockResolvedValue(device.engine);
    for (const entry of uploader.snapshot()) uploader.retry(entry.key);
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    await device.engine.queue.drain();
    expect(uploader.snapshot().every((entry) => entry.stage === 'received' && entry.file === null)).toBe(true);
    expect(device.engine.store.libraryStats()).toMatchObject({ count: 50, failed: 0, pending: 0 });
  });

  it('reattaches an original selected by Retry to the failed upload after a reload', async () => {
    const file = new File([makeJpeg() as BlobPart], 'original.jpg', { type: 'image/jpeg' });
    device.storage.failNextPut = new Error('offline');
    uploader.add([file]);
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    await device.engine.queue.drain();
    const id = uploader.snapshot()[0]!.photoId!;
    uploader.clearSettled(() => true);
    await device.reload();
    vi.mocked(getEngine).mockResolvedValue(device.engine);
    expect(device.engine.uploadStatus().items[0]).toMatchObject({ id, needsFile: true });

    uploader.add([file], null, { retryOnly: true });
    await vi.waitFor(() => expect(uploader.isBusy).toBe(false));
    await device.engine.queue.drain();
    expect(uploader.snapshot()[0]).toMatchObject({ stage: 'received', photoId: id });
    expect(device.engine.photo(id).status).toBe('stored');
    expect(device.engine.store.allPhotos()).toHaveLength(1);
  });
});
