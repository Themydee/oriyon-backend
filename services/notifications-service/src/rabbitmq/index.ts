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
  // Ensure DLX exists for unhandled message failures
  await ch.assertExchange(DLX_EXCHANGE, "topic", { durable: true });
  await ch.assertQueue(`${queueName}.dlq`, { durable: true });
  await ch.bindQueue(`${queueName}.dlq`, DLX_EXCHANGE, routingKey);

  // Assert queue with dead letter exchange routing
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
      console.error(`[notifications-service][RabbitMQ] Handler error on ${routingKey}:`, err);
      // Requeue=false sends to dead letter queue
      ch.nack(msg, false, false);
    }
  });

  console.log(`[notifications-service][RabbitMQ] Consumer active → ${routingKey} (queue: ${queueName})`);
}

export async function connectRabbitMQ(url: string) {
  let retries = 10;
  while (retries > 0) {
    try {
      connection = await amqplib.connect(url);
      const ch = await connection.createChannel();
      channel = ch;
      await ch.assertExchange(EXCHANGE, "topic", { durable: true });

      connection.on("close", () => {
        console.error("[notifications-service][RabbitMQ] Connection closed. Reconnecting & re-attaching consumers...");
        channel = null;
        connection = null;
        if (!isReconnecting) {
          isReconnecting = true;
          setTimeout(async () => {
            try {
              await connectRabbitMQ(url);
              isReconnecting = false;
            } catch (recErr) {
              console.error("[notifications-service][RabbitMQ] Reconnection failed:", recErr);
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
          console.error(`[notifications-service][RabbitMQ] Failed to re-register consumer for ${reg.routingKey}:`, regErr);
        }
      }

      console.log(`[notifications-service][RabbitMQ] Connected successfully. Active consumers: ${consumerRegistry.length}`);
      return channel;
    } catch (err) {
      retries--;
      console.error(`[notifications-service][RabbitMQ] Retrying... (${retries} left)`, err);
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
  console.log(`[notifications-service][RabbitMQ] Published → ${routingKey}`);
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
    console.warn(`[notifications-service][RabbitMQ] Channel not ready yet for ${routingKey}, saved in registry.`);
    return;
  }

  await bindAndConsume(channel, routingKey, queueName, handler);
}
