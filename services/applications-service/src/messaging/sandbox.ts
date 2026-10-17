import { MessagingProvider, MessagePayload, MessageSendResult, InboundMessage, DeliveryReceipt } from "./types";
import { normalizeNigerianPhone, maskPhoneNumber } from "../utils/phone";

export class SandboxMessagingProvider implements MessagingProvider {
  name = "sandbox";

  private static instance?: SandboxMessagingProvider;

  // In-memory record of all sent messages for verification & testing
  public sentMessages: Array<MessagePayload & { messageId: string; sentAt: Date }> = [];
  public deliveryFailuresSimulated: Set<string> = new Set();

  constructor() {
    SandboxMessagingProvider.instance = this;
  }

  static getSentMessages() {
    return SandboxMessagingProvider.instance ? SandboxMessagingProvider.instance.sentMessages : [];
  }

  static clear() {
    if (SandboxMessagingProvider.instance) {
      SandboxMessagingProvider.instance.clear();
    }
  }

  async send(payload: MessagePayload): Promise<MessageSendResult> {
    const normPhone = normalizeNigerianPhone(payload.to) || payload.to;
    const messageId = `sandbox-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    console.log(
      `[SandboxMessaging] [${payload.channel.toUpperCase()}] [${payload.templateId}] -> ${maskPhoneNumber(normPhone)}: "${payload.message.substring(0, 80)}..."`
    );

    const record = {
      ...payload,
      to: normPhone,
      messageId,
      sentAt: new Date(),
    };
    this.sentMessages.push(record);

    // If simulated failure
    if (this.deliveryFailuresSimulated.has(normPhone) || this.deliveryFailuresSimulated.has(payload.templateId)) {
      return {
        success: false,
        messageId,
        channel: payload.channel,
        provider: this.name,
        error: "Simulated sandbox delivery failure",
      };
    }

    return {
      success: true,
      messageId,
      channel: payload.channel,
      provider: this.name,
    };
  }

  verifyWebhookSignature(_signatureHeader?: string, _rawBody?: string): boolean {
    return true;
  }

  parseInboundWebhook(body: any): InboundMessage | null {
    if (!body) return null;
    const sender = body.from || body.sender || body.phone;
    const text = body.message || body.text || body.content;
    if (!sender || !text) return null;

    return {
      from: normalizeNigerianPhone(sender) || sender,
      text: String(text).trim(),
      channel: body.channel || "whatsapp",
      timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
      providerMessageId: body.messageId || `inbound-${Date.now()}`,
      rawPayload: body,
    };
  }

  parseDeliveryWebhook(body: any): DeliveryReceipt | null {
    if (!body) return null;
    const messageId = body.messageId || body.id;
    const to = body.to || body.phone;
    if (!messageId || !to) return null;

    return {
      messageId,
      to: normalizeNigerianPhone(to) || to,
      status: body.status || "delivered",
      timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
      rawPayload: body,
    };
  }

  clear() {
    this.sentMessages = [];
    this.deliveryFailuresSimulated.clear();
  }
}
