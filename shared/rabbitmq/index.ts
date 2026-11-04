import amqplib, { Channel, ChannelModel } from "amqplib";

const EXCHANGE_NAME = "oriyon.events";
const EXCHANGE_TYPE = "topic";
const DLX_EXCHANGE = "oriyon.events.dlx";

let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let isReconnecting = false;

interface RegisteredConsumer {
  routingKey: string;
  queueName: string;
  handler: (payload: Record<string, unknown>) => Promise<void>;
}

const consumerRegistry: RegisteredConsumer[] = [];

async function bindAndConsume(
  ch: Channel,
  routingKey: string,
  queueName: string,
  handler: (payload: Record<string, unknown>) => Promise<void>
) {
  // Ensure dead-letter exchange exists for unhandled failures
  await ch.assertExchange(DLX_EXCHANGE, "topic", { durable: true });
  await ch.assertQueue(`${queueName}.dlq`, { durable: true });
  await ch.bindQueue(`${queueName}.dlq`, DLX_EXCHANGE, routingKey);

  // Assert active queue with DLX configured
  await ch.assertQueue(queueName, {
    durable: true,
    deadLetterExchange: DLX_EXCHANGE,
    deadLetterRoutingKey: routingKey,
  });
  await ch.bindQueue(queueName, EXCHANGE_NAME, routingKey);
  ch.prefetch(1);

  ch.consume(queueName, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(payload);
      ch.ack(msg);
    } catch (err) {
      console.error(`[RabbitMQ] Error processing message on ${routingKey}:`, err);
      // Nack with requeue=false routes to DLQ
      ch.nack(msg, false, false);
    }
  });

  console.log(`[RabbitMQ] Consumer active → ${routingKey} (queue: ${queueName})`);
}

export async function connectRabbitMQ(url: string): Promise<Channel> {
  let retries = 10;
  while (retries > 0) {
    try {
      const conn = await amqplib.connect(url);
      connection = conn;
      const ch = await conn.createChannel();
      channel = ch;
      await ch.assertExchange(EXCHANGE_NAME, EXCHANGE_TYPE, { durable: true });

      conn.on("close", () => {
        console.error("[RabbitMQ] Connection closed. Reconnecting and re-registering consumers...");
        channel = null;
        connection = null;
        if (!isReconnecting) {
          isReconnecting = true;
          setTimeout(async () => {
            try {
              await connectRabbitMQ(url);
              isReconnecting = false;
            } catch (recErr) {
              console.error("[RabbitMQ] Reconnection failed:", recErr);
              isReconnecting = false;
            }
          }, 5000);
        }
      });

      // Automatically re-attach all registered consumers upon channel establishment
      for (const reg of consumerRegistry) {
        try {
          await bindAndConsume(ch, reg.routingKey, reg.queueName, reg.handler);
        } catch (regErr) {
          console.error(`[RabbitMQ] Failed to re-register consumer for ${reg.routingKey}:`, regErr);
        }
      }

      console.log(`[RabbitMQ] Connected successfully. Active consumers re-verified: ${consumerRegistry.length}`);
      return ch;
    } catch (err) {
      console.error(`[RabbitMQ] Connection failed. Retrying... (${retries} left)`, err);
      retries--;
      await new Promise((res) => setTimeout(res, 5000));
    }
  }

  throw new Error("[RabbitMQ] Could not connect after multiple retries");
}

export async function publishEvent(
  routingKey: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (!channel) throw new Error("[RabbitMQ] Channel not initialised");
  const buffer = Buffer.from(JSON.stringify(payload));
  channel.publish(EXCHANGE_NAME, routingKey, buffer, {
    persistent: true,
    contentType: "application/json",
  });
  console.log(`[RabbitMQ] Published → ${routingKey}`, payload);
}

export async function consumeEvent(
  routingKey: string,
  queueName: string,
  handler: (payload: Record<string, unknown>) => Promise<void>
): Promise<void> {
  if (!consumerRegistry.some((c) => c.queueName === queueName && c.routingKey === routingKey)) {
    consumerRegistry.push({ routingKey, queueName, handler });
  }

  if (!channel) {
    console.warn(`[RabbitMQ] Channel not ready yet for ${routingKey}, saved in registry.`);
    return;
  }

  await bindAndConsume(channel, routingKey, queueName, handler);
}
