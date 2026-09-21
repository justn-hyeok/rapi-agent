export type RestartSmokeArtifact = {
  project: string;
  database: string;
  before: string;
  after: string;
};

export function restartSmokeArtifact(
  input: RestartSmokeArtifact,
): RestartSmokeArtifact;
