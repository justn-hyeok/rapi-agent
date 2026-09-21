export interface QuarantineUpdate {
  text: string;
  values: [string[]];
}

export function buildQuarantineUpdate(ids: string[]): QuarantineUpdate;
