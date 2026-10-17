export type MessageChannel = "whatsapp" | "sms";

export type DeliveryStatus = "pending" | "sent" | "delivered" | "failed";

export interface MessagePayload {
  to: string;
  message: string;
  templateId: "MSG-01" | "MSG-02" | "MSG-03" | "MSG-04" | "MSG-05" | "MSG-06" | "MSG-07" | "CLARIFY";
  channel: MessageChannel;
  variables?: Record<string, string>;
  applicationId?: string;
  refereeId?: string;
}

export interface MessageSendResult {
  success: boolean;
  messageId: string;
  channel: MessageChannel;
  provider: string;
  rawResponse?: any;
  error?: string;
}

export interface InboundMessage {
  from: string;
  text: string;
  channel: MessageChannel;
  timestamp: Date;
  providerMessageId?: string;
  rawPayload?: any;
}

export interface DeliveryReceipt {
  messageId: string;
  to: string;
  status: "delivered" | "failed" | "sent";
  timestamp: Date;
  rawPayload?: any;
}

export interface MessagingProvider {
  name: string;
  send(payload: MessagePayload): Promise<MessageSendResult>;
  verifyWebhookSignature(signatureHeader?: string, rawBody?: string): boolean;
  parseInboundWebhook(body: any): InboundMessage | null;
  parseDeliveryWebhook(body: any): DeliveryReceipt | null;
}
