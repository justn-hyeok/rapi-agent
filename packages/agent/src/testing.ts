import type {
  DeliveryAdapter,
  DeliveryPayload,
  DeliveryResult,
  DeliveryTarget,
} from "@rapi/core";

export class RecordingDeliveryAdapter implements DeliveryAdapter {
  readonly messages: Array<{
    target: DeliveryTarget;
    payload: DeliveryPayload;
    key: string;
  }> = [];
  readonly failRecipients = new Set<string>();

  async send(
    target: DeliveryTarget,
    payload: DeliveryPayload,
    key: string,
  ): Promise<DeliveryResult> {
    if (this.failRecipients.has(target.recipientId))
      throw new Error("Injected temporary failure");
    this.messages.push({ target, payload, key });
    return { providerId: `recorded-${this.messages.length}` };
  }
}
