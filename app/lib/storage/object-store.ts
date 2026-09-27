// 对象存储抽象。
//
// 规格第廿五章。先落地本地磁盘，S3/R2/OSS 留接口——决策依据是：
// 成片文件几十 MB，塞进 D1 会把库撑爆（老项目把参考图塞在 JSON 列里已经很勉强），
// 但现在也还没到需要上云存储的规模。接口定好，换实现时业务层一行不用改。
//
// 关键约定：key 由业务层构造且必须稳定（projects/{id}/shots/{id}/{jobId}.mp4），
// 重复 put 同一个 key 视为覆盖同一份产物，不产生第二份。

export interface StoredObject {
  key: string;
  bytes: number;
  contentType: string;
}

export interface ObjectStore {
  put(key: string, body: ArrayBuffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<ArrayBuffer | null>;
  head(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** 给前端用的可访问地址。本地实现返回 /api/assets/ 路由，云实现返回签名 URL。 */
  url(key: string): string;
}

/** 进程内实现。测试与本地开发用，重启即失。 */
export class MemoryObjectStore implements ObjectStore {
  private readonly items = new Map<string, { body: ArrayBuffer; contentType: string }>();

  async put(key: string, body: ArrayBuffer, contentType: string): Promise<StoredObject> {
    this.items.set(key, { body, contentType });
    return { key, bytes: body.byteLength, contentType };
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    return this.items.get(key)?.body ?? null;
  }

  async head(key: string): Promise<StoredObject | null> {
    const item = this.items.get(key);
    return item ? { key, bytes: item.body.byteLength, contentType: item.contentType } : null;
  }

  async delete(key: string): Promise<void> { this.items.delete(key); }

  url(key: string): string { return `/api/objects/${key}`; }

  get size(): number { return this.items.size; }
}
