import amqplib, { Channel, Connection } from "amqplib";

const EXCHANGE_NAME = "oriyon.events";
const EXCHANGE_TYPE = "topic";

let connection: Connection | null = null;
let channel: Channel | null = null;

export async function connectRabbitMQ(url: string): Promise<Channel> {
  if (channel) return channel;

  let retries = 10;
  while (retries > 0) {
    try {
      connection = await amqplib.connect(url);
      channel = await connection.createChannel();
      await channel.assertExchange(EXCHANGE_NAME, EXCHANGE_TYPE, { durable: true });

      connection.on("close", () => {
        console.error("[RabbitMQ] Connection closed. Reconnecting...");
        channel = null;
        connection = null;
        setTimeout(() => connectRabbitMQ(url), 5000);
      });

      console.log("[RabbitMQ] Connected successfully");
      return channel;
    } catch (err) {
      console.error(`[RabbitMQ] Connection failed. Retrying... (${retries} left)`);
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
  if (!channel) throw new Error("[RabbitMQ] Channel not initialised");

  await channel.assertQueue(queueName, { durable: true });
  await channel.bindQueue(queueName, EXCHANGE_NAME, routingKey);
  channel.prefetch(1);

  channel.consume(queueName, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(payload);
      channel!.ack(msg);
    } catch (err) {
      console.error(`[RabbitMQ] Error processing message on ${routingKey}:`, err);
      channel!.nack(msg, false, false); // dead-letter, don't requeue
    }
  });

  console.log(`[RabbitMQ] Consuming → ${routingKey} (queue: ${queueName})`);
}
