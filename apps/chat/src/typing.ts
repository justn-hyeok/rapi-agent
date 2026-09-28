type ChannelTyping = {
  users: number;
  controller: AbortController;
  timer: NodeJS.Timeout;
  sending: boolean;
};

// Discord expires typing after ten seconds. Share one heartbeat per channel
// so overlapping questions neither flood the API nor stop each other's signal.
export class DiscordTyping {
  private channels = new Map<string, ChannelTyping>();

  constructor(
    private readonly send: (
      channel: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ) {}

  async run<T>(channel: string, work: () => Promise<T>): Promise<T> {
    let state = this.channels.get(channel);
    if (!state) {
      const controller = new AbortController();
      state = {
        users: 0,
        controller,
        timer: setInterval(() => void this.pulse(channel, state!), 8_000),
        sending: false,
      };
      state.timer.unref();
      this.channels.set(channel, state);
      void this.pulse(channel, state);
    }
    state.users++;
    try {
      return await work();
    } finally {
      if (--state.users === 0) {
        clearInterval(state.timer);
        state.controller.abort();
        this.channels.delete(channel);
      }
    }
  }

  private async pulse(channel: string, state: ChannelTyping): Promise<void> {
    if (state.sending || state.controller.signal.aborted) return;
    state.sending = true;
    try {
      await this.send(channel, state.controller.signal);
    } catch {
      // Feedback is best effort: permissions, rate limits or network failures
      // must never block the actual answer or become an unhandled rejection.
    } finally {
      state.sending = false;
    }
  }
}
