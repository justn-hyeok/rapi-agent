import { loadEnvironment, type Environment } from "@rapi/config";

export interface BotRuntime {
  connect(config: Environment): Promise<void>;
}

export async function startBot(
  runtime: BotRuntime,
  input: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = loadEnvironment(input);
  await runtime.connect(config);
}
