export interface StoredRawEvent {
  id: string;
  sourceId: string;
  externalEventId: string | null;
  payloadChecksum: string;
  payload: unknown;
  collectedAt: Date;
}
export interface RawEventRepository {
  putIfAbsent(event: Omit<StoredRawEvent, "id">): Promise<StoredRawEvent>;
  findById(id: string): Promise<StoredRawEvent | null>;
}
export interface UnitOfWork {
  transaction<T>(work: () => Promise<T>): Promise<T>;
}
