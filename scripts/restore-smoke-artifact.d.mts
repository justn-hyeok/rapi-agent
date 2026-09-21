export type RestoreSmokeArtifact = {
  project: string;
  database: string;
  tables: number;
  migrations: number;
  constraints: number;
};

export function restoreSmokeArtifact(
  input: RestoreSmokeArtifact,
): RestoreSmokeArtifact;
