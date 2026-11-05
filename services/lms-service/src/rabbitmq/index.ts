import amqplib, { Channel, ChannelModel } from "amqplib";

const EXCHANGE = "oriyon.events";
const DLX_EXCHANGE = "oriyon.events.dlx";

let channel: Channel | null = null;
let connection: ChannelModel | null = null;
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
  await ch.assertExchange(DLX_EXCHANGE, "topic", { durable: true });
  await ch.assertQueue(`${queueName}.dlq`, { durable: true });
  await ch.bindQueue(`${queueName}.dlq`, DLX_EXCHANGE, routingKey);

  await ch.assertQueue(queueName, {
    durable: true,
    deadLetterExchange: DLX_EXCHANGE,
    deadLetterRoutingKey: routingKey,
  });
  await ch.bindQueue(queueName, EXCHANGE, routingKey);
  ch.prefetch(1);

  ch.consume(queueName, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(payload);
      ch.ack(msg);
    } catch (err) {
      console.error(`[lms-service][RabbitMQ] Handler error on ${routingKey}:`, err);
      ch.nack(msg, false, false);
    }
  });

  console.log(`[lms-service][RabbitMQ] Consumer active → ${routingKey} (queue: ${queueName})`);
}

export async function connectRabbitMQ(url: string) {
  let retries = 10;
  while (retries > 0) {
    try {
      connection = await amqplib.connect(url);
      connection.on("error", (err) => {
        console.error("[lms-service][RabbitMQ] Connection error:", err);
      });
      const ch = await connection.createChannel();
      ch.on("error", (err) => {
        console.error("[lms-service][RabbitMQ] Channel error:", err);
      });
      channel = ch;
      await ch.assertExchange(EXCHANGE, "topic", { durable: true });

      connection.on("close", () => {
        console.error("[lms-service][RabbitMQ] Connection closed. Reconnecting & re-attaching consumers...");
        channel = null;
        connection = null;
        if (!isReconnecting) {
          isReconnecting = true;
          setTimeout(async () => {
            try {
              await connectRabbitMQ(url);
              isReconnecting = false;
            } catch (recErr) {
              console.error("[lms-service][RabbitMQ] Reconnection failed:", recErr);
              isReconnecting = false;
            }
          }, 5000);
        }
      });

      for (const reg of consumerRegistry) {
        try {
          await bindAndConsume(ch, reg.routingKey, reg.queueName, reg.handler);
        } catch (regErr) {
          console.error(`[lms-service][RabbitMQ] Failed to re-register consumer for ${reg.routingKey}:`, regErr);
        }
      }

      console.log(`[lms-service][RabbitMQ] Connected successfully. Active consumers: ${consumerRegistry.length}`);
      return channel;
    } catch (err) {
      retries--;
      console.error(`[lms-service][RabbitMQ] Retrying... (${retries} left)`, err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error("RabbitMQ connection failed after maximum retries");
}

export async function publishEvent(routingKey: string, payload: Record<string, unknown>) {
  if (!channel) throw new Error("RabbitMQ channel not ready");
  channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(payload)), {
    persistent: true,
    contentType: "application/json",
  });
  console.log(`[lms-service][RabbitMQ] Published → ${routingKey}`);
}

export async function consumeEvent(
  routingKey: string,
  queueName: string,
  handler: (payload: Record<string, unknown>) => Promise<void>
) {
  if (!consumerRegistry.some((c) => c.queueName === queueName && c.routingKey === routingKey)) {
    consumerRegistry.push({ routingKey, queueName, handler });
  }

  if (!channel) {
    console.warn(`[lms-service][RabbitMQ] Channel not ready yet for ${routingKey}, saved in registry.`);
    return;
  }

  await bindAndConsume(channel, routingKey, queueName, handler);
}
