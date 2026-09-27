const DATABASE = 'mirror-source-videos';
const STORE = 'sources';

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveSourceVideo(projectId: string, file: File): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ blob: file, name: file.name, modified: file.lastModified }, projectId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function loadSourceVideo(projectId: string): Promise<File | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(projectId);
      request.onsuccess = () => {
        const value = request.result;
        resolve(value?.blob instanceof Blob ? new File([value.blob], value.name, { type: value.blob.type, lastModified: value.modified }) : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
