import { MessagingProvider, MessagePayload, MessageSendResult, InboundMessage, DeliveryReceipt } from "./types";
import { normalizeNigerianPhone, maskPhoneNumber } from "../utils/phone";

export class TermiiMessagingProvider implements MessagingProvider {
  name = "termii";

  private apiKey: string;
  private baseUrl: string;
  private senderId: string;
  private webhookSecret?: string;

  constructor() {
    this.apiKey = process.env.TERMII_API_KEY || "";
    this.baseUrl = process.env.TERMII_BASE_URL || "https://api.ng.termii.com/api";
    this.senderId = process.env.TERMII_SENDER_ID || "Oriyon";
    this.webhookSecret = process.env.TERMII_WEBHOOK_SECRET;
  }

  async send(payload: MessagePayload): Promise<MessageSendResult> {
    const normPhone = normalizeNigerianPhone(payload.to) || payload.to;
    const cleanPhone = normPhone.replace(/^\+/, "");

    if (!this.apiKey) {
      console.warn(`[TermiiProvider] No API key configured. Cannot deliver real message to ${maskPhoneNumber(payload.to)}`);
      return {
        success: false,
        messageId: `err-unconfigured-${Date.now()}`,
        channel: payload.channel,
        provider: this.name,
        error: "Termii API key is not configured.",
      };
    }

    try {
      // Determine endpoint based on channel
      const isWhatsApp = payload.channel === "whatsapp";
      const endpoint = isWhatsApp
        ? `${this.baseUrl}/whatsapp/send`
        : `${this.baseUrl}/sms/send`;

      const requestBody: any = {
        api_key: this.apiKey,
        to: cleanPhone,
        from: isWhatsApp ? (process.env.TERMII_WHATSAPP_NUMBER || this.senderId) : this.senderId,
        sms: payload.message,
        type: "plain",
        channel: isWhatsApp ? "whatsapp" : "generic",
      };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const resData = (await res.json().catch(() => ({}))) as any;

      if (!res.ok) {
        console.error(`[TermiiProvider Error] HTTP ${res.status}:`, resData);
        return {
          success: false,
          messageId: `err-${Date.now()}`,
          channel: payload.channel,
          provider: this.name,
          rawResponse: resData,
          error: resData?.message || `HTTP ${res.status} from Termii`,
        };
      }

      const messageId = resData?.message_id || resData?.messageId || `termii-${Date.now()}`;
      return {
        success: true,
        messageId,
        channel: payload.channel,
        provider: this.name,
        rawResponse: resData,
      };
    } catch (err: any) {
      console.error("[TermiiProvider Exception]:", err);
      return {
        success: false,
        messageId: `err-${Date.now()}`,
        channel: payload.channel,
        provider: this.name,
        error: err?.message || "Network error contacting Termii API",
      };
    }
  }

  verifyWebhookSignature(signatureHeader?: string, rawBody?: string): boolean {
    if (!this.webhookSecret) {
      // If no secret is configured in env, allow request in dev/staging
      return true;
    }
    if (!signatureHeader) return false;
    // Check header match
    return signatureHeader === this.webhookSecret;
  }

  parseInboundWebhook(body: any): InboundMessage | null {
    if (!body) return null;
    const sender = body.from || body.sender || body.phone;
    const text = body.message || body.text || body.content || body.sms;
    if (!sender || !text) return null;

    const channel = body.channel === "whatsapp" || body.type === "whatsapp" ? "whatsapp" : "sms";

    return {
      from: normalizeNigerianPhone(sender) || sender,
      text: String(text).trim(),
      channel,
      timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
      providerMessageId: body.message_id || body.messageId,
      rawPayload: body,
    };
  }

  parseDeliveryWebhook(body: any): DeliveryReceipt | null {
    if (!body) return null;
    const messageId = body.message_id || body.messageId || body.id;
    const statusRaw = String(body.status || "").toLowerCase();
    const to = body.to || body.receiver || body.phone;

    if (!messageId || !to) return null;

    let status: "delivered" | "failed" | "sent" = "sent";
    if (statusRaw.includes("delivered") || statusRaw === "successful" || statusRaw === "success") {
      status = "delivered";
    } else if (statusRaw.includes("failed") || statusRaw.includes("rejected") || statusRaw.includes("undelivered")) {
      status = "failed";
    }

    return {
      messageId,
      to: normalizeNigerianPhone(to) || to,
      status,
      timestamp: body.timestamp ? new Date(body.timestamp) : new Date(),
      rawPayload: body,
    };
  }
}
