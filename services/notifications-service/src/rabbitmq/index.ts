import amqplib, { Channel, ChannelModel } from "amqplib";

const EXCHANGE = "oriyon.events";
let channel: Channel | null = null;
let connection: ChannelModel | null = null;

export async function connectRabbitMQ(url: string) {
  let retries = 10;
  while (retries > 0) {
    try {
      connection = await amqplib.connect(url);
      channel = await connection.createChannel();
      await channel.assertExchange(EXCHANGE, "topic", { durable: true });
      connection.on("close", () => {
        console.error("[notifications-service][RabbitMQ] Connection closed. Reconnecting...");
        channel = null;
        setTimeout(() => connectRabbitMQ(url), 5000);
      });
      console.log("[notifications-service][RabbitMQ] Connected");
      return channel;
    } catch {
      retries--;
      console.error(`[notifications-service][RabbitMQ] Retrying... (${retries} left)`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error("RabbitMQ connection failed");
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
  if (!channel) throw new Error("RabbitMQ channel not ready");
  await channel.assertQueue(queueName, { durable: true });
  await channel.bindQueue(queueName, EXCHANGE, routingKey);
  channel.prefetch(1);
  channel.consume(queueName, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      await handler(payload);
      channel!.ack(msg);
    } catch (err) {
      console.error(`[notifications-service][RabbitMQ] Handler error on ${routingKey}:`, err);
      channel!.nack(msg, false, false);
    }
  });
  console.log(`[notifications-service][RabbitMQ] Consuming → ${routingKey} (queue: ${queueName})`);
}
